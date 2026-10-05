'use strict';
/**
 * OpenVibe.Chat's typed service-token ingress (T3 J2): Live's only delivery path to Chat.
 *
 *   message(body)   POST /internal/chat/messages    chat.message.send       persist + broadcast a line (or a DM)
 *   event(body)     POST /internal/chat/events      chat.event.publish      a transient card, alert, sound, notice
 *   moderation(body) POST /internal/chat/moderation chat.moderation.write   deletes, IP reviews, relay hides, log, disconnect
 *   invalidate(body) POST /internal/chat/invalidate chat.cache.invalidate   a cache hint (user, approvals, bans)
 *   presence()      GET  /internal/chat/presence    chat.presence.read      the connection snapshot
 *   soundAsset(body) POST /internal/chat/sounds/asset chat.sounds.write     record where Live's asset sync put a channel sound
 *
 * Reads (Read Live's chat stats, queues and history from Chat — server/chat/chat-reads.js is the mode-aware
 * layer the callers use; these are the raw asks):
 *   readStats(body)   POST /internal/chat/stats                  chat.stats.read             counts, or top chatters
 *   readMessages(q)   GET  /internal/chat/messages               chat.messages.read          a page of messages
 *   readTimeline(q)   GET  /internal/chat/timeline               chat.analysis.read          time-bucketed message counts
 *   readFirstChat(q)  GET  /internal/chat/first-chat             chat.analysis.read          has this identity ever chatted here
 *   readPendingIp(q)  GET  /internal/chat/moderation/pending-ip  chat.moderation.queue.read  held IP-approval messages
 *   readRelayUsers(q) GET  /internal/chat/moderation/relay-users chat.moderation.queue.read  hidden relay users
 *   readRelayUser(id) GET  /internal/chat/moderation/relay-users/:id chat.moderation.queue.read one hidden relay user
 *   readTtsOverride(q) GET /internal/chat/moderation/tts-override chat.moderation.queue.read a voice override
 *   readSounds(q)     GET  /internal/chat/sounds                 chat.sounds.read            a channel's sound count, or its pending assets
 *   readSoundByCommand(q) GET /internal/chat/sounds/by-command   chat.sounds.read            the approved sound a !command plays
 *
 * Auth: Live's Network service principal (client_credentials, audience openvibe.chat, server/net/network-principal.js).
 * Every POST carries one idempotency `key` made when the operation is created and reused on every retry, so Chat
 * applies it once (Chat answers the first result again; see OpenVibe.Chat docs/chat-ingress.md).
 *
 * Errors are logged and counted (`stats`), never thrown into the caller: every POST resolves to Chat's answer or
 * null. A 4xx is final (Chat refused the body; retrying cannot help). A 5xx, a timeout or Chat being unreachable
 * is retried with the same key on a back-off that outlasts Chat's five-minute delivery lease, then dropped. There
 * is deliberately no second path: it would deliver twice.
 * Retries live in memory only (a Live restart drops the ones still waiting). Off under LIVE_DRILL.
 */
const crypto = require('crypto');
const principal = require('../net/network-principal');
const { CHAT_URL } = require('./chat-authority');

const AUDIENCE = 'openvibe.chat';
const TIMEOUT_MS = 5000;
const RETRY_MS = [1000, 5000, 30000, 120000, 360000];
const MAX_WAITING = 2000;
const KEY_RE = /[^A-Za-z0-9:._-]/g;

const stats = { sent: 0, refused: 0, failed: 0, retried: 0, dropped: 0, byFamily: {}, lastError: null };
let waiting = 0;
let lastLog = null;
let retryMs = RETRY_MS;

function drill() { try { return require('../drill').enabled; } catch { return false; } }

function count(family, result) {
    const f = stats.byFamily[family] || (stats.byFamily[family] = { sent: 0, refused: 0, failed: 0, dropped: 0 });
    f[result]++;
    stats[result]++;
}

function note(message) {
    stats.lastError = message;
    if (message === lastLog) return;   // log once until it changes
    lastLog = message;
    console.warn(`[ChatIngress] ${message}`);
}

/** A stable idempotency key: `live:<family>:<natural id or a fresh uuid>`, safe for Chat's key pattern. */
function key(family, natural) {
    const tail = natural == null || natural === '' ? crypto.randomUUID() : String(natural);
    return `live:${family}:${tail}`.replace(KEY_RE, '_').slice(0, 160);
}

async function request(method, path, body, retried = false) {
    const res = await fetch(`${CHAT_URL}${path}`, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await principal.serviceHeaders(AUDIENCE)) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) { principal.invalidate(AUDIENCE); return request(method, path, body, true); }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data };
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

/** POST one operation to /internal/chat/<family>, retrying 5xx/unreachable with the same key. Never rejects. */
async function send(family, body, path = `/internal/chat/${family}`) {
    if (drill()) return null;
    if (!principal.configured()) { count(family, 'dropped'); note(`${family}: not configured (OV_OAUTH_CLIENT_SECRET unset); dropped`); return null; }
    const payload = { ...body, key: body.key || key(family) };
    if (waiting >= MAX_WAITING) { count(family, 'dropped'); note(`${family}: ${waiting} operations already waiting for Chat; dropped`); return null; }
    waiting++;
    try {
        for (let attempt = 0; ; attempt++) {
            let status = 0;
            let data = null;
            let why;
            try {
                ({ status, data } = await request('POST', path, payload));
                why = `answered ${status}${data && data.error ? ` (${data.error})` : ''}`;
            } catch (err) { why = err.message; }
            if (status >= 200 && status < 300) { count(family, 'sent'); lastLog = null; return data || { ok: true }; }
            if (status >= 400 && status < 500) {
                count(family, 'refused');
                note(`${family} ${payload.key}: Chat ${why}; not retried`);
                return null;
            }
            if (attempt >= retryMs.length) {
                count(family, 'failed');
                note(`${family} ${payload.key}: Chat ${why}; gave up after ${attempt + 1} attempts`);
                return null;
            }
            stats.retried++;
            note(`${family}: Chat ${why}; retrying with the same key`);
            await sleep(retryMs[attempt]);
        }
    } finally { waiting--; }
}

