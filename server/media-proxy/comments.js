/**
 * OpenVibe.Live — Comments API Routes (/api/comments)
 *
 * Comments on VODs and clips are OpenVibe.Community threads (roadmap Wave 5); these routes are an
 * adapter over them (server/comments-client.js) that keeps the paths and response shapes the SPA
 * uses. Live still decides who may see the commented-on VOD/clip (./access — a private one is
 * missing to everyone but its owners and staff, and so are its comments) and who may delete a
 * comment (its author, staff, or the item's owners); Community stores the comments, enforces its
 * own limits, and does the moderation.
 *
 * Commenting needs a signed-in account (as before; Community refuses anonymous comments on Live
 * threads too). If Community cannot be reached every route answers 503 "Comments are unavailable
 * right now" — never an empty list that looks real.
 *
 * Live's old `comments` table is read-only: it is only the source of the one-time import
 * (OpenVibe.Community scripts/import-live-comments.js).
 */
'use strict';
const express = require('express');
const db = require('../db/database');
const media = require('../media-client');
const comments = require('../comments-client');
const permissions = require('../auth/permissions');
const { requireAuth, optionalAuth } = require('../auth/auth');
const { pushNotification, actorInfo: notificationActor } = require('../utils/notify');
const access = require('./access');

const router = express.Router();
const MAX_MESSAGE = 2000;
const MAX_OFFSET = 1000;
const MAX_REPLIES = 500;
const HIDDEN = { error: 'Comments are hidden here', code: 'comments_hidden' };

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
            return { row: vod, user_id: vod.user_id, title: vod.title || 'your VOD', label: 'VOD', url: `https://openvibe.live/vod/${contentId}` };
        }
        if (contentType === 'clip') {
            const clip = await media.getClip(contentId);
            if (!clip) return null;
            return { row: clip, user_id: clip.user_id, title: clip.title || 'your clip', label: 'clip', url: `https://openvibe.live/clip/${contentId}`, stream_id: clip.stream_id || null };
        }
    } catch { /* Media unreachable → treat as not found */ }
    return null;
}

/**
 * The commented-on VOD/clip, if this caller may see it. A private one is missing to everyone but
 * its owners and staff (./access), so its comments are too — they quote and discuss it.
 */
async function visibleTarget(user, contentType, contentId) {
    const target = await getCommentTarget(contentType, contentId);
    return target && access.canView(user, target.row) ? target : null;
}

function sendError(res, err, fallback) {
    if (err instanceof comments.CommentsError) {
        const body = { error: err.message };
        if (err.status === 503) body.code = 'comments_unavailable';
        return res.status(err.status).json(body);
    }
    console.error(`[Comments] ${fallback}:`, err && err.message);
    return res.status(500).json({ error: fallback });
}

const viewerSubject = async (user) => (user ? comments.subjectForLiveUser(user.id) : null);

/** How this viewer may delete a comment on this target: 'author' | 'staff' | 'owner' | null. */
function deleteRight(user, subject, c, target) {
    if (!user || c.deleted) return null;
    if (subject && c.author && c.author.subject === subject) return 'author';
    if (permissions.isStaff(user)) return 'staff';
    if (target && access.ownerIds(target.row).includes(Number(user.id))) return 'owner';
    return null;
}

/**
 * A Community comment in the shape /api/comments always returned (the old row plus the author's
 * Live profile), with the Community fields the SPA can use on top.
 */
function shape(c, ctx) {
    const a = c.author || null;
    const liveUserId = a && a.subject ? comments.liveUserForSubject(a.subject) : null;
    const u = liveUserId ? db.getUserById(liveUserId) : null;
    const edited = c.edited_at || null;
    const out = {
        id: c.id,
        content_type: ctx.type,
        content_id: ctx.id,
        user_id: u ? u.id : null,
        subject: a ? a.subject || null : null,
        parent_id: c.parent_id || null,
        message: c.deleted ? '' : c.message,
        is_deleted: c.deleted ? 1 : 0,
        deleted: !!c.deleted,
        created_at: c.created_at,
        updated_at: edited || c.created_at,
        edited_at: edited,
        username: c.deleted ? null : (u ? u.username : (a && a.username) || null),
        display_name: c.deleted ? null : (u ? u.display_name || u.username : c.display_name || (a && a.display_name) || null),
        avatar_url: c.deleted ? null : (u ? u.avatar_url : (a && a.avatar_url)) || null,
        profile_color: c.deleted ? null : (u ? u.profile_color : (a && a.profile_color)) || null,
        role: u && !c.deleted ? u.role : null,
        is_ai: !!(a && a.is_ai),
        reply_count: c.reply_count || 0,
        can_edit: !!(ctx.subject && a && a.subject === ctx.subject && !c.deleted),
        can_delete: !!deleteRight(ctx.user, ctx.subject, c, ctx.target),
    };
    if (c.replies) out.replies = c.replies.map((r) => shape(r, ctx));
    return out;
}

