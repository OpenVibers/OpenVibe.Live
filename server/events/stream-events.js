'use strict';
/**
 * Live → OpenVibe.Events: stream lifecycle as durable events (roadmap Wave 3, ADR-004, ADR-020).
 *
 *   live.stream.started   a stream row went live       (subject: stream <id>, revision 1)
 *   live.stream.ended     a live stream row ended       (subject: stream <id>, revision 2)
 *
 * Events are written to Live's own `event_outbox` table inside the same SQLite transaction as the
 * streams row (database.js onStreamLifecycle), and a relay publishes them with Live's service
 * token (audience openvibe.events, capability events.event.publish). If Events or Network is down
 * the rows wait and are retried with backoff; going live never waits on either.
 *
 * Off unless EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set (EVENTS_PUBLISH=off disables it).
 * Payloads carry public channel facts only (the stream is already listed publicly); consumers such
 * as Network's go-live notifications decide who hears about it.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');
const db = require('../db/database');
const identity = require('../auth/identity-sync');

const EVENTS_URL = (process.env.EVENTS_URL || '').replace(/\/+$/, '');
const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const CLIENT_ID = process.env.OV_OAUTH_CLIENT_ID || 'live';
const CLIENT_SECRET = process.env.OV_OAUTH_CLIENT_SECRET || '';
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

let outbox = null;
const stats = { queued: 0, lastError: null };

/** The envelope for one lifecycle change, read inside the caller's transaction. */
function envelopeFor(kind, streamId) {
    const s = db.getDb().prepare(`SELECT s.id, s.user_id, s.title, s.category, s.protocol, s.is_nsfw, s.started_at, s.ended_at,
            s.duration_seconds, s.managed_stream_id, u.username, u.display_name
        FROM streams s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(streamId);
    if (!s) return null;
    const subjectId = identity.subjectOf(s.user_id);
    const channel = { username: s.username, display_name: s.display_name || s.username, url: `https://openvibe.live/${encodeURIComponent(s.username)}` };
    if (subjectId) channel.subject = { type: 'user', id: subjectId };
    const payload = {
        stream_id: s.id,
        channel,
        title: s.title,
        category: s.category || null,
        protocol: s.protocol,
        is_nsfw: !!s.is_nsfw,
        started_at: toIso(s.started_at),
    };
    if (kind === 'ended') {
        payload.ended_at = toIso(s.ended_at);
        payload.duration_seconds = s.duration_seconds == null ? null : Number(s.duration_seconds);
    }
    return {
        event_type: `live.stream.${kind}`,
        actor: subjectId ? { type: 'user', id: subjectId } : { type: 'service', id: 'live' },
        subject: { type: 'stream', id: String(s.id), revision: kind === 'started' ? 1 : 2 },
        visibility: 'public',
        priority: 'important',
        payload,
    };
}

// SQLite CURRENT_TIMESTAMP is UTC without a zone ('2026-09-23 01:30:00').
function toIso(v) {
    if (!v) return null;
    const d = new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function init({ eventsUrl = EVENTS_URL, clientSecret = CLIENT_SECRET, fetchImpl, intervalMs } = {}) {
    if (outbox) return outbox;
    if (process.env.EVENTS_PUBLISH === 'off' || !eventsUrl || !clientSecret) {
        return null;
    }
    const tokens = createServiceTokenClient({ tokenUrl: `${NETWORK_INTERNAL_URL}/oauth/token`, clientId: CLIENT_ID, clientSecret, fetch: fetchImpl });
    const client = createClient({ baseUrls: { events: eventsUrl }, tokenProvider: tokens, fetch: fetchImpl, retries: 0 });
    const events = createEventsClient(client, { source: 'live' });
    outbox = createOutbox(db.getDb(), {
        events,
        intervalMs: intervalMs || 2000,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== stats.lastError) console.warn('[Events] publish failed (will retry):', msg);
            stats.lastError = msg;
        },
    });
    outbox.ensureSchema();
    db.onStreamLifecycle((kind, streamId) => {
        const env = envelopeFor(kind, streamId);
        if (!env) return;
        outbox.enqueue(env);
        stats.queued++;
        setImmediate(() => outbox && outbox.kick());
    });
    outbox.start();
    const prune = setInterval(() => { try { outbox.prune(); } catch { /* next time */ } }, PRUNE_EVERY_MS);
    if (prune.unref) prune.unref();
    console.log(`[Events] stream lifecycle → ${eventsUrl} (${outbox.pending()} pending)`);
    return outbox;
}

function status() {
    if (!outbox) return { enabled: false };
    return { enabled: true, pending: outbox.pending(), rejected: outbox.rejected(), queued_since_boot: stats.queued, last_error: stats.lastError };
}

function _reset() { if (outbox) outbox.stop(); outbox = null; db.onStreamLifecycle(null); stats.queued = 0; stats.lastError = null; }

module.exports = { init, status, envelopeFor, _reset };
