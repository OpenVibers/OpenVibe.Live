/**
 * OpenVibe.Live — Admin Panel API Routes
 * 
 * All routes require admin role.
 * 
 * GET    /api/admin/stats                  - Dashboard statistics
 * GET    /api/admin/users                  - List all users
 * PUT    /api/admin/users/:id              - Update user (role, ban)
 * POST   /api/admin/users/:id/ban          - Ban a user
 * DELETE /api/admin/users/:id/ban          - Unban a user
 * GET    /api/admin/streams                - All active streams
 * DELETE /api/admin/streams/:id            - Force end a stream
 * GET    /api/admin/bans                   - List all bans
 * GET    /api/admin/vpn-queue              - VPN approval queue
 * PUT    /api/admin/vpn-queue/:id          - Approve/deny VPN
 * GET    /api/admin/settings               - Get all site settings
 * PUT    /api/admin/settings               - Update site settings (bulk)
 * PUT    /api/admin/settings/:key          - Update a single setting
 * DELETE /api/admin/settings/:key          - Delete a setting
 * GET    /api/admin/moderators             - List global moderators
 * POST   /api/admin/moderators             - Promote user to mod
 * DELETE /api/admin/moderators/:id         - Demote mod to user
 * GET    /api/admin/verification-keys      - List verification keys
 * POST   /api/admin/verification-keys      - Generate a verification key
 * DELETE /api/admin/verification-keys/:id  - Revoke a verification key
 * GET    /api/admin/storage                - Disk usage & per-directory breakdown
 * GET    /api/admin/storage/vods           - Detailed VOD file listing
 * DELETE /api/admin/storage/vods/bulk      - Bulk-delete VODs by ID
 * GET    /api/admin/storage/tiers          - Storage tier status (hot/cold)
 * PUT    /api/admin/storage/tiers/settings - Update tier settings
 * POST   /api/admin/storage/tiers/sweep    - Trigger manual sweep
 * POST   /api/admin/storage/tiers/move     - Move single VOD between tiers
 * POST   /api/admin/storage/tiers/bulk-move - Bulk move VODs between tiers
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const chatServer = require('../chat/chat-server');
const permissions = require('../auth/permissions');

const router = express.Router();

// All admin routes require admin role
router.use(requireAuth, permissions.requireAdmin);

// ── Dashboard Stats ──────────────────────────────────────────
router.get('/stats', (req, res) => {
    try {
        const stats = {
            users: {
                total: db.get('SELECT COUNT(*) as c FROM users').c,
                streamers: db.get("SELECT COUNT(*) as c FROM users WHERE role IN ('streamer', 'admin')").c,
                banned: db.get('SELECT COUNT(*) as c FROM users WHERE is_banned = 1').c,
            },
            streams: {
                live: db.get('SELECT COUNT(*) as c FROM streams WHERE is_live = 1').c,
                total: db.get('SELECT COUNT(*) as c FROM streams').c,
                totalViewers: db.get('SELECT COALESCE(SUM(viewer_count), 0) as c FROM streams WHERE is_live = 1').c,
            },
            openvibeBucks: {
                totalCirculating: db.get('SELECT COALESCE(SUM(openvibe_bucks_balance), 0) as c FROM users').c,
                totalTransactions: db.get('SELECT COUNT(*) as c FROM transactions').c,
                pendingCashouts: db.get("SELECT COUNT(*) as c FROM transactions WHERE type = 'cashout' AND status = 'escrow'").c,
                totalDonated: db.get("SELECT COALESCE(SUM(amount), 0) as c FROM transactions WHERE type = 'donation'").c,
            },
            vods: {
                total: db.get('SELECT COUNT(*) as c FROM vods').c,
                public: db.get('SELECT COUNT(*) as c FROM vods WHERE is_public = 1').c,
            },
            chat: {
                totalMessages: db.get('SELECT COUNT(*) as c FROM chat_messages').c,
            },
        };

        // Recent activity
        stats.recentUsers = db.all(
            'SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at DESC LIMIT 10'
        );

        stats.recentStreams = db.all(`
            SELECT s.id, s.title, s.protocol, s.viewer_count, s.started_at, u.username
            FROM streams s JOIN users u ON s.user_id = u.id
            WHERE s.is_live = 1
            ORDER BY s.viewer_count DESC LIMIT 20
        `);

        res.json(stats);
    } catch (err) {
        console.error('[Admin] Stats error:', err.message);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// ── List Users ───────────────────────────────────────────────
router.get('/users', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');
        const search = req.query.search || '';

        let sql = `SELECT u.id, u.username, u.display_name, u.email, u.role, u.openvibe_bucks_balance,
                    u.is_banned, u.ban_reason, u.created_at, u.last_seen,
                    COALESCE(c.force_vod_recording_disabled, 0) AS force_vod_recording_disabled
                    FROM users u
                    LEFT JOIN channels c ON c.user_id = u.id`;
        const params = [];

        if (search) {
            sql += ' WHERE u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        const countSql = search
            ? `SELECT COUNT(*) as c FROM users WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?`
            : `SELECT COUNT(*) as c FROM users`;
        const countParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

        sql += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const users = db.all(sql, params);
        const total = db.get(countSql, countParams).c;

        res.json({ users, total });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list users' });
    }
});

// ── Update User ──────────────────────────────────────────────
router.put('/users/:id', (req, res) => {
    try {
        let { role, display_name, username, max_managed_streams } = req.body;
        const updates = [];
        const params = [];

        if (role) {
            const validRoles = ['user', 'streamer', 'global_mod', 'admin'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
            }
            updates.push('role = ?'); params.push(role);
        }
        if (max_managed_streams !== undefined) {
            const parsed = parseInt(max_managed_streams);
            if (isNaN(parsed) || parsed < 1 || parsed > 50) {
                return res.status(400).json({ error: 'max_managed_streams must be 1-50' });
            }
            updates.push('max_managed_streams = ?'); params.push(parsed);
        }
        if (username) {
            // Validate username format (same rules as registration)
            username = String(username).trim();
            if (username.length < 3 || username.length > 24) {
                return res.status(400).json({ error: 'Username must be 3-24 characters' });
            }
            if (!/^[a-zA-Z0-9_]+$/.test(username)) {
                return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
            }
            if (/^anon\d*$/i.test(username)) {
                return res.status(400).json({ error: 'That username is reserved for anonymous users' });
            }
            // Check uniqueness (case-insensitive)
            const existing = db.getUserByUsername(username);
            if (existing && String(existing.id) !== String(req.params.id)) {
                return res.status(409).json({ error: 'Username already taken' });
            }
            updates.push('username = ?'); params.push(username);
        }
        if (display_name) {
            // Sanitize display name — strip HTML + dangerous chars
            display_name = display_name.replace(/<[^>]*>/g, '').replace(/[\\`'"<>(){};:/\[\]]/g, '').replace(/\s+/g, ' ').trim();
            if (display_name.length < 1 || display_name.length > 60) {
                return res.status(400).json({ error: 'Display name must be 1-60 characters' });
            }
            updates.push('display_name = ?'); params.push(display_name);
        }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        // If display_name or username changed, update denormalized chat_messages.username
        // (chat_messages.username stores display_name at message creation time)
        if (display_name || username) {
            const freshUser = db.getUserById(req.params.id);
            if (freshUser) {
                const newChatName = freshUser.display_name || freshUser.username;
                db.run('UPDATE chat_messages SET username = ? WHERE user_id = ?', [newChatName, req.params.id]);
            }
        }

        const user = db.getUserById(req.params.id);
        // Sanitize — never expose password_hash or stream_key
        const { password_hash, stream_key, ...safeUser } = user;

        // Push real-time update to the affected user's chat connections
        if (updates.length > 0) {
            chatServer.sendUserUpdate(parseInt(req.params.id), safeUser);
        }

        res.json({ user: safeUser });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// ── Ban User ─────────────────────────────────────────────────
router.post('/users/:id/ban', (req, res) => {
    try {
        const { reason, duration_hours } = req.body;
        const expires = duration_hours
            ? new Date(Date.now() + duration_hours * 3600000).toISOString()
            : null;

        db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
            [reason || 'Banned by admin', req.params.id]);

        db.run(
            `INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
            [req.params.id, reason || 'Banned by admin', req.user.id, expires]
        );

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: Number(req.params.id),
            action_type: 'site_ban',
            details: { reason: reason || 'Banned by admin', duration_hours: duration_hours || null },
        });

        res.json({ message: 'User banned' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// ── Unban User ───────────────────────────────────────────────
router.delete('/users/:id/ban', (req, res) => {
    try {
        db.run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [req.params.id]);
        db.run('DELETE FROM bans WHERE user_id = ?', [req.params.id]);

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: Number(req.params.id),
            action_type: 'site_unban',
        });

        res.json({ message: 'User unbanned' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

// ── List All Active Streams ──────────────────────────────────
router.get('/streams', (req, res) => {
    try {
        const streams = db.all(`
            SELECT s.*, u.username, u.display_name,
                   c.id AS channel_id,
                   COALESCE(c.force_vod_recording_disabled, 0) AS force_vod_recording_disabled,
                   COALESCE(c.vod_recording_enabled, 1) AS vod_recording_enabled
            FROM streams s JOIN users u ON s.user_id = u.id
            LEFT JOIN channels c ON c.user_id = s.user_id
            WHERE s.is_live = 1
            ORDER BY s.viewer_count DESC
        `);
        res.json({ streams });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list streams' });
    }
});

// ── Force End Stream ─────────────────────────────────────────
router.delete('/streams/:id', (req, res) => {
    try {
        const stream = db.getStreamById(parseInt(req.params.id, 10));
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        // Protect the owner's stream: a regular admin/global-mod cannot force-end
        // the network owner's broadcast — only the owner (or the streamer themself)
        // may. Prevents a rogue admin from repeatedly knocking the owner offline.
        const target = db.getUserById(stream.user_id);
        if (target && target.is_owner && !permissions.isOwner(req.user) && req.user.id !== stream.user_id) {
            return res.status(403).json({ error: "You cannot end the owner's stream" });
        }

        db.endStream(req.params.id);

        // Accountability: force-ending someone's live stream is a moderation action
        // and MUST be logged (previously it left no trace at all).
        try {
            db.logModerationAction({
                scope_type: 'stream',
                scope_id: stream.id,
                actor_user_id: req.user.id,
                target_user_id: stream.user_id,
                action_type: 'stream_force_end',
                details: { title: stream.title || null },
            });
        } catch (e) { console.warn('[Admin] force-end log failed:', e.message); }

        console.log(`[Admin] Stream ${stream.id} force-ended by ${req.user.username} (${req.user.id}); owner=${target?.username}`);
        res.json({ message: 'Stream force-ended' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to end stream' });
    }
});

// ── Force NSFW on a Channel ──────────────────────────────────
router.put('/channels/:id/force-nsfw', (req, res) => {
    try {
        const { force } = req.body; // true or false
        const forceVal = force ? 1 : 0;
        db.run('UPDATE channels SET force_nsfw = ?, is_nsfw = CASE WHEN ? = 1 THEN 1 ELSE is_nsfw END, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [forceVal, forceVal, req.params.id]);
        // Also update any currently live streams for this channel
        if (forceVal) {
            db.run('UPDATE streams SET is_nsfw = 1 WHERE channel_id = ? AND is_live = 1', [req.params.id]);
        }
        res.json({ message: force ? 'Channel force-marked as NSFW' : 'Force-NSFW removed from channel' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update NSFW status' });
    }
});

// ── Force Disable VOD Recording on a User Channel ───────────
router.put('/users/:id/force-vod-recording', (req, res) => {
    try {
        const targetUserId = parseInt(req.params.id, 10);
        if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
            return res.status(400).json({ error: 'Invalid user id' });
        }

        const user = db.getUserById(targetUserId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const channel = db.ensureChannel(targetUserId);
        const forceVal = req.body?.force ? 1 : 0;
        db.run(
            'UPDATE channels SET force_vod_recording_disabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [forceVal, channel.id],
        );

        res.json({
            message: forceVal
                ? 'Forced VOD recording disabled for user channel'
                : 'Forced VOD recording disable removed for user channel',
            user_id: targetUserId,
            channel_id: channel.id,
            force_vod_recording_disabled: !!forceVal,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update forced VOD recording policy' });
    }
});

// ── Force NSFW on a Stream ───────────────────────────────────
router.put('/streams/:id/nsfw', (req, res) => {
    try {
        const { is_nsfw } = req.body;
        db.run('UPDATE streams SET is_nsfw = ? WHERE id = ?', [is_nsfw ? 1 : 0, req.params.id]);
        res.json({ message: is_nsfw ? 'Stream marked as NSFW' : 'NSFW removed from stream' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update stream NSFW' });
    }
});

// ── Force NSFW on a Paste ────────────────────────────────────
router.put('/pastes/:id/nsfw', (req, res) => {
    try {
        const { is_nsfw } = req.body;
        db.run('UPDATE pastes SET is_nsfw = ? WHERE id = ?', [is_nsfw ? 1 : 0, req.params.id]);
        res.json({ message: is_nsfw ? 'Paste marked as NSFW' : 'NSFW removed from paste' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update paste NSFW' });
    }
});

// ── List Bans ────────────────────────────────────────────────
router.get('/bans', (req, res) => {
    try {
        const bans = db.all(`
            SELECT b.*, u.username as banned_username, m.username as banned_by_username
            FROM bans b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN users m ON b.banned_by = m.id
            ORDER BY b.created_at DESC LIMIT 100
        `);
        res.json({ bans });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list bans' });
    }
});

// ── VPN Approval Queue ───────────────────────────────────────
router.get('/vpn-queue', (req, res) => {
    try {
        const queue = db.all(`
            SELECT v.*, u.username
            FROM vpn_approvals v
            LEFT JOIN users u ON v.user_id = u.id
            WHERE v.status = 'pending'
            ORDER BY v.created_at ASC
        `);
        res.json({ queue });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get VPN queue' });
    }
});

// ── Approve/Deny VPN ─────────────────────────────────────────
router.put('/vpn-queue/:id', (req, res) => {
    try {
        const { status } = req.body; // 'approved' or 'denied'
        if (!['approved', 'denied'].includes(status)) {
            return res.status(400).json({ error: 'Status must be approved or denied' });
        }

        db.run('UPDATE vpn_approvals SET status = ?, reviewed_by = ? WHERE id = ?',
            [status, req.user.id, req.params.id]);

        res.json({ message: `VPN request ${status}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update VPN request' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Site Settings
// ═══════════════════════════════════════════════════════════════

// ── Get All Settings ─────────────────────────────────────────
router.get('/settings', (req, res) => {
    try {
        // Non-owners get API keys / secrets / money settings redacted.
        const settings = permissions.redactSettingsForUser(db.getAllSettings(), req.user);
        res.json({ settings });
    } catch (err) {
        console.error('[Admin] Settings error:', err.message);
        res.status(500).json({ error: 'Failed to get settings' });
    }
});

// AI usage + estimated cost breakdown (for the openvibe.tools admin AI tab).
router.get('/ai/usage', (req, res) => {
    try {
        const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
        res.json({ days, usage: db.getAiUsageSummary(days) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get AI usage' });
    }
});

// ── AI Explorer + status tools (admin AI tab) ────────────────
const aiAnalysis = require('../ai/ai-analysis');

// AI health/config + optional live provider probe.
router.get('/ai/status', async (req, res) => {
    try {
        const probe = req.query.probe !== '0' && req.query.probe !== 'false';
        res.json({ status: await aiAnalysis.testStatus({ probe }) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'AI status check failed' });
    }
});

// Browse a streamer's AI-relevant data: memories, AI-analyzed pastes, VODs, overview.
router.get('/ai/explorer/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        const user = db.getUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const memories = db.getStreamMemoriesByUser(userId, 80).map(m => ({
            id: m.id, stream_id: m.stream_id, description: m.description,
            tags: m.tags, created_at: m.created_at, thumbnail_url: m.thumbnail_url,
        }));
        const pastes = db.getUserPastesForAi(userId, 40);
        const vods = (db.getVodsByUser ? db.getVodsByUser(userId, true, 40, 0) : []).map(v => ({
            id: v.id, title: v.title, category: v.category, created_at: v.created_at,
            duration_seconds: v.duration_seconds, ai_overview: v.ai_overview || null,
            ai_transcript: (v.ai_transcript && v.ai_transcript.trim()) ? v.ai_transcript : null,
        }));
        const clips = (db.getClipsByUser ? db.getClipsByUser(userId, true, 40, 0) : []).map(c => ({
            id: c.id, title: c.title, created_at: c.created_at,
            duration_seconds: c.duration_seconds, ai_overview: c.ai_overview || null,
            ai_transcript: (c.ai_transcript && c.ai_transcript.trim()) ? c.ai_transcript : null,
        }));
        res.json({
            user: { id: user.id, username: user.username, display_name: user.display_name, bio: user.bio },
            overview: db.getStreamerOverview(userId) || null,
            counts: { memories: memories.length, pastes: pastes.length, vods: vods.length, clips: clips.length },
            memories, pastes, vods, clips,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'AI explorer failed' });
    }
});

// List all stored per-streamer overviews.
router.get('/ai/overviews', (req, res) => {
    try {
        res.json({ overviews: db.getAllStreamerOverviews(200) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list overviews' });
    }
});

// Generate (or regenerate) the AI overview for a streamer.
router.post('/ai/streamer/:userId/overview', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        const user = db.getUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!aiAnalysis.isEnabled()) return res.status(400).json({ error: 'AI is disabled — enable it in AI Config first.' });
        const overview = await aiAnalysis.generateStreamerOverview(userId);
        if (!overview) return res.status(422).json({ error: 'Could not generate an overview — no AI-analyzable data for this streamer yet, or the provider returned nothing.' });
        res.json({ overview: db.getStreamerOverview(userId) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Overview generation failed' });
    }
});

// ── Update Settings (bulk) ───────────────────────────────────
router.put('/settings', (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Invalid settings payload' });
        }
        const owner = permissions.isOwner(req.user);
        let blocked = 0;
        for (const [key, value] of Object.entries(settings)) {
            if (typeof key !== 'string' || key.length > 100) continue;
            // Only the owner may change API keys / secrets / money settings.
            if (!owner && permissions.isSensitiveSettingKey(key)) { blocked++; continue; }
            db.setSetting(key, value);
        }
        res.json({
            message: blocked ? `Settings updated (${blocked} owner-only setting${blocked === 1 ? '' : 's'} skipped)` : 'Settings updated',
            settings: permissions.redactSettingsForUser(db.getAllSettings(), req.user),
        });
    } catch (err) {
        console.error('[Admin] Settings update error:', err.message);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ── Update Single Setting ────────────────────────────────────
router.put('/settings/:key', (req, res) => {
    try {
        const { value } = req.body;
        if (value === undefined) {
            return res.status(400).json({ error: 'Value is required' });
        }
        if (permissions.isSensitiveSettingKey(req.params.key) && !permissions.isOwner(req.user)) {
            return res.status(403).json({ error: 'Only the owner can change API keys / money settings' });
        }
        db.setSetting(req.params.key, value);
        res.json({ message: 'Setting updated', setting: db.getSettingRow(req.params.key) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

// ── Delete Setting ───────────────────────────────────────────
router.delete('/settings/:key', (req, res) => {
    try {
        if (permissions.isSensitiveSettingKey(req.params.key) && !permissions.isOwner(req.user)) {
            return res.status(403).json({ error: 'Only the owner can change API keys / money settings' });
        }
        db.deleteSetting(req.params.key);
        res.json({ message: 'Setting deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete setting' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Global Moderators
// ═══════════════════════════════════════════════════════════════

// ── List Mods ────────────────────────────────────────────────
router.get('/moderators', (req, res) => {
    try {
        const mods = db.all(
            "SELECT id, username, display_name, avatar_url, created_at, last_seen FROM users WHERE role IN ('mod', 'global_mod') ORDER BY username"
        );
        res.json({ moderators: mods });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list moderators' });
    }
});

// ── Promote to Global Mod ────────────────────────────────────
router.post('/moderators', (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Username is required' });

        const user = db.getUserByUsername(username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(400).json({ error: 'Cannot change admin role' });
        if (user.role === 'global_mod') return res.status(400).json({ error: 'User is already a global moderator' });

        db.run("UPDATE users SET role = 'global_mod' WHERE id = ?", [user.id]);

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: user.id,
            action_type: 'global_mod_promote',
            details: { username: user.username },
        });

        res.json({ message: `${user.username} promoted to global moderator` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to promote user' });
    }
});

// ── Demote Global Mod ────────────────────────────────────────
router.delete('/moderators/:id', (req, res) => {
    try {
        const user = db.getUserById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role !== 'global_mod') return res.status(400).json({ error: 'User is not a global moderator' });

        db.run("UPDATE users SET role = 'user' WHERE id = ?", [user.id]);

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: user.id,
            action_type: 'global_mod_demote',
            details: { username: user.username },
        });

        res.json({ message: `${user.username} demoted to user` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to demote moderator' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Admins (OWNER only — admins can add mods, but not other admins)
// ═══════════════════════════════════════════════════════════════

router.get('/admins', permissions.requireOwner, (req, res) => {
    try {
        const admins = db.all("SELECT id, username, display_name, avatar_url, is_owner FROM users WHERE role = 'admin' ORDER BY is_owner DESC, username ASC");
        res.json({ admins });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list admins' });
    }
});

// ── Promote to Admin (owner only) ────────────────────────────
router.post('/admins', permissions.requireOwner, (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Username is required' });
        const user = db.getUserByUsername(username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(400).json({ error: 'User is already an admin' });
        db.run("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
        db.logModerationAction({
            scope_type: 'site', actor_user_id: req.user.id, target_user_id: user.id,
            action_type: 'admin_promote', details: { username: user.username },
        });
        res.json({ message: `${user.username} promoted to admin` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to promote user to admin' });
    }
});

// ── Revoke Admin (owner only; cannot demote an owner) ────────
router.delete('/admins/:id', permissions.requireOwner, (req, res) => {
    try {
        const user = db.getUserById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role !== 'admin') return res.status(400).json({ error: 'User is not an admin' });
        if (user.is_owner) return res.status(400).json({ error: 'Cannot demote an owner' });
        db.run("UPDATE users SET role = 'user' WHERE id = ?", [user.id]);
        db.logModerationAction({
            scope_type: 'site', actor_user_id: req.user.id, target_user_id: user.id,
            action_type: 'admin_demote', details: { username: user.username },
        });
        res.json({ message: `${user.username} demoted from admin` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to demote admin' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Verification Keys (legacy RS-Companion username claims)
// ═══════════════════════════════════════════════════════════════

// ── List All Keys ────────────────────────────────────────────
router.get('/verification-keys', (req, res) => {
    try {
        const keys = db.getAllVerificationKeys();
        res.json({ keys });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list verification keys' });
    }
});

// ── Generate Key ─────────────────────────────────────────────
router.post('/verification-keys', (req, res) => {
    try {
        const { target_username, note } = req.body;
        if (!target_username) {
            return res.status(400).json({ error: 'Target username is required' });
        }
        if (!/^[a-zA-Z0-9_]+$/.test(target_username) || target_username.length < 3 || target_username.length > 24) {
            return res.status(400).json({ error: 'Invalid username format (3-24 chars, alphanumeric + underscore)' });
        }

        // Check if username already taken by a real user
        const existingUser = db.getUserByUsername(target_username);
        if (existingUser) {
            return res.status(409).json({ error: `Username "${target_username}" is already registered` });
        }

        // Check for duplicate active key for same username
        const existingKey = db.getVerificationKeyByUsername(target_username);
        if (existingKey) {
            return res.status(409).json({ error: `Active key already exists for "${target_username}"` });
        }

        // Generate a readable key: OPENVIBE-XXXX-XXXX-XXXX
        const key = 'OPENVIBE-' + [4, 4, 4].map(() =>
            crypto.randomBytes(2).toString('hex').toUpperCase()
        ).join('-');

        db.createVerificationKey({
            key,
            target_username,
            note: note || '',
            created_by: req.user.id,
        });

        const created = db.getVerificationKeyByKey(key);
        res.status(201).json({ key: created });
    } catch (err) {
        console.error('[Admin] Verification key error:', err.message);
        res.status(500).json({ error: 'Failed to generate key' });
    }
});

// ── Revoke Key ───────────────────────────────────────────────
router.delete('/verification-keys/:id', (req, res) => {
    try {
        const result = db.revokeVerificationKey(req.params.id);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Key not found or already used/revoked' });
        }
        res.json({ message: 'Verification key revoked' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to revoke key' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Storage / Data Management
// ═══════════════════════════════════════════════════════════════

/**
 * Recursively compute total size (bytes) and file count for a directory.
 * Returns { bytes, files }.
 */
