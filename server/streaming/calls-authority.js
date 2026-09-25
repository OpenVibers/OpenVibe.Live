'use strict';
/**
 * Who runs voice/video calls (roadmap WS-I task 1). CALLS_AUTHORITY is read here and nowhere else.
 *
 * live (default, anything but "chat"): Live's own call server (./call-server.js) serves /ws/call and
 *   the voice-channel routes, and the stream lifecycle creates and removes stream voice channels in
 *   it — exactly as before.
 * chat: OpenVibe.Chat owns calls (nginx sends /ws/call, /api/streams/voice-channels… and
 *   /api/streams/:id/call there; Chat runs with CHAT_CALLS=1 — OpenVibe.Chat docs/calls-cutover.md).
 *   Go-live with a call mode, stream end, the WHIP teardown and the admin force-end ask Chat instead
 *   of the local call server:
 *       POST   /internal/calls/stream-channel { stream_id, mode, user_id }
 *       DELETE /internal/calls/stream-channel/:streamId
 *   with Live's service token for audience openvibe.chat — the same principal and grant
 *   (chat.live_bridge.write) Live's chat bridge uses (../chat/chat-remote.js). Fire-and-forget for the
 *   caller: a network error or a 5xx is retried after 1 s, 5 s and 15 s, unless a later call for the
 *   same stream superseded it (a stream that ended while its go-live was being retried is not
 *   given a channel afterwards); a 4xx is logged and dropped. Live's /ws/call and voice-channel
 *   routes stay mounted for one release, unreached once nginx routes those paths to Chat.
 */
const { CHAT_URL } = require('../chat/chat-authority');

const AUDIENCE = 'openvibe.chat';
const RETRY_MS = [1000, 5000, 15000];
const TIMEOUT_MS = 5000;

function authority() {
    return String(process.env.CALLS_AUTHORITY || '').trim().toLowerCase() === 'chat' ? 'chat' : 'live';
}
function isChat() { return authority() === 'chat'; }

const local = () => require('./call-server');

async function send(method, path, body, retried = false) {
    const principal = require('../net/network-principal');
    const res = await fetch(`${CHAT_URL}${path}`, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await principal.serviceHeaders(AUDIENCE)) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) { principal.invalidate(AUDIENCE); return send(method, path, body, true); }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const err = new Error(`Chat ${res.status}${data && data.error ? `: ${data.error}` : ''}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

const latest = new Map();   // streamId → seq of the newest call for it
let seq = 0;
const stats = { sent: 0, retried: 0, superseded: 0, failed: 0, lastError: null };

/** Send one hook to Chat, retrying as above. Resolves (never rejects) with Chat's answer or null. */
function deliver(streamId, method, path, body) {
    const mine = ++seq;
    latest.set(streamId, mine);
    const attempt = async (n) => {
        if (latest.get(streamId) !== mine) { stats.superseded++; return null; }
        try {
            const out = await send(method, path, body);
            stats.sent++;
            if (latest.get(streamId) === mine) latest.delete(streamId);
            return out;
        } catch (err) {
            stats.lastError = err.message;
            const retry = !(err.status >= 400 && err.status < 500) && n < RETRY_MS.length;
            if (!retry) {
                stats.failed++;
                console.warn(`[Calls] Chat refused ${method} ${path}: ${err.message}`);
                if (latest.get(streamId) === mine) latest.delete(streamId);
                return null;
            }
            stats.retried++;
            console.warn(`[Calls] ${method} ${path} failed (${err.message}); retrying in ${RETRY_MS[n] / 1000}s`);
            await new Promise((r) => { const t = setTimeout(r, RETRY_MS[n]); if (t.unref) t.unref(); });
            return attempt(n + 1);
        }
    };
    return attempt(0);
}

/** Go-live with a call mode, or the mode changed: the stream's voice channel. */
function createStreamChannel(streamId, mode, userId) {
    if (!isChat()) return local().createStreamChannel(streamId, mode, userId);
    return deliver(Number(streamId), 'POST', '/internal/calls/stream-channel', { stream_id: Number(streamId), mode, user_id: Number(userId) });
}

/** The stream ended (or was force-ended): its call ends and its voice channel goes. */
function removeStreamChannel(streamId) {
    if (!isChat()) return local().removeStreamChannel(streamId);
    return deliver(Number(streamId), 'DELETE', `/internal/calls/stream-channel/${Number(streamId)}`);
}

module.exports = { authority, isChat, createStreamChannel, removeStreamChannel, stats, RETRY_MS, AUDIENCE };
