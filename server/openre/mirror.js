'use strict';
/**
 * OpenRe sessions → Live's `streams` table (roadmap Wave 7, ADR-009: Live observes sessions through
 * OpenRe events and APIs). Watch pages, discovery, go-live notifications and analytics keep working
 * because an OpenRe-ingested session becomes an ordinary live `streams` row.
 *
 *   POST /internal/openre-events   the endpoint of Live's OpenVibe.Events subscription (topic
 *                                  openre.session.*), signed with OPENRE_EVENTS_SECRET. Each event
 *                                  is applied exactly once (openvibe-sdk inbox, consumer
 *                                  'live-openre-mirror'), in revision order per session.
 *   reconcile (every 30 s)         for mirrored live sessions only: asks OpenRe for the session,
 *                                  keeps the row's heartbeat fresh, ends it if OpenRe says it ended
 *                                  (covers a missed event). Does nothing when no row is mirrored.
 *
 * Consent: a session is mirrored only when its slot is switched to OpenRe on Live AND the OpenRe
 * definition says mirror_to_live (plan §15.10 "explicit visibility and consent").
 */
const db = require('../db/database');
const client = require('./openre-client');
const { authorityOf } = require('./authority');

const CONSUMER = 'live-openre-mirror';
const RECONCILE_MS = 30000;
// A mirrored session OpenRe has not confirmed for this long is left to Live's stale cleanup.
const CONFIRM_WINDOW_MIN = 30;
let inbox = null;
let timer = null;

function ensureInbox() {
    if (inbox) return inbox;
    const { createInbox } = require('openvibe-sdk/events');
    inbox = createInbox(db.getDb());
    inbox.ensureSchema();
    return inbox;
}

function slotRef(payload) {
    const refs = Array.isArray(payload && payload.external_refs) ? payload.external_refs : [];
    const r = refs.find(x => x && x.service === 'live' && x.type === 'managed_stream');
    const id = r ? parseInt(r.id, 10) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
}