function dirStats(dirPath) {
    let bytes = 0, files = 0;
    try {
        const resolved = path.resolve(dirPath);
        if (!fs.existsSync(resolved)) return { bytes: 0, files: 0 };
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(resolved, entry.name);
            if (entry.isDirectory()) {
                const sub = dirStats(full);
                bytes += sub.bytes;
                files += sub.files;
            } else if (entry.isFile()) {
                try {
                    bytes += fs.statSync(full).size;
                    files++;
                } catch { /* permission / race */ }
            }
        }
    } catch { /* dir doesn't exist or inaccessible */ }
    return { bytes, files };
}

/**
 * Get disk usage for the volume containing a path.
 * Returns { total, used, available } in bytes.
 */
function diskUsage(targetPath) {
    try {
        const resolved = path.resolve(targetPath);
        // `df -B1` gives bytes; last line of output has the numbers
        const output = execSync(`df -B1 "${resolved}" 2>/dev/null | tail -1`, { encoding: 'utf8' });
        const parts = output.trim().split(/\s+/);
        // Format: Filesystem 1B-blocks Used Available Use% Mounted
        if (parts.length >= 6) {
            return {
                total: parseInt(parts[1], 10) || 0,
                used: parseInt(parts[2], 10) || 0,
                available: parseInt(parts[3], 10) || 0,
                usePct: parts[4] || '0%',
                mount: parts[5] || '/',
            };
        }
    } catch { /* not Linux / df not available */ }
    return { total: 0, used: 0, available: 0, usePct: '0%', mount: '/' };
}

