'use strict';
/**
 * What happened during a live stream, in stream time (seconds since streams.started_at), kept so a seek, a clip or a
 * transcript can use it later (migration 0020_stream_history; owner, 2026-10-26).
 *
 * Stream 2795 showed why: its broadcaster reconnected 11 minutes in, so it was recorded in two parts (VODs 6025 and
 * 6026), and nothing remembered where part 2 began. The studio's clip panel measures from the stream's start and sent
 * those times to part 1 ("Start time exceeds video duration"); a viewer's rewind could not reach part 1; part 2's
 * transcript lines pointed 11 minutes late. With each part's start on record, stream time minus that start is the
 * part's own time.
 *
 *   partStarted(stream, { vodId, part, why })   a recording part began (recorder.js, once Media made its VOD)
 *   partEnded(streamId, vodId)                  it stopped
 *   shape(streamId, width, height)              the broadcaster's picture changed size (its studio reports it); a burst
 *                                               of changes is written at most every SHAPE_MIN_MS, the last one kept
 *   broadcasterLeft(streamId) / broadcasterBack(streamId)   a reconnect, with its gap
 *   forStream(streamId)                         { parts, shapes, reconnects } in time order
 *   partAt(streamId, sec)                       the part recording stream time `sec` (or the nearest one before it)
 *   partForVod(vodId)                           a VOD's part row, or null
 *
 * Writes never throw: the history is a record, not a gate on going live or recording.
 */
const db = require('../db/database');

const SHAPE_MIN_MS = 2000;
const MAX_SIDE = 16384;

/** Epoch ms of a stored timestamp ('YYYY-MM-DD HH:MM:SS' is UTC), or null. */
function epochMs(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v.getTime();
    const t = String(v);
    const d = new Date(/^\d{4}-\d{2}-\d{2} /.test(t) ? `${t.replace(' ', 'T')}Z` : t);
    return isNaN(d) ? null : d.getTime();
}

/** Seconds since the stream started at `atMs` (now by default); null when it has no start. */
function streamSeconds(stream, atMs = Date.now()) {
    const start = epochMs(stream && stream.started_at);
    return start == null ? null : Math.max(0, Math.round((atMs - start) / 100) / 10);
}

const _streams = new Map();   // streamId → { started: epoch ms, shape: { width, height, writtenAt, pending, timer }, leftAt }

async function startOf(streamId) {
    const cur = _streams.get(streamId);
    if (cur && cur.started != null) return cur.started;
    let started = null;
    try { started = epochMs((await db.getStreamById(streamId))?.started_at); } catch { /* */ }
    if (started != null) entry(streamId).started = started;
    return started;
}
const MAX_STREAMS = 500;   // in-memory state of streams seen lately; the oldest goes first (rows stay in the table)
function entry(streamId) {
    let e = _streams.get(streamId);
    if (!e) {
        _streams.set(streamId, e = {});
        for (const id of _streams.keys()) { if (_streams.size <= MAX_STREAMS) break; forget(id); }
    }
    return e;
}

