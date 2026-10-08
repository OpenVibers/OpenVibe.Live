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
const delivery = require('../chat/chat-delivery');
const chatReads = require('../chat/chat-reads');
const ipUtils = require('./ip-utils');

const router = express.Router();

/** A read the console acts on failed against Chat: answer 503 (or the read's own status), never empty data. */
function chatReadError(res, err) {
    if (err && err.status) { res.status(err.status).json({ error: err.message }); return true; }
    if (err && err.unavailable) { res.status(503).json({ error: 'Chat unavailable' }); return true; }
    return false;
}

/**
 * A relay hide or unhide just changed Chat's hidden-user list: drop the cached per-channel list so
 * the next relay line sees it at once instead of waiting out the peek's TTL. A site-wide row
 * (channel_id null) changes every channel's list, so all `hru:` answers are dropped.
 */
function invalidateRelayHidden(channelId) {
    chatReads.invalidate(channelId ? `hru:${Number(channelId)}` : 'hru:');
}

// All mod routes require auth (individual routes check specific permissions)
router.use(requireAuth);

// ── List bans ────────────────────────────────────────────────
router.get('/bans', permissions.requireGlobalMod, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100'), 500);
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id) : null;
        const where = streamId ? 'WHERE b.stream_id = ?' : '';
        const params = streamId ? [streamId, limit] : [limit];
        const bans = await db.all(`
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
/**
 * Site-wide ban: the account, the IP it was last seen on, and every other account that has used
 * that IP.
 *
 * /global-ban and /users/:id/ban used to be two copies of this code. Neither checked who the
 * cascade was about to hit. getLinkedAccounts() returns every account that ever shared an IP with
 * the target — and on production all three admin accounts share an IP with some other account,
 * because staff browse from the same home and phone networks as people who have been banned. The
 * IP-ban exemption for admins only applies to sessions that are not themselves banned, so a
 * cascade that set is_banned on an admin would have locked them out of their own site.
 *
 * Staff are now never swept up by the cascade, nobody can ban themselves by association, and a
 * moderator cannot ban someone of equal or higher rank directly either.
 */
async function performGlobalBan(req, res, { userId, reason, durationHours, ipAddress }) {
    const targetUser = await db.getUserById(parseInt(userId));
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser.id === req.user.id) return res.status(400).json({ error: 'You cannot ban yourself' });
    if (permissions.isStaff(targetUser) && permissions.roleRank(targetUser.role) >= permissions.roleRank(req.user.role)) {
        return res.status(403).json({ error: 'You cannot ban staff of equal or higher rank' });
    }

    const banReason = reason || 'Banned by moderator';
    const expires = durationHours
        ? new Date(Date.now() + parseInt(durationHours) * 3600000).toISOString()
        : null;

    // Auto-detect IP from connected WebSocket clients, then fall back to IP log
    let resolvedIp = ipAddress || delivery.getConnectedUserIp(targetUser.id);
    if (!resolvedIp) {
        const latest = await db.getLatestIpForUser(targetUser.id);
        if (latest) resolvedIp = latest.ip_address;
    }

    // Set the site-wide is_banned flag
    await db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?', [banReason, targetUser.id]);
    await db.run(
        `INSERT INTO bans (user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [targetUser.id, resolvedIp, banReason, req.user.id, expires]
    );

    let cascadeBanned = 0, cascadeSkippedStaff = 0;
    if (resolvedIp) {
        // Standalone IP ban (catches future visits and new alts)
        await db.run(
            `INSERT INTO bans (ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
            [resolvedIp, banReason + ` (IP of ${targetUser.username})`, req.user.id, expires]
        );
        // Cascade: ban the other accounts that have used this IP — except staff and the moderator
        // doing the banning.
        for (const alt of await db.getLinkedAccounts(targetUser.id)) {
            if (alt.is_banned) continue;
            if (alt.id === req.user.id || permissions.isStaff(alt)) { cascadeSkippedStaff++; continue; }
            await db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
                [banReason + ` (alt of ${targetUser.username})`, alt.id]);
            await db.run(`INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
                [alt.id, banReason + ` (alt of ${targetUser.username})`, req.user.id, expires]);
            await delivery.disconnect({ userId: alt.id });
            cascadeBanned++;
        }
        if (cascadeBanned || cascadeSkippedStaff) {
            console.log(`[Mod] Global ban cascade for ${targetUser.username}: ${cascadeBanned} alt account(s) banned, ${cascadeSkippedStaff} staff account(s) on a shared IP left alone`);
        }
    }

    // Immediately disconnect the user from chat
    await delivery.disconnect({ userId: targetUser.id, ip: resolvedIp });

    await delivery.logModeration({
        scope_type: 'site',
        actor_user_id: req.user.id,
        target_user_id: targetUser.id,
        action_type: 'global_ban',
        details: { reason: banReason, duration_hours: durationHours || null, ip: resolvedIp, cascade_banned: cascadeBanned, cascade_skipped_staff: cascadeSkippedStaff },
    });

    return res.json({ message: `${targetUser.username} globally banned` });
}

