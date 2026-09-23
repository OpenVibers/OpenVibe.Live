'use strict';
// GET /internal/followers?stream_id=<id>&limit=<n>[&after=<cursor>] — the followers of the channel that
// streams <id>, for OpenVibe.Network's live.stream.started consumer (go-live notifications are
// Network's job). Service token only (aud openvibe.live, cap live.follower.read), loopback only.
// A follower is named by their Network subject when Live knows it, else their Network user id.
const express = require('express');
const db = require('../db/database');
const { guard } = require('../net/service-guard');
const { http } = require('openvibe-contracts');

const router = express.Router();
router.get('/', guard('live.follower.read'), (req, res) => {
    const streamId = Number(req.query.stream_id);
    if (!Number.isSafeInteger(streamId) || streamId <= 0) return http.sendProblem(res, 400, 'live.bad_request', { detail: 'stream_id is required' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
    const after = Math.max(parseInt(req.query.after, 10) || 0, 0);
    const d = db.getDb();
    const stream = d.prepare('SELECT user_id FROM streams WHERE id = ?').get(streamId);
    if (!stream) return http.sendProblem(res, 404, 'live.unknown_stream', { detail: `no stream ${streamId}` });
    const channel = d.prepare("SELECT subject_id FROM linked_accounts WHERE service = 'network' AND user_id = ?").get(stream.user_id);
    const rows = d.prepare(`SELECT f.id, la.subject_id, la.service_user_id FROM follows f
        LEFT JOIN linked_accounts la ON la.service = 'network' AND la.user_id = f.follower_id
        WHERE f.streamer_id = ? AND f.id > ? ORDER BY f.id LIMIT ?`).all(stream.user_id, after, limit);
    const followers = rows.map(r => ({
        subject: r.subject_id || null,
        network_user_id: /^\d+$/.test(String(r.service_user_id || '')) ? Number(r.service_user_id) : null,
    }));
    res.set('Cache-Control', 'no-store').json({
        stream_id: streamId,
        channel: { subject: (channel && channel.subject_id) || null },
        followers,
        next: rows.length === limit ? rows[rows.length - 1].id : null,
    });
});

module.exports = router;
