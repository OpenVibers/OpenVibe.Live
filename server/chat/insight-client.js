'use strict';
/**
 * The chat-AI insight OpenVibe.Chat keeps (roadmap T3): the global chat overview and each chatter's
 * summary live in Chat's chat_ai_summaries now, so Live's features that fold them into their own
 * work read them from Chat's public read API (/api/chat/ai/…, the same answers the browser gets):
 *
 *   getGlobal()                      → { overview, memory, timeline, … } | null
 *   getUser(userId)                  → a signed-in chatter's insight | null
 *   getAnon(anonId)                  → an anonymous chatter's insight ("anon123") | null
 *   getRelay(platform, username)     → a relayed chatter's insight | null
 *
 * Each has a synchronous peek*() twin for the few callers that cannot await (the persona's prompt
 * context): it answers what is cached, or null, and refreshes in the background, so the next call
 * has it. Answers are cached 60 s; a failure answers null, logs once and is cached too, so a Chat
 * outage costs the insight text and never a request. Off under LIVE_DRILL (a restore drill calls no
 * other service).
 */
const { CHAT_URL } = require('./chat-authority');
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 4000;

const cache = new Map();     // key → { at, value }
const inflight = new Map();  // key → Promise
let lastLog = null;

function drill() { try { return require('../drill').enabled; } catch { return false; } }

function cached(key) { const h = cache.get(key); return h && Date.now() - h.at < CACHE_TTL_MS ? h : null; }
function remember(key, value) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
}

function read(key, path) {
    const hit = cached(key);
    if (hit) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        if (drill()) return null;
        try {
            const res = await fetch(`${CHAT_URL}/api/chat/ai${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) throw new Error(`answered ${res.status}`);
            const out = await res.json();
            const value = (out && out.insight) || null;
            lastLog = null;
            remember(key, value);
            return value;
        } catch (err) {
            const m = `OpenVibe.Chat insight ${path}: ${(err && err.message) || err}`;
            if (m !== lastLog) { lastLog = m; console.warn(`[ChatInsight] ${m}`); }
            remember(key, null);
            return null;
        }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

function peek(key, path) {
    const hit = cached(key);
    if (hit) return hit.value;
    read(key, path).catch(() => { /* logged in read() */ });   // floating-ok: warms the cache for the next peek
    return null;
}

const userPath = (id) => `/user/${Number(id)}`;
const anonPath = (id) => `/anon/${encodeURIComponent(String(id))}`;
const relayPath = (platform, username) => `/relay/${encodeURIComponent(String(platform))}/${encodeURIComponent(String(username))}`;
const validUser = (id) => Number.isInteger(Number(id)) && Number(id) > 0;
const validAnon = (id) => /^anon\d+$/i.test(String(id || ''));

module.exports = {
    getGlobal: () => read('g', '/global'),
    getUser: (id) => (validUser(id) ? read(`u:${Number(id)}`, userPath(id)) : Promise.resolve(null)),
    getAnon: (id) => (validAnon(id) ? read(`a:${id}`, anonPath(id)) : Promise.resolve(null)),
    getRelay: (platform, username) => (platform && username ? read(`r:${platform}:${username}`, relayPath(platform, username)) : Promise.resolve(null)),
    peekGlobal: () => peek('g', '/global'),
    peekUser: (id) => (validUser(id) ? peek(`u:${Number(id)}`, userPath(id)) : null),
    peekAnon: (id) => (validAnon(id) ? peek(`a:${id}`, anonPath(id)) : null),
    peekRelay: (platform, username) => (platform && username ? peek(`r:${platform}:${username}`, relayPath(platform, username)) : null),
    _reset() { cache.clear(); inflight.clear(); lastLog = null; },
};
