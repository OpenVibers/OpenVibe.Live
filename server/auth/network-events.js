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
 *   follow.created/.deleted  Live's follows table as a projection of Network's graph (../social/network-follows.js)
 *   subject.merged     two accounts became one (ADR-029): the folded-in Live user's follows, channel points and streams
 *                      move to the survivor's (./subject-merge.js), once per merge
 *   account.export_requested / account.deleted  the person's export part goes to Network, or their Live rows are
 *                      erased and the erasure confirmed (./account-data.js, ADR-033), once per export or deletion
 *
 * Applying is idempotent (a cutoff only ever moves forward; a profile revision only up), so a redelivery
 * is a no-op without an inbox. Anything signed but not ours to act on is acknowledged (204).
 */
const revocations = require('./revocations');

const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const stats = { received: 0, revoked: 0, unchanged: 0, profiles: 0, ignored: 0, refused: 0 };

function secret() { return process.env.LIVE_EVENTS_SECRET || process.env.MEDIA_EVENTS_SECRET || ''; }

/** Apply one envelope; returns 'revoked' | 'unchanged' | 'updated' | 'stale' | 'ignored:<why>' (a merge, export or deletion: a promise). */
function apply(ev) {
    if (!ev || !EVENT_ID_RE.test(String(ev.event_id || ''))) return 'ignored:envelope';
    if (ev.event_type === 'network.subject.merged') return ev.source === 'network' ? require('./subject-merge').apply(ev) : 'ignored:source';
    if (ev.event_type === 'network.account.export_requested' || ev.event_type === 'network.account.deleted') return ev.source === 'network' ? require('./account-data').apply(ev) : 'ignored:source';
    const follow = ev.event_type === 'network.follow.created' || ev.event_type === 'network.follow.deleted';
    if (ev.event_type !== 'network.user.token_valid_after' && ev.event_type !== 'network.user.updated' && !follow) return 'ignored:type';
    if (ev.source !== 'network') return 'ignored:source';
    // The follow graph is Network's (ADR-030); Live's follows table is its projection.
    if (follow) return require('../social/network-follows').apply(ev);
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (ev.event_type === 'network.user.updated') return require('./subject-projection').apply(p);
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
    const count = (out) => { if (out === 'revoked') stats.revoked++; else if (out === 'unchanged' || out === 'stale') stats.unchanged++; else if (out === 'updated' || out === 'followed' || out === 'unfollowed' || out === 'merged' || out === 'relinked' || out === 'exported' || out === 'erased' || out === 'confirmed') stats.profiles++; else stats.ignored++; };
    const out = apply(delivery.event);
    if (out && typeof out.then === 'function') {
        // A merge, export or deletion: answer after it applied, so a failure is redelivered.
        return out.then((o) => { count(o); res.status(204).end(); }, (e) => { console.error(`[NetworkEvents] ${delivery.event.event_type} failed:`, e.message); res.status(500).json({ error: 'not applied' }); });
    }
    count(out);
    res.status(204).end();
}

module.exports = { handler, apply, stats, secret };