// ── GET /api/admin/storage ───────────────────────────────────
// Full disk overview + per-directory breakdown
router.get('/storage', (req, res) => {
    try {
        const dataRoot = path.resolve('./data');
        const disk = diskUsage(dataRoot);

        // Per-directory breakdown
        // VODs/clips/pastes/thumbnails moved to OpenVibe.Media — only Live-local dirs remain.
        const directories = [
            { name: 'Live thumbs', path: './data/live-thumbs',        icon: 'fa-image' },
            { name: 'Avatars',    path: './data/avatars',             icon: 'fa-user-circle' },
            { name: 'Emotes',     path: './data/emotes',              icon: 'fa-face-smile' },
            { name: 'Offline screens', path: './data/offline',        icon: 'fa-tv' },
        ];

        const breakdown = directories.map(d => {
            const stats = dirStats(d.path);
            return { name: d.name, icon: d.icon, bytes: stats.bytes, files: stats.files };
        });

        // Database file size
        let dbBytes = 0;
        try { dbBytes = fs.statSync(path.resolve('./data/live.db')).size; } catch {}

        // Total data directory
        const dataTotal = dirStats(dataRoot);

        // VOD/clip stats live in OpenVibe.Media now — report the move instead.
        const vodDbStats = { count: 0, totalSize: 0, oldest: '', newest: '', moved_to: 'openvibe.media' };
        const clipDbStats = { count: 0, moved_to: 'openvibe.media' };

        res.json({
            disk,
            dataTotal: { bytes: dataTotal.bytes, files: dataTotal.files },
            database: { bytes: dbBytes },
            breakdown,
            vodStats: vodDbStats,
            clipStats: clipDbStats,
        });
    } catch (err) {
        console.error('[Admin] Storage error:', err.message);
        res.status(500).json({ error: 'Failed to analyze storage' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Media storage administration — moved to OpenVibe.Media
// ═══════════════════════════════════════════════════════════════
// VOD/clip files, storage tiering (local/B2/R2) and the yt-dlp media tools all
// live in the OpenVibe.Media service now. The listing/delete endpoints below
// proxy the Media API; the tiering + media-tools endpoints return a stub note
// so the admin SPA shows where the controls went instead of erroring.
const mediaClient = require('../media-client');

// ── GET /api/admin/storage/vods — proxied VOD listing ────────
router.get('/storage/vods', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100'), 500);
        const offset = parseInt(req.query.offset || '0');
        const out = await mediaClient.listVods({ limit, offset, include_private: 1, sort: req.query.sort, order: req.query.order });
        const vods = (out?.vods || (Array.isArray(out) ? out : [])).map(v => ({
            ...v,
            diskSize: v.file_size || 0,
            fileExists: v.status !== 'failed',
            actualTier: v.storage_provider && v.storage_provider !== 'local' ? v.storage_provider : 'hot',
        }));
        res.json({ vods, total: out?.total ?? vods.length, userSummary: out?.userSummary || [] });
    } catch (err) {
        console.error('[Admin] VOD storage error:', err.message);
        res.status(502).json({ error: 'Media service unavailable' });
    }
});

// ── DELETE /api/admin/storage/vods/bulk ──────────────────────
router.delete('/storage/vods/bulk', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
        if (ids.length > 200) return res.status(400).json({ error: 'Max 200 VODs per bulk delete' });
        let deleted = 0, freed = 0; const errors = [];
        for (const id of ids) {
            try {
                const vod = await mediaClient.getVod(id).catch(() => null);
                if (!vod) { errors.push(`VOD ${id} not found`); continue; }
                // Owner-rank users' content is protected from admins.
                if (!permissions.canModerateContentOwner(req.user, vod.user_id ? db.getUserById(vod.user_id) : null)) {
                    errors.push(`VOD ${id}: protected (owner content)`); continue;
                }
                freed += vod.file_size || 0;
                await mediaClient.deleteVod(id);
                deleted++;
            } catch (err) {
                errors.push(`VOD ${id}: ${err.message}`);
            }
        }
        console.log(`[Admin] Bulk VOD delete by ${req.user.username}: ${deleted}/${ids.length} deleted`);
        res.json({ deleted, freed, errors: errors.length ? errors : undefined });
    } catch (err) {
        console.error('[Admin] Bulk VOD delete error:', err.message);
        res.status(500).json({ error: 'Bulk delete failed' });
    }
});

// ── DELETE /api/admin/storage/clips/bulk ─────────────────────
router.delete('/storage/clips/bulk', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
        if (ids.length > 200) return res.status(400).json({ error: 'Max 200 clips per bulk delete' });
        let deleted = 0; const errors = [];
        for (const id of ids) {
            try {
                const clip = await mediaClient.getClip(id).catch(() => null);
                if (!clip) { errors.push(`Clip ${id} not found`); continue; }
                let clipStreamOwner = null;
                if (clip.stream_id) { const s = db.getStreamById(clip.stream_id); if (s) clipStreamOwner = db.getUserById(s.user_id); }
                if (!permissions.canModerateContentOwner(req.user, clip.user_id ? db.getUserById(clip.user_id) : null) ||
                    !permissions.canModerateContentOwner(req.user, clipStreamOwner)) {
                    errors.push(`Clip ${id}: protected (owner content)`); continue;
                }
                await mediaClient.deleteClip(id);
                db.run("DELETE FROM content_views WHERE content_type = 'clip' AND content_id = ?", [id]);
                db.run("DELETE FROM comments WHERE content_type = 'clip' AND content_id = ?", [id]);
                deleted++;
            } catch (err) {
                errors.push(`Clip ${id}: ${err.message}`);
            }
        }
        console.log(`[Admin] Bulk clip delete by ${req.user.username}: ${deleted}/${ids.length} deleted`);
        res.json({ deleted, errors: errors.length ? errors : undefined });
    } catch (err) {
        console.error('[Admin] Bulk clip delete error:', err.message);
        res.status(500).json({ error: 'Bulk delete failed' });
    }
});

