/**
 * OpenVibe.Live — /api/pastes proxy (OpenVibe.Media backed)
 *
 * The paste system (incl. like/comment/fork endpoints, preserved from the
 * inherited code) lives in OpenVibe.Media under /api/v1/live/pastes/... .
 * This router forwards the SPA's existing /api/pastes/* calls 1:1, passing the
 * caller's Network JWT through when present so Media applies user-level ACLs.
 *
 * Live-local exceptions:
 *   - POST /:slug/set-avatar  → updates users.avatar_url in live.db
 *   - screenshot upload       → re-wrapped as multipart POST /pastes
 */
'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db/database');
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

function forward(subPath) {
    return (req, res) => {
        const p = typeof subPath === 'function' ? subPath(req) : subPath;
        media.proxy(req, res, `/pastes${p}`, { userToken: media.userTokenFrom(req) })
            .catch((err) => {
                console.warn('[Pastes proxy]', err.message);
                if (!res.headersSent) res.status(502).json({ error: 'Media service unavailable' });
            });
    };
}

const slugPath = (suffix = '') => (req) => `/${encodeURIComponent(req.params.slug)}${suffix}`;

// ── Screenshot upload (multipart re-wrap) ────────────────────
router.post('/screenshot', optionalAuth, shotUpload.single('screenshot'), async (req, res) => {
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
        }, { userToken: media.userTokenFrom(req) });
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
            const query = { ...req.query };
            if (query.username && query.username !== 'all') {
                const u = db.getUserByUsername(query.username);
                delete query.username;
                if (!u) return res.json({ pastes: [], total: 0, limit: 0, offset: 0, hasMore: false });
                query.user_id = u.id;
            }
            const p = typeof subPath === 'function' ? subPath(req) : subPath;
            const out = await media.request('GET', `/pastes${p}`, { query, userToken: media.userTokenFrom(req) });
            _nameUsers(pick(out));
            res.json(out);
        } catch (err) {
            if (err && err.name === 'MediaApiError' && err.status) return res.status(err.status).json(err.body || { error: err.message });
            console.warn('[Pastes proxy]', err.message);
            res.status(502).json({ error: 'Media service unavailable' });
        }
    };
}
router.get('/', forwardEnriched('', (o) => o?.pastes));
router.post('/', forward(''));
router.get('/config', forward('/config'));
router.get('/admin/stats', requireAdmin, forwardAsApp('/admin/stats'));
router.delete('/admin/forks', requireAdmin, forwardAsApp('/admin/forks'));
router.post('/bulk', requireAdmin, forwardAsApp('/bulk'));
// Media doesn't know usernames — resolve locally, then list by user id.
// Browser-JWT-created pastes carry the NETWORK id while migrated/app-key rows
// carry the LOCAL id, so query both id spaces and merge.
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
        // Anyone else viewing this user's page still sees public pastes only. Media
        // re-checks this, so the flag alone cannot leak another user's pastes.
        const viewingSelf = !!(req.user && (
            String(req.user.id) === String(user.id) ||
            (networkId != null && String(req.user.id) === String(networkId))
        ));
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
router.get('/:slug', forwardEnriched(slugPath(), (o) => (o?.paste ? [o.paste] : [o])));
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
router.post('/:slug/fork', forward(slugPath('/fork')));
// Raw content is public on Media (/p/:slug/raw) — bounce the API-shaped URL there.
router.get('/:slug/raw', (req, res) => res.redirect(302, media.pasteRawUrl(req.params.slug)));
router.post('/:slug/like', requireAuth, forward(slugPath('/like')));
router.post('/:slug/copy', forward(slugPath('/copy')));
router.get('/:slug/comments', forwardEnriched(slugPath('/comments'), (o) => o?.comments));
router.post('/:slug/comments', forward(slugPath('/comments')));
router.delete('/:slug/comments/:commentId', forward((req) => `/${encodeURIComponent(req.params.slug)}/comments/${encodeURIComponent(req.params.commentId)}`));

module.exports = router;
