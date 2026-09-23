'use strict';
/**
 * GET|POST /internal/lineage/resolve: the canonical channel/owner resolver (./resolver.js) for other
 * services (Pulse, OpenRe, Media, creator UI). Service token only (aud openvibe.live, capability
 * live.lineage.resolve), loopback only.
 *
 *   GET  ?slug=&parent_slug=&channel_id=&stream_id=&slot_id=&vod_id=&clip_id=&media_object_id=
 *        &owner_subject=&live_user_id=&network_user_id=&display_name=
 *   POST lineage.resolve-request@1 (JSON)
 *
 * Every well-formed request is answered 200 with a lineage.resolution@1, resolved or unresolved
 * (a conflict, a display name alone, Media down); a malformed one is 400 lineage.invalid_request.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { guard } = require('../net/service-guard');
const resolver = require('./resolver');

const router = express.Router();
router.use(guard('live.lineage.resolve'));

async function answer(req, res, raw, flat) {
    const { input, error } = resolver.normalizeRequest(raw, { flat });
    if (error) return http.sendProblem(res, 400, 'lineage.invalid_request', { detail: error });
    try {
        res.set('Cache-Control', 'no-store').json(await resolver.resolve(input));
    } catch (err) {
        console.warn('[Lineage] resolve failed:', err.message);
        http.sendProblem(res, 500, 'lineage.failed', { detail: 'the resolver failed' });
    }
}

router.get('/resolve', (req, res) => answer(req, res, req.query, true));
router.post('/resolve', express.json({ limit: '16kb' }), (req, res) => answer(req, res, req.body, false));

module.exports = router;
