/**
 * OpenVibe.Live — Comments API Routes (/api/comments)
 *
 * Comments on VODs/clips are Live-local social data (comments table in live.db);
 * only the commented-on content lives in OpenVibe.Media now, so target lookups
 * (owner, title) go through the media client.
 */
'use strict';
const express = require('express');
const db = require('../db/database');
const media = require('../media-client');
const { requireAuth, optionalAuth } = require('../auth/auth');
const { pushNotification, actorInfo: notificationActor } = require('../utils/notify');

const router = express.Router();

function truncatePreview(text, max = 120) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function getCommentTarget(contentType, contentId) {
    try {
        if (contentType === 'vod') {
            const vod = await media.getVod(contentId);
            if (!vod) return null;
            return { user_id: vod.user_id, title: vod.title || 'your VOD', label: 'VOD', url: `https://openvibe.live/vod/${contentId}` };
        }
        if (contentType === 'clip') {
            const clip = await media.getClip(contentId);
            if (!clip) return null;
            return { user_id: clip.user_id, title: clip.title || 'your clip', label: 'clip', url: `https://openvibe.live/clip/${contentId}`, stream_id: clip.stream_id || null };
        }
    } catch { /* Media unreachable → treat as not found */ }
    return null;
}

// ── List Comments ────────────────────────────────────────────
router.get('/:type/:id', optionalAuth, (req, res) => {
    try {
        const contentType = req.params.type;
        const contentId = parseInt(req.params.id);
        if (!['vod', 'clip'].includes(contentType) || !contentId) {
            return res.status(400).json({ error: 'Invalid content type or ID' });
        }
        const limit = Math.min(parseInt(req.query.limit || '50'), 100);
        const offset = parseInt(req.query.offset || '0');
        const comments = db.getComments(contentType, contentId, limit, offset);
        const totalCount = db.getCommentCount(contentType, contentId);
        for (const c of comments) {
            const replies = db.getCommentReplies(c.id);
            c.replies = replies;
            c.reply_count = replies.length;
        }
        res.json({ comments, total: totalCount });
    } catch (err) {
        console.error('[Comments] List error:', err.message);
        res.status(500).json({ error: 'Failed to get comments' });
    }
});

// ── Add Comment ──────────────────────────────────────────────
router.post('/:type/:id', requireAuth, async (req, res) => {
    try {
        const contentType = req.params.type;
        const contentId = parseInt(req.params.id);
        if (!['vod', 'clip'].includes(contentType) || !contentId) {
            return res.status(400).json({ error: 'Invalid content type or ID' });
        }
        const message = (req.body.message || '').trim();
        if (!message || message.length > 2000) {
            return res.status(400).json({ error: 'Comment must be 1-2000 characters' });
        }
        const parentId = req.body.parent_id ? parseInt(req.body.parent_id) : null;
        const target = await getCommentTarget(contentType, contentId);
        if (!target) return res.status(404).json({ error: 'Content not found' });

        let parent = null;
        if (parentId) {
            parent = db.getCommentById(parentId);
            if (!parent || parent.content_type !== contentType || parent.content_id !== contentId) {
                return res.status(400).json({ error: 'Invalid parent comment' });
            }
        }

        const result = db.createComment({
            content_type: contentType,
            content_id: contentId,
            user_id: req.user.id,
            parent_id: parentId,
            message,
        });

        const comment = db.get(`
            SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
            FROM comments c JOIN users u ON c.user_id = u.id
            WHERE c.id = ?
        `, [result.lastInsertRowid]);

        const actor = notificationActor(req.user);
        const recipients = new Map();
        if (target.user_id && target.user_id !== req.user.id) {
            recipients.set(target.user_id, {
                user_id: target.user_id,
                type: parentId ? 'CONTENT_REPLY' : 'CONTENT_COMMENT',
                category: 'social',
                priority: 'normal',
                title: parentId ? `New reply on your ${target.label}` : `New comment on your ${target.label}`,
                message: `${actor.sender_name} ${parentId ? 'replied on' : 'commented on'} "${truncatePreview(target.title, 80)}"`,
                icon: parentId ? '↩️' : '💬',
                ...actor,
                service: 'live',
                url: `${target.url}#comments`,
                rich_content: {
                    body: truncatePreview(message, 180),
                    context: { content_type: contentType, content_id: contentId, comment_id: comment.id, parent_id: parentId || null },
                },
            });
        }
        if (parent?.user_id && parent.user_id !== req.user.id) {
            recipients.set(parent.user_id, {
                user_id: parent.user_id,
                type: 'CONTENT_REPLY',
                category: 'social',
                priority: 'normal',
                title: 'New reply to your comment',
                message: `${actor.sender_name} replied to your comment on "${truncatePreview(target.title, 80)}"`,
                icon: '↩️',
                ...actor,
                service: 'live',
                url: `${target.url}#comments`,
                rich_content: {
                    body: truncatePreview(message, 180),
                    context: { content_type: contentType, content_id: contentId, comment_id: comment.id, parent_id: parentId },
                },
            });
        }
        for (const payload of recipients.values()) pushNotification(payload);

        res.status(201).json({ comment });
    } catch (err) {
        console.error('[Comments] Create error:', err.message);
        res.status(500).json({ error: 'Failed to post comment' });
    }
});

// ── Get Replies ──────────────────────────────────────────────
router.get('/:commentId/replies', optionalAuth, (req, res) => {
    try {
        const replies = db.getCommentReplies(parseInt(req.params.commentId));
        res.json({ replies });
    } catch {
        res.status(500).json({ error: 'Failed to get replies' });
    }
});

// ── Edit Comment ─────────────────────────────────────────────
router.put('/:commentId', requireAuth, (req, res) => {
    try {
        const comment = db.getCommentById(req.params.commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const message = (req.body.message || '').trim();
        if (!message || message.length > 2000) {
            return res.status(400).json({ error: 'Comment must be 1-2000 characters' });
        }
        db.updateComment(comment.id, message);
        res.json({ message: 'Comment updated' });
    } catch {
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// ── Delete Comment ───────────────────────────────────────────
router.delete('/:commentId', requireAuth, async (req, res) => {
    try {
        const comment = db.getCommentById(req.params.commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });

        let canDelete = (comment.user_id === req.user.id) || (req.user.role === 'admin');
        if (!canDelete) {
            const target = await getCommentTarget(comment.content_type, comment.content_id);
            if (target && target.user_id === req.user.id) canDelete = true;
            if (!canDelete && target?.stream_id) {
                const stream = db.getStreamById(target.stream_id);
                if (stream && stream.user_id === req.user.id) canDelete = true;
            }
        }
        if (!canDelete) return res.status(403).json({ error: 'Not authorized' });

        db.deleteComment(comment.id);
        res.json({ message: 'Comment deleted' });
    } catch {
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

module.exports = router;