// ── Storage tiering + media tools → moved to OpenVibe.Media ──
const MOVED_NOTE = {
    moved: true,
    service: 'OpenVibe.Media',
    note: 'Storage tiering (local/B2/R2) and media tools are managed by the OpenVibe.Media service now.',
};
for (const route of ['/storage/tiers', '/storage/buckets']) {
    router.get(route, (req, res) => res.status(200).json({ ...MOVED_NOTE }));
}
for (const [method, route] of [
    ['put', '/storage/tiers/settings'],
    ['post', '/storage/tiers/sweep'],
    ['post', '/storage/tiers/move'],
    ['post', '/storage/tiers/bulk-move'],
]) {
    router[method](route, (req, res) => res.status(501).json({ ...MOVED_NOTE, error: 'Moved to OpenVibe.Media' }));
}

// ═══════════════════════════════════════════════════════════════
// Media Tools — yt-dlp cookies, diagnostics, test extraction
// ═══════════════════════════════════════════════════════════════
const downloader = require('../media/media-downloader');

// GET  /api/admin/media-tools/status — yt-dlp availability + cookies status
router.get('/media-tools/status', async (req, res) => {
    try {
        const cookiesPath = downloader.getCookiesPath();
        let cookiesExist = false;
        let cookiesSize = 0;
        try {
            const stat = fs.statSync(cookiesPath);
            cookiesExist = stat.size > 0;
            cookiesSize = stat.size;
        } catch {}
        const extraArgs = downloader.getExtraArgs();
        let ytdlpVersion = null;
        let potProviders = [];
        let potAvailable = false;
        if (downloader.isAvailable()) {
            try { ytdlpVersion = await downloader.getVersion(); } catch {}
            try {
                const pot = await downloader.checkPotProvider();
                potProviders = pot.providers;
                potAvailable = pot.hasExternal;
            } catch {}
        }
        res.json({
            ytdlp_available: downloader.isAvailable(),
            ytdlp_path: downloader.getYtdlpPath(),
            ytdlp_version: ytdlpVersion,
            cookies_configured: cookiesExist,
            cookies_size: cookiesSize,
            cookies_path: cookiesPath,
            extra_args: extraArgs,
            extra_args_configured: extraArgs.trim().length > 0,
            pot_available: potAvailable,
            pot_providers: potProviders,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT  /api/admin/media-tools/cookies — Upload/paste cookies.txt content
router.put('/media-tools/cookies', (req, res) => {
    try {
        const { cookies } = req.body;
        if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 10) {
            return res.status(400).json({ error: 'Cookies content is required (Netscape cookies.txt format)' });
        }
        const cookiesPath = downloader.getCookiesPath();
        const dir = path.dirname(cookiesPath);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        fs.writeFileSync(cookiesPath, cookies.trim() + '\n', 'utf8');
        console.log(`[Admin] yt-dlp cookies updated by ${req.user.username} (${cookies.length} bytes)`);
        res.json({ message: 'Cookies saved', size: cookies.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/media-tools/cookies — Remove cookies file
router.delete('/media-tools/cookies', (req, res) => {
    try {
        const cookiesPath = downloader.getCookiesPath();
        try { fs.unlinkSync(cookiesPath); } catch {}
        console.log(`[Admin] yt-dlp cookies removed by ${req.user.username}`);
        res.json({ message: 'Cookies removed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT  /api/admin/media-tools/extra-args — Save extra yt-dlp CLI arguments
router.put('/media-tools/extra-args', (req, res) => {
    try {
        const { extra_args } = req.body;
        if (typeof extra_args !== 'string') {
            return res.status(400).json({ error: 'extra_args must be a string' });
        }
        db.setSetting('ytdlp_extra_args', extra_args.trim());
        console.log(`[Admin] yt-dlp extra args updated by ${req.user.username}`);
        res.json({ message: 'Extra args saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/media-tools/extra-args — Clear extra yt-dlp CLI arguments
router.delete('/media-tools/extra-args', (req, res) => {
    try {
        db.setSetting('ytdlp_extra_args', '');
        console.log(`[Admin] yt-dlp extra args cleared by ${req.user.username}`);
        res.json({ message: 'Extra args cleared' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/media-tools/test — Test yt-dlp extraction on a URL
router.post('/media-tools/test', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'URL is required' });
        }
        const results = { url, steps: [] };

        // Step 1: Check yt-dlp availability
        results.steps.push({ name: 'yt-dlp available', ok: downloader.isAvailable() });
        if (!downloader.isAvailable()) {
            return res.json(results);
        }

        // Step 2: Get info
        try {
            const info = await downloader.getInfo(url);
            results.steps.push({ name: 'getInfo', ok: true, data: { title: info.title, duration: info.duration, extractor: info.extractor } });
        } catch (err) {
            results.steps.push({ name: 'getInfo', ok: false, error: err.message });
        }

        // Step 3: Extract stream URL
        try {
            const stream = await downloader.extractStreamUrl(url);
            const previewUrl = stream?.streamUrl || stream?.embedUrl || null;
            if (!previewUrl) throw new Error('No playable URL returned');
            results.steps.push({
                name: 'extractStreamUrl',
                ok: true,
                data: {
                    streamUrl: previewUrl.substring(0, 120) + '...',
                    transport: stream?.transport || (stream?.embedUrl ? 'embed' : 'direct'),
                },
            });
        } catch (err) {
            results.steps.push({ name: 'extractStreamUrl', ok: false, error: err.message });
        }

        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
