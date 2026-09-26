'use strict';
/**
 * A channel's game summary (roadmap WS-M task 2, PF7): the public fields of the owner's
 * games.progress.summary user module (level, achievements, playtime_hours; Contracts declares them
 * public), read from Network's public module endpoint GET /api/modules/:ns/public/:subject. No token
 * and no grant: it is what Network shows anyone. Games writes the record when a character leaves.
 *
 *   forUser(userId) → { game, url, level, achievements?, playtime_hours? } | null
 *
 * Null when the account has no Network subject, has no record, or Network does not answer in 3 s.
 * Answers (misses too) are cached 10 minutes per subject, at most 2000 entries.
 */
const identity = require('./identity-sync');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const NAMESPACE = 'games.progress.summary';
const TTL_MS = 10 * 60 * 1000;
const MAX = 2000;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const cache = new Map();

const nonNegInt = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

function shape(data) {
    const level = nonNegInt(data && data.level);
    if (level == null) return null;
    const out = { game: 'Scraplandia', url: 'https://openvibe.games/', level };
    const ach = nonNegInt(data.achievements);
    if (ach != null) out.achievements = ach;
    if (typeof data.playtime_hours === 'number' && data.playtime_hours >= 0 && Number.isFinite(data.playtime_hours)) out.playtime_hours = Math.round(data.playtime_hours * 10) / 10;
    return out;
}

async function forUser(userId, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
    const subject = identity.subjectOf(userId);
    if (!SUBJECT_RE.test(subject || '')) return null;
    const hit = cache.get(subject);
    if (hit && now - hit.at < TTL_MS) return hit.value;
    let value = null;
    try {
        const r = await fetchImpl(`${NETWORK_INTERNAL_URL}/api/modules/${encodeURIComponent(NAMESPACE)}/public/${subject}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
        if (r.status === 200) value = shape((await r.json()).data);
        else if (r.status !== 404) return null;           // not cached: Network trouble is not an answer
    } catch { return null; }
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
    cache.set(subject, { at: now, value });
    return value;
}

function _reset() { cache.clear(); }

module.exports = { forUser, shape, NAMESPACE, _reset };
