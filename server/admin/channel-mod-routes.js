/**
 * OpenVibe.Live — Channel Moderator Routes
 *
 * Manage per-channel mod assignments.
 *
 * GET    /api/channels/moderation/mine              - Channels the user owns/moderates
 * GET    /api/channels/:channelId/mods              - List channel mods
 * POST   /api/channels/:channelId/mods              - Add channel mod (channel owner or admin)
 * DELETE /api/channels/:channelId/mods/:userId      - Remove channel mod
 * GET    /api/channels/:channelId/moderation        - Get channel moderation settings
 * PUT    /api/channels/:channelId/moderation        - Update channel moderation settings
 * GET    /api/channels/:channelId/moderation/logs   - View moderation action log
 * GET    /api/channels/:channelId/moderation/chat-search - Search channel chat
 * POST   /api/channels/:channelId/moderation/messages/:messageId/delete - Delete a chat message
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const chatServer = require('../chat/chat-server');

const router = express.Router({ mergeParams: true });

/** Parse a boolean from various input formats. */
function parseBoolean(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
    }
    return fallback;
}

/** Middleware: require channel access (owner, channel mod, or staff). */
function requireChannelAccess(req, res, next) {
    const channelId = parseInt(req.params.channelId, 10);
    if (!channelId) return res.status(400).json({ error: 'Invalid channel ID' });
    const channel = db.getChannelById(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!permissions.canModerateChannel(req.user, channelId)) {
        return res.status(403).json({ error: 'Channel moderation access required' });
    }
    req.channel = channel;
    next();
}

// ── My moderation access ─────────────────────────────────────
router.get('/moderation/mine', requireAuth, (req, res) => {
    try {
        const owned = db.getChannelByUserId(req.user.id);
        const moderated = db.getChannelsByModerator(req.user.id) || [];

        // Combine owned + moderated, dedup
        const channelMap = new Map();
        if (owned) channelMap.set(owned.id, owned);
        for (const ch of moderated) {
            if (!channelMap.has(ch.id)) channelMap.set(ch.id, ch);
        }

        const channels = [...channelMap.values()].map(channel => ({
            ...channel,
            moderation_settings: db.getChannelModerationSettings(channel.id),
            moderators: db.getChannelModerators(channel.id),
        }));

        res.json({ channels });
    } catch (err) {
        console.error('[ChannelMod] Failed to load moderation access:', err.message);
        res.status(500).json({ error: 'Failed to load channel moderation access' });
    }
});

// ── List channel mods ────────────────────────────────────────
router.get('/:channelId/mods', requireAuth, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const mods = db.getChannelModerators(channelId);
        res.json({ moderators: mods, channel_id: channelId });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list channel moderators' });
    }
});

// ── Add channel mod ──────────────────────────────────────────
router.post('/:channelId/mods', requireAuth, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        if (!permissions.canAssignChannelMods(req.user, channelId)) {
            return res.status(403).json({ error: 'Only the channel owner or an admin can add moderators' });
        }

        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Username is required' });

        const targetUser = db.getUserByUsername(username);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        if (targetUser.id === channel.user_id) {
            return res.status(400).json({ error: 'Channel owner is already a moderator' });
        }

        db.addChannelModerator(channelId, targetUser.id, req.user.id);

        db.logModerationAction({
            scope_type: 'channel',
            scope_id: channelId,
            actor_user_id: req.user.id,
            target_user_id: targetUser.id,
            action_type: 'channel_mod_add',
            details: { channel_id: channelId, username: targetUser.username },
        });

        res.json({ message: `${targetUser.username} added as channel moderator`, moderators: db.getChannelModerators(channelId) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add channel moderator' });
    }
});

// ── Remove channel mod ───────────────────────────────────────
router.delete('/:channelId/mods/:userId', requireAuth, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const userId = parseInt(req.params.userId);
        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        if (!permissions.canAssignChannelMods(req.user, channelId)) {
            return res.status(403).json({ error: 'Only the channel owner or an admin can remove moderators' });
        }

        const target = db.getUserById(userId);
        db.removeChannelModerator(channelId, userId);

        db.logModerationAction({
            scope_type: 'channel',
            scope_id: channelId,
            actor_user_id: req.user.id,
            target_user_id: userId,
            action_type: 'channel_mod_remove',
            details: { channel_id: channelId, username: target?.username || String(userId) },
        });

        res.json({ message: 'Channel moderator removed', moderators: db.getChannelModerators(channelId) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove channel moderator' });
    }
});

// ── Get channel moderation settings ──────────────────────────
router.get('/:channelId/moderation', requireAuth, requireChannelAccess, (req, res) => {
    try {
        const settings = db.getChannelModerationSettings(req.channel.id);
        res.json({ settings });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get moderation settings' });
    }
});

