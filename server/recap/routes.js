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

// An after-show report follows its stream's Rundown audience (RUNDOWN-CONTROLS design 2026-11-06): the stricter of the
// episode's own setting and its recording's. Everyone and Anyone with the link read it; Specific people and Only me are
// for those people and the streamer; a list never shows a report its reader may not open.
const visibility = require('../rundown/visibility');
const sharing = require('../rundown/sharing');
async function readerOf(req) {
    if (!req.user || !req.user.id) return { userId: null, subject: null };
    let subject = null;
    try { subject = await require('../auth/identity-sync').subjectOf(req.user.id); } catch { subject = null; }
    return { userId: Number(req.user.id), subject };
}
async function mayRead(streamId, ownerUserId, reader) {
    const eff = await visibility.effective(streamId);
    return { ok: sharing.maySee(eff, { ownerUserId, viewer: reader }), eff };
}

router.get('/channel/:username', optionalAuth, async (req, res) => {
    const user = await db.get('SELECT * FROM users WHERE lower(username) = lower(?)', [String(req.params.username || '')]);
    if (!user) return res.status(404).json({ error: 'Channel not found' });
    const reader = await readerOf(req);
    const all = await recap.listRecaps(user.id, Math.min(12, parseInt(req.query.limit || '6', 10) || 6));
    // A list shows Everyone reports only, plus the streamer's own.
    const shown = [];
    for (const r of all) {
        const eff = await visibility.effective(r.stream_id);
        if (eff.audience === 'public' || (reader.userId != null && reader.userId === Number(user.id))) shown.push(r);
    }
    res.set('Cache-Control', reader.userId ? 'private, no-store' : 'public, max-age=60');
    res.json({ recaps: shown });
});

router.get('/:streamId', optionalAuth, async (req, res) => {
    try {
        if (!/^\d+$/.test(String(req.params.streamId))) return res.status(404).json({ error: 'Not found' });
        const id = parseInt(req.params.streamId, 10);
        const stream = await db.getStreamById(id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.is_live) return res.status(409).json({ error: 'Still live — the report comes after the stream ends', live: true });
        const reader = await readerOf(req);
        const gate = await mayRead(id, stream.user_id, reader);
        if (!gate.ok) return res.status(404).json({ error: 'No report for this stream' });
        let r = await recap.getRecap(id);
        if (!r) {
            const dur = Number(stream.duration_seconds) || 0;
            if (dur && dur < recap.MIN_DURATION_SEC) return res.status(404).json({ error: 'Too short for a report', min_seconds: recap.MIN_DURATION_SEC });
            r = await recap.buildRecap(id);
        }
        if (!r) return res.status(404).json({ error: 'No report for this stream' });
        res.set('Cache-Control', gate.eff.audience === 'public' ? 'public, max-age=120' : 'private, no-store');
        const more = [];
        for (const x of (await recap.listRecaps(r.streamer.id, 6)).filter((y) => y.stream_id !== id)) {
            if ((await visibility.effective(x.stream_id)).audience === 'public') more.push(x);
        }
        res.json({ recap: r, more });
    } catch (err) {
        console.error('[Recap] route:', err.message);
        res.status(500).json({ error: 'Failed to build the report' });
    }
});

router.post('/:streamId/regenerate', requireAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.streamId, 10);
        const stream = await db.getStreamById(id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && !can(req.user, 'staff.streams.manage')) return res.status(403).json({ error: 'Not your stream' });
        const r = await recap.buildRecap(id);
        if (!r) return res.status(409).json({ error: 'Stream is live or has no data yet' });
        res.json({ recap: r });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
