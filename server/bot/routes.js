/**
 * Binding a channel to an OpenVibe.Bot robot (roadmap T15 R9), mounted under /api/streams.
 *
 *   PUT /api/streams/channel/:username/bot  { robot_id: 'rob_…' | null }  — the channel owner only
 *
 * With LIVE_BOT_EMBED off the route answers 404 as if it did not exist. Binding does not call Bot: the
 * robot owner's embed_public toggle there decides what the embed shows (server/bot/embed.js).
 */
'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const embed = require('./embed');

const router = express.Router();

const notFound = (res) => res.status(404).json({ error: 'Not found' });

router.put('/channel/:username/bot', (req, res, next) => (embed.enabled() ? next() : notFound(res)), requireAuth, async (req, res) => {
    try {
        const channel = await db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        // Owner only: channel moderators and staff do not choose which robot a channel shows.
        if (Number(req.user.id) !== Number(channel.user_id)) {
            return res.status(403).json({ error: 'Only the channel owner can bind a robot' });
        }
        const raw = req.body ? req.body.robot_id : undefined;
        let robotId;
        if (raw === null || raw === '') robotId = null;
        else if (embed.validRobotId(raw)) robotId = raw;
        else return res.status(400).json({ error: 'robot_id must be a Bot robot id (rob_…) or null' });
        await db.updateChannel(channel.user_id, { bot_robot_id: robotId });
        res.json({ ok: true, bot_embed: embed.channelEmbed({ bot_robot_id: robotId }) });
    } catch (err) {
        console.error('[BotEmbed] Bind error:', err.message);
        res.status(500).json({ error: 'Failed to bind robot' });
    }
});

module.exports = router;
