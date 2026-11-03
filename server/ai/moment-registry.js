/**
 * moment-registry.js — ONE shared record of every stream moment the AI has already turned into
 * something (a paste, a clip), so the paste job and the clip job never pick the same spot or the
 * same scene twice. Replaces the two separate logs (`home_hero_moments.usedSigs` and
 * `auto_clip_log[].sig`) that could not see each other — which is how a paste and a clip ended
 * up with the identical title from the identical second of the same VOD.
 *
 *   record({ kind, vod_id, stream_id, offset, sig, title })   after a paste/clip is created
 *   isUsed({ vod_id, stream_id, offset, sig })                 same VOD within GAP_SEC, or same scene
 *   usedOffsets(vod_id, stream_id)                             → [sec…] to tell the picker to avoid
 *
 * Durable since 11-03 (item 151, C06; migration 0024): every moment is a row of `ai_moments`. The same-recording check
 * is an indexed lookup, the scene/speech/footage checks read the last SIG_TTL (14 days), and rows go after OFFSET_TTL
 * (90 days). It was a JSON list in app_state 'ai_used_moments' capped at 800, so on a busy week the oldest fell out and
 * a repeat came back; that list (or, before it, the two legacy logs) moves in once, on first use.
 */
'use strict';

const db = require('../db/database');
const dedupe = require('./clip-dedupe');

const KEY = 'ai_used_moments';
const MOVED = 'ai_moments_moved';
const GAP_SEC = 120;          // two moments on the same VOD must be at least this far apart
const SIG_TTL_MS = 14 * 24 * 3600_000;   // a scene signature blocks re-use for two weeks
const OFFSET_TTL_MS = 90 * 24 * 3600_000;
const SCAN = 5000;            // the most recent rows the scene check reads (two weeks is far fewer today)

const idOf = (v) => (v == null || v === '' ? null : String(v));
const iso = (ms) => new Date(ms).toISOString();

let _ready = null;
/** The table, with the old list moved in once. */
function _load() {
    if (!_ready) _ready = (async () => {
        if (await db.getState(MOVED)) return;
        let list = [];
        try { const l = JSON.parse(await db.getState(KEY) || '[]'); if (Array.isArray(l)) list = l; } catch { /* */ }
        if (!list.length) list = await _importLegacy();
        for (const e of list.slice().reverse()) await _insert(e, e.ts || Date.now());
        await db.setState(MOVED, new Date().toISOString());
    })().catch((e) => { _ready = null; throw e; });
    return _ready;
}

async function _importLegacy() {
    const out = [];
    try { for (const c of JSON.parse(await db.getState('auto_clip_log') || '[]') || []) out.push({ kind: 'clip', vod_id: c.vod_id || null, stream_id: c.stream_id || null, offset: (c.start_time || 0) + 16, sig: c.sig || null, title: c.title || null, ts: c.ts || Date.now() }); } catch { /* */ }
    try { const h = JSON.parse(await db.getState('home_hero_moments') || '{}') || {}; for (const m of h.moments || []) out.push({ kind: 'paste', vod_id: m.vodId || null, stream_id: null, offset: m.offset || 0, sig: sig(m.title), title: m.title || null, ts: h.updated_at || Date.now() }); for (const s of h.usedSigs || []) out.push({ kind: 'paste', vod_id: null, stream_id: null, offset: null, sig: s, title: null, ts: h.updated_at || Date.now() }); } catch { /* */ }
    return out;
}

/** Coarse scene signature — the first five significant tokens of a description/title. */
function sig(text) {
    return dedupe.shortSignature(text, 5);
}

/** A caller's frame embedding, kept only when it is a usable finite vector. */
function _embedding(v) {
    if (!Array.isArray(v) || !v.length || v.length > 1024) return null;
    const out = v.map(Number);
    return out.every(Number.isFinite) ? out : null;
}

async function _insert(e, ts = Date.now()) {
    await db.run(`INSERT INTO ai_moments (kind, vod_id, stream_id, at_sec, sig, scene, speech, embedding, title, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::timestamptz)`, [
        String(e.kind || 'moment').slice(0, 20), idOf(e.vod_id), idOf(e.stream_id), e.offset == null ? null : Math.floor(Number(e.offset)) || 0,
        e.sig ? String(e.sig).slice(0, 200) : null, e.scene ? String(e.scene).slice(0, 600) : null, e.speech ? String(e.speech).slice(0, 600) : null,
        e.embedding ? JSON.stringify(e.embedding) : null, e.title ? String(e.title).slice(0, 120) : null, iso(ts),
    ]);
}

let _pruned = 0;
async function record({ kind, vod_id = null, stream_id = null, offset = null, sig: s = null, title = null, desc = null, speech = null, embedding = null }) {
    await _load();
    const scene = dedupe.normalize(desc || title);
    await _insert({
        kind: kind || 'moment', vod_id, stream_id, offset,
        sig: s || sig(desc || title),
        // Full normalized scene + what was said, so a re-worded description still matches and a
        // static webcam with a NEW conversation does not.
        scene, speech: speech ? dedupe.normalize(speech) : null,
        // Optional frame embedding: the same footage in another upload scores near 1.
        embedding: _embedding(embedding),
        title,
    });
    // Rows past 90 days go, at most once an hour.
    if (Date.now() - _pruned > 3600_000) { _pruned = Date.now(); await db.run('DELETE FROM ai_moments WHERE created_at < ?::timestamptz', [iso(Date.now() - OFFSET_TTL_MS)]).catch(() => {}); }
}