// ── Update channel moderation settings ───────────────────────
router.put('/:channelId/moderation', requireAuth, requireChannelAccess, (req, res) => {
    try {
        const settings = db.upsertChannelModerationSettings(req.channel.id, {
            slow_mode_seconds: req.body.slow_mode_seconds !== undefined
                ? Math.max(0, parseInt(req.body.slow_mode_seconds) || 0) : undefined,
            slowmode_seconds: req.body.slowmode_seconds !== undefined
                ? Math.max(0, parseInt(req.body.slowmode_seconds) || 0) : undefined,
            followers_only: req.body.followers_only !== undefined
                ? parseBoolean(req.body.followers_only, false) : undefined,
            emote_only: req.body.emote_only,
            allow_anonymous: req.body.allow_anonymous !== undefined
                ? parseBoolean(req.body.allow_anonymous, true) : undefined,
            links_allowed: req.body.links_allowed !== undefined
                ? parseBoolean(req.body.links_allowed, true) : undefined,
            gifs_enabled: req.body.gifs_enabled !== undefined
                ? parseBoolean(req.body.gifs_enabled, true) : undefined,
            aggressive_filter: req.body.aggressive_filter !== undefined
                ? parseBoolean(req.body.aggressive_filter, false) : undefined,
            account_age_gate_hours: req.body.account_age_gate_hours !== undefined
                ? Math.max(0, parseInt(req.body.account_age_gate_hours) || 0) : undefined,
            caps_percentage_limit: req.body.caps_percentage_limit !== undefined
                ? Math.min(100, Math.max(0, parseInt(req.body.caps_percentage_limit) || 70)) : undefined,
            // Streamers can raise their chat cap up to 4000 chars; admins up to 6000. TTS is
            // capped at 1200 for everyone (a very long TTS line is a griefing/queue-clog vector).
            max_message_length: req.body.max_message_length !== undefined
                ? Math.min(permissions.isAdmin(req.user) ? 6000 : 4000, Math.max(1, parseInt(req.body.max_message_length) || 500)) : undefined,
            tts_max_length: req.body.tts_max_length !== undefined
                ? Math.min(1200, Math.max(10, parseInt(req.body.tts_max_length) || 200)) : undefined,
            slur_filter_enabled: req.body.slur_filter_enabled !== undefined
                ? parseBoolean(req.body.slur_filter_enabled, false) : undefined,
            slur_filter_use_builtin: req.body.slur_filter_use_builtin !== undefined
                ? parseBoolean(req.body.slur_filter_use_builtin, true) : undefined,
            slur_filter_terms: req.body.slur_filter_terms !== undefined
                ? String(req.body.slur_filter_terms || '').slice(0, 4000) : undefined,
            slur_filter_regexes: req.body.slur_filter_regexes !== undefined
                ? String(req.body.slur_filter_regexes || '').slice(0, 8000) : undefined,
            slur_filter_nudge_message: req.body.slur_filter_nudge_message !== undefined
                ? String(req.body.slur_filter_nudge_message || '').slice(0, 800) : undefined,
            slur_filter_disabled_categories: req.body.slur_filter_disabled_categories !== undefined
                ? (() => {
                    const VALID_CATS = new Set(['n_word', 'antisemitic', 'homophobic', 'racial']);
                    let val = req.body.slur_filter_disabled_categories;
                    if (typeof val === 'string') {
                        try { val = JSON.parse(val); } catch { val = []; }
                    }
                    if (!Array.isArray(val)) return '[]';
                    return JSON.stringify(val.filter((k) => typeof k === 'string' && VALID_CATS.has(k)));
                })() : undefined,
            ip_approval_mode: req.body.ip_approval_mode !== undefined
                ? parseBoolean(req.body.ip_approval_mode, false) : undefined,
            soundboard_enabled: req.body.soundboard_enabled !== undefined
                ? parseBoolean(req.body.soundboard_enabled, true) : undefined,
            soundboard_allow_pitch: req.body.soundboard_allow_pitch !== undefined
                ? parseBoolean(req.body.soundboard_allow_pitch, true) : undefined,
            soundboard_allow_speed: req.body.soundboard_allow_speed !== undefined
                ? parseBoolean(req.body.soundboard_allow_speed, true) : undefined,
            soundboard_banned_ids: req.body.soundboard_banned_ids !== undefined
                ? (() => {
                    const raw = String(req.body.soundboard_banned_ids || '');
                    const ids = raw.split(/[\s,\n\r]+/)
                        .map((s) => {
                            const m = s.trim().match(/101soundboards\.com\/sounds\/(\d+)/i);
                            if (m) return m[1];
                            if (/^\d{2,}$/.test(s.trim())) return s.trim();
                            return null;
                        })
                        .filter(Boolean);
                    return [...new Set(ids)].slice(0, 200).join(',');
                })() : undefined,
            viewer_auto_delete_enabled: req.body.viewer_auto_delete_enabled !== undefined
                ? parseBoolean(req.body.viewer_auto_delete_enabled, true) : undefined,
            viewer_delete_all_enabled: req.body.viewer_delete_all_enabled !== undefined
                ? parseBoolean(req.body.viewer_delete_all_enabled, true) : undefined,
            custom_emotes_enabled: req.body.custom_emotes_enabled !== undefined
                ? parseBoolean(req.body.custom_emotes_enabled, true) : undefined,
            custom_sounds_enabled: req.body.custom_sounds_enabled !== undefined
                ? parseBoolean(req.body.custom_sounds_enabled, true) : undefined,
            uploads_mods_only: req.body.uploads_mods_only !== undefined
                ? parseBoolean(req.body.uploads_mods_only, false) : undefined,
            mods_can_edit_about: req.body.mods_can_edit_about !== undefined
                ? parseBoolean(req.body.mods_can_edit_about, false) : undefined,
            max_sound_seconds: req.body.max_sound_seconds !== undefined
                ? Math.min(30, Math.max(1, parseInt(req.body.max_sound_seconds) || 10)) : undefined,
            emote_scale: req.body.emote_scale !== undefined
                ? Math.min(300, Math.max(50, parseInt(req.body.emote_scale) || 100)) : undefined,
            emote_size_min: req.body.emote_size_min !== undefined
                ? Math.min(200, Math.max(25, parseInt(req.body.emote_size_min) || 50)) : undefined,
            emote_size_max: req.body.emote_size_max !== undefined
                ? Math.min(400, Math.max(50, parseInt(req.body.emote_size_max) || 200)) : undefined,
            sounds_mods_only: req.body.sounds_mods_only !== undefined ? (req.body.sounds_mods_only ? 1 : 0) : undefined,
            sound_min_speed: req.body.sound_min_speed !== undefined
                ? Math.min(1, Math.max(0.1, parseFloat(req.body.sound_min_speed) || 0.5)) : undefined,
            sound_max_speed: req.body.sound_max_speed !== undefined
                ? Math.min(5, Math.max(1, parseFloat(req.body.sound_max_speed) || 3.0)) : undefined,
            sound_min_pitch_cents: req.body.sound_min_pitch_cents !== undefined
                ? Math.min(0, Math.max(-2400, parseInt(req.body.sound_min_pitch_cents) || -1200)) : undefined,
            sound_max_pitch_cents: req.body.sound_max_pitch_cents !== undefined
                ? Math.max(0, Math.min(2400, parseInt(req.body.sound_max_pitch_cents) || 1200)) : undefined,
        });

        db.logModerationAction({
            scope_type: 'channel',
            scope_id: req.channel.id,
            actor_user_id: req.user.id,
            action_type: 'channel_settings_update',
            details: settings,
        });

        res.json({ settings });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update moderation settings' });
    }
});

