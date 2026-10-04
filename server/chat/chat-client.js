'use strict';
/**
 * OpenVibe.Chat's typed service-token ingress (T3 J2), the replacement for the chat-remote.js bridge.
 *
 *   message(body)   POST /internal/chat/messages    chat.message.send       persist + broadcast a line (or a DM)
 *   event(body)     POST /internal/chat/events      chat.event.publish      a transient card, alert, sound, notice
 *   moderation(body) POST /internal/chat/moderation chat.moderation.write   deletes, IP reviews, relay hides, log, disconnect
 *   invalidate(body) POST /internal/chat/invalidate chat.cache.invalidate   a cache hint (user, approvals, bans)
 *   presence()      GET  /internal/chat/presence    chat.presence.read      the connection snapshot
 *
 * Auth: Live's Network service principal (client_credentials, audience openvibe.chat, server/net/network-principal.js).
 * Every POST carries one idempotency `key` made when the operation is created and reused on every retry, so Chat
 * applies it once (Chat answers the first result again; see OpenVibe.Chat docs/chat-ingress.md).
 *
 * Errors are logged and counted (`stats`), never thrown into the caller: every POST resolves to Chat's answer or
 * null. A 4xx is final (Chat refused the body; retrying cannot help). A 5xx, a timeout or Chat being unreachable
 * is retried with the same key on a back-off that outlasts Chat's five-minute delivery lease, then dropped. There
 * is deliberately no fallback to the bridge: once Chat owns delivery, a second path would deliver twice.
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
async function send(family, body) {
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
                ({ status, data } = await request('POST', `/internal/chat/${family}`, payload));
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

module.exports = {
    AUDIENCE,
    key,
    stats,
    message: (body) => send('messages', body),
    event: (body) => send('events', body),
    moderation: (body) => send('moderation', body),
    invalidate: (body) => send('invalidate', body),
    presence,
    _setRetryMs(ms) { retryMs = ms || RETRY_MS; },
};