/** Chat's presence snapshot ({ total, streams, slow_mode, users, anons }), or null. */
async function presence() {
    if (drill() || !principal.configured()) return null;
    try {
        const { status, data } = await request('GET', '/internal/chat/presence');
        if (status === 200 && data) return data;
        note(`presence: Chat answered ${status}`);
    } catch (err) { note(`presence: ${err.message}`); }
    return null;
}

// ── Reads (Chat's internal read API; see the header) ─────────────────────────
// All of these degrade like presence(): Chat's answer, or null plus one logged warning. A caller
// that can only show the data answers with its own cached or empty value — never a 500.

/** Query string for a GET read; arrays become Chat's comma lists, booleans its 1/0 flags. */
function qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
        if (v == null || v === '') continue;
        if (Array.isArray(v)) u.set(k, v.join(','));
        else if (typeof v === 'boolean') u.set(k, v ? '1' : '0');
        else u.set(k, String(v));
    }
    const s = u.toString();
    return s ? `?${s}` : '';
}

/** GET one Chat read; its JSON body or null. Ordinary failures are logged and answered null. */
async function read(name, path) {
    if (drill() || !principal.configured()) return null;
    try {
        const { status, data } = await request('GET', path);
        if (status === 200 && data && data.ok !== false) return data;
        note(`${name}: Chat answered ${status}${data && data.error ? ` (${data.error})` : ''}`);
    } catch (err) { note(`${name}: ${err.message}`); }
    return null;
}

/** POST /internal/chat/stats — message/chatter counts, or the top chatters of a room. */
async function readStats(body) {
    if (drill() || !principal.configured()) return null;
    try {
        const { status, data } = await request('POST', '/internal/chat/stats', body || {});
        if (status === 200 && data && data.ok !== false) return data;
        note(`stats: Chat answered ${status}${data && data.error ? ` (${data.error})` : ''}`);
    } catch (err) { note(`stats: ${err.message}`); }
    return null;
}

const readMessages = (params) => read('messages', `/internal/chat/messages${qs(params)}`);
const readTimeline = (params) => read('timeline', `/internal/chat/timeline${qs(params)}`);
const readFirstChat = (params) => read('first-chat', `/internal/chat/first-chat${qs(params)}`);
const readPendingIp = (params) => read('pending-ip', `/internal/chat/moderation/pending-ip${qs(params)}`);
const readRelayUsers = (params) => read('relay-users', `/internal/chat/moderation/relay-users${qs(params)}`);
const readRelayUser = (id) => read('relay-user', `/internal/chat/moderation/relay-users/${Number(id)}`);
const readTtsOverride = (params) => read('tts-override', `/internal/chat/moderation/tts-override${qs(params)}`);
const readSounds = (params) => read('sounds', `/internal/chat/sounds${qs(params)}`);
/**
 * GET /internal/chat/sounds/by-command — the approved sound a !command plays. Chat answers 404 for a
 * definitive "no such sound", so that is surfaced as `{ sound: null }`; null instead means Chat was
 * unreachable (a 5xx, a malformed body or an exception), which the caller answers from Live's table.
 */
async function readSoundByCommand(params) {
    if (drill() || !principal.configured()) return null;
    try {
        const { status, data } = await request('GET', `/internal/chat/sounds/by-command${qs(params)}`);
        if (status === 200 && data && data.ok !== false && data.sound) return data;
        if (status === 404) return { sound: null };
        note(`sound-by-command: Chat answered ${status}${data && data.error ? ` (${data.error})` : ''}`);
    } catch (err) { note(`sound-by-command: ${err.message}`); }
    return null;
}
/** Record where Live's asset sync uploaded a channel sound (idempotent; Chat applies the same write once). */
async function soundAsset(body) {
    if (drill() || !principal.configured()) return null;
    try {
        // Chat's /sounds/asset takes exactly { id, media_url, media_asset_id } — no idempotency key.
        const { status, data } = await request('POST', '/internal/chat/sounds/asset', body);
        if (status === 200 && data && data.ok !== false) return data;
        note(`sounds-asset: Chat answered ${status}${data && data.error ? ` (${data.error})` : ''}`);
    } catch (err) { note(`sounds-asset: ${err.message}`); }
    return null;
}

module.exports = {
    AUDIENCE,
    key,
    stats,
    message: (body) => send('messages', body),
    event: (body) => send('events', body),
    moderation: (body) => send('moderation', body),
    invalidate: (body) => send('invalidate', body),
    presence,
    readStats, readMessages, readTimeline, readFirstChat, readPendingIp, readRelayUsers, readRelayUser, readTtsOverride,
    readSounds, readSoundByCommand, soundAsset,
    _setRetryMs(ms) { retryMs = ms || RETRY_MS; },
};
