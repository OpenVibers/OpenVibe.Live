'use strict';

/**
 * POST /api/views/:kind/:id — a view of a recording or clip played on another OpenVibe site.
 *
 * openvibe.video plays Live's recordings and clips but reads Live's API over loopback, so Live's own
 * view count (one content_views row per address, written by the detail read) saw one address for all
 * of its viewers. Its watch page now calls this with navigator.sendBeacon when playback starts, from
 * the viewer's own browser, so the address counted is the viewer's.
 *
 * It is mounted before the credentialed CORS allowlist and is not part of it: it reads no cookie,
 * answers only the origins in VIEW_ORIGINS, changes nothing but content_views, and answers 204
 * whether or not a row was added, so it tells a caller nothing about the item. A missing, private or
 * unfinished item is not counted.
 */
const express = require('express');
const db = require('../db/database');
const media = require('../media-client');
const access = require('./access');

const VIEW_ORIGINS = new Set(['https://openvibe.video']);
const VISIBLE_TTL_MS = 60_000;
const VISIBLE_MAX = 2000;
const visible = new Map();   // 'vod:12' → { at, ok }

function requesterIp(req) {
    return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

/** Whether a signed-out viewer may see it: Live's own rule (./access), remembered for a minute. */
async function isVisible(kind, id) {
    const key = `${kind}:${id}`;
    const hit = visible.get(key);
    if (hit && Date.now() - hit.at < VISIBLE_TTL_MS) return hit.ok;
    let ok = false;
    try {
        const item = kind === 'vod' ? await media.getVod(id) : await media.getClip(id);
        ok = !!item && !item.is_recording && await access.canView(null, item);
    } catch (err) {
        if (!(err && err.name === 'MediaApiError' && err.status === 404)) return false;   // Media down: count nothing, remember nothing
    }
    visible.delete(key);
    visible.set(key, { at: Date.now(), ok });
    if (visible.size > VISIBLE_MAX) visible.delete(visible.keys().next().value);
    return ok;
}

function createViewBeacon({ rateLimit }) {
    const router = express.Router();
    const limiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        standardHeaders: false,
        legacyHeaders: false,
        handler: (req, res) => res.status(204).end(),
    });

    router.use((req, res, next) => {
        const origin = req.get('origin');
        if (!origin || !VIEW_ORIGINS.has(origin)) return res.status(403).json({ error: 'Origin not allowed' });
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        res.set('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') {
            res.set('Access-Control-Allow-Methods', 'POST');
            res.set('Access-Control-Max-Age', '600');
            return res.status(204).end();
        }
        return next();
    });

    router.post('/:kind/:id', limiter, async (req, res) => {
        const { kind, id } = req.params;
        if ((kind !== 'vod' && kind !== 'clip') || !/^[1-9]\d{0,15}$/.test(id)) return res.status(204).end();
        try {
            if (await isVisible(kind, id)) {
                await db.run('INSERT INTO content_views (content_type, content_id, ip) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [kind, Number(id), requesterIp(req)]);
            }
        } catch { /* a view that is not counted is not an error */ }
        res.status(204).end();
    });

    return router;
}

module.exports = { createViewBeacon, VIEW_ORIGINS, _internals: { visible } };
