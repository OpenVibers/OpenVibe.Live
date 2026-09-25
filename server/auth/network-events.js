'use strict';
/**
 * OpenVibe.Events → Live: identity events from OpenVibe.Network (roadmap WS-B task 4).
 *
 *   POST /internal/network-events   the endpoint of Live's subscriptions to
 *                                   network.user.token_valid_after and network.user.updated
 *                                   (scripts/subscribe-media-events.js --network), signed with LIVE_EVENTS_SECRET,
 *                                   else MEDIA_EVENTS_SECRET (Live's one events secret), signature v2 only.
 *
 *   token_valid_after  the person's older tokens are refused (./revocations.js)
 *   updated            the person's profile, role and ban (./subject-projection.js, WS-B task 2)
 *
 * Applying is idempotent (a cutoff only ever moves forward; a profile revision only up), so a redelivery
 * is a no-op without an inbox. Anything signed but not ours to act on is acknowledged (204).
 */
const revocations = require('./revocations');

const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const stats = { received: 0, revoked: 0, unchanged: 0, profiles: 0, ignored: 0, refused: 0 };
const notifyChat = (userId) => { try { const cs = require('../chat/chat-server'); if (cs.remote) cs.userChanged(userId); } catch { /* non-critical */ } };

function secret() { return process.env.LIVE_EVENTS_SECRET || process.env.MEDIA_EVENTS_SECRET || ''; }

/** Apply one envelope; returns 'revoked' | 'unchanged' | 'updated' | 'stale' | 'ignored:<why>'. */
function apply(ev) {
    if (!ev || !EVENT_ID_RE.test(String(ev.event_id || ''))) return 'ignored:envelope';
    if (ev.event_type !== 'network.user.token_valid_after' && ev.event_type !== 'network.user.updated') return 'ignored:type';
    if (ev.source !== 'network') return 'ignored:source';
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (ev.event_type === 'network.user.updated') return require('./subject-projection').apply(p, { notify: notifyChat });
    const subject = p.subject && p.subject.id;
    const ms = Date.parse(p.valid_after);
    if (!SUBJECT_RE.test(String(subject || '')) || !Number.isFinite(ms)) return 'ignored:payload';
    return revocations.record(subject, ms, typeof p.reason === 'string' ? p.reason.slice(0, 40) : null) ? 'revoked' : 'unchanged';
}

/** Express handler (needs req.rawBody from the express.json verify hook). */
function handler(req, res) {
    const key = secret();
    if (key.length < 32) return res.status(503).json({ error: 'LIVE_EVENTS_SECRET is not set' });
    const { parseDelivery } = require('openvibe-sdk/events');
    const delivery = parseDelivery(req.rawBody, req.headers, key, { requireV2: true });
    if (!delivery) { stats.refused++; return res.status(401).json({ error: 'bad signature' }); }
    stats.received++;
    const out = apply(delivery.event);
    if (out === 'revoked') stats.revoked++; else if (out === 'unchanged' || out === 'stale') stats.unchanged++; else if (out === 'updated') stats.profiles++; else stats.ignored++;
    res.status(204).end();
}

module.exports = { handler, apply, stats, secret };
