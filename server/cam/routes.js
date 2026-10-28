'use strict';
/**
 * OpenVibe.Live — the cam button API.
 *
 *   POST /api/cam/stills       { slot, stream_id, caption? }   take a still (Cam → Pics as the viewer)
 *   POST /api/cam/post-share   { stream_id, text }             post Cam's returned share.text to chat
 *
 * A signed-in viewer takes a still of a live stream. Live's server sends the viewer's own
 * Network token to OpenVibe.Cam, returns the still (link and picture), and — when the viewer
 * chooses — posts Cam's returned share.text into the stream's chat through Live's chat authority.
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth, extractToken } = require('../auth/auth');
const cam = require('./cam-client');
const delivery = require('../chat/chat-delivery');

const router = express.Router();

// Cam's own slot rule (server/store.js SLOT_RE): a slot id, slug or @username.
const SLOT_RE = /^@?[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const SHARE_TEXT_MAX = 500;

async function liveStream(req, res) {
    const streamId = req.body && Number(req.body.stream_id);
    if (!Number.isInteger(streamId) || streamId <= 0) {
        res.status(400).json({ error: 'stream_id must be a positive whole number' });
        return null;
    }
    const stream = await db.getStreamById(streamId);
    if (!stream) {
        res.status(404).json({ error: 'Stream not found' });
        return null;
    }
    if (!stream.is_live) {
        res.status(409).json({ error: 'That stream is offline' });
        return null;
    }
    return stream;
}

router.post('/stills', requireAuth, async (req, res) => {
    try {
        if (req.authSource === 'api_token') {
            return res.status(403).json({ error: 'The cam button needs your signed-in Network account, not an API token' });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const slot = String(body.slot == null ? '' : body.slot).trim();
        const caption = body.caption == null ? '' : String(body.caption).trim();

        if (!SLOT_RE.test(slot)) return res.status(400).json({ error: 'A slot id, slug or @username is required' });

        const stream = await liveStream(req, res);
        if (!stream) return;

        const token = extractToken(req);
        if (!token || String(token).startsWith('hbt_')) {
            return res.status(401).json({ error: 'A Network sign-in is required' });
        }

        let result;
        try {
            result = await cam.createStill({ token, slot, streamId: stream.id, caption });
        } catch (err) {
            const status = err && err.status ? err.status : 502;
            const message = (err && err.message) || 'OpenVibe.Cam could not take a still';
            return res.status(status).json({ error: message, ...(err && err.code ? { code: err.code } : {}) });
        }

        return res.json(result);
    } catch (err) {
        console.error('[Cam] still error:', err.message);
        res.status(500).json({ error: 'Failed to take a still' });
    }
});

router.post('/post-share', requireAuth, async (req, res) => {
    try {
        if (req.authSource === 'api_token') {
            return res.status(403).json({ error: 'The cam button needs your signed-in Network account, not an API token' });
        }
        const text = String((req.body && req.body.text) || '').trim().slice(0, SHARE_TEXT_MAX);
        if (!text) return res.status(400).json({ error: 'A share line is required' });

        const stream = await liveStream(req, res);
        if (!stream) return;

        const chatId = await delivery.message({
            stream_id: stream.id,
            channel_user_id: stream.user_id,
            user_id: req.user.id,
            username: req.user.username,
            message: text,
            message_type: 'chat',
            is_global: false,
            source_platform: 'cam',
            frame: { role: 'user' },
        });

        return res.json({ posted: !!chatId });
    } catch (err) {
        console.error('[Cam] post-share error:', err.message);
        res.status(500).json({ error: 'Failed to post the still to chat' });
    }
});

module.exports = router;
