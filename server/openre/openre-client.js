'use strict';
/**
 * OpenRe.Stream client (roadmap Wave 7). Live asks OpenRe for stream definitions, ingest URLs,
 * key rotation, sessions and playback descriptors; it never touches an OpenRe worker.
 *
 * Auth: Live's Network service principal (OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET),
 * client-credentials tokens for audience openvibe.openre. Grants Live needs on openre:
 *   openre.stream.read, openre.stream.write, openre.key.rotate, openre.session.read
 * Calls made for a streamer carry X-OV-Subject: <their usr_ subject>.
 *
 * Env:
 *   OPENRE_URL            OpenRe API, host-local (http://127.0.0.1:4500). Unset = integration off:
 *                         every slot behaves exactly as before, whatever its ingest_authority.
 *   OPENRE_PUBLIC_URL     for links to the standalone UI (default https://openre.stream)
 *   OPENRE_EVENTS_SECRET  the signing secret of Live's OpenVibe.Events subscription to openre.*
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const TIMEOUT_MS = 5000;
let tokens = null;
const cache = new Map(); // playback descriptors, 10 s

function settings() {
    return {
        url: String(process.env.OPENRE_URL || '').replace(/\/+$/, ''),
        publicUrl: String(process.env.OPENRE_PUBLIC_URL || 'https://openre.stream').replace(/\/+$/, ''),
        networkInternalUrl: String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, ''),
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'live',
        clientSecret: process.env.OV_OAUTH_CLIENT_SECRET || '',
    };
}

/** True when Live is configured to talk to OpenRe at all. */
function enabled() {
    const s = settings();
    return Boolean(s.url && s.clientSecret);
}

class OpenReError extends Error {
    constructor(message, status, body) { super(message); this.status = status || 0; this.body = body || null; this.code = body && body.code; }
}

function tokenClient() {
    const s = settings();
    if (!tokens || tokens._for !== `${s.clientId}@${s.networkInternalUrl}`) {
        tokens = createServiceTokenClient({ tokenUrl: `${s.networkInternalUrl}/oauth/token`, clientId: s.clientId, clientSecret: s.clientSecret, audience: 'openvibe.openre' });
        tokens._for = `${s.clientId}@${s.networkInternalUrl}`;
    }
    return tokens;
}

async function request(method, path, { body, subject, timeoutMs = TIMEOUT_MS } = {}) {
    if (!enabled()) throw new OpenReError('OpenRe integration is not configured (OPENRE_URL, OV_OAUTH_CLIENT_SECRET)', 0);
    const s = settings();
    const headers = { Accept: 'application/json', Authorization: `Bearer ${await tokenClient().getToken()}` };
    if (subject) headers['X-OV-Subject'] = subject;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    let text = '';
    try {
        res = await fetch(`${s.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        text = await res.text().catch(() => '');
    } catch (err) {
        throw new OpenReError(`OpenRe unreachable (${method} ${path}): ${err.message}`, 0);
    }
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (!res.ok) throw new OpenReError((json && (json.detail || json.error)) || `OpenRe ${res.status} on ${method} ${path}`, res.status, json);
    return json;
}

/** The OpenRe stream definition serving a Live slot, or null. */
async function streamForSlot(managedStreamId) {
    const r = await request('GET', `/api/v1/streams?external_ref=${encodeURIComponent(`live:managed_stream:${managedStreamId}`)}`);
    return (r && r.streams && r.streams[0]) || null;
}

/** Create the definition for a slot, owned by the streamer's canonical subject. The key it
 *  returns is dropped unseen: the streamer gets a usable key by rotating. */
async function createStreamForSlot(slot, { subject, recordingMode, recordingVisibility }) {
    const r = await request('POST', '/api/v1/streams', {
        subject,
        body: {
            title: slot.title || 'Stream',
            recording_mode: recordingMode,
            recording_visibility: recordingVisibility,
            mirror_to_live: true,
            external_refs: [
                { service: 'live', type: 'managed_stream', id: String(slot.id), label: slot.slug || slot.title || null },
                { service: 'live', type: 'user', id: String(slot.user_id), label: slot.username || null },
            ],
        },
    });
    return r.stream;
}

async function rotateKey(streamId, { subject, graceSeconds = 0 } = {}) {
    return request('POST', `/api/v1/streams/${encodeURIComponent(streamId)}/keys/rotate`, { subject, body: { grace_seconds: graceSeconds } });
}

async function getStream(streamId, { subject } = {}) {
    const r = await request('GET', `/api/v1/streams/${encodeURIComponent(streamId)}`, { subject });
    return r.stream;
}

async function getSession(sessionId) {
    const r = await request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    return r.session;
}

/** Playback descriptor for a session (cached 10 s: the FLV proxy asks on every viewer connect). */
async function playback(sessionId) {
    const hit = cache.get(sessionId);
    if (hit && hit.at > Date.now() - 10000) return hit.value;
    const r = await request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/playback`);
    cache.set(sessionId, { at: Date.now(), value: r.playback });
    if (cache.size > 500) for (const [k, v] of cache) if (v.at < Date.now() - 60000) cache.delete(k);
    return r.playback;
}

function manageUrl(streamId) {
    return `${settings().publicUrl}/streams/${encodeURIComponent(streamId || '')}`;
}

function _reset() { tokens = null; cache.clear(); }

module.exports = { enabled, settings, request, streamForSlot, createStreamForSlot, rotateKey, getStream, getSession, playback, manageUrl, OpenReError, _reset };
