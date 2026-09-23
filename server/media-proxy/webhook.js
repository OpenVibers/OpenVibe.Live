/**
 * OpenVibe.Live — OpenVibe.Media webhook receiver (the direct path, being replaced by Events)
 *
 * POST /internal/media-webhook
 * Media POSTs { event: 'vod.ready'|'vod.failed'|'clip.ready'|'clip.failed'|'storage.alert'|…,
 * app_id, data, event_id? } with header
 * `X-OVMedia-Signature: sha256=<hmac-sha256(raw body, MEDIA_WEBHOOK_SECRET)>`.
 * `event_id` is the id of the same outcome's OpenVibe.Events event (Media ≥ cbf8410).
 *
 * What Live does with an outcome lives in ./outcomes.js, shared with the Events consumer
 * (./media-events.js). MEDIA_EVENTS_AUTHORITY decides whether this path acts:
 *   webhook (default) or both  → applied (once: an outcome that already arrived through Events
 *                                is a no-op here, and the other way round)
 *   events                     → a webhook with an event_id is acknowledged and dropped; one
 *                                without (no durable twin exists) is still applied
 *
 * Removal: once MEDIA_EVENTS_AUTHORITY=events has run clean, clear Live's webhook_url in Media and
 * delete this route (docs/architecture.md, "Media outcomes over Events").
 */
'use strict';
const crypto = require('crypto');
const outcomes = require('./outcomes');

const WEBHOOK_SECRET = process.env.MEDIA_WEBHOOK_SECRET || '';

function verifySignature(req) {
    if (!WEBHOOK_SECRET) {
        console.warn('[MediaWebhook] MEDIA_WEBHOOK_SECRET not set — rejecting webhook');
        return false;
    }
    const header = String(req.headers['x-ovmedia-signature'] || '');
    const m = header.match(/^sha256=([0-9a-f]+)$/i);
    if (!m || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(m[1].toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
    } catch {
        return false;
    }
}

function handler(req, res) {
    if (!verifySignature(req)) return res.status(401).json({ error: 'Invalid signature' });
    const { event, data } = req.body || {};
    if (!event) return res.status(400).json({ error: 'Missing event' });
    const eventId = outcomes.EVENT_ID_RE.test(String(req.body.event_id || '')) ? String(req.body.event_id) : null;

    // Events is the authority and this outcome has a durable twin: that copy acts, not this one.
    if (eventId && !outcomes.accepts('webhook')) {
        outcomes.stats.dropped.webhook++;
        return res.json({ ok: true, ignored: 'events_authority' });
    }
    let result = null;
    try {
        result = outcomes.handle({ via: 'webhook', event, data, eventId });
    } catch (e) {
        console.warn('[MediaWebhook] handler error:', e.message);
    }
    res.json(result && result.duplicate ? { ok: true, duplicate: true } : { ok: true });
}

module.exports = handler;
