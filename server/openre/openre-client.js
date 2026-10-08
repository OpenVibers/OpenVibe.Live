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
const { createClient, OpenVibeError } = require('openvibe-sdk/core');
const { createOpenReClient } = require('openvibe-sdk/openre');

// The calls themselves are openvibe-sdk/openre (SDK 0.16.0), shared with every product that uses OpenRe; this
// module keeps Live's configuration (env), its on/off switch and the names the rest of Live calls.
const TIMEOUT_MS = 5000;
let sdk = null;

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

/** The SDK client for the current settings (rebuilt when they change: tests and rollbacks flip OPENRE_URL). */
function openre() {
    if (!enabled()) throw new OpenReError('OpenRe integration is not configured (OPENRE_URL, OV_OAUTH_CLIENT_SECRET)', 0);
    const s = settings();
    const key = `${s.url}|${s.publicUrl}|${s.clientId}@${s.networkInternalUrl}`;
    if (!sdk || sdk.key !== key) {
        const tokens = createServiceTokenClient({ tokenUrl: `${s.networkInternalUrl}/oauth/token`, clientId: s.clientId, clientSecret: s.clientSecret, audience: 'openvibe.openre' });
        const client = createClient({ tokenProvider: tokens, baseUrls: { openre: s.url }, timeoutMs: TIMEOUT_MS, retries: 1 });
        sdk = { key, api: createOpenReClient(client, { publicUrl: s.publicUrl }), client };
    }
    return sdk.api;
}

/** SDK errors keep Live's OpenReError shape (status, body, code) for the routes that answer with them. */
async function wrap(what, fn) {
    try { return await fn(); } catch (err) {
        if (err instanceof OpenReError) throw err;
        if (err instanceof OpenVibeError || (err && err.name === 'OpenVibeError')) {
            const body = err.problem || (err.code ? { code: err.code, detail: err.detail || err.message } : null);
            throw new OpenReError(err.status ? (err.detail || err.message) : `OpenRe unreachable (${what}): ${err.message}`, err.status || 0, body);
        }
        throw new OpenReError(`OpenRe unreachable (${what}): ${err.message}`, 0);
    }
}

/** A raw call, for anything the SDK client does not name yet. */
async function request(method, path, { body, subject, timeoutMs = TIMEOUT_MS } = {}) {
    openre();
    return await wrap(`${method} ${path}`, () => sdk.client.json({ service: 'openre', audience: 'openvibe.openre', method, path, json: body, timeoutMs,
        headers: subject ? { 'X-OV-Subject': subject } : {} }));
}

/** The OpenRe stream definition serving a Live slot, or null. */
const streamForSlot = async (managedStreamId) => await wrap('stream lookup', () => openre().streams.byExternalRef(`live:managed_stream:${managedStreamId}`));

/** Create the definition for a slot, owned by the streamer's canonical subject. The key it
 *  returns is dropped unseen: the streamer gets a usable key by rotating. */
async function createStreamForSlot(slot, { subject, protocols, recordingMode, recordingVisibility }) {
    const r = await wrap('stream create', () => openre().streams.create({
        title: slot.title || 'Stream',
        ...(protocols ? { protocols } : {}),
        recording_mode: recordingMode,
        recording_visibility: recordingVisibility,
        mirror_to_live: true,
        external_refs: [
            { service: 'live', type: 'managed_stream', id: String(slot.id), label: slot.slug || slot.title || null },
            { service: 'live', type: 'user', id: String(slot.user_id), label: slot.username || null },
        ],
    }, { subject }));
    return r.stream;
}

const rotateKey = async (streamId, { subject, graceSeconds = 0 } = {}) => await wrap('key rotate', () => openre().streams.rotateKey(streamId, { subject, graceSeconds }));
const updateStream = async (streamId, patch, { subject } = {}) => await wrap('stream update', () => openre().streams.update(streamId, patch, { subject }));
const getStream = async (streamId, { subject } = {}) => await wrap('stream read', () => openre().streams.get(streamId, { subject }));
const getSession = async (sessionId) => await wrap('session read', () => openre().sessions.get(sessionId));
/** Playback descriptor for a session (the SDK caches it 10 s: the FLV proxy asks on every viewer connect). */
const playback = async (sessionId) => await wrap('playback', () => openre().sessions.playback(sessionId));

function manageUrl(streamId) {
    return `${settings().publicUrl}/streams/${encodeURIComponent(streamId || '')}`;
}

function _reset() { sdk = null; }

module.exports = { enabled, settings, request, streamForSlot, createStreamForSlot, updateStream, rotateKey, getStream, getSession, playback, manageUrl, OpenReError, _reset };