/** Every reply of a top-level comment (Community nests the first 20; the rest are paged). */
async function allReplies(threadId, c, subject, ip) {
    const replies = [...(c.replies || [])];
    let after = replies.length ? replies[replies.length - 1].id : null;
    while (replies.length < Math.min(c.reply_count || 0, MAX_REPLIES)) {
        const page = await comments.readThread(threadId, { subject, parent: c.id, after, limit: 100, ip });
        replies.push(...page.comments);
        if (!page.next_cursor || !page.comments.length) break;
        after = page.next_cursor;
    }
    return replies;
}

/** The Live VOD/clip a Community comment belongs to, or null (another product's comment, or gone). */
function liveRefOf(found) {
    const ref = found && found.thread && found.thread.ref;
    if (!ref || ref.service !== 'live' || !comments.TYPES.includes(ref.type) || !/^\d{1,15}$/.test(ref.id)) return null;
    return { type: ref.type, id: Number(ref.id) };
}

// ── Get Replies ──────────────────────────────────────────────
// (Before /:type/:id, which would otherwise take "/<id>/replies".)
router.get('/:commentId/replies', optionalAuth, async (req, res) => {
    try {
        const subject = await viewerSubject(req.user);
        const found = await comments.getComment(req.params.commentId, subject, { ip: req.ip });
        const ref = liveRefOf(found);
        const target = ref && await visibleTarget(req.user, ref.type, ref.id);
        if (!target) return res.status(404).json({ error: 'Comment not found' });
        const ctx = { type: ref.type, id: ref.id, user: req.user, subject, target };
        // Replies nest one level: a reply has none of its own.
        const c = found.comment;
        const replies = c.parent_id ? [] : await allReplies(found.thread.id, { id: c.id, replies: [], reply_count: c.reply_count || 0 }, subject, req.ip);
        res.json({ replies: replies.map((r) => shape(r, ctx)) });
    } catch (err) {
        sendError(res, err, 'Failed to get replies');
    }
});