async function add(row) {
    try {
        await db.run(`INSERT INTO stream_history (stream_id, kind, at_sec, end_sec, vod_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
            [row.stream_id, row.kind, row.at_sec, row.end_sec == null ? null : row.end_sec, row.vod_id || null, row.detail ? JSON.stringify(row.detail) : null]);
        return true;
    } catch (err) {
        console.warn(`[History] stream ${row.stream_id} ${row.kind} not recorded:`, err.message);
        return false;
    }
}

/** The part recording now, for a shape row: the recorder's active VOD. */
function recordingVod(streamId) {
    try { return require('./recorder').getActiveRecording(streamId)?.vodId || null; } catch { return null; }
}

async function partStarted(stream, { vodId, part = 1, why = null, atMs = Date.now() } = {}) {
    if (!stream || !stream.id || !vodId) return false;
    const at = streamSeconds(stream, atMs);
    if (at == null) return false;
    entry(stream.id).started = epochMs(stream.started_at);
    return add({ stream_id: stream.id, kind: 'part', at_sec: at, vod_id: vodId, detail: { part, ...(why ? { why } : {}) } });
}

async function partEnded(streamId, vodId, atMs = Date.now()) {
    if (!streamId || !vodId) return false;
    const start = await startOf(streamId);
    if (start == null) return false;
    try {
        await db.run(`UPDATE stream_history SET end_sec = ? WHERE stream_id = ? AND kind = 'part' AND vod_id = ? AND end_sec IS NULL`,
            [Math.max(0, Math.round((atMs - start) / 100) / 10), streamId, vodId]);
        return true;
    } catch { return false; }
}

async function writeShape(streamId, shape) {
    const start = await startOf(streamId);
    if (start == null) return;
    const e = entry(streamId);
    e.shape = { ...(e.shape || {}), width: shape.width, height: shape.height, writtenAt: Date.now() };
    await add({ stream_id: streamId, kind: 'shape', at_sec: Math.max(0, Math.round((shape.atMs - start) / 100) / 10),
        vod_id: recordingVod(streamId), detail: { width: shape.width, height: shape.height } });
}

/** The broadcaster's picture is now width×height. Returns false for a size that is not one. */
function shape(streamId, width, height) {
    width = Number(width); height = Number(height);
    if (!streamId || !Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > MAX_SIDE || height > MAX_SIDE) return false;
    const e = entry(streamId);
    const s = e.shape || {};
    if (s.pending) s.pending = null;
    if (s.width === width && s.height === height) return true;   // back where the last row says: nothing new
    const next = { width, height, atMs: Date.now() };
    const wait = (s.writtenAt || 0) + SHAPE_MIN_MS - Date.now();
    if (wait <= 0) { writeShape(streamId, next).catch(() => {}); return true; }
    e.shape = { ...s, pending: next };
    if (!s.timer) {
        const timer = setTimeout(() => {
            const cur = _streams.get(streamId)?.shape;
            if (!cur) return;
            cur.timer = null;
            const p = cur.pending;
            cur.pending = null;
            if (p && !(p.width === cur.width && p.height === cur.height)) writeShape(streamId, p).catch(() => {});
        }, wait);
        if (timer.unref) timer.unref();
        e.shape.timer = timer;
    }
    return true;
}

function broadcasterLeft(streamId) { entry(streamId).leftAt = Date.now(); }

async function broadcasterBack(streamId) {
    const e = _streams.get(streamId);
    if (!e || !e.leftAt) return false;
    const left = e.leftAt;
    e.leftAt = null;
    const start = await startOf(streamId);
    if (start == null) return false;
    return add({ stream_id: streamId, kind: 'reconnect', at_sec: Math.max(0, Math.round((Date.now() - start) / 100) / 10),
        detail: { gap_s: Math.round((Date.now() - left) / 100) / 10 } });
}

/** The stream ended: forget its in-memory state (rows stay). */
function forget(streamId) {
    const e = _streams.get(streamId);
    if (e && e.shape && e.shape.timer) clearTimeout(e.shape.timer);
    _streams.delete(streamId);
}

const parse = (detail) => { try { return detail ? JSON.parse(detail) : {}; } catch { return {}; } };

async function forStream(streamId) {
    let rows = [];
    try {
        rows = await db.all(`SELECT kind, at_sec, end_sec, vod_id, detail FROM stream_history WHERE stream_id = ? ORDER BY at_sec ASC, id ASC LIMIT 5000`, [streamId]);
    } catch { /* none */ }
    const out = { parts: [], shapes: [], reconnects: [] };
    for (const r of rows) {
        const d = parse(r.detail);
        if (r.kind === 'part') out.parts.push({ part: d.part || out.parts.length + 1, vod_id: Number(r.vod_id) || null, at: Number(r.at_sec), end: r.end_sec == null ? null : Number(r.end_sec), ...(d.why ? { why: d.why } : {}) });
        else if (r.kind === 'shape') out.shapes.push({ at: Number(r.at_sec), width: d.width, height: d.height, vod_id: Number(r.vod_id) || null });
        else if (r.kind === 'reconnect') out.reconnects.push({ at: Number(r.at_sec), gap_s: d.gap_s == null ? null : Number(d.gap_s) });
    }
    return out;
}

async function partAt(streamId, sec) {
    const { parts } = await forStream(streamId);
    let best = null;
    for (const p of parts) if (p.at <= sec) best = p;
    return best;
}

async function partForVod(vodId) {
    if (!vodId) return null;
    try {
        const r = await db.get(`SELECT stream_id, at_sec, end_sec, detail FROM stream_history WHERE kind = 'part' AND vod_id = ? ORDER BY id ASC LIMIT 1`, [vodId]);
        if (!r) return null;
        const d = parse(r.detail);
        return { stream_id: Number(r.stream_id), vod_id: Number(vodId), part: d.part || 1, at: Number(r.at_sec), end: r.end_sec == null ? null : Number(r.end_sec) };
    } catch { return null; }
}

/**
 * Where each of these VODs starts in its stream's time → Map(vodId → seconds). Stream time minus that is the VOD's own
 * time (a timeline row's start_sec, a Rundown segment's). A VOD with no part row (recorded before the history) is
 * left out: its rows are read as they always were.
 */
async function vodOffsets(vodIds) {
    const ids = [...new Set((vodIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 500);
    const out = new Map();
    if (!ids.length) return out;
    try {
        const rows = await db.all(`SELECT vod_id, MIN(at_sec) AS at FROM stream_history WHERE kind = 'part' AND vod_id IN (${ids.map(() => '?').join(',')}) GROUP BY vod_id`, ids);
        for (const r of rows) out.set(Number(r.vod_id), Number(r.at));
    } catch { /* none */ }
    return out;
}

/** A time in stream seconds as seconds into the VOD that starts at `offset` (never before its start). */
const vodTime = (sec, offset) => Math.max(0, Math.round(((Number(sec) || 0) - (Number(offset) || 0)) * 100) / 100);

module.exports = {
    partStarted, partEnded, shape, broadcasterLeft, broadcasterBack, forget,
    forStream, partAt, partForVod, vodOffsets, vodTime, streamSeconds, epochMs, SHAPE_MIN_MS,
};