/** Why a moment is blocked, or null when it is free. */
async function usedReason({ vod_id = null, stream_id = null, offset = null, sig: s = null, desc = null, title = null, speech = null, embedding = null } = {}, { gapSec = GAP_SEC } = {}) {
    await _load();
    const now = Date.now();
    const v = idOf(vod_id);
    const st = idOf(stream_id);
    if (offset != null && (v || st)) {
        const at = Math.floor(Number(offset)) || 0;
        const hit = await db.get(`SELECT kind, at_sec, vod_id FROM ai_moments
                                   WHERE created_at >= ?::timestamptz AND at_sec IS NOT NULL AND at_sec > ? AND at_sec < ?
                                     AND ((?::text IS NOT NULL AND vod_id = ?::text) OR (?::text IS NOT NULL AND stream_id = ?::text))
                                   ORDER BY created_at DESC LIMIT 1`,
            [iso(now - OFFSET_TTL_MS), at - gapSec, at + gapSec, v, v, st, st]);
        if (hit) return `${hit.kind} already made at ${hit.at_sec}s of this ${v && hit.vod_id === v ? 'VOD' : 'stream'}`;
    }
    const scene = s || sig(desc || title);
    const full = dedupe.normalize(desc || title);
    const said = dedupe.normalize(speech);
    const emb = _embedding(embedding);
    if (!scene && !full && !emb) return null;
    const rows = await db.all(`SELECT kind, sig, scene, speech, embedding FROM ai_moments WHERE created_at >= ?::timestamptz
                                ORDER BY created_at DESC LIMIT ${SCAN}`, [iso(now - SIG_TTL_MS)]);
    for (const e of rows) {
        const eEmb = Array.isArray(e.embedding) ? e.embedding : null;
        const shortMatch = scene && e.sig && e.sig === scene;
        const sceneMatch = full && e.scene && dedupe.isSameScene(e.scene, full);
        // Frame embeddings (when both sides have them) are independent evidence: the same footage
        // is a repeat even if it was re-described or re-uploaded.
        const visualMatch = emb && eEmb && dedupe.isSameEmbedding(eEmb, emb);
        if (!shortMatch && !sceneMatch && !visualMatch) continue;
        if (visualMatch) return `same footage as a recent ${e.kind}`;
        // Same camera/description but a different conversation is a new moment, not a repeat.
        if (said && e.speech && !dedupe.isSameSpeech(e.speech, said)) continue;
        return `same scene as a recent ${e.kind} ("${scene || e.sig}")`;
    }
    return null;
}
async function isUsed(m, o) { return !!await usedReason(m, o); }

/** Offsets already used on this VOD/stream (for the picker's "avoid these" list). */
async function usedOffsets(vod_id = null, stream_id = null) {
    await _load();
    const v = idOf(vod_id);
    const st = idOf(stream_id);
    if (!v && !st) return [];
    const rows = await db.all(`SELECT DISTINCT at_sec FROM ai_moments WHERE created_at >= ?::timestamptz AND at_sec IS NOT NULL
                                AND ((?::text IS NOT NULL AND vod_id = ?::text) OR (?::text IS NOT NULL AND stream_id = ?::text)) ORDER BY at_sec`,
        [iso(Date.now() - OFFSET_TTL_MS), v, v, st, st]);
    return rows.map((r) => Number(r.at_sec));
}

const _shape = (r) => r && ({ kind: r.kind, vod_id: r.vod_id, stream_id: r.stream_id, offset: r.at_sec == null ? null : Number(r.at_sec), sig: r.sig, title: r.title, ts: new Date(r.created_at).getTime() });

async function lastOfKind(kind, { stream_id = null, vod_id = null } = {}) {
    await _load();
    const st = idOf(stream_id);
    const v = idOf(vod_id);
    return _shape(await db.get(`SELECT * FROM ai_moments WHERE kind = ? AND (?::text IS NULL OR stream_id = ?::text) AND (?::text IS NULL OR vod_id = ?::text)
                                ORDER BY created_at DESC, id DESC LIMIT 1`, [kind, st, st, v, v])) || null;
}

async function recent(hours = 48) {
    await _load();
    return (await db.all('SELECT * FROM ai_moments WHERE created_at >= ?::timestamptz ORDER BY created_at DESC, id DESC LIMIT 1000', [iso(Date.now() - hours * 3600_000)])).map(_shape);
}

module.exports = {
    record, isUsed, usedReason, usedOffsets, lastOfKind, recent, sig, GAP_SEC,
    _reset: () => { _ready = null; },
    /** Tests: an empty registry (the move counts as done). */
    _clear: async () => { await db.run('DELETE FROM ai_moments'); await db.setState(MOVED, new Date().toISOString()); _ready = null; },
};
