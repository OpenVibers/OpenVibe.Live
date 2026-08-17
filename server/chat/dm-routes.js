/**
 * OpenVibe.Live — DM REST API Routes
 *
 * GET  /api/dm/conversations          — list conversations
 * POST /api/dm/conversations          — create or get 1-on-1 / group
 * GET  /api/dm/conversations/:id      — get conversation details + participants
 * GET  /api/dm/conversations/:id/messages — paginated messages
 * POST /api/dm/conversations/:id/messages — send a message
 * POST /api/dm/conversations/:id/read — mark conversation read
 * POST /api/dm/conversations/:id/participants — add participant to group
 * DELETE /api/dm/conversations/:id/participants/:userId — remove participant
 * PATCH /api/dm/conversations/:id     — rename group
 * GET  /api/dm/unread                 — total unread count
 * GET  /api/dm/users/search           — search users for new-message picker
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/auth');
const dm = require('./dm');

// All DM routes require authentication
router.use(requireAuth);

// ── Per-user rate limiting (in-memory sliding window) ────────
const _rateBuckets = new Map();
const RATE_MSG_MAX = 10, RATE_MSG_WINDOW = 60_000;       // 10 messages / 60s
const RATE_CONV_MAX = 5, RATE_CONV_WINDOW = 3_600_000;   // 5 new conversations / hour
const MAX_GROUP_SIZE = 20;

function _checkRate(userId, bucket, max, windowMs) {
    if (!_rateBuckets.has(userId)) _rateBuckets.set(userId, { messages: [], convos: [] });
    const u = _rateBuckets.get(userId);
    const now = Date.now(), cutoff = now - windowMs;
    u[bucket] = u[bucket].filter(t => t > cutoff);
    if (u[bucket].length >= max) return false;
    u[bucket].push(now);
    return true;
}
setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [uid, b] of _rateBuckets) {
        b.messages = b.messages.filter(t => t > cutoff);
        b.convos = b.convos.filter(t => t > cutoff);
        if (!b.messages.length && !b.convos.length) _rateBuckets.delete(uid);
    }
}, 300_000);

// List conversations for current user
router.get('/conversations', (req, res) => {
    try {
        const conversations = dm.getConversations(req.user.id);
        // Attach participant info to each conversation
        for (const conv of conversations) {
            conv.participants = dm.getParticipants(conv.id);
        }
        res.json({ conversations });
    } catch (err) {
        console.error('[DM] List conversations error:', err.message);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

// Create or get a conversation
router.post('/conversations', (req, res) => {
    try {
        const { user_ids, name } = req.body;
        if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
            return res.status(400).json({ error: 'user_ids array required' });
        }
        const participantIds = [...new Set([req.user.id, ...user_ids.map(Number).filter(Boolean)])];
        if (participantIds.length < 2) {
            return res.status(400).json({ error: 'Need at least one other user' });
        }
        if (participantIds.length > MAX_GROUP_SIZE) {
            return res.status(400).json({ error: `Groups are limited to ${MAX_GROUP_SIZE} members` });
        }

        // Rate limit conversation creation
        if (!_checkRate(req.user.id, 'convos', RATE_CONV_MAX, RATE_CONV_WINDOW)) {
            return res.status(429).json({ error: 'Too many new conversations. Try again later.' });
        }

        // New account restriction
        const accountCheck = dm.isAccountTooNew(req.user.id, 5);
        if (accountCheck.tooNew) {
            return res.status(403).json({ error: `Your account is too new to start conversations. Please wait ${accountCheck.minutesRemaining} more minute(s).` });
        }

        // Validate all target users exist, aren't banned, aren't blocked
        const userDb = require('../db/database');
        for (const uid of participantIds) {
            if (uid === req.user.id) continue;
            const target = userDb.getUserById(uid);
            if (!target) return res.status(400).json({ error: 'User not found' });
            if (target.is_banned) return res.status(400).json({ error: 'Cannot message banned users' });
            if (dm.isBlockedEither(req.user.id, uid)) {
                return res.status(403).json({ error: 'Cannot start a conversation with this user' });
            }
        }

        let conversationId;
        if (participantIds.length === 2) {
            const otherId = participantIds.find(id => id !== req.user.id);
            conversationId = dm.getOrCreateDirect(req.user.id, otherId);
        } else {
            const safeName = name ? String(name).replace(/<[^>]*>/g, '').replace(/[\\`'"<>(){};:/\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) : null;
            conversationId = dm.createConversation(req.user.id, participantIds, safeName);
        }

        const conversation = dm.getConversation(conversationId);
        conversation.participants = dm.getParticipants(conversationId);
        res.json({ conversation });
    } catch (err) {
        console.error('[DM] Create conversation error:', err.message);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

// Get conversation details
router.get('/conversations/:id', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const conversation = dm.getConversation(convId);
        if (!conversation) return res.status(404).json({ error: 'Not found' });
        conversation.participants = dm.getParticipants(convId);
        res.json({ conversation });
    } catch (err) {
        console.error('[DM] Get conversation error:', err.message);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// Get messages (paginated)
router.get('/conversations/:id/messages', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const before = parseInt(req.query.before) || null;
        const after = parseInt(req.query.after) || null;
        const messages = dm.getMessages(convId, limit, before, after);
        res.json({ messages });
    } catch (err) {
        console.error('[DM] Get messages error:', err.message);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// Send a message
router.post('/conversations/:id/messages', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }

        // Per-user message rate limit
        if (!_checkRate(req.user.id, 'messages', RATE_MSG_MAX, RATE_MSG_WINDOW)) {
            return res.status(429).json({ error: 'Slow down! You\'re sending messages too fast.' });
        }

        // Block check for 1-on-1 conversations
        const conv = dm.getConversation(convId);
        if (conv && !conv.is_group) {
            const participants = dm.getParticipants(convId);
            const other = participants.find(p => p.id !== req.user.id);
            if (other && dm.isBlockedEither(req.user.id, other.id)) {
                return res.status(403).json({ error: 'Cannot send messages in this conversation' });
            }
        }

        const { message } = req.body;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: 'Message required' });
        }

        const msg = dm.sendMessage(convId, req.user.id, message);
        if (!msg) return res.status(400).json({ error: 'Failed to send' });

        // Attach sender info
        const db = require('../db/database');
        const sender = db.getUserById(req.user.id);
        msg.username = sender?.username;
        msg.display_name = sender?.display_name;
        msg.avatar_url = sender?.avatar_url;
        msg.profile_color = sender?.profile_color;

        // Real-time delivery via chat WebSocket
        try {
            const chatServer = require('./chat-server');
            const participants = dm.getParticipants(convId);
            for (const p of participants) {
                if (p.id === req.user.id) continue; // skip sender
                chatServer.sendDm(p.id, {
                    type: 'dm',
                    conversation_id: convId,
                    message: msg,
                });
            }
        } catch { /* non-critical */ }

        // Push notifications to other participants (for when they're offline)
        try {
            const { pushBulkNotification, actorInfo } = require('../utils/notify');
            const participants = dm.getParticipants(convId);
            const otherIds = participants.filter(p => p.id !== req.user.id).map(p => p.id);
            if (otherIds.length) {
                const senderName = sender?.display_name || sender?.username || 'Someone';
                // Use generic preview — actual message content is only in real-time delivery
                const preview = 'Sent you a message';
                pushBulkNotification(otherIds, {
                    type: 'DIRECT_MESSAGE',
                    title: `Message from ${senderName}`,
                    message: preview,
                    url: `https://openvibe.live/dm/${convId}`,
                    ...actorInfo(sender),
                });
            }
        } catch { /* non-critical */ }

        res.json({ message: msg });
    } catch (err) {
        console.error('[DM] Send message error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Mark conversation read
router.post('/conversations/:id/read', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        dm.markRead(convId, req.user.id);

        // Clear matching DM notifications in openvibe-tools
        try {
            const { markNotificationsRead } = require('../utils/notify');
            markNotificationsRead(req.user.id, 'DIRECT_MESSAGE', `%/dm/${convId}`);
        } catch { /* non-critical */ }

        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Mark read error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Add participant to group
router.post('/conversations/:id/participants', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });

        // Validate target user exists, isn't banned, isn't blocked
        const userDb = require('../db/database');
        const target = userDb.getUserById(user_id);
        if (!target) return res.status(400).json({ error: 'User not found' });
        if (target.is_banned) return res.status(400).json({ error: 'Cannot add banned users' });
        if (dm.isBlockedEither(req.user.id, user_id)) {
            return res.status(403).json({ error: 'Cannot add this user' });
        }

        // Group size limit
        if (dm.getParticipantCount(convId) >= MAX_GROUP_SIZE) {
            return res.status(400).json({ error: `Group is full (max ${MAX_GROUP_SIZE} members)` });
        }

        dm.addParticipant(convId, user_id);
        const participants = dm.getParticipants(convId);

        // Notify all participants about the new member
        try {
            const chatServer = require('./chat-server');
            for (const p of participants) {
                chatServer.sendDm(p.id, {
                    type: 'dm-participant-added',
                    conversation_id: convId,
                    user_id,
                    participants,
                });
            }
        } catch { /* non-critical */ }

        res.json({ participants });
    } catch (err) {
        console.error('[DM] Add participant error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Remove participant from group
router.delete('/conversations/:id/participants/:userId', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const targetUserId = parseInt(req.params.userId);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        // Can only remove self (leave) or be the creator
        const conv = dm.getConversation(convId);
        if (targetUserId !== req.user.id && conv?.created_by !== req.user.id) {
            return res.status(403).json({ error: 'Only the creator can remove others' });
        }
        dm.removeParticipant(convId, targetUserId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Remove participant error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Rename group conversation
router.patch('/conversations/:id', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        let { name } = req.body;
        if (name) {
            name = String(name).replace(/<[^>]*>/g, '').replace(/[\\`'"<>(){};:/\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
        }
        dm.renameConversation(convId, name || null);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Rename error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Total unread count
router.get('/unread', (req, res) => {
    try {
        const total = dm.getTotalUnread(req.user.id);
        res.json({ unread: total });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// Search users for new-message picker
router.get('/users/search', (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json({ users: [] });
        const users = dm.searchUsers(q, req.user.id);
        res.json({ users });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ── Block & message management ───────────────────────────────

// Block a user
router.post('/blocks/:userId', (req, res) => {
    try {
        const targetId = parseInt(req.params.userId);
        if (!targetId || targetId === req.user.id) {
            return res.status(400).json({ error: 'Invalid user' });
        }
        dm.blockUser(req.user.id, targetId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Block error:', err.message);
        res.status(500).json({ error: 'Failed to block user' });
    }
});

// Unblock a user
router.delete('/blocks/:userId', (req, res) => {
    try {
        const targetId = parseInt(req.params.userId);
        dm.unblockUser(req.user.id, targetId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Unblock error:', err.message);
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

// List blocked users
router.get('/blocks', (req, res) => {
    try {
        const blocked = dm.getBlockedUsers(req.user.id);
        res.json({ blocked });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load blocked users' });
    }
});

// Check if a specific user is blocked
router.get('/blocks/check/:userId', (req, res) => {
    try {
        const targetId = parseInt(req.params.userId);
        res.json({ blocked: dm.hasBlocked(req.user.id, targetId) });
    } catch {
        res.json({ blocked: false });
    }
});

// Delete own message
router.delete('/conversations/:id/messages/:msgId', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const msgId = parseInt(req.params.msgId);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const deleted = dm.deleteMessage(msgId, req.user.id);
        if (!deleted) return res.status(403).json({ error: 'Cannot delete this message' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Delete message error:', err.message);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

module.exports = router;
