'use strict';
/**
 * routes.js — the streamer's own way to line up their OBS overlay.
 *
 *   POST /api/overlay/test-alert { kind }   fire a sample of that kind into the streamer's own room
 *
 * The streamer is signed in with their own account and the sample always goes to their own channel
 * room, so nobody can make an alert appear on someone else's stream: the route takes no target and
 * refuses any other field. It is rate-limited (a few a minute per streamer) — it is a test button,
 * not a firehose.
 *
 * The samples are what a real moment looks like (server/overlay/overlay-alerts.js): the same shape,
 * the same kinds, no money moved and no goal credited.
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const overlay = require('./overlay-alerts');

const router = express.Router();

// One sample per kind: what the overlay is meant to show for that moment.
const SAMPLES = {
    follow: { who: { name: 'Test Viewer', avatar: null }, amount: null, text: null },
    tip: { who: { name: 'Test Tipper', avatar: null }, amount: { value: 500, unit: 'vibes' }, text: 'Nice stream!' },
    sub: { who: { name: 'Test Subscriber', avatar: null }, amount: null, text: null },
    raid: { who: { name: 'Test Raider', avatar: null }, amount: { value: 12, unit: 'viewers' }, text: null },
    goal: { who: null, amount: { value: 1000, unit: 'vibes' }, text: null },
};

// A few a minute, per streamer.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 10;
const _hits = new Map();

/** Whether this streamer already fired too many test alerts in the last minute. */
function tooMany(userId) {
    const now = Date.now();
    const hits = (_hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
    hits.push(now);
    _hits.set(userId, hits);
    if (_hits.size > 5000) _hits.clear();
    return hits.length > MAX_PER_WINDOW;
}

router.post('/test-alert', requireAuth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    // The target is the streamer themselves: there is nothing else to name.
    const extra = Object.keys(body).filter((k) => k !== 'kind');
    if (extra.length) return res.status(400).json({ error: 'Only "kind" is accepted' });
    const kind = String(body.kind == null ? '' : body.kind).trim();
    if (!Object.prototype.hasOwnProperty.call(SAMPLES, kind)) {
        return res.status(400).json({ error: `Unknown test kind "${kind}"`, kinds: Object.keys(SAMPLES) });
    }
    if (tooMany(req.user.id)) return res.status(429).json({ error: 'Too many test alerts — try again in a minute' });
    const sample = SAMPLES[kind];
    let frame = null;
    try {
        frame = await overlay.emit({
            streamerId: req.user.id,
            kind,
            who: sample.who,
            amount: sample.amount,
            text: sample.text,
            naturalKey: `test:${kind}:${req.user.id}:${Date.now()}`,
        });
    } catch (e) {
        console.warn('[Overlay] test alert not sent:', e.message);
    }
    if (!frame) return res.status(503).json({ error: 'The alert could not be sent right now' });
    return res.json({ ok: true, kind, id: frame.id, at: frame.at });
});

module.exports = router;
module.exports.SAMPLES = SAMPLES;
module.exports._reset = () => _hits.clear();