// ── View moderation action log ───────────────────────────────
router.get('/:channelId/moderation/logs', requireAuth, requireChannelAccess, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        res.json({
            actions: db.getModerationActions({
                scopeType: 'channel',
                scopeId: req.channel.id,
                limit,
                offset,
            }),
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load channel moderation log' });
    }
});

// ── Search channel chat messages ─────────────────────────────
router.get('/:channelId/moderation/chat-search', requireAuth, requireChannelAccess, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const q = (req.query.q || '').trim();
        const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
        const result = db.searchChannelChatMessages(req.channel.id, { query: q, userId, limit, offset });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to search channel chat' });
    }
});

// ── Delete a channel chat message ────────────────────────────
router.post('/:channelId/moderation/messages/:messageId/delete', requireAuth, requireChannelAccess, (req, res) => {
    try {
        const messageId = parseInt(req.params.messageId, 10);
        const message = db.getChatMessageById(messageId);
        if (!message) return res.status(404).json({ error: 'Message not found' });

        // Verify message belongs to this channel's streams
        if (message.stream_id) {
            const stream = db.getStreamById(message.stream_id);
            if (stream && stream.channel_id !== req.channel.id && !permissions.isGlobalModOrAbove(req.user)) {
                return res.status(403).json({ error: 'Message is outside this channel scope' });
            }
        }

        db.deleteChatMessage(messageId, req.user.id);

        // Broadcast deletion to connected clients
        if (message.stream_id) {
            chatServer.broadcastToStream(message.stream_id, { type: 'delete-messages', ids: [messageId] });
            chatServer.forwardToGlobal(message.stream_id, { type: 'delete-messages', ids: [messageId] });
        } else {
            chatServer.broadcastGlobal({ type: 'delete-messages', ids: [messageId] });
        }

        db.logModerationAction({
            scope_type: 'channel',
            scope_id: req.channel.id,
            actor_user_id: req.user.id,
            target_user_id: message.user_id,
            action_type: 'channel_message_delete',
            details: { message_id: messageId, stream_id: message.stream_id },
        });

        res.json({ message: 'Message deleted', ids: [messageId] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

module.exports = router;