router.post('/global-ban', permissions.requireGlobalMod, async (req, res) => {
    try {
        const { user_id, reason, duration_hours, ip_address } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });
        return await performGlobalBan(req, res, { userId: user_id, reason, durationHours: duration_hours, ipAddress: ip_address });
    } catch (err) {
        console.error('[Mod] Global ban error:', err.message);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// ── Per-User Ban/Unban (staff console) ───────────────────────
// Same ban, addressed by URL; both routes share performGlobalBan so they cannot drift apart again.
router.post('/users/:id/ban', permissions.requireGlobalMod, async (req, res) => {
    try {
        const { reason, duration_hours } = req.body;
        return await performGlobalBan(req, res, { userId: req.params.id, reason, durationHours: duration_hours });
    } catch (err) {
        console.error('[Mod] User ban error:', err.message);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

router.delete('/users/:id/ban', permissions.requireGlobalMod, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const targetUser = await db.getUserById(userId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        await db.run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [userId]);
        await db.run('DELETE FROM bans WHERE user_id = ? AND stream_id IS NULL', [userId]);

        await delivery.disconnect({ userId });

        await delivery.logModeration({
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
router.post('/stream-ban', async (req, res) => {
    try {
        const { user_id, anon_id, stream_id, reason, duration_hours, ip_address } = req.body;
        const streamId = parseInt(stream_id);
        if (!streamId) return res.status(400).json({ error: 'stream_id required' });
        if (!user_id && !anon_id) return res.status(400).json({ error: 'user_id or anon_id required' });

        // Check moderation permission for this stream
        if (!(await permissions.canModerateStream(req.user, streamId))) {
            return res.status(403).json({ error: 'You cannot moderate this stream' });
        }

        const banReason = reason || 'Banned by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        if (user_id) {
            const targetUser = await db.getUserById(parseInt(user_id));
            if (!targetUser) return res.status(404).json({ error: 'User not found' });

            // Auto-detect IP from connected clients if not provided
            const resolvedIp = ip_address || delivery.getConnectedUserIp(targetUser.id);

            await db.run(
                `INSERT INTO bans (stream_id, user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [streamId, targetUser.id, resolvedIp, banReason, req.user.id, expires]
            );

            // Disconnect from this stream's chat
            await delivery.disconnect({ userId: targetUser.id, ip: resolvedIp, streamId });

            await delivery.logModeration({
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
            const anonClient = delivery.findClientByAnonId(anon_id, streamId);
            const resolvedIp = ip_address || anonClient?.ip || null;

            await db.run(
                `INSERT INTO bans (stream_id, ip_address, anon_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [streamId, resolvedIp, anon_id, banReason, req.user.id, expires]
            );

            // Disconnect the anon user
            if (resolvedIp) await delivery.disconnect({ ip: resolvedIp, streamId });

            await delivery.logModeration({
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
router.delete('/ban/:id', async (req, res) => {
    try {
        const ban = await db.get('SELECT * FROM bans WHERE id = ?', [req.params.id]);
        if (!ban) return res.status(404).json({ error: 'Ban not found' });

        // Permission check: global bans require global_mod+, stream bans require stream mod
        if (!ban.stream_id) {
            if (!permissions.isGlobalModOrAbove(req.user)) {
                return res.status(403).json({ error: 'Only global mods can remove global bans' });
            }
            // Clear is_banned flag if this was a global user ban
            if (ban.user_id) {
                await db.run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [ban.user_id]);
                // Remove ALL global bans for this user (user + IP entries)
                await db.run('DELETE FROM bans WHERE user_id = ? AND stream_id IS NULL', [ban.user_id]);
                await db.run('DELETE FROM bans WHERE ip_address IS NOT NULL AND banned_by = ? AND stream_id IS NULL AND reason ILIKE ?',
                    [ban.banned_by, '%' + (ban.reason || '') + '%']);
            }
        } else {
            if (!(await permissions.canModerateStream(req.user, ban.stream_id))) {
                return res.status(403).json({ error: 'You cannot moderate this stream' });
            }
        }

        await db.run('DELETE FROM bans WHERE id = ?', [req.params.id]);

        await delivery.logModeration({
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
// Unscoped: searches every channel's chat, by user or by text. Every other route in this file
// checks a permission in its body; these two had none, so requireAuth alone let any signed-in
// account read anyone's chat history site-wide. Their only caller is the staff console.
router.get('/chat/search', permissions.requireGlobalMod, async (req, res) => {
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

        const result = await chatReads.searchMessages({ query, userId, anonId, username, streamId, limit, offset });
        res.json(result || { messages: [], total: 0 });
    } catch (err) {
        if (chatReadError(res, err)) return;
        res.status(500).json({ error: 'Search failed' });
    }
});

// ── View a user's chat history ───────────────────────────────
router.get('/chat/user/:userId', permissions.requireGlobalMod, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');

        const result = await chatReads.userHistory(userId, { limit, offset });
        res.json(result || { messages: [], total: 0 });
    } catch (err) {
        if (chatReadError(res, err)) return;
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

// ══════════════════════════════════════════════════════════════
//  MESSAGE DELETION
// ══════════════════════════════════════════════════════════════

// ── Delete a single chat message ─────────────────────────────
router.post('/delete-message', async (req, res) => {
    try {
        const { message_id, stream_id } = req.body;
        if (!message_id) return res.status(400).json({ error: 'message_id required' });

        const message = await chatReads.messageById(parseInt(message_id));
        if (!message) return res.status(404).json({ error: 'Message not found' });

        // Permission: stream mod can delete messages in their stream, global mod can delete anything.
        // Checked against the MESSAGE's own stream or channel. It used to prefer the stream_id in the
        // request body, so the owner of any stream could delete any message on the site by naming
        // their own stream alongside someone else's message id. `stream_id` is ignored now.
        void stream_id;
        const isGlobal = permissions.isGlobalModOrAbove(req.user);
        if (!isGlobal) {
            let allowed = false;
            if (message.stream_id) allowed = await permissions.canModerateStream(req.user, message.stream_id);
            else if (message.channel_user_id) {
                const ownerChannel = await db.getChannelByUserId(message.channel_user_id);
                allowed = !!(ownerChannel && await permissions.canModerateChannel(req.user, ownerChannel.id));
            }
            if (!allowed) return res.status(403).json({ error: 'You cannot moderate this stream' });
        }

        // Chat deletes the row and broadcasts the delete to every surface it reached.
        await delivery.moderate('delete-message', { id: parseInt(message_id), deleted_by: req.user.id }, { key: `delete:${message_id}` });

        await delivery.logModeration({
            scope_type: message.stream_id ? 'stream' : 'site',
            scope_id: message.stream_id || undefined,
            actor_user_id: req.user.id,
            target_user_id: message.user_id || undefined,
            action_type: 'message_delete',
            details: { message_id: parseInt(message_id) },
        });

        res.json({ message: 'Message deleted', ids: [parseInt(message_id)] });
    } catch (err) {
        if (chatReadError(res, err)) return;
        console.error('[Mod] Delete message error:', err.message);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// ── Bulk-delete all messages from a user/anon/relay ──────────
router.post('/delete-user-messages', async (req, res) => {
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
            if (!(await permissions.canModerateStream(req.user, stream_id))) {
                return res.status(403).json({ error: 'You cannot moderate this stream' });
            }
        }

        // Chat deletes the rows and broadcasts the deletes (also the site-wide one) itself.
        const [action, subject] = user_id ? ['delete-user-messages', { user_id: parseInt(user_id) }]
            : anon_id ? ['delete-anon-messages', { anon_id: String(anon_id) }] : ['delete-relay-messages', { username: String(relay_username) }];
        const scoped = { stream_id: scopedStreamId ? parseInt(scopedStreamId) : undefined, deleted_by: req.user.id };
        const r = await delivery.moderate(action, { ...subject, ...scoped });
        const ids = (r && Array.isArray(r.ids)) ? r.ids : [];

        const target = user_id ? `user ${user_id}` : anon_id ? `anon ${anon_id}` : `relay ${relay_username}`;
        await delivery.logModeration({
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
router.post('/relay-user/hide', async (req, res) => {
    try {
        const { channel_id, platform, external_username, action, reason } = req.body;
        if (!platform || !external_username) {
            return res.status(400).json({ error: 'platform and external_username required' });
        }

        // Permission: channel owner/mod or global mod
        const isGlobal = permissions.isGlobalModOrAbove(req.user);
        // Without a channel_id the hide is site-wide, which is staff business. Channel owners and
        // their mods act on their own channel. (Leaving channel_id out used to skip the check.)
        if (!isGlobal) {
            if (!channel_id) return res.status(403).json({ error: 'Only staff can hide relay users site-wide' });
            const channel = await db.getChannelById(channel_id);
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
            if (!(await permissions.canModerateChannel(req.user, channel.id))) {
                return res.status(403).json({ error: 'You cannot moderate this channel' });
            }
        }

        // Unban / unhide — remove the ban for this exact relay identity only.
        if (action === 'unban' || action === 'unhide') {
            await delivery.moderate('relay-unhide', { channel_id: channel_id || undefined, platform, external_username });
            invalidateRelayHidden(channel_id || null);
            await delivery.logModeration({
                scope_type: channel_id ? 'channel' : 'site',
                scope_id: channel_id || undefined,
                actor_user_id: req.user.id,
                action_type: 'relay_user_unhide',
                details: { platform, external_username },
            });
            return res.json({ message: `[${platform}] ${external_username} unbanned` });
        }

        await delivery.moderate('relay-hide', { channel_id: channel_id || undefined, platform, external_username, mode: action || 'hide', reason: reason || undefined, created_by: req.user.id });
        invalidateRelayHidden(channel_id || null);

        await delivery.logModeration({
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
router.delete('/relay-user/:id', async (req, res) => {
    try {
        const row = await chatReads.relayUser(parseInt(req.params.id));
        if (!row) return res.status(404).json({ error: 'Not found' });
        // Site rows are staff's; a channel row belongs to that channel's moderators. This had no check.
        const allowed = permissions.isGlobalModOrAbove(req.user)
            || (row.channel_id != null && await permissions.canModerateChannel(req.user, row.channel_id));
        if (!allowed) return res.status(403).json({ error: 'You cannot moderate this channel' });
        await delivery.moderate('relay-unhide', { id: row.id });
        invalidateRelayHidden(row.channel_id);

        await delivery.logModeration({
            scope_type: 'site',
            actor_user_id: req.user.id,
            action_type: 'relay_user_unhide',
            details: { id: parseInt(req.params.id) },
        });

        res.json({ message: 'Relay user unhidden' });
    } catch (err) {
        if (chatReadError(res, err)) return;
        console.error('[Mod] Relay user unhide error:', err.message);
        res.status(500).json({ error: 'Failed to unhide relay user' });
    }
});

// ── List hidden relay users for a channel ────────────────────
router.get('/relay-users/hidden/:channelId', async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        if (!(await permissions.canModerateChannel(req.user, channelId))) return res.status(403).json({ error: 'Access denied' });
        const hidden = await chatReads.relayUsers(channelId);
        res.json({ hidden });
    } catch (err) {
        if (chatReadError(res, err)) return;
        console.error('[Mod] List hidden relay users error:', err.message);
        res.status(500).json({ error: 'Failed to list hidden relay users' });
    }
});

// ══════════════════════════════════════════════════════════════
//  IP APPROVAL QUEUE (Anti-VPN Mode)
// ══════════════════════════════════════════════════════════════

// ── Get pending messages for a channel ───────────────────────
router.get('/ip-approval/:channelId/pending', async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        // A channel id, checked as a channel. canModerateStream() was given this id as if it were a
        // stream id, so owning stream #N opened channel #N's queue — IP addresses and locations.
        if (!(await permissions.canModerateChannel(req.user, channelId))) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const pending = await chatReads.pendingIp(channelId);

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
        if (chatReadError(res, err)) return;
        console.error('[Mod] IP approval pending error:', err.message);
        res.status(500).json({ error: 'Failed to get pending messages' });
    }
});

// ── Approve all messages from an IP ──────────────────────────
router.post('/ip-approval/:channelId/approve', async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const { ip } = req.body;
        if (!ip) return res.status(400).json({ error: 'ip required' });

        const channel = await db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        if (channel.user_id !== req.user.id && !permissions.isGlobalModOrAbove(req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // The held rows this IP is about — Chat holds them; Live keeps no queue. Live only needs
        // the count for its answer and log: Chat releases them and broadcasts.
        const pendingMsgs = (await chatReads.pendingIp(channelId, { limit: 500 })).filter((m) => m.ip_address === ip);

        await delivery.moderate('approve-ip-messages', { channel_id: parseInt(channelId), ip, reviewed_by: req.user.id });

        await delivery.logModeration({
            scope_type: 'channel',
            scope_id: channelId,
            actor_user_id: req.user.id,
            action_type: 'ip_approval_approve',
            details: { ip, messages_approved: pendingMsgs.length },
        });

        res.json({ message: `IP ${ip} approved — ${pendingMsgs.length} held message(s) released`, count: pendingMsgs.length });
    } catch (err) {
        if (chatReadError(res, err)) return;
        console.error('[Mod] IP approve error:', err.message);
        res.status(500).json({ error: 'Failed to approve IP' });
    }
});

// ── Deny all messages from an IP ─────────────────────────────
router.post('/ip-approval/:channelId/deny', async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const { ip } = req.body;
        if (!ip) return res.status(400).json({ error: 'ip required' });

        const channel = await db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        if (channel.user_id !== req.user.id && !permissions.isGlobalModOrAbove(req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await delivery.moderate('deny-ip-messages', { channel_id: parseInt(channelId), ip, reviewed_by: req.user.id });

        await delivery.logModeration({
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
router.post('/ip-approval/:channelId/review', async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const { message_id, status } = req.body;
        if (!message_id || !['approved', 'denied'].includes(status)) {
            return res.status(400).json({ error: 'message_id and status (approved/denied) required' });
        }

        const channel = await db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        if (channel.user_id !== req.user.id && !permissions.isGlobalModOrAbove(req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await delivery.moderate('review-pending-ip', { id: parseInt(message_id), status, reviewed_by: req.user.id, channel_id: parseInt(channelId) });

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
router.get('/ip/user/:userId', permissions.requireGlobalMod, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const user = await db.getUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const ips = await db.getIpsByUser(userId);
        const linked = await db.getLinkedAccounts(userId);

        // Also check if the user is currently connected and get their live IP
        const liveIp = delivery.getConnectedUserIp(userId);

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
router.get('/ip/anon/:anonId', permissions.requireGlobalMod, async (req, res) => {
    try {
        const anonId = req.params.anonId;
        const latest = await db.getLatestIpForAnon(anonId);
        const linked = await db.getLinkedAccountsByAnon(anonId);

        // Try to find their live IP from connected clients
        const anonClient = delivery.findClientByAnonId(anonId);
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
router.get('/ip/lookup/:ip', permissions.requireGlobalMod, async (req, res) => {
    try {
        const ip = req.params.ip;
        const users = await db.getUsersByIp(ip);
        const geo = ipUtils.lookupIp(ip);
        const isBanned = await db.isIpBanned(ip, null);

        res.json({ ip, geo, is_banned: isBanned, accounts: users });
    } catch (err) {
        console.error('[Mod] IP lookup error:', err.message);
        res.status(500).json({ error: 'Failed to lookup IP' });
    }
});

// ── Get linked accounts (alt detection) ──────────────────────
router.get('/ip/alts/:userId', permissions.requireGlobalMod, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const linked = await db.getLinkedAccounts(userId);
        res.json({ user_id: userId, linked_accounts: linked });
    } catch (err) {
        console.error('[Mod] Alt detection error:', err.message);
        res.status(500).json({ error: 'Failed to find linked accounts' });
    }
});

// ── Ban all accounts on an IP ────────────────────────────────
router.post('/ip/ban-all', permissions.requireGlobalMod, async (req, res) => {
    try {
        const { ip, reason, duration_hours } = req.body;
        if (!ip) return res.status(400).json({ error: 'ip required' });

        const banReason = reason || 'IP-wide ban by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        const bannedIds = await db.banAllAccountsOnIp(ip, {
            reason: banReason,
            bannedBy: req.user.id,
            expires,
        });

        // Disconnect all clients on this IP
        await delivery.disconnect({ ip });

        // Log the action
        await delivery.logModeration({
            scope_type: 'site',
            actor_user_id: req.user.id,
            action_type: 'ip_ban_all',
            details: { ip, reason: banReason, banned_user_ids: [...bannedIds], skipped_staff_ids: bannedIds.skippedStaff || [], duration_hours: duration_hours || null },
        });

        const skipped = (bannedIds.skippedStaff || []).length;
        res.json({
            message: `Banned IP ${ip} and ${bannedIds.length} associated account(s)` + (skipped ? ` — ${skipped} staff account(s) on this IP were not banned` : ''),
            banned_user_ids: [...bannedIds],
            skipped_staff_ids: bannedIds.skippedStaff || [],
        });
    } catch (err) {
        console.error('[Mod] IP ban-all error:', err.message);
        res.status(500).json({ error: 'Failed to ban IP' });
    }
});

// ── Search IP history log ────────────────────────────────────
router.get('/ip/log', permissions.requireGlobalMod, async (req, res) => {
    try {
        const filters = {};
        if (req.query.user_id) filters.userId = parseInt(req.query.user_id);
        if (req.query.anon_id) filters.anonId = req.query.anon_id;
        if (req.query.ip) filters.ip = req.query.ip;
        if (req.query.action) filters.action = req.query.action;
        filters.limit = Math.min(parseInt(req.query.limit || '100'), 500);
        filters.offset = parseInt(req.query.offset || '0');

        const log = await db.getIpLog(filters);
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
router.get('/tts-voice/:kind/:id', permissions.requireGlobalMod, async (req, res) => {
    try {
        const identityKey = _ttsIdentityKey(req.params.kind, req.params.id);
        const override = await chatReads.ttsOverride(identityKey);
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
        if (chatReadError(res, err)) return;
        console.error('[Mod] tts-voice get error:', err.message);
        res.status(500).json({ error: 'Failed to load voice' });
    }
});

// PUT: set explicit params, or {reset:true} (back to auto), or {reroll:true} (new random voice).
router.put('/tts-voice/:kind/:id', permissions.requireGlobalMod, async (req, res) => {
    try {
        const identityKey = _ttsIdentityKey(req.params.kind, req.params.id);
        if (req.body?.reset) {
            await delivery.moderate('tts-voice-override', { identity_key: identityKey });
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
        await delivery.moderate('tts-voice-override', { identity_key: identityKey, params: clamped, set_by: req.user.id });
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
        let url = null; try { const stashed = require('../arena/voice').stash(result.audio, result.mimeType); if (stashed) url = `/api/tts/audio/${stashed.file}`; } catch { /* */ }
        res.json({ audio: result.audio, mimeType: result.mimeType || 'audio/wav', url });
    } catch (err) {
        console.error('[Mod] tts-voice preview error:', err.message);
        res.status(500).json({ error: 'Preview failed' });
    }
});

module.exports = router;
