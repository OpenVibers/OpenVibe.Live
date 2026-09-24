/**
 * OpenVibe.Live — /api/pastes proxy (OpenVibe.Media backed)
 *
 * The paste system (incl. like/comment/fork endpoints, preserved from the
 * inherited code) lives in OpenVibe.Media under /api/v1/live/pastes/... .
 * This router forwards the SPA's existing /api/pastes/* calls 1:1. Identity is resolved
 * HERE — every forwarding route runs optionalAuth/requireAuth first, and media-client
 * sends the resulting Live-local user id to Media. Forwarding the caller's Network JWT
 * and letting Media read the identity out of it (what this used to do) filed writes
 * under the Network's id for the account, which is a different number from the local
 * one and belongs to an unrelated local user.
 *
 * Live-local exceptions:
 *   - POST /:slug/set-avatar  → updates users.avatar_url in live.db
 *   - screenshot upload       → re-wrapped as multipart POST /pastes
 */
'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db/database');
const { can } = require('../auth/permissions');
const media = require('../media-client');
const { requireAuth, optionalAuth, requireAdmin } = require('../auth/auth');

// Admin/moderation endpoints on Media are app-key-only: authorize the caller
// as a Live admin here, then forward WITHOUT the user token so the app key applies.
function forwardAsApp(subPath) {
    return (req, res) => {
        const p = typeof subPath === 'function' ? subPath(req) : subPath;
        media.proxy(req, res, `/pastes${p}`)
            .catch((err) => {
                console.warn('[Pastes proxy]', err.message);
                if (!res.headersSent) res.status(502).json({ error: 'Media service unavailable' });
            });
    };
}

const router = express.Router();
const shotUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
// Anonymous pastes and comments are allowed, but Media does not rate-limit app-key calls, so the
// limit for anonymous writes lives here.
// (A restore drill refuses every write, so it has no limiter and no limiter timer.)
const anonWriteLimiter = require('../drill').enabled ? (req, res, next) => next() : require('express-rate-limit')({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !!(req.user && req.user.id),
    message: { error: 'Too many anonymous posts — sign in or try again later' },
});

/**
 * Every request reaches Media with Live's app key. Media treats an app-key call that names no acting
 * user as the app itself — full authority: it trusts `user_id` in the body and query, lists private
 * pastes, and moderates comments freely. A signed-in caller is pinned by X-OV-User-Id and gets
 * normal ownership checks; an anonymous one would get app authority. So identity fields a browser
 * sends are dropped here, always, and owner-view switches are dropped for anonymous callers.
 */
const IDENTITY_FIELDS = ['user_id', 'userId', 'author_id', 'owner_id'];
const OWNER_VIEW_FIELDS = ['include_unlisted', 'include_private', 'mine'];
function scrubIdentity(req) {
    const anon = media.actingUserFrom(req) == null;
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        for (const k of IDENTITY_FIELDS) delete req.body[k];
    }
    if (anon && req.query) for (const k of OWNER_VIEW_FIELDS) delete req.query[k];
    return anon;
}

function forward(subPath) {
    return (req, res) => {
        scrubIdentity(req);
        const p = typeof subPath === 'function' ? subPath(req) : subPath;
        media.proxy(req, res, `/pastes${p}`, { actingUser: media.actingUserFrom(req) })
            .catch((err) => {
                console.warn('[Pastes proxy]', err.message);
                if (!res.headersSent) res.status(502).json({ error: 'Media service unavailable' });
            });
    };
}

const slugPath = (suffix = '') => (req) => `/${encodeURIComponent(req.params.slug)}${suffix}`;

// ── Screenshot upload (multipart re-wrap) ────────────────────
router.post('/screenshot', optionalAuth, anonWriteLimiter, shotUpload.single('screenshot'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No screenshot uploaded' });
        const out = await media.createPaste({
            title: req.body.title || 'Screenshot',
            content: req.body.description || '',
            language: 'text',
            visibility: req.body.visibility || 'public',
            user_id: req.user?.id || undefined,
            stream_id: req.body.stream_id || undefined,
            metadata: req.body.metadata || undefined,
            screenshot: {
                buffer: req.file.buffer,
                filename: req.file.originalname || 'screenshot.png',
                contentType: req.file.mimetype || 'image/png',
            },
        }, { actingUser: media.actingUserFrom(req) });
        const paste = out?.paste || out;   // Media returns { id, slug, url, paste }
        res.status(201).json({ paste, url: out?.url || (paste?.slug ? `/p/${paste.slug}` : null) });
    } catch (err) {
        if (err && err.name === 'MediaApiError' && err.status) return res.status(err.status).json(err.body || { error: err.message });
        console.warn('[Pastes proxy] screenshot:', err.message);
        res.status(502).json({ error: 'Media service unavailable' });
    }
});

