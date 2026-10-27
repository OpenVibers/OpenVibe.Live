'use strict';
/**
 * A stream recorded in parts is one video (owner, 2026-10-27: "instead of 'The stream was recorded in 2 parts: Part 1 ·
 * Part 2' it should automatically just have them as a single vod"; OpenVibe.Media docs/recordings.md).
 *
 * The broadcaster dropping and coming back, or a recorder restart, makes a new VOD per session (stream 2795: VODs 6025
 * and 6026). Live knows which VODs are one stream's parts and where each starts in stream time (stream_history), so it
 * tells Media: PUT /recordings/stream:<id> with the parts in order, the gap before each and its stream offset. Media then
 * plays them as one video (one HLS playlist over the parts' segments), lists only the first part, which names the
 * recording, and lets a clip cross a join. A stream with one part sends nothing: that VOD is the video.
 *
 *   sync(streamId, { close })   → Media's recording (or null): from the stream's history, idempotent; close: the stream ended
 *   soon(streamId)              sync a few seconds after a part started or ended (several changes, one call)
 *   sweep()                     the streams of the last two days with two or more parts: synced, and closed once ended
 *                               (also the backfill of streams recorded in parts before this existed)
 *   start()                     the sweep every SWEEP_MS (server/index.js's normal boot, so never under LIVE_DRILL)
 *   toRecordingTime(parts, s) / toStreamTime(parts, s)   stream time ↔ the video's time (gaps between parts skipped)
 *   presentParts(recording)     Media's parts as Live answers them: start_sec, duration_sec, stream_offset_sec
 *
 * Never throws: a recording that is not joined yet plays as its parts did before.
 */
const db = require('../db/database');
const history = require('./stream-history');

const SOON_MS = 5000;
const SWEEP_MS = 10 * 60 * 1000;
const SWEEP_DAYS = 2;
const keyOf = (streamId) => `stream:${Number(streamId)}`;
const pending = new Map();   // streamId → timer

/** The parts to send: the stream's recording parts with a VOD, in stream time order, each once. */
async function partsOf(streamId) {
    const { parts } = await history.forStream(streamId);
    const seen = new Set();
    const out = [];
    let prevEnd = null;
    for (const p of parts) {
        if (!p.vod_id || seen.has(p.vod_id)) continue;
        seen.add(p.vod_id);
        const gap = prevEnd != null && p.at > prevEnd ? Math.round((p.at - prevEnd) * 1000) : 0;
        out.push({ vod_id: p.vod_id, gap_before_ms: gap, stream_offset_ms: Math.round(p.at * 1000) });
        prevEnd = p.end != null ? p.end : prevEnd;
    }
    return out;
}

async function sync(streamId, { close = false } = {}) {
    try {
        const parts = await partsOf(streamId);
        if (parts.length < 2) return null;
        const media = require('../media-client');
        const stream = await db.getStreamById(streamId).catch(() => null);
        const rec = await media.putRecording(keyOf(streamId), { parts, ...(stream && stream.title ? { title: String(stream.title).slice(0, 200) } : {}), ...(close ? { state: 'closed' } : {}) });
        return rec && rec.id ? rec : null;
    } catch (err) {
        console.warn(`[Recordings] stream ${streamId}: ${err.message}`);
        return null;
    }
}

function soon(streamId) {
    if (!streamId || require('../drill').enabled) return;
    clearTimeout(pending.get(streamId));
    const t = setTimeout(() => { pending.delete(streamId); sync(streamId).catch(() => {}); }, SOON_MS);
    if (t.unref) t.unref();
    pending.set(streamId, t);
}

async function sweep() {
    let rows = [];
    try {
        rows = await db.all(`SELECT h.stream_id, MAX(CASE WHEN s.is_live = 1 THEN 1 ELSE 0 END) AS live
            FROM stream_history h JOIN streams s ON s.id = h.stream_id
            WHERE h.kind = 'part' AND h.vod_id IS NOT NULL AND h.created_at >= ?
            GROUP BY h.stream_id HAVING COUNT(DISTINCT h.vod_id) >= 2 ORDER BY h.stream_id DESC LIMIT 200`,
        [new Date(Date.now() - SWEEP_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19)]);
    } catch (err) { console.warn('[Recordings] sweep:', err.message); return 0; }
    let n = 0;
    for (const r of rows) if (await sync(r.stream_id, { close: !Number(r.live) })) n++;
    return n;
}

// ── Time (the one conversion, Media docs/recordings.md §2) ──
// parts: [{ start_sec (recording time), duration_sec, stream_offset_sec }]. The gaps between parts are not in the video.

/** Stream seconds → seconds into the recording, or null when that moment fell between parts (not recorded). */
function toRecordingTime(parts, streamSec) {
    const s = Number(streamSec);
    for (const p of parts || []) {
        if (p.stream_offset_sec == null) continue;
        if (s >= p.stream_offset_sec && s <= p.stream_offset_sec + p.duration_sec) return Math.round((p.start_sec + s - p.stream_offset_sec) * 100) / 100;
    }
    return null;
}

/** Seconds into the recording → stream seconds (null when the part's place in the stream is unknown). */
function toStreamTime(parts, recSec) {
    const t = Number(recSec);
    const list = parts || [];
    const p = list.find((x) => t >= x.start_sec && t < x.start_sec + x.duration_sec) || list[list.length - 1];
    if (!p || p.stream_offset_sec == null) return null;
    return Math.round((p.stream_offset_sec + t - p.start_sec) * 100) / 100;
}

/** Media's recording parts (ms) as Live answers them (s), each with its stream offset (Media's, else the history's). */
async function presentParts(rec) {
    const parts = (rec && Array.isArray(rec.parts) ? rec.parts : []);
    const offsets = await history.vodOffsets(parts.map((p) => p.vod_id));
    return parts.map((p) => ({
        vod_id: Number(p.vod_id), start_sec: Number(p.start_ms) / 1000, duration_sec: Number(p.duration_ms) / 1000,
        gap_before_sec: Number(p.gap_before_ms || 0) / 1000,
        stream_offset_sec: p.stream_offset_ms != null ? Number(p.stream_offset_ms) / 1000 : (offsets.has(Number(p.vod_id)) ? offsets.get(Number(p.vod_id)) : null),
    }));
}

let started = false;
function start() {
    if (started || require('../drill').enabled) return;
    started = true;
    require('../utils/jobs').every('recordings-sweep', SWEEP_MS, sweep, { initialDelayMs: 90 * 1000, jitterMs: 30 * 1000 });
}

module.exports = { sync, soon, sweep, start, partsOf, keyOf, toRecordingTime, toStreamTime, presentParts };
