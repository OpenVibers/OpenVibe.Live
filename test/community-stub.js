'use strict';
/**
 * An in-process stand-in for OpenVibe.Community's comment API (/api/v1/comments), for Live tests
 * of the comments adapter (server/comments-client.js). It follows Community's contract as a service
 * caller sees it: resolve by EntityRef (sequential id + access id), threads newest/oldest first with
 * one level of nested replies and an ?after= cursor, ?parent= reply pages, comments as X-OV-Subject
 * (none on live vod/clip without a subject), GET/PATCH/DELETE /:commentId, X-OV-Staff, visibility.
 *
 *   const stub = await startCommunityStub({ people: { usr_…: { username, display_name } } });
 *   process.env.OV_COMMUNITY_INTERNAL_URL = stub.url;
 *   stub.down = true;   // every request fails (connection reset) until set back
 *   stub.calls          // [{ method, path, subject, staff, body }]
 */
const http = require('http');
const crypto = require('crypto');

function startCommunityStub({ people = {} } = {}) {
    const threads = [];      // { id, access_id, ref, visibility, comment_count }
    const comments = [];     // { id, thread_id, parent_id, author, message, created_at, edited_at, deleted_at }
    const calls = [];
    const state = { down: false };
    let clock = Date.parse('2026-09-01T00:00:00Z');
    const now = () => new Date(clock += 1000).toISOString();

    const personOf = (subject) => (subject ? { subject, username: (people[subject] || {}).username || null, display_name: (people[subject] || {}).display_name || null, avatar_url: null, profile_color: null } : null);
    const threadBy = (id) => threads.find((t) => String(t.id) === String(id) || t.access_id === id) || null;
    const replyCount = (c) => comments.filter((r) => r.parent_id === c.id && !r.deleted_at).length;
    const shapeThread = (t) => ({ id: t.id, access_id: t.access_id, ref: t.ref, visibility: t.visibility, comment_count: comments.filter((c) => c.thread_id === t.id && !c.deleted_at).length });
    function shapeComment(c, subject, withReplies) {
        const deleted = !!c.deleted_at;
        const out = {
            id: c.id, thread_id: c.thread_id, parent_id: c.parent_id, origin: 'user',
            author: deleted ? null : personOf(c.author), anon_name: null,
            display_name: deleted ? null : ((people[c.author] || {}).display_name || null),
            message: deleted ? null : c.message, deleted, score: 0, upvotes: 0, downvotes: 0, my_vote: 0,
            reply_count: replyCount(c), created_at: c.created_at, updated_at: c.edited_at || c.created_at, edited_at: deleted ? null : c.edited_at,
            can_edit: !deleted && !!subject && c.author === subject, can_delete: !deleted && !!subject && c.author === subject,
        };
        if (withReplies) out.replies = comments.filter((r) => r.parent_id === c.id && !r.deleted_at).sort((a, b) => a.id - b.id).slice(0, 20).map((r) => shapeComment(r, subject, false));
        return out;
    }

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (state.down) { req.socket.destroy(); return; }
            const url = new URL(req.url, 'http://x');
            const p = url.pathname.replace(/^\/api\/v1\/comments/, '');
            const subject = req.headers['x-ov-subject'] || null;
            const staff = req.headers['x-ov-staff'] === '1';
            const body = raw ? JSON.parse(raw) : undefined;
            calls.push({ method: req.method, path: p, query: url.search, subject, staff, body, auth: req.headers.authorization || null, xff: req.headers['x-forwarded-for'] || null });
            const send = (status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
            const problem = (status, code, detail) => send(status, { type: 'about:blank', status, code, detail, error: detail });
            if (!/^Bearer /.test(req.headers.authorization || '')) return problem(401, 'token.missing', 'service token required');
            const moderator = !subject || staff;
            let m;

            if (req.method === 'POST' && p === '/threads/resolve') {
                const ref = body.ref;
                let t = threads.find((x) => x.ref.service === ref.service && x.ref.type === ref.type && x.ref.id === ref.id);
                if (t) { if (ref.label) t.ref.label = ref.label; return send(200, { thread: shapeThread(t), created: false }); }
                t = { id: threads.length + 1, access_id: `cth_${crypto.randomBytes(16).toString('base64url')}`, ref: { ...ref }, visibility: 'public' };
                threads.push(t);
                return send(201, { thread: shapeThread(t), created: true });
            }
            if ((m = p.match(/^\/threads\/([^/]+)$/)) && req.method === 'GET') {
                const t = threadBy(m[1]);
                if (!t || (t.visibility === 'hidden' && !moderator)) return problem(404, 'thread.not_found', 'Comment thread not found');
                const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 30, 1), 100);
                const after = url.searchParams.get('after') ? Number(url.searchParams.get('after')) : null;
                const parent = url.searchParams.get('parent');
                let rows;
                if (parent) {
                    rows = comments.filter((c) => c.parent_id === Number(parent) && !c.deleted_at && (after == null || c.id > after)).sort((a, b) => a.id - b.id);
                } else {
                    const newest = url.searchParams.get('sort') === 'new';
                    rows = comments.filter((c) => c.thread_id === t.id && !c.parent_id && (!c.deleted_at || replyCount(c) > 0) && (after == null || (newest ? c.id < after : c.id > after)))
                        .sort((a, b) => (newest ? b.id - a.id : a.id - b.id));
                }
                const more = rows.length > limit;
                rows = rows.slice(0, limit);
                return send(200, { thread: shapeThread(t), comments: rows.map((c) => shapeComment(c, subject, !parent)), next_cursor: more ? String(rows[rows.length - 1].id) : null, viewer: {} });
            }
            if ((m = p.match(/^\/threads\/([^/]+)\/comments$/)) && req.method === 'POST') {
                const t = threadBy(m[1]);
                if (!t || t.visibility === 'hidden') return problem(404, 'thread.not_found', 'Comment thread not found');
                if (!subject && t.ref.service === 'live') return problem(401, 'auth.required', 'Sign in to comment here');
                let parentId = null;
                if (body.parent_id) {
                    const parent = comments.find((c) => c.id === Number(body.parent_id));
                    if (!parent || parent.thread_id !== t.id || parent.deleted_at) return problem(400, 'comment.invalid_parent', 'Invalid parent comment');
                    parentId = parent.parent_id || parent.id;
                }
                const c = { id: comments.length + 1, thread_id: t.id, parent_id: parentId, author: subject, message: String(body.message).trim(), created_at: now(), edited_at: null, deleted_at: null };
                comments.push(c);
                return send(201, { comment: shapeComment(c, subject, false) });
            }
            if ((m = p.match(/^\/threads\/([^/]+)\/visibility$/)) && req.method === 'PUT') {
                const t = threadBy(m[1]);
                if (!t) return problem(404, 'thread.not_found', 'Comment thread not found');
                if (!moderator) return problem(403, 'capability.denied', 'moderators only');
                t.visibility = body.visibility;
                return send(200, { thread: shapeThread(t) });
            }
            if ((m = p.match(/^\/(\d+)$/))) {
                const c = comments.find((x) => x.id === Number(m[1]));
                const t = c && threads.find((x) => x.id === c.thread_id);
                if (!c || c.deleted_at || (t.visibility === 'hidden' && !moderator)) return problem(404, 'comment.not_found', 'Comment not found');
                if (req.method === 'GET') return send(200, { comment: shapeComment(c, subject, false), thread: shapeThread(t) });
                if (req.method === 'PATCH') {
                    if (!subject || c.author !== subject) return problem(403, 'comment.not_yours', 'Only the author can edit a comment');
                    c.message = String(body.message).trim();
                    c.edited_at = now();
                    return send(200, { comment: shapeComment(c, subject, false) });
                }
                if (req.method === 'DELETE') {
                    if (!(subject && c.author === subject) && !moderator) return problem(403, 'comment.not_yours', 'Not authorized to delete this comment');
                    c.deleted_at = now();
                    return send(200, { ok: true, id: c.id });
                }
            }
            return problem(404, 'route.not_found', 'Not found');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        threads, comments, calls,
        get down() { return state.down; },
        set down(v) { state.down = !!v; },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    })));
}

module.exports = { startCommunityStub };