// ── Set an image paste as my avatar (Live-local user record) ─
router.post('/:slug/set-avatar', requireAuth, async (req, res) => {
    try {
        let paste;
        try { paste = await media.getPaste(req.params.slug); } catch { paste = null; }
        if (!paste) return res.status(404).json({ error: 'Paste not found' });
        if (paste.type !== 'screenshot' && !paste.screenshot_url && !paste.screenshot_path) {
            return res.status(400).json({ error: 'That paste is not an image' });
        }
        const avatarUrl = media.publicUrl(paste.screenshot_url)
            || (paste.screenshot_path ? media.screenshotUrl(require('path').basename(paste.screenshot_path)) : media.pasteRawUrl(paste.slug));
        db.updateUserAvatar(req.user.id, avatarUrl, paste.id || null);
        // The avatar belongs to the network account: every other OpenVibe site shows it too.
        try { require('../utils/notify').reportAvatarChange({ id: req.user.id, avatar_url: avatarUrl }); } catch { /* picked up at the next sign-in */ }
        res.json({ success: true, avatar_url: avatarUrl });
    } catch (err) {
        console.warn('[Pastes proxy] set-avatar:', err.message);
        res.status(500).json({ error: 'Failed to set avatar' });
    }
});

// ── Everything else: transparent passthrough ─────────────────
// Media only stores our numeric user ids — resolve author names locally so
// cards don't all read "Anonymous", and translate ?username= into user_id.
function _nameUsers(rows) {
    for (const p of rows || []) {
        if (p && p.user_id != null && !p.username) {
            const u = db.getUserById(p.user_id);
            if (u) { p.username = u.username; p.display_name = u.display_name; p.profile_color = u.profile_color; p.avatar_url = u.avatar_url; }
        }
    }
    return rows;
}
function forwardEnriched(subPath, pick) {
    return async (req, res) => {
        try {
            const anon = scrubIdentity(req);
            const query = { ...req.query };
            if (query.username && query.username !== 'all') {
                const u = db.getUserByUsername(query.username);
                delete query.username;
                if (!u) return res.json({ pastes: [], total: 0, limit: 0, offset: 0, hasMore: false });
                query.user_id = u.id;
            }
            const p = typeof subPath === 'function' ? subPath(req) : subPath;
            const out = await media.request('GET', `/pastes${p}`, { query, actingUser: media.actingUserFrom(req) });
            // Media shows private pastes to the app itself, which is what an anonymous call looks like.
            if (anon && out && out.paste && out.paste.visibility === 'private') return res.status(404).json({ error: 'Paste not found' });
            if (anon && out && Array.isArray(out.pastes)) out.pastes = out.pastes.filter((x) => !x || x.visibility !== 'private');
            _nameUsers(pick(out));
            res.json(out);
        } catch (err) {
            if (err && err.name === 'MediaApiError' && err.status) return res.status(err.status).json(err.body || { error: err.message });
            console.warn('[Pastes proxy]', err.message);
            res.status(502).json({ error: 'Media service unavailable' });
        }
    };
}
router.get('/', optionalAuth, forwardEnriched('', (o) => o?.pastes));
router.post('/', optionalAuth, anonWriteLimiter, forward(''));
router.get('/config', forward('/config'));
router.get('/admin/stats', requireAdmin, forwardAsApp('/admin/stats'));
router.delete('/admin/forks', requireAdmin, forwardAsApp('/admin/forks'));
router.post('/bulk', requireAdmin, forwardAsApp('/bulk'));
// Media doesn't know usernames — resolve locally, then list by user id.
// Rows written before the id-space fix (when the SPA's Network JWT was forwarded to
// Media, which then filed the write under the NETWORK id) still carry that id, so keep
// asking for both and merge. New rows are always written with the local id.
router.get('/by-user/:username', optionalAuth, async (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        let networkId = null;
        try {
            const row = db.getDb().prepare("SELECT service_user_id FROM linked_accounts WHERE service = 'network' AND user_id = ?").get(user.id);
            if (row && row.service_user_id != null) networkId = row.service_user_id;
        } catch { /* */ }
        const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 100);
        const sort = req.query.sort === 'oldest' ? 'oldest' : 'newest';
        // Viewing your OWN paste list includes your unlisted/private ones — otherwise an
        // unlisted paste is invisible everywhere and looks like it was never created.
        // Anyone else viewing this user's page still sees public pastes only.
        //
        // Local ids only. req.user.id has always been the local one, so also accepting a
        // match against the VIEWED user's network id just meant that whoever happened to
        // hold that number as their local id — an unrelated person — was treated as the
        // owner here, and Media trusts this gate rather than re-checking it.
        const viewingSelf = !!(req.user && String(req.user.id) === String(user.id));
        const mine = viewingSelf ? { include_unlisted: 1 } : {};
        const lists = await Promise.all([
            media.listPastes({ user_id: user.id, limit, sort, ...mine }).catch(() => null),
            networkId != null && String(networkId) !== String(user.id)
                ? media.listPastes({ user_id: networkId, limit, sort, ...mine }).catch(() => null)
                : null,
        ]);
        const seen = new Set();
        const pastes = lists.flatMap(l => l?.pastes || [])
            .filter(p => !seen.has(p.slug) && seen.add(p.slug))
            .sort((a, b) => (sort === 'oldest' ? 1 : -1) * (new Date(a.created_at) - new Date(b.created_at)))
            .slice(0, limit);
        res.json({ pastes: _nameUsers(pastes), total: pastes.length, username: user.username });
    } catch (err) {
        console.warn('[Pastes proxy] by-user:', err.message);
        res.status(502).json({ error: 'Media service unavailable' });
    }
});
router.get('/:slug', optionalAuth, forwardEnriched(slugPath(), (o) => (o?.paste ? [o.paste] : [o])));
router.put('/:slug', requireAuth, forward(slugPath()));
router.delete('/:slug', requireAuth, forward(slugPath()));
// TODO(contract): paste admin tools (censor, admin/stats, admin/forks, bulk)
// have no Media API v1 endpoints yet — they 404 until Media grows them.
// Censor replaces the screenshot: multer consumed the multipart body, so re-wrap
// it as a fresh multipart upstream request (app-key auth — Media censor is admin-only).
router.post('/:slug/censor', requireAdmin, shotUpload.single('screenshot'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No replacement screenshot uploaded' });
        const fd = media._formData({}, {
            buffer: req.file.buffer,
            filename: req.file.originalname || 'censored.png',
            contentType: req.file.mimetype || 'image/png',
        }, 'screenshot');
        const out = await media.request('POST', `/pastes/${encodeURIComponent(req.params.slug)}/censor`, { body: fd, timeoutMs: 60000 });
        res.json(out);
    } catch (err) {
        if (err && err.name === 'MediaApiError' && err.status) return res.status(err.status).json(err.body || { error: err.message });
        console.warn('[Pastes proxy] censor:', err.message);
        res.status(502).json({ error: 'Media service unavailable' });
    }
});
router.post('/:slug/fork', optionalAuth, anonWriteLimiter, forward(slugPath('/fork')));
// Raw content is public on Media (/p/:slug/raw) — bounce the API-shaped URL there.
router.get('/:slug/raw', (req, res) => res.redirect(302, media.pasteRawUrl(req.params.slug)));
router.post('/:slug/like', requireAuth, forward(slugPath('/like')));
router.post('/:slug/copy', optionalAuth, forward(slugPath('/copy')));
router.get('/:slug/comments', optionalAuth, forwardEnriched(slugPath('/comments'), (o) => o?.comments));
// optionalAuth, not requireAuth: anonymous comments are allowed, and Media decides
// whether they are enabled. What matters is that a signed-in commenter is named.
router.post('/:slug/comments', optionalAuth, anonWriteLimiter, forward(slugPath('/comments')));
// Deleting needs an identity: without one Media sees the app key alone and lets it delete anything.
router.delete('/:slug/comments/:commentId', requireAuth, forward((req) => `/${encodeURIComponent(req.params.slug)}/comments/${encodeURIComponent(req.params.commentId)}`));