// ── List Comments ────────────────────────────────────────────
router.get('/:type/:id', optionalAuth, async (req, res) => {
    try {
        const contentType = req.params.type;
        const contentId = parseInt(req.params.id);
        if (!['vod', 'clip'].includes(contentType) || !contentId) {
            return res.status(400).json({ error: 'Invalid content type or ID' });
        }
        const target = await visibleTarget(req.user, contentType, contentId);
        if (!target) return res.status(404).json({ error: 'Content not found' });
        const limit = Math.min(Math.max(parseInt(req.query.limit || '50') || 50, 1), 100);
        const offset = Math.min(Math.max(parseInt(req.query.offset || '0') || 0, 0), MAX_OFFSET);

        const subject = await viewerSubject(req.user);
        const thread = await comments.threadFor(contentType, contentId, target.row.title, { ip: req.ip });
        const ctx = { type: contentType, id: contentId, user: req.user, subject, target };

        // Newest first, like before; Community pages by cursor, so an offset is walked.
        const picked = [];
        let skipped = 0, after = null, total = 0;
        for (;;) {
            let page;
            try { page = await comments.readThread(thread.id, { subject, sort: 'new', limit: 100, after, ip: req.ip }); }
            catch (err) { if (err.status === 404) return res.status(404).json(HIDDEN); throw err; }
            // A thread Community's moderators hid is hidden here too (Live reads anonymous visitors' pages as itself, which sees it).
            if (page.thread && page.thread.visibility === 'hidden' && !permissions.isStaff(req.user)) return res.status(404).json(HIDDEN);
            total = page.thread ? page.thread.comment_count || 0 : 0;
            for (const c of page.comments) {
                if (skipped < offset) { skipped++; continue; }
                if (picked.length < limit) picked.push(c);
            }
            if (picked.length >= limit || !page.next_cursor) break;
            after = page.next_cursor;
        }
        for (const c of picked) {
            if ((c.reply_count || 0) > (c.replies || []).length) c.replies = await allReplies(thread.id, c, subject, req.ip);
        }
        const out = { comments: picked.map((c) => shape(c, ctx)), total };
        // The same thread on Community's own page — offered for items anyone may see (the access id
        // is all it takes to read it there).
        if (!access.isPrivate(target.row)) out.thread = { id: thread.access_id, url: comments.threadUrl(thread.access_id) };
        res.json(out);
    } catch (err) {
        sendError(res, err, 'Failed to get comments');
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
        const message = String(req.body.message || '').trim();
        if (!message || message.length > MAX_MESSAGE) {
            return res.status(400).json({ error: `Comment must be 1-${MAX_MESSAGE} characters` });
        }
        const parentId = req.body.parent_id ? parseInt(req.body.parent_id) : null;
        const target = await visibleTarget(req.user, contentType, contentId);
        if (!target) return res.status(404).json({ error: 'Content not found' });

        const subject = await viewerSubject(req.user);
        if (!subject) return res.status(409).json({ error: 'This account is not linked to an OpenVibe account yet — sign in again and retry.' });
        const thread = await comments.threadFor(contentType, contentId, target.row.title, { ip: req.ip });

        let parent = null;
        if (parentId) {
            parent = await comments.getComment(parentId, subject, { ip: req.ip });
            if (!parent || !parent.thread || parent.thread.id !== thread.id) {
                return res.status(400).json({ error: 'Invalid parent comment' });
            }
        }

        const out = await comments.addComment(thread.id, subject, { message, parentId }, { ip: req.ip });
        const comment = shape(out.comment, { type: contentType, id: contentId, user: req.user, subject, target });

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
        const parentAuthor = parent && parent.comment.author && parent.comment.author.subject
            ? comments.liveUserForSubject(parent.comment.author.subject) : null;
        if (parentAuthor && parentAuthor !== req.user.id) {
            recipients.set(parentAuthor, {
                user_id: parentAuthor,
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
        sendError(res, err, 'Failed to post comment');
    }
});

/** The comment and its Live target, when this caller may see both; otherwise null (→ 404). */
async function commentForCaller(req, subject) {
    const found = await comments.getComment(req.params.commentId, subject, { ip: req.ip });
    const ref = liveRefOf(found);
    const target = ref && await visibleTarget(req.user, ref.type, ref.id);
    return target ? { found, ref, target } : null;
}

// ── Edit Comment (the author only) ───────────────────────────
router.put('/:commentId', requireAuth, async (req, res) => {
    try {
        const subject = await viewerSubject(req.user);
        const hit = await commentForCaller(req, subject);
        if (!hit) return res.status(404).json({ error: 'Comment not found' });
        const c = hit.found.comment;
        if (!subject || !c.author || c.author.subject !== subject) {
            return res.status(403).json({ error: 'Only the author can edit a comment' });
        }
        const message = String(req.body.message || '').trim();
        if (!message || message.length > MAX_MESSAGE) {
            return res.status(400).json({ error: `Comment must be 1-${MAX_MESSAGE} characters` });
        }
        await comments.editComment(c.id, subject, message, { ip: req.ip });
        res.json({ message: 'Comment updated' });
    } catch (err) {
        sendError(res, err, 'Failed to update comment');
    }
});

// ── Delete Comment (author, staff, or the VOD's/clip's owners) ──
router.delete('/:commentId', requireAuth, async (req, res) => {
    try {
        const subject = await viewerSubject(req.user);
        const hit = await commentForCaller(req, subject);
        if (!hit) return res.status(404).json({ error: 'Comment not found' });
        let right = deleteRight(req.user, subject, hit.found.comment, hit.target);
        if (!right) return res.status(403).json({ error: 'Not authorized' });
        if (right === 'staff' && !subject) right = 'owner';   // staff without a linked subject: Live moderates for them
        await comments.deleteComment(hit.found.comment.id, { subject, as: right, ip: req.ip });
        res.json({ message: 'Comment deleted' });
    } catch (err) {
        sendError(res, err, 'Failed to delete comment');
    }
});

/**
 * The comment count of a VOD/clip for detail responses: a number, or null when Community is
 * unreachable. Short timeouts, and after a failure the count is skipped for a while, so a
 * Community outage never slows VOD and clip pages down.
 */
let countsDownUntil = 0;
async function commentCount(contentType, contentId, label, ip = null) {
    if (Date.now() < countsDownUntil) return null;
    try {
        const thread = await comments.threadFor(contentType, contentId, label, { timeoutMs: 1500, ip });
        const page = await comments.readThread(thread.id, { limit: 1, timeoutMs: 1500, ip });
        return page.thread ? page.thread.comment_count || 0 : 0;
    } catch (err) {
        if (err && err.status === 503) countsDownUntil = Date.now() + 30_000;
        return null;
    }
}

module.exports = router;
module.exports.commentCount = commentCount;
