/**
 * /api/recap — the after-show report (server/recap/recap.js).
 *   GET  /:streamId              the recap (built on first view if the stream is over and long enough)
 *   GET  /channel/:username      latest recaps for a channel
 *   POST /:streamId/regenerate   owner / admin: rebuild it (fresh AI write-up)
 */
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { can } = require('../auth/permissions');
const recap = require('./recap');
const { requireAuth, optionalAuth } = require('../auth/auth');

router.get('/channel/:username', (req, res) => {
    const user = db.getUserByUsername(String(req.params.username || ''));
    if (!user) return res.status(404).json({ error: 'Channel not found' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ recaps: recap.listRecaps(user.id, Math.min(12, parseInt(req.query.limit || '6', 10) || 6)) });
});

router.get('/:streamId', optionalAuth, async (req, res) => {
    try {
        if (!/^\d+$/.test(String(req.params.streamId))) return res.status(404).json({ error: 'Not found' });
        const id = parseInt(req.params.streamId, 10);
        const stream = db.getStreamById(id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.is_live) return res.status(409).json({ error: 'Still live — the report comes after the stream ends', live: true });
        let r = recap.getRecap(id);
        if (!r) {
            const dur = Number(stream.duration_seconds) || 0;
            if (dur && dur < recap.MIN_DURATION_SEC) return res.status(404).json({ error: 'Too short for a report', min_seconds: recap.MIN_DURATION_SEC });
            r = await recap.buildRecap(id);
        }
        if (!r) return res.status(404).json({ error: 'No report for this stream' });
        res.set('Cache-Control', 'public, max-age=120');
        res.json({ recap: r, more: recap.listRecaps(r.streamer.id, 6).filter(x => x.stream_id !== id) });
    } catch (err) {
        console.error('[Recap] route:', err.message);
        res.status(500).json({ error: 'Failed to build the report' });
    }
});

router.post('/:streamId/regenerate', requireAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.streamId, 10);
        const stream = db.getStreamById(id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && !can(req.user, 'staff.streams.manage')) return res.status(403).json({ error: 'Not your stream' });
        const r = await recap.buildRecap(id);
        if (!r) return res.status(409).json({ error: 'Stream is live or has no data yet' });
        res.json({ recap: r });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
