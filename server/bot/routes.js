/**
 * Binding a channel to an OpenVibe.Bot robot (roadmap T15 R9), mounted under /api/streams.
 *
 *   PUT  /api/streams/channel/:username/bot         { robot_id: 'rob_…' | null }  — the channel owner only
 *   POST /api/streams/channel/:username/bot/ticket  { robot_id }  — any signed-in viewer: a Drive ticket for the
 *        channel's robot, asked by its panel framed on the page (public/js/bot-embed.js listen), so a viewer signed in
 *        here drives with no popup or second sign-in on openvibe.bot. Bot decides who may (a member, or anyone on a
 *        robot that takes turns): a refusal answers 403 with its words.
 *
 * With LIVE_BOT_EMBED off the routes answer 404 as if they did not exist. Binding does not call Bot: the
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

// What Bot's refusal means, said to the viewer in the panel (Bot's codes, OpenVibe.Bot docs/protocol.md §3).
const TICKET_REFUSALS = {
    'bot.not_an_operator': 'The robot\'s owner decides who may drive it.',
    'bot.robot_not_found': 'This channel\'s robot no longer exists.',
};

router.post('/channel/:username/bot/ticket', (req, res, next) => (embed.enabled() ? next() : notFound(res)), requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const channel = await db.getChannelByUsername(req.params.username);
        const robotId = channel && embed.validRobotId(channel.bot_robot_id) ? channel.bot_robot_id : null;
        // Only the robot this channel shows: the page cannot ask Live for tickets to other robots.
        if (!robotId || (req.body && req.body.robot_id !== robotId)) return res.status(404).json({ error: 'This channel shows no such robot' });
        const subject = await require('../auth/identity-sync').subjectOf(req.user.id);
        if (!subject) return res.status(409).json({ error: 'Sign in again on OpenVibe.Live to drive the robot.' });
        const bot = require('./bot-client');
        try {
            const t = await bot.controlTicket(robotId, subject);
            return res.json({ ticket: t.ticket, robot_id: robotId, role: t.role || null, expires_in: t.expires_in || null });
        } catch (err) {
            if (err instanceof bot.BotRefusal) {
                return res.status(403).json({ error: TICKET_REFUSALS[err.code] || 'You cannot drive this robot from here.', code: err.code });
            }
            return res.status(503).json({ error: 'The robot service did not answer. Try again in a moment.' });
        }
    } catch (err) {
        console.error('[BotEmbed] Ticket error:', err.message);
        res.status(500).json({ error: 'Could not ask for the controls' });
    }
});

module.exports = router;
