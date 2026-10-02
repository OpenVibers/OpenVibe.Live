/**
 * OpenVibe.Live — /api/pastes proxy (OpenVibe.Community backed)
 *
 * OpenVibe.Community owns pastes. This router keeps the SPA's /api/pastes/* URLs and forwards every
 * call there with Live's service token; the person is named by their canonical subject (never by a
 * Live id), anonymous callers stay anonymous, and staff routes still pass Live's requireAdmin first.
 *
 * Live-local exception:
 *   - POST /:slug/set-avatar  → updates users.avatar_url in live.db
 */
'use strict';
const express = require('express');
const db = require('../db/database');
const { can } = require('../auth/permissions');
const media = require('../media-client');
const { requireAuth, optionalAuth, requireAdmin } = require('../auth/auth');

// Anonymous pastes and comments are allowed; the limit for anonymous writes lives here.
// (A restore drill refuses every write, so it has no limiter and no limiter timer.)
const anonWriteLimiter = require('../drill').enabled ? (req, res, next) => next() : require('express-rate-limit')({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !!(req.user && req.user.id),
    message: { error: 'Too many anonymous posts — sign in or try again later' },
});

const pastesClient = require('../pastes-client');
const principal = require('../net/network-principal');
const { Readable } = require('stream');

/** `whenDown(req)`: the answer while Community is unreachable or failing (5xx), instead of a 502. */
function toCommunity(subPath, whenDown = null) {
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
            if (whenDown && upstream.status >= 500) return res.json(whenDown(req));
            if (upstream.status === 401) principal.invalidate('openvibe.community');
            res.status(upstream.status);
            for (const h of ['content-type', 'cache-control', 'location', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
                const v = upstream.headers.get(h);
                if (v) res.set(h, v);
            }
            res.send(Buffer.from(await upstream.arrayBuffer()));
        } catch (err) {
            console.warn('[Pastes → Community]', err.message);
            if (!res.headersSent) {
                if (whenDown) return res.json(whenDown(req));
                res.status(502).json({ error: 'Paste service unavailable' });
            }
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
// Editing, deleting, liking and removing a comment need a signed-in person: refused here, before Community.
communityRouter.put('/:slug', requireAuth, toCommunity((req) => req.path));
communityRouter.delete(['/:slug', '/:slug/comments/:commentId'], requireAuth, toCommunity((req) => req.path));
communityRouter.post('/:slug/like', requireAuth, toCommunity((req) => req.path));
// A channel's or dashboard's paste tab shows an empty list while Community is down, not an error.
communityRouter.get('/by-user/:username', optionalAuth, toCommunity((req) => req.path, (req) => ({ pastes: [], total: 0, username: req.params.username })));
communityRouter.all('*', optionalAuth, toCommunity((req) => req.path === '/' ? '' : req.path));

module.exports = communityRouter;
module.exports.communityRouter = communityRouter;