// ── Community authority (PASTES_AUTHORITY=community, roadmap Wave 5) ──────────────
// OpenVibe.Community owns pastes. This router keeps the SPA's /api/pastes/* URLs and forwards every
// call there with Live's service token; the person is named by their canonical subject (never by a
// Live id), anonymous callers stay anonymous, and staff routes still pass Live's requireAdmin first.
// Only set-avatar stays here, because it changes Live's own user row.
const pastesClient = require('../pastes-client');
const principal = require('../net/network-principal');
const { Readable } = require('stream');

function toCommunity(subPath) {
    return async (req, res) => {
        try {
            const p = typeof subPath === 'function' ? subPath(req) : subPath;
            const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            const headers = { Accept: 'application/json', ...(await principal.serviceHeaders('openvibe.community')) };
            if (req.user && req.user.id) {
                const sid = req.user.subject_id || await pastesClient.subjectForLiveUser(req.user.id);
                if (!sid) return res.status(409).json({ error: 'This account is not linked to an OpenVibe account yet. Sign in again and retry.' });
                headers['X-OV-Subject'] = sid;
                // Live staff moderate pastes as staff (Community checks our community.paste.moderate grant).
                if (can(req.user, 'staff.moderation.pastes')) headers['X-OV-Staff'] = '1';
            }
            if (req.ip) headers['X-Forwarded-For'] = req.ip;
            const opts = { method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(req.method === 'GET' ? 20000 : 120000) };
            if (!['GET', 'HEAD'].includes(req.method)) {
                const ct = req.headers['content-type'] || '';
                if (req.rawBody) { headers['Content-Type'] = ct || 'application/json'; opts.body = req.rawBody; }
                else if (ct.startsWith('application/x-www-form-urlencoded')) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(req.body || {}); }
                else if (ct) { headers['Content-Type'] = ct; opts.body = Readable.toWeb(req); opts.duplex = 'half'; }
            }
            const upstream = await fetch(`${pastesClient.COMMUNITY_URL}/api/pastes${p}${qs}`, opts);
            if (upstream.status === 401) principal.invalidate('openvibe.community');
            res.status(upstream.status);
            for (const h of ['content-type', 'cache-control', 'location', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
                const v = upstream.headers.get(h);
                if (v) res.set(h, v);
            }
            res.send(Buffer.from(await upstream.arrayBuffer()));
        } catch (err) {
            console.warn('[Pastes → Community]', err.message);
            if (!res.headersSent) res.status(502).json({ error: 'Paste service unavailable' });
        }
    };
}

