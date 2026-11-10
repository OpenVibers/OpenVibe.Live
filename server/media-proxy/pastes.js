/**
 * OpenVibe.Live — /api/pastes proxy (OpenVibe.Community backed)
 *
 * OpenVibe.Community owns pastes. This router keeps the SPA's /api/pastes/* URLs and forwards every
 * call there with Live's service token; the person is named by their canonical subject (never by a
 * Live id), anonymous callers stay anonymous, and staff routes still pass Live's requireAdmin first.
 *
 * Live does not call Media's read-only paste API (`/api/v1/:app/pastes`, plan T10 step 2 — being
 * retired); every paste read and write here goes to Community. Media's public paste URLs
 * (/p/:slug[/raw|/screenshot]) are built in media-client.js for legacy rows only.
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
const crypto = require('crypto');

function consecutiveUnique(pastes) {
    const out = [];
    for (const p of pastes || []) {
        const owner = p.owner_subject || p.user_id || p.username;
        const ref = String(p.media_ref || p.screenshot_url || '');
        const mediaId = /med_[0-9A-HJKMNP-TV-Z]{26}/.exec(ref);
        const fingerprint = p.content_hash ? `content:${String(p.content_hash).toLowerCase()}`
            : p.type === 'screenshot' ? (mediaId ? `image:${mediaId[0]}` : null)
            : `text:${crypto.createHash('sha256').update(String(p.content || ''), 'utf8').digest('hex')}`;
        const key = owner && fingerprint ? `${owner}:${fingerprint}` : null;
        const previous = out[out.length - 1];
        if (key && previous && previous._dedupeKey === key) { previous.more_like_it = (previous.more_like_it || 0) + 1; continue; }
        out.push({ ...p, ...(key ? { _dedupeKey: key } : {}) });
    }
    return out.map(({ _dedupeKey, ...p }) => p);
}

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
            if (req.method === 'GET' && p === '' && req.query.dedupe === 'consecutive' && upstream.ok) {
                const payload = await upstream.json();
                const original = Array.isArray(payload.pastes) ? payload.pastes : [];
                return res.status(upstream.status).json({ ...payload, raw_count: original.length, pastes: consecutiveUnique(original) });
            }
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
        await db.updateUserAvatar(req.user.id, avatarUrl, null);
        // The Network copies the screenshot into the person's own avatar object; the paste stays untouched.
        let stored = avatarUrl;
        try {
            const synced = await require('../utils/notify').syncAvatarChange({ id: req.user.id, avatar_url: avatarUrl });
            if (synced && synced.avatar_url) { stored = synced.avatar_url; await db.updateUserAvatar(req.user.id, stored, null); }
        } catch { /* next report */ }
        res.json({ success: true, avatar_url: stored });
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
module.exports.consecutiveUnique = consecutiveUnique;
