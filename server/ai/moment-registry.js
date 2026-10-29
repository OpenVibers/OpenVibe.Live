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
 * State key `ai_used_moments` (capped). Legacy logs are imported once on first use.
 */
'use strict';

const db = require('../db/database');
const dedupe = require('./clip-dedupe');

const KEY = 'ai_used_moments';
const MAX = 800;
const GAP_SEC = 120;          // two moments on the same VOD must be at least this far apart
const SIG_TTL_MS = 14 * 24 * 3600_000;   // a scene signature blocks re-use for two weeks
const OFFSET_TTL_MS = 90 * 24 * 3600_000;

let _cache = null;
async function _load() {
    if (_cache) return _cache;
    let list = [];
    try { const l = JSON.parse(await db.getState(KEY) || '[]'); if (Array.isArray(l)) list = l; } catch { /* */ }
    if (!list.length) list = await _importLegacy();
    _cache = list;
    return list;
}
async function _save(list) { _cache = list.slice(0, MAX); try { await db.setState(KEY, JSON.stringify(_cache)); } catch { /* */ } }

async function _importLegacy() {
    const out = [];
    try { for (const c of JSON.parse(await db.getState('auto_clip_log') || '[]') || []) out.push({ kind: 'clip', vod_id: c.vod_id || null, stream_id: c.stream_id || null, offset: (c.start_time || 0) + 16, sig: c.sig || null, title: c.title || null, ts: c.ts || Date.now() }); } catch { /* */ }
    try { const h = JSON.parse(await db.getState('home_hero_moments') || '{}') || {}; for (const m of h.moments || []) out.push({ kind: 'paste', vod_id: m.vodId || null, stream_id: null, offset: m.offset || 0, sig: sig(m.title), title: m.title || null, ts: h.updated_at || Date.now() }); for (const s of h.usedSigs || []) out.push({ kind: 'paste', vod_id: null, stream_id: null, offset: null, sig: s, title: null, ts: h.updated_at || Date.now() }); } catch { /* */ }
    return out.slice(0, MAX);
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

async function record({ kind, vod_id = null, stream_id = null, offset = null, sig: s = null, title = null, desc = null, speech = null, embedding = null }) {
    const list = await _load();
    const scene = dedupe.normalize(desc || title);
    list.unshift({
        kind: kind || 'moment', vod_id: vod_id || null, stream_id: stream_id || null,
        offset: offset == null ? null : Math.floor(offset),
        sig: s || sig(desc || title),
        // Full normalized scene + what was said, so a re-worded description still matches and a
        // static webcam with a NEW conversation does not. Legacy entries keep only `sig`.
        scene: scene ? scene.slice(0, 600) : null,
        speech: speech ? dedupe.normalize(speech).slice(0, 600) : null,
        // Optional frame embedding: the same footage in another upload scores near 1.
        embedding: _embedding(embedding),
        title: title ? String(title).slice(0, 120) : null, ts: Date.now(),
    });
    await _save(list);
}

/** Why a moment is blocked, or null when it is free. */
async function usedReason({ vod_id = null, stream_id = null, offset = null, sig: s = null, desc = null, title = null, speech = null, embedding = null } = {}, { gapSec = GAP_SEC } = {}) {
    const now = Date.now();
    const scene = s || sig(desc || title);
    const full = dedupe.normalize(desc || title);
    const said = dedupe.normalize(speech);
    const emb = _embedding(embedding);
    for (const e of await _load()) {
        const age = now - (e.ts || 0);
        if (age > OFFSET_TTL_MS) continue;
        if (offset != null && e.offset != null && ((vod_id && e.vod_id === vod_id) || (stream_id && e.stream_id === stream_id)) && Math.abs(e.offset - offset) < gapSec) return `${e.kind} already made at ${Math.floor(e.offset)}s of this ${e.vod_id === vod_id ? 'VOD' : 'stream'}`;
        if (age > SIG_TTL_MS) continue;
        const shortMatch = scene && e.sig && e.sig === scene;
        const sceneMatch = full && e.scene && dedupe.isSameScene(e.scene, full);
        // Frame embeddings (when both sides have them) are independent evidence: the same footage
        // is a repeat even if it was re-described or re-uploaded.
        const visualMatch = emb && e.embedding && dedupe.isSameEmbedding(e.embedding, emb);
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
    const now = Date.now();
    return [...new Set((await _load()).filter(e => e.offset != null && now - (e.ts || 0) <= OFFSET_TTL_MS && ((vod_id && e.vod_id === vod_id) || (stream_id && e.stream_id === stream_id))).map(e => Math.floor(e.offset)))].sort((a, b) => a - b);
}

async function lastOfKind(kind, { stream_id = null, vod_id = null } = {}) {
    return (await _load()).find(e => e.kind === kind && (!stream_id || e.stream_id === stream_id) && (!vod_id || e.vod_id === vod_id)) || null;
}

async function recent(hours = 48) { const cut = Date.now() - hours * 3600_000; return (await _load()).filter(e => (e.ts || 0) >= cut); }

module.exports = { record, isUsed, usedReason, usedOffsets, lastOfKind, recent, sig, GAP_SEC, _reset: () => { _cache = null; } };