const communityRouter = express.Router();
communityRouter.post('/:slug/set-avatar', requireAuth, async (req, res) => {
    try {
        let paste = null;
        try { paste = await pastesClient.getPaste(req.params.slug); } catch { paste = null; }
        if (!paste) return res.status(404).json({ error: 'Paste not found' });
        if (paste.type !== 'screenshot' || !paste.screenshot_url) return res.status(400).json({ error: 'That paste is not an image' });
        const avatarUrl = media.publicUrl(paste.screenshot_url) || paste.screenshot_url;
        db.updateUserAvatar(req.user.id, avatarUrl, null);
        try { require('../utils/notify').reportAvatarChange({ id: req.user.id, avatar_url: avatarUrl }); } catch { /* next sign-in */ }
        res.json({ success: true, avatar_url: avatarUrl });
    } catch (err) {
        console.warn('[Pastes → Community] set-avatar:', err.message);
        res.status(500).json({ error: 'Failed to set avatar' });
    }
});
communityRouter.get('/:slug/raw', (req, res) => res.redirect(302, `${String(process.env.OV_COMMUNITY_URL || 'https://openvibe.community').replace(/\/$/, '')}/p/${encodeURIComponent(req.params.slug)}/raw`));
for (const pth of ['/admin/stats', '/admin/forks']) communityRouter.get(pth, requireAdmin, toCommunity(pth));
communityRouter.delete('/admin/forks', requireAdmin, toCommunity('/admin/forks'));
communityRouter.post('/bulk', requireAdmin, toCommunity('/bulk'));
communityRouter.post('/:slug/censor', requireAdmin, toCommunity((req) => `/${encodeURIComponent(req.params.slug)}/censor`));
communityRouter.post(['/', '/screenshot', '/:slug/fork', '/:slug/comments'], optionalAuth, anonWriteLimiter, toCommunity((req) => req.path === '/' ? '' : req.path));
communityRouter.all('*', optionalAuth, toCommunity((req) => req.path === '/' ? '' : req.path));

module.exports = (req, res, next) => (pastesClient.onCommunity() ? communityRouter : router)(req, res, next);
module.exports.mediaRouter = router;
module.exports.communityRouter = communityRouter;
