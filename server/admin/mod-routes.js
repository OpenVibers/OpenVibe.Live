/**
 * OpenVibe.Live — Moderator API Routes
 *
 * Accessible by global_mod + admin.
 * These are moderator-specific tools that don't belong in the admin panel.
 *
 * GET    /api/mod/bans                    - List stream-scoped bans
 * POST   /api/mod/global-ban              - Global ban (admin + global_mod): site-wide + IP
 * POST   /api/mod/stream-ban              - Local ban (any mod with stream powers)
 * DELETE /api/mod/ban/:id                 - Unban (removes ban entry + clears is_banned if global)
 * GET    /api/mod/chat/search             - Search all chat logs
 * GET    /api/mod/chat/user/:userId       - View a user's chat history
 * POST   /api/mod/delete-message          - Delete a single chat message
 * POST   /api/mod/delete-user-messages    - Bulk-delete all messages from a user/anon/relay
 * POST   /api/mod/relay-user/hide         - Hide or ban a relayed user
 * DELETE /api/mod/relay-user/:id          - Unhide a relayed user
 * GET    /api/mod/relay-users/hidden/:channelId - List hidden relay users for a channel
 * GET    /api/mod/ip/user/:userId         - Get all IPs used by a user
 * GET    /api/mod/ip/anon/:anonId         - Get latest IP + alts for an anon
 * GET    /api/mod/ip/lookup/:ip           - Get all accounts on an IP
 * GET    /api/mod/ip/alts/:userId         - Get linked accounts (alt detection)
 * POST   /api/mod/ip/ban-all              - Ban all accounts on an IP
 * GET    /api/mod/ip/log                  - Search IP history log
 * GET    /api/mod/ip-approval/:channelId/pending  - Get pending IP-approval messages
 * POST   /api/mod/ip-approval/:channelId/approve  - Approve all messages from an IP
 * POST   /api/mod/ip-approval/:channelId/deny     - Deny all messages from an IP
 * POST   /api/mod/ip-approval/:channelId/review   - Review a single pending message
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const chatServer = require('../chat/chat-server');
const ipUtils = require('./ip-utils');

const router = express.Router();

// All mod routes require auth (individual routes check specific permissions)
router.use(requireAuth);

// ── List bans ────────────────────────────────────────────────
router.get('/bans', permissions.requireGlobalMod, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100'), 500);
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id) : null;
        const where = streamId ? 'WHERE b.stream_id = ?' : '';
        const params = streamId ? [streamId, limit] : [limit];
        const bans = db.all(`
            SELECT b.*, u.username as banned_username, m.username as banned_by_username,
                   s.title as stream_title
            FROM bans b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN users m ON b.banned_by = m.id
            LEFT JOIN streams s ON b.stream_id = s.id
            ${where}
            ORDER BY b.created_at DESC LIMIT ?
        `, params);
        res.json({ bans });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list bans' });
    }
});

// ── Global Ban (admin + global_mod) ──────────────────────────
// Site-wide ban: sets is_banned flag, creates bans entry with no stream_id, adds IP ban.
// Also cascades: bans all other accounts that share this user's IP.
router.post('/global-ban', permissions.requireGlobalMod, (req, res) => {
    try {
        const { user_id, reason, duration_hours, ip_address } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });

        const targetUser = db.getUserById(parseInt(user_id));
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        const banReason = reason || 'Banned by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        // Auto-detect IP from connected WebSocket clients, then fall back to IP log
        let resolvedIp = ip_address || chatServer.getConnectedUserIp(targetUser.id);
        if (!resolvedIp) {
            const latest = db.getLatestIpForUser(targetUser.id);
            if (latest) resolvedIp = latest.ip_address;
        }

        // Set the site-wide is_banned flag
        db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
            [banReason, targetUser.id]);

        // Create user-based global ban
        db.run(
            `INSERT INTO bans (user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
            [targetUser.id, resolvedIp, banReason, req.user.id, expires]
        );

        // Also create standalone IP ban for the IP (catches alt accounts + future visits)
        if (resolvedIp) {
            db.run(
                `INSERT INTO bans (ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
                [resolvedIp, banReason + ` (IP of ${targetUser.username})`, req.user.id, expires]
            );

            // Cascade: ban all other accounts that have ever used this IP
            const linked = db.getLinkedAccounts(targetUser.id);
            let cascadeBanned = 0;
            for (const alt of linked) {
                if (alt.is_banned) continue; // already banned
                db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
                    [banReason + ` (alt of ${targetUser.username})`, alt.id]);
                db.run(`INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
                    [alt.id, banReason + ` (alt of ${targetUser.username})`, req.user.id, expires]);
                chatServer.disconnectUser({ userId: alt.id });
                cascadeBanned++;
            }

            if (cascadeBanned > 0) {
                console.log(`[Mod] Global ban cascade: ${cascadeBanned} alt accounts of ${targetUser.username} also banned`);
            }
        }

        // Immediately disconnect the user from chat
        chatServer.disconnectUser({ userId: targetUser.id, ip: resolvedIp });

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: targetUser.id,
            action_type: 'global_ban',
            details: { reason: banReason, duration_hours: duration_hours || null, ip: resolvedIp },
        });

        res.json({ message: `${targetUser.username} globally banned` });
    } catch (err) {
        console.error('[Mod] Global ban error:', err.message);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// ── Per-User Ban/Unban (staff console) ───────────────────────
// Aliases for /global-ban and unban — the staff console calls /mod/users/:id/ban
router.post('/users/:id/ban', permissions.requireGlobalMod, (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { reason, duration_hours } = req.body;

        const targetUser = db.getUserById(userId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        const banReason = reason || 'Banned by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        let resolvedIp = chatServer.getConnectedUserIp(targetUser.id);
        if (!resolvedIp) {
            const latest = db.getLatestIpForUser(targetUser.id);
            if (latest) resolvedIp = latest.ip_address;
        }

        db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
            [banReason, targetUser.id]);
        db.run(
            `INSERT INTO bans (user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
            [targetUser.id, resolvedIp, banReason, req.user.id, expires]
        );

        if (resolvedIp) {
            db.run(
                `INSERT INTO bans (ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
                [resolvedIp, banReason + ` (IP of ${targetUser.username})`, req.user.id, expires]
            );
            const linked = db.getLinkedAccounts(targetUser.id);
            for (const alt of linked) {
                if (alt.is_banned) continue;
                db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
                    [banReason + ` (alt of ${targetUser.username})`, alt.id]);
                db.run(`INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
                    [alt.id, banReason + ` (alt of ${targetUser.username})`, req.user.id, expires]);
                chatServer.disconnectUser({ userId: alt.id });
            }
        }

        chatServer.disconnectUser({ userId: targetUser.id, ip: resolvedIp });

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: targetUser.id,
            action_type: 'global_ban',
            details: { reason: banReason, duration_hours: duration_hours || null, ip: resolvedIp },
        });

        res.json({ message: `${targetUser.username} globally banned` });
    } catch (err) {
        console.error('[Mod] User ban error:', err.message);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

router.delete('/users/:id/ban', permissions.requireGlobalMod, (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const targetUser = db.getUserById(userId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        db.run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [userId]);
        db.run('DELETE FROM bans WHERE user_id = ? AND stream_id IS NULL', [userId]);

        chatServer.disconnectUser({ userId });

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: userId,
            action_type: 'global_unban',
            details: { username: targetUser.username },
        });

        res.json({ message: `${targetUser.username} unbanned` });
    } catch (err) {
        console.error('[Mod] User unban error:', err.message);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

// ── Stream Ban (any mod with stream moderation powers) ───────
// Local ban: creates bans entry scoped to a specific stream
router.post('/stream-ban', (req, res) => {
    try {
        const { user_id, anon_id, stream_id, reason, duration_hours, ip_address } = req.body;
        const streamId = parseInt(stream_id);
        if (!streamId) return res.status(400).json({ error: 'stream_id required' });
        if (!user_id && !anon_id) return res.status(400).json({ error: 'user_id or anon_id required' });

        // Check moderation permission for this stream
        if (!permissions.canModerateStream(req.user, streamId)) {
            return res.status(403).json({ error: 'You cannot moderate this stream' });
        }

        const banReason = reason || 'Banned by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        if (user_id) {
            const targetUser = db.getUserById(parseInt(user_id));
            if (!targetUser) return res.status(404).json({ error: 'User not found' });

            // Auto-detect IP from connected clients if not provided
            const resolvedIp = ip_address || chatServer.getConnectedUserIp(targetUser.id);

            db.run(
                `INSERT INTO bans (stream_id, user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [streamId, targetUser.id, resolvedIp, banReason, req.user.id, expires]
            );

            // Disconnect from this stream's chat
            chatServer.disconnectUser({ userId: targetUser.id, ip: resolvedIp, streamId });

            db.logModerationAction({
                scope_type: 'stream',
                scope_id: streamId,
                actor_user_id: req.user.id,
                target_user_id: targetUser.id,
                action_type: 'stream_ban',
                details: { reason: banReason, duration_hours: duration_hours || null },
            });

            res.json({ message: `${targetUser.username} banned from stream` });
        } else {
            // Anon ban — look up IP from connected anon client
            const anonClient = chatServer.findClientByAnonId(anon_id, streamId);
            const resolvedIp = ip_address || anonClient?.ip || null;

            db.run(
                `INSERT INTO bans (stream_id, ip_address, anon_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [streamId, resolvedIp, anon_id, banReason, req.user.id, expires]
            );

            // Disconnect the anon user
            if (resolvedIp) chatServer.disconnectUser({ ip: resolvedIp, streamId });

            db.logModerationAction({
                scope_type: 'stream',
                scope_id: streamId,
                actor_user_id: req.user.id,
                action_type: 'stream_ban_anon',
                details: { anon_id, reason: banReason, duration_hours: duration_hours || null },
            });

            res.json({ message: `${anon_id} banned from stream` });
        }
    } catch (err) {
        console.error('[Mod] Stream ban error:', err.message);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// ── Unban ────────────────────────────────────────────────────
router.delete('/ban/:id', (req, res) => {
    try {
        const ban = db.get('SELECT * FROM bans WHERE id = ?', [req.params.id]);
        if (!ban) return res.status(404).json({ error: 'Ban not found' });

        // Permission check: global bans require global_mod+, stream bans require stream mod
        if (!ban.stream_id) {
            if (!permissions.isGlobalModOrAbove(req.user)) {
                return res.status(403).json({ error: 'Only global mods can remove global bans' });
            }
            // Clear is_banned flag if this was a global user ban
            if (ban.user_id) {
                db.run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [ban.user_id]);
                // Remove ALL global bans for this user (user + IP entries)
                db.run('DELETE FROM bans WHERE user_id = ? AND stream_id IS NULL', [ban.user_id]);
                db.run('DELETE FROM bans WHERE ip_address IS NOT NULL AND banned_by = ? AND stream_id IS NULL AND reason LIKE ?',
                    [ban.banned_by, '%' + (ban.reason || '') + '%']);
            }
        } else {
            if (!permissions.canModerateStream(req.user, ban.stream_id)) {
                return res.status(403).json({ error: 'You cannot moderate this stream' });
            }
        }

        db.run('DELETE FROM bans WHERE id = ?', [req.params.id]);

        db.logModerationAction({
            scope_type: ban.stream_id ? 'stream' : 'site',
            scope_id: ban.stream_id || undefined,
            actor_user_id: req.user.id,
            target_user_id: ban.user_id || undefined,
            action_type: 'unban',
            details: { ban_id: ban.id, original_reason: ban.reason },
        });

        res.json({ message: 'Ban removed' });
    } catch (err) {
        console.error('[Mod] Unban error:', err.message);
        res.status(500).json({ error: 'Failed to unban' });
    }
});

// ── Search chat messages (all users) ─────────────────────────
router.get('/chat/search', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');
        const query = req.query.q || '';
        const rawUid = (req.query.user_id || '').trim();
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id) : null;

        // Support "anon123", numeric user ID, or username string
        let userId = null;
        let anonId = null;
        let username = null;
        if (rawUid) {
            const anonMatch = rawUid.match(/^anon(\d+)$/i);
            if (anonMatch) {
                anonId = rawUid.toLowerCase();
            } else if (/^\d+$/.test(rawUid)) {
                userId = parseInt(rawUid);
            } else {
                username = rawUid;
            }
        }

        const result = db.searchChatMessages({ query, userId, anonId, username, streamId, limit, offset });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// ── View a user's chat history ───────────────────────────────
router.get('/chat/user/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');

        const result = db.getUserChatHistory(userId, limit, offset);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

// ══════════════════════════════════════════════════════════════
//  MESSAGE DELETION
// ══════════════════════════════════════════════════════════════

// ── Delete a single chat message ─────────────────────────────
router.post('/delete-message', (req, res) => {
    try {
        const { message_id, stream_id } = req.body;
        if (!message_id) return res.status(400).json({ error: 'message_id required' });

        const message = db.getChatMessageById(parseInt(message_id));
        if (!message) return res.status(404).json({ error: 'Message not found' });

        // Permission: stream mod can delete messages in their stream, global mod can delete anything
        const isGlobal = permissions.isGlobalModOrAbove(req.user);
        if (!isGlobal) {
            const targetStreamId = stream_id || message.stream_id;
            if (!targetStreamId || !permissions.canModerateStream(req.user, targetStreamId)) {
                return res.status(403).json({ error: 'You cannot moderate this stream' });
            }
        }

        db.deleteChatMessage(parseInt(message_id), req.user.id);

        // Broadcast deletion to connected clients — reach the streamer's whole
        // channel room (all slots + offline viewers), plus the global feed.
        const delPayload = { type: 'delete-messages', ids: [parseInt(message_id)] };
        const chanUid = message.channel_user_id || (message.stream_id ? (db.getStreamById(message.stream_id)?.user_id || null) : null);
        if (chanUid || message.stream_id) {
            chatServer.broadcastToChannelRoom(chanUid, message.stream_id, delPayload);
            if (message.stream_id) chatServer.forwardToGlobal(message.stream_id, delPayload);
            else chatServer.broadcastGlobal(delPayload);
        } else {
            chatServer.broadcastGlobal(delPayload);
        }

        db.logModerationAction({
            scope_type: message.stream_id ? 'stream' : 'site',
            scope_id: message.stream_id || undefined,
            actor_user_id: req.user.id,
            target_user_id: message.user_id || undefined,
            action_type: 'message_delete',
            details: { message_id: parseInt(message_id) },
        });

        res.json({ message: 'Message deleted', ids: [parseInt(message_id)] });
    } catch (err) {
        console.error('[Mod] Delete message error:', err.message);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// ── Bulk-delete all messages from a user/anon/relay ──────────
router.post('/delete-user-messages', (req, res) => {
    try {
        const { user_id, anon_id, relay_username, stream_id } = req.body;
        if (!user_id && !anon_id && !relay_username) {
            return res.status(400).json({ error: 'user_id, anon_id, or relay_username required' });
        }

        // Permission: streamers can only delete within their stream, global mods can delete globally
        const isGlobal = permissions.isGlobalModOrAbove(req.user);
        const scopedStreamId = isGlobal ? (stream_id || null) : stream_id;

        if (!isGlobal) {
            if (!stream_id) return res.status(400).json({ error: 'stream_id required for stream moderators' });
            if (!permissions.canModerateStream(req.user, stream_id)) {
                return res.status(403).json({ error: 'You cannot moderate this stream' });
            }
        }

        let ids = [];
        if (user_id) {
            ids = db.deleteUserChatMessages(parseInt(user_id), { streamId: scopedStreamId, deletedBy: req.user.id });
        } else if (anon_id) {
            ids = db.deleteAnonChatMessages(anon_id, { streamId: scopedStreamId, deletedBy: req.user.id });
        } else if (relay_username) {
            ids = db.deleteRelayUserMessages(relay_username, { streamId: scopedStreamId, deletedBy: req.user.id });
        }

        // Broadcast deletions to connected clients
        if (ids.length > 0) {
            const deleteMsg = { type: 'delete-messages', ids };
            if (scopedStreamId) {
                const chanUid = db.getStreamById(scopedStreamId)?.user_id || null;
                chatServer.broadcastToChannelRoom(chanUid, scopedStreamId, deleteMsg);
                chatServer.forwardToGlobal(scopedStreamId, deleteMsg);
            } else {
                // Global deletion — broadcast to every connected client
                const msg = JSON.stringify(deleteMsg);
                for (const [ws] of chatServer.clients) {
                    if (ws.readyState === 1) ws.send(msg);
                }
            }
        }

        const target = user_id ? `user ${user_id}` : anon_id ? `anon ${anon_id}` : `relay ${relay_username}`;
        db.logModerationAction({
            scope_type: scopedStreamId ? 'stream' : 'site',
            scope_id: scopedStreamId || undefined,
            actor_user_id: req.user.id,
            target_user_id: user_id ? parseInt(user_id) : undefined,
            action_type: 'bulk_message_delete',
            details: { target, count: ids.length, stream_id: scopedStreamId || null },
        });

        res.json({ message: `Deleted ${ids.length} message(s) from ${target}`, ids, count: ids.length });
    } catch (err) {
        console.error('[Mod] Bulk delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete messages' });
    }
});

// ══════════════════════════════════════════════════════════════
//  RELAY USER MODERATION
// ══════════════════════════════════════════════════════════════

// ── Hide or ban a relayed external user ──────────────────────
router.post('/relay-user/hide', (req, res) => {
    try {
        const { channel_id, platform, external_username, action, reason } = req.body;
        if (!platform || !external_username) {
            return res.status(400).json({ error: 'platform and external_username required' });
        }

        // Permission: channel owner/mod or global mod
        const isGlobal = permissions.isGlobalModOrAbove(req.user);
        if (!isGlobal && channel_id) {
            const channel = db.getChannelById(channel_id);
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
            // Stream owner or global mod
            if (channel.user_id !== req.user.id) {
                return res.status(403).json({ error: 'You cannot moderate this channel' });
            }
        }

        // Unban / unhide — remove the ban for this exact relay identity only.
        if (action === 'unban' || action === 'unhide') {
            db.unhideRelayUserByIdentity(channel_id || null, platform, external_username);
            db.logModerationAction({
                scope_type: channel_id ? 'channel' : 'site',
                scope_id: channel_id || undefined,
                actor_user_id: req.user.id,
                action_type: 'relay_user_unhide',
                details: { platform, external_username },
            });
            return res.json({ message: `[${platform}] ${external_username} unbanned` });
        }

        db.hideRelayUser({
            channelId: channel_id || null,
            platform,
            externalUsername: external_username,
            action: action || 'hide',
            reason,
            createdBy: req.user.id,
        });

        db.logModerationAction({
            scope_type: channel_id ? 'channel' : 'site',
            scope_id: channel_id || undefined,
            actor_user_id: req.user.id,
            action_type: 'relay_user_hide',
            details: { platform, external_username, action: action || 'hide', reason },
        });

        res.json({ message: `[${platform}] ${external_username} ${action || 'hidden'}` });
    } catch (err) {
        console.error('[Mod] Relay user hide error:', err.message);
        res.status(500).json({ error: 'Failed to hide relay user' });
    }
});

// ── Unhide a relayed user ────────────────────────────────────
router.delete('/relay-user/:id', (req, res) => {
    try {
        db.unhideRelayUser(parseInt(req.params.id));

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            action_type: 'relay_user_unhide',
            details: { id: parseInt(req.params.id) },
        });

        res.json({ message: 'Relay user unhidden' });
    } catch (err) {
        console.error('[Mod] Relay user unhide error:', err.message);
        res.status(500).json({ error: 'Failed to unhide relay user' });
    }
});

// ── List hidden relay users for a channel ────────────────────
router.get('/relay-users/hidden/:channelId', (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const hidden = db.getHiddenRelayUsers(channelId);
        res.json({ hidden });
    } catch (err) {
        console.error('[Mod] List hidden relay users error:', err.message);
        res.status(500).json({ error: 'Failed to list hidden relay users' });
    }
});

// ══════════════════════════════════════════════════════════════
//  IP APPROVAL QUEUE (Anti-VPN Mode)
// ══════════════════════════════════════════════════════════════

// ── Get pending messages for a channel ───────────────────────
router.get('/ip-approval/:channelId/pending', (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        if (!permissions.canModerateStream(req.user, channelId) && !permissions.isGlobalModOrAbove(req.user)) {
            // Also check channel ownership
            const channel = db.getChannelById(channelId);
            if (!channel || channel.user_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }
        }
        const pending = db.getPendingIpMessages(channelId);

        // Add geo data
        const enriched = pending.map(msg => {
            let geo = null;
            if (msg.ip_address) {
                try { geo = ipUtils.lookupIp(msg.ip_address); } catch {}
            }
            return { ...msg, geo };
        });

        res.json({ pending: enriched });
    } catch (err) {
        console.error('[Mod] IP approval pending error:', err.message);
        res.status(500).json({ error: 'Failed to get pending messages' });
    }
});

// ── Approve all messages from an IP ──────────────────────────
router.post('/ip-approval/:channelId/approve', (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const { ip } = req.body;
        if (!ip) return res.status(400).json({ error: 'ip required' });

        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        if (channel.user_id !== req.user.id && !permissions.isGlobalModOrAbove(req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Get pending messages that will be approved (to broadcast them as real chat)
        const pendingMsgs = db.all(
            "SELECT * FROM pending_ip_messages WHERE channel_id = ? AND ip_address = ? AND status = 'pending'",
            [channelId, ip]
        );

        db.approveAllFromIp(channelId, ip, req.user.id);

        // Broadcast previously-held messages as real chat messages
        for (const msg of pendingMsgs) {
            if (msg.stream_id) {
                const chatMsg = {
                    type: 'chat',
                    username: msg.username,
                    user_id: msg.user_id || null,
                    anon_id: msg.anon_id || null,
                    role: msg.user_id ? 'user' : 'anon',
                    message: msg.message,
                    stream_id: msg.stream_id,
                    is_global: false,
                    profile_color: '#999',
                    timestamp: msg.created_at,
                    was_held: true,
                };
                chatServer.broadcastToStream(msg.stream_id, chatMsg);
                chatServer.forwardToGlobal(msg.stream_id, chatMsg);
            }
        }

        db.logModerationAction({
            scope_type: 'channel',
            scope_id: channelId,
            actor_user_id: req.user.id,
            action_type: 'ip_approval_approve',
            details: { ip, messages_approved: pendingMsgs.length },
        });

        res.json({ message: `IP ${ip} approved — ${pendingMsgs.length} held message(s) released`, count: pendingMsgs.length });
    } catch (err) {
        console.error('[Mod] IP approve error:', err.message);
        res.status(500).json({ error: 'Failed to approve IP' });
    }
});

// ── Deny all messages from an IP ─────────────────────────────
router.post('/ip-approval/:channelId/deny', (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const { ip } = req.body;
        if (!ip) return res.status(400).json({ error: 'ip required' });

        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        if (channel.user_id !== req.user.id && !permissions.isGlobalModOrAbove(req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        db.denyAllFromIp(channelId, ip, req.user.id);

        db.logModerationAction({
            scope_type: 'channel',
            scope_id: channelId,
            actor_user_id: req.user.id,
            action_type: 'ip_approval_deny',
            details: { ip },
        });

        res.json({ message: `IP ${ip} denied` });
    } catch (err) {
        console.error('[Mod] IP deny error:', err.message);
        res.status(500).json({ error: 'Failed to deny IP' });
    }
});

// ── Review a single pending message ──────────────────────────
router.post('/ip-approval/:channelId/review', (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const { message_id, status } = req.body;
        if (!message_id || !['approved', 'denied'].includes(status)) {
            return res.status(400).json({ error: 'message_id and status (approved/denied) required' });
        }

        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        if (channel.user_id !== req.user.id && !permissions.isGlobalModOrAbove(req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        db.reviewPendingIpMessage(parseInt(message_id), {
            status,
            reviewedBy: req.user.id,
            channelId,
        });

        res.json({ message: `Message ${status}` });
    } catch (err) {
        console.error('[Mod] IP review error:', err.message);
        res.status(500).json({ error: 'Failed to review message' });
    }
});

// ══════════════════════════════════════════════════════════════
//  IP TRACKING & ADMIN TOOLS
// ══════════════════════════════════════════════════════════════

// ── Get all IPs used by a user ───────────────────────────────
router.get('/ip/user/:userId', permissions.requireGlobalMod, (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const user = db.getUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const ips = db.getIpsByUser(userId);
        const linked = db.getLinkedAccounts(userId);

        // Also check if the user is currently connected and get their live IP
        const liveIp = chatServer.getConnectedUserIp(userId);

        res.json({
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, is_banned: user.is_banned, ban_reason: user.ban_reason, created_at: user.created_at },
            ips,
            linked_accounts: linked,
            live_ip: liveIp || null,
        });
    } catch (err) {
        console.error('[Mod] IP user lookup error:', err.message);
        res.status(500).json({ error: 'Failed to lookup user IPs' });
    }
});

// ── Get IP info for an anon ──────────────────────────────────
router.get('/ip/anon/:anonId', permissions.requireGlobalMod, (req, res) => {
    try {
        const anonId = req.params.anonId;
        const latest = db.getLatestIpForAnon(anonId);
        const linked = db.getLinkedAccountsByAnon(anonId);

        // Try to find their live IP from connected clients
        const anonClient = chatServer.findClientByAnonId(anonId);
        const liveIp = anonClient?.ip || null;
        const currentIp = liveIp || latest?.ip_address || null;

        // If we have an IP, do a GeoIP lookup
        let geo = null;
        if (currentIp) {
            geo = ipUtils.lookupIp(currentIp);
        }

        res.json({
            anon_id: anonId,
            current_ip: currentIp,
            geo,
            latest_record: latest,
            linked_accounts: linked,
        });
    } catch (err) {
        console.error('[Mod] IP anon lookup error:', err.message);
        res.status(500).json({ error: 'Failed to lookup anon IPs' });
    }
});

// ── Lookup all accounts on a specific IP ─────────────────────
router.get('/ip/lookup/:ip', permissions.requireGlobalMod, (req, res) => {
    try {
        const ip = req.params.ip;
        const users = db.getUsersByIp(ip);
        const geo = ipUtils.lookupIp(ip);
        const isBanned = db.isIpBanned(ip, null);

        res.json({ ip, geo, is_banned: isBanned, accounts: users });
    } catch (err) {
        console.error('[Mod] IP lookup error:', err.message);
        res.status(500).json({ error: 'Failed to lookup IP' });
    }
});

// ── Get linked accounts (alt detection) ──────────────────────
router.get('/ip/alts/:userId', permissions.requireGlobalMod, (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const linked = db.getLinkedAccounts(userId);
        res.json({ user_id: userId, linked_accounts: linked });
    } catch (err) {
        console.error('[Mod] Alt detection error:', err.message);
        res.status(500).json({ error: 'Failed to find linked accounts' });
    }
});

// ── Ban all accounts on an IP ────────────────────────────────
router.post('/ip/ban-all', permissions.requireGlobalMod, (req, res) => {
    try {
        const { ip, reason, duration_hours } = req.body;
        if (!ip) return res.status(400).json({ error: 'ip required' });

        const banReason = reason || 'IP-wide ban by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        const bannedIds = db.banAllAccountsOnIp(ip, {
            reason: banReason,
            bannedBy: req.user.id,
            expires,
        });

        // Disconnect all clients on this IP
        chatServer.disconnectUser({ ip });

        // Log the action
        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            action_type: 'ip_ban_all',
            details: { ip, reason: banReason, banned_user_ids: bannedIds, duration_hours: duration_hours || null },
        });

        res.json({ message: `Banned IP ${ip} and ${bannedIds.length} associated account(s)`, banned_user_ids: bannedIds });
    } catch (err) {
        console.error('[Mod] IP ban-all error:', err.message);
        res.status(500).json({ error: 'Failed to ban IP' });
    }
});

// ── Search IP history log ────────────────────────────────────
router.get('/ip/log', permissions.requireGlobalMod, (req, res) => {
    try {
        const filters = {};
        if (req.query.user_id) filters.userId = parseInt(req.query.user_id);
        if (req.query.anon_id) filters.anonId = req.query.anon_id;
        if (req.query.ip) filters.ip = req.query.ip;
        if (req.query.action) filters.action = req.query.action;
        filters.limit = Math.min(parseInt(req.query.limit || '100'), 500);
        filters.offset = parseInt(req.query.offset || '0');

        const log = db.getIpLog(filters);
        res.json({ log });
    } catch (err) {
        console.error('[Mod] IP log error:', err.message);
        res.status(500).json({ error: 'Failed to get IP log' });
    }
});

// ── Per-user TTS voice (admin: edit / re-roll the auto-assigned voice) ────────
const ttsEngine = require('../chat/tts-engine');

// Quick presets an admin can one-click apply (the streamer wanted a tiny squeaky robot).
const TTS_VOICE_PRESETS = [
    { id: 'squeaky', label: '🐭 Tiny / Squeaky', params: { voice: 'en+f3', pitch: 99, speed: 200 } },
    { id: 'chipmunk', label: '🐿️ Chipmunk', params: { voice: 'en+f5', pitch: 95, speed: 260 } },
    { id: 'deep', label: '🔊 Deep / Booming', params: { voice: 'en+m7', pitch: 5, speed: 130 } },
    { id: 'robotic', label: '🤖 Robotic', params: { voice: 'en', pitch: 40, speed: 150, gap: 8 } },
    { id: 'normal', label: '🙂 Neutral', params: { voice: 'en', pitch: 50, speed: 165 } },
];

function _ttsIdentityKey(kind, id) {
    const k = kind === 'anon' ? 'anon' : 'user';
    return `${k}:${String(id || '').trim().toLowerCase()}`;
}

// GET current voice (override or auto-assigned) + editing metadata.
router.get('/tts-voice/:kind/:id', permissions.requireGlobalMod, (req, res) => {
    try {
        const identityKey = _ttsIdentityKey(req.params.kind, req.params.id);
        const override = db.getTtsVoiceOverride(identityKey);
        const auto = ttsEngine.autoUserVoiceParams(identityKey);
        res.json({
            identityKey,
            isOverride: !!override,
            params: override ? ttsEngine.clampVoiceParams(override) : auto,
            auto,
            voices: ttsEngine.PER_USER_BASE_VOICES,
            bounds: ttsEngine.VOICE_BOUNDS,
            presets: TTS_VOICE_PRESETS,
        });
    } catch (err) {
        console.error('[Mod] tts-voice get error:', err.message);
        res.status(500).json({ error: 'Failed to load voice' });
    }
});

// PUT: set explicit params, or {reset:true} (back to auto), or {reroll:true} (new random voice).
router.put('/tts-voice/:kind/:id', permissions.requireGlobalMod, (req, res) => {
    try {
        const identityKey = _ttsIdentityKey(req.params.kind, req.params.id);
        if (req.body?.reset) {
            db.deleteTtsVoiceOverride(identityKey);
            return res.json({ isOverride: false, params: ttsEngine.autoUserVoiceParams(identityKey) });
        }
        let params;
        if (req.body?.reroll) {
            const voices = ttsEngine.PER_USER_BASE_VOICES;
            const [pLo, pHi] = ttsEngine.VOICE_BOUNDS.pitch;
            params = {
                voice: voices[Math.floor(Math.random() * voices.length)],
                pitch: pLo + Math.floor(Math.random() * (pHi - pLo + 1)),
                speed: 140 + Math.floor(Math.random() * 60), // 140..200 wpm
                gap: 0,
            };
        } else {
            params = { voice: req.body?.voice, pitch: req.body?.pitch, speed: req.body?.speed, gap: req.body?.gap };
        }
        const clamped = ttsEngine.clampVoiceParams(params);
        db.setTtsVoiceOverride(identityKey, clamped, req.user.id);
        res.json({ isOverride: true, params: clamped });
    } catch (err) {
        console.error('[Mod] tts-voice set error:', err.message);
        res.status(500).json({ error: 'Failed to save voice' });
    }
});

// POST: synthesize a short preview clip with the given params so the admin can hear it.
router.post('/tts-voice/preview', permissions.requireGlobalMod, async (req, res) => {
    try {
        const text = String(req.body?.text || 'Hey there, this is how I sound on the site!').slice(0, 160);
        const result = await ttsEngine.synthesizeWithParams(text, {
            voice: req.body?.voice, pitch: req.body?.pitch, speed: req.body?.speed, gap: req.body?.gap,
        });
        if (!result?.audio) return res.status(503).json({ error: 'TTS unavailable (espeak-ng not installed?)' });
        res.json({ audio: result.audio, mimeType: result.mimeType || 'audio/wav' });
    } catch (err) {
        console.error('[Mod] tts-voice preview error:', err.message);
        res.status(500).json({ error: 'Preview failed' });
    }
});

module.exports = router;