const toSqlTime = (iso) => { const d = iso ? new Date(iso) : new Date(); return Number.isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').slice(0, 19); };

/**
 * Apply one event (inside the inbox transaction). Returns { outcome, after? } where after() runs
 * once the transaction committed (go-live notifications must not fire for a rolled-back row).
 */
function apply(event) {
    const type = String(event && event.event_type || '');
    const p = event.payload || {};
    const sessionId = String(p.session_id || (event.subject && event.subject.id) || '');
    const revision = Number(event.subject && event.subject.revision) || 0;
    if (event.source !== 'openre') return { outcome: 'ignored' };
    if (!/^openre\.session\.(started|ended|failed)$/.test(type) || !/^ses_[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId)) return { outcome: 'ignored' };
    const known = db.get('SELECT * FROM openre_sessions WHERE session_id = ?', [sessionId]);
    if (known && known.revision >= revision) return { outcome: 'stale' };

    if (type === 'openre.session.started') {
        const slotId = slotRef(p);
        const slot = slotId ? db.getManagedStreamById(slotId) : null;
        if (!slot || authorityOf(slot) !== 'openre' || !p.mirror_to_live) return { outcome: 'not_mirrored' };
        const user = db.getUserById(slot.user_id);
        if (!user || user.is_banned) return { outcome: 'not_mirrored' };
        // A row made by the Go Live page waiting for RTMP is used, like Live's own RTMP ingest does.
        const waiting = db.get(`SELECT s.id FROM streams s LEFT JOIN openre_sessions o ON o.stream_id = s.id
            WHERE s.managed_stream_id = ? AND s.is_live = 1 AND s.protocol = 'rtmp' AND o.session_id IS NULL ORDER BY s.id DESC LIMIT 1`, [slot.id]);
        let streamId;
        let created = false;
        if (waiting) {
            streamId = waiting.id;
            db.run('UPDATE streams SET started_at = CURRENT_TIMESTAMP, last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);
        } else {
            const channel = db.ensureChannel(user.id);
            streamId = Number(db.createStream({
                user_id: user.id,
                channel_id: channel && channel.id,
                managed_stream_id: slot.id,
                control_config_id: slot.control_config_id || null,
                title: slot.title || `${user.display_name || user.username}'s Stream`,
                description: slot.description || '',
                category: slot.category || null,
                protocol: 'rtmp',
                is_nsfw: slot.is_nsfw ? 1 : 0,
            }).lastInsertRowid);
            db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);
            created = true;
        }
        db.run(`INSERT INTO openre_sessions (session_id, managed_stream_id, stream_id, state, revision, started_at, confirmed_at, updated_at)
            VALUES (?, ?, ?, 'live', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id) DO UPDATE SET stream_id = excluded.stream_id, state = 'live', revision = excluded.revision, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
        [sessionId, slot.id, streamId, revision, toSqlTime(p.started_at)]);
        const ended = db.endOtherLiveStreamsForSlot(slot.id, streamId);
        return {
            outcome: created ? 'created' : 'attached',
            after: () => {
                for (const sid of ended) { try { require('../streaming/broadcast-server').endStream(sid); } catch { /* */ } }
                try {
                    const channel = db.getChannelByUserId(user.id);
                    const configId = slot.control_config_id || (channel && channel.active_control_config_id);
                    if (configId) db.applyConfigToStream(configId, streamId);
                } catch (e) { console.warn('[OpenRe] control config for mirrored stream failed:', e.message); }
                const stream = db.getStreamById(streamId) || { id: streamId };
                try { require('../streaming/golive-notify').notifyFollowersGoLive(user, stream); } catch (e) { console.warn('[OpenRe] go-live notify failed:', e.message); }
                try { require('../streaming/live-events').announceGoLive(stream, user); } catch { /* */ }
                console.log(`[OpenRe] session ${sessionId} mirrored into stream ${streamId} (${user.username}, slot ${slot.id})`);
            },
        };
    }

    // ended / failed
    const state = type === 'openre.session.ended' ? 'ended' : 'failed';
    const streamId = known ? known.stream_id : null;
    db.run(`INSERT INTO openre_sessions (session_id, managed_stream_id, stream_id, state, revision, ended_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, revision = excluded.revision, ended_at = excluded.ended_at, updated_at = CURRENT_TIMESTAMP`,
    [sessionId, known ? known.managed_stream_id : slotRef(p), streamId, state, revision, toSqlTime(p.ended_at)]);
    if (!streamId) return { outcome: 'recorded' };
    const row = db.getStreamById(streamId);
    if (row && row.is_live) db.endStream(streamId);
    return {
        outcome: 'ended',
        after: () => {
            try { db.computeAndCacheStreamAnalytics(streamId); } catch { /* */ }
            try { require('../streaming/broadcast-server').endStream(streamId); } catch { /* */ }
            // What Live's own RTMP unpublish stops (server/index.js): the RS bridge, chat relays, AI bots.
            try { require('../integrations/robotstreamer-service').stopForStream(streamId); } catch { /* */ }
            try { require('../integrations/chat-relay-service').stopForStream(streamId); } catch { /* */ }
            try { require('../integrations/ai-chatbot-service').stopForStream(streamId); } catch { /* */ }
            console.log(`[OpenRe] session ${sessionId} ${state}: stream ${streamId} ended`);
        },
    };
}

/** Express handler for POST /internal/openre-events (needs req.rawBody from express.json verify). */
function webhookHandler(req, res) {
    const secret = process.env.OPENRE_EVENTS_SECRET || '';
    if (!secret) return res.status(503).json({ error: 'OPENRE_EVENTS_SECRET is not set' });
    const { parseDelivery } = require('openvibe-sdk/events');
    const delivery = parseDelivery(req.rawBody, req.headers, secret);
    if (!delivery) return res.status(401).json({ error: 'bad signature' });
    // Signed but unusable (no event_id): acknowledge so it is not redelivered forever.
    if (!delivery.event || !delivery.event.event_id) return res.status(204).end();
    let result;
    try {
        let after = null;
        result = ensureInbox().once(CONSUMER, delivery.event.event_id, () => {
            const r = apply(delivery.event);
            after = r.after || null;
            return r.outcome;
        });
        if (!result.duplicate && after) { try { after(); } catch (e) { console.warn('[OpenRe] post-commit step failed:', e.message); } }
    } catch (err) {
        console.error('[OpenRe] event apply failed:', err.message);
        return res.status(500).json({ error: 'apply failed' }); // Events retries
    }
    return res.status(204).end();
}

/** Stream id → the mirrored OpenRe session (or null). */
function sessionForStream(streamId) {
    try { return db.get('SELECT * FROM openre_sessions WHERE stream_id = ? ORDER BY updated_at DESC LIMIT 1', [streamId]) || null; } catch { return null; }
}

/** Does OpenRe hold a live ingest for this stream (confirmed recently)? Used by Live's stale cleanup. */
function hasLiveSession(streamId) {
    try {
        return Boolean(db.get(`SELECT 1 FROM openre_sessions WHERE stream_id = ? AND state = 'live'
            AND confirmed_at > datetime('now', '-${CONFIRM_WINDOW_MIN} minutes')`, [streamId]));
    } catch { return false; }
}

/** Does OpenRe own this stream at all (so Live must not start its own restream/recording for it)? */
function ownsStream(streamId) {
    return Boolean(sessionForStream(streamId));
}

async function reconcileOnce() {
    let rows = [];
    try { rows = db.all("SELECT * FROM openre_sessions WHERE state = 'live'"); } catch { return 0; }
    if (!rows.length || !client.enabled()) return 0;
    let n = 0;
    for (const r of rows) {
        // Live ended the row itself (End Stream, or stale cleanup while OpenRe was unreachable):
        // stop tracking it rather than keeping a live mirror of an offline stream.
        const row = r.stream_id ? db.getStreamById(r.stream_id) : null;
        if (row && !row.is_live) { db.run("UPDATE openre_sessions SET state = 'detached', updated_at = CURRENT_TIMESTAMP WHERE session_id = ?", [r.session_id]); continue; }
        let s;
        try { s = await client.getSession(r.session_id); } catch (err) {
            if (err.status === 404) s = { state: 'failed', revision: r.revision + 1, ended_at: null };
            else continue; // OpenRe unreachable: keep the last known state (bounded by CONFIRM_WINDOW_MIN)
        }
        if (s.state === 'live' || s.state === 'starting') {
            db.run("UPDATE openre_sessions SET confirmed_at = CURRENT_TIMESTAMP WHERE session_id = ?", [r.session_id]);
            if (r.stream_id) db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ? AND is_live = 1', [r.stream_id]);
        } else if (['ending', 'ended', 'failed'].includes(s.state)) {
            const event = { source: 'openre', event_type: `openre.session.${s.state === 'failed' ? 'failed' : 'ended'}`, subject: { type: 'ingest_session', id: r.session_id, revision: Math.max(Number(s.revision) || 0, r.revision + 1) }, payload: { session_id: r.session_id, ended_at: s.ended_at } };
            const out = db.getDb().transaction(() => apply(event))();
            if (out.after) out.after();
            n++;
        }
    }
    return n;
}

function start() {
    if (timer || !client.enabled()) return;
    timer = setInterval(() => { reconcileOnce().catch(err => console.warn('[OpenRe] reconcile failed:', err.message)); }, RECONCILE_MS);
    if (timer.unref) timer.unref();
}

function stop() { if (timer) clearInterval(timer); timer = null; }
function _reset() { stop(); inbox = null; }

module.exports = { apply, webhookHandler, sessionForStream, hasLiveSession, ownsStream, reconcileOnce, start, stop, CONSUMER, _reset };
