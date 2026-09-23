'use strict';
/**
 * OpenVibe.Events → Live: Media's outcomes (roadmap Wave 3 exit, audit item 7).
 *
 *   POST /internal/media-events   the endpoint of Live's OpenVibe.Events subscriptions to
 *                                 media.vod.*, media.clip.* and media.storage.*
 *                                 (scripts/subscribe-media-events.js), signed with
 *                                 MEDIA_EVENTS_SECRET, signature v2 only.
 *
 * The same completions Media also sends to /internal/media-webhook; ./outcomes.js applies each one
 * once whichever copy arrives first (inbox receipt keyed by Media object + event id) and
 * MEDIA_EVENTS_AUTHORITY decides whether this path acts (`both` or `events`) or only
 * acknowledges (`webhook`, the default until the subscription is proven).
 *
 * Only Live's own tenant counts: Events carries every Media tenant's VODs and clips, and a
 * vod/clip event whose payload.app_id is not MEDIA_APP_ID is acknowledged and ignored. Storage
 * events are service-wide (app_id null) and apply.
 */
const outcomes = require('./outcomes');

/** Express handler (needs req.rawBody from the express.json verify hook). */
function handler(req, res) {
    const secret = process.env.MEDIA_EVENTS_SECRET || '';
    if (!secret) return res.status(503).json({ error: 'MEDIA_EVENTS_SECRET is not set' });
    const { parseDelivery } = require('openvibe-sdk/events');
    // v2 only: HMAC over "<t>.<raw body>", t within ±300 s; a v1-only or stale delivery is refused.
    const delivery = parseDelivery(req.rawBody, req.headers, secret, { requireV2: true });
    if (!delivery) return res.status(401).json({ error: 'bad signature' });
    const ev = delivery.event;
    // Signed but unusable: acknowledge so it is not redelivered forever.
    if (!ev || !outcomes.EVENT_ID_RE.test(String(ev.event_id || ''))) return res.status(204).end();

    const name = ev.source === 'media' ? outcomes.WEBHOOK_NAMES[ev.event_type] : null;
    if (!name) return res.status(204).end();
    const data = ev.payload || {};
    if (!name.startsWith('storage.') && String(data.app_id || '') !== outcomes.MEDIA_APP_ID) return res.status(204).end();
    if (!outcomes.accepts('events')) {
        outcomes.stats.dropped.events++;
        return res.status(204).end();
    }
    const subject = ev.subject && ev.subject.type && ev.subject.id != null
        ? { type: String(ev.subject.type), id: String(ev.subject.id) }
        : outcomes.subjectOf(name, data);
    try {
        outcomes.handle({ via: 'events', event: name, data, eventId: ev.event_id, subject });
    } catch (err) {
        console.error('[MediaEvents] apply failed:', err.message);
        return res.status(500).json({ error: 'apply failed' }); // Events retries
    }
    return res.status(204).end();
}

module.exports = { handler };
