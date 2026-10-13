/**
 * OpenVibe.Live — /api/thumbnails proxy
 *
 * Live-stream thumbnails are Live-local ephemeral files (see live-thumbs.js) and
 * are served straight from disk. VOD/clip thumbnails live in OpenVibe.Media —
 * unknown filenames 302-redirect to MEDIA_PUBLIC_URL/t/<name>, and the generate
 * endpoints delegate to Media's thumbnail API.
 */
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
// pipeline, never .pipe(res): a viewer who leaves mid-file destroys the response, and .pipe() left the file open for the
// life of the process (36 deleted live thumbnails were still open after 12 h, 2026-10-13).
const { pipeline } = require('stream');
const multer = require('multer');
const db = require('../db/database');
const { can } = require('../auth/permissions');
const media = require('../media-client');
const access = require('./access');
const liveThumbs = require('./live-thumbs');
const { requireAuth, optionalAuth } = require('../auth/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// 1x1 JPEG fallback for missing live thumbs (matches old behavior).
const PIXEL = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA=',
    'base64'
);

// ── Live stream thumbnail upload (from broadcaster client) ───
router.post('/live/:streamId', requireAuth, upload.single('thumbnail'), async (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const stream = await db.getStreamById(streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && !can(req.user, 'staff.streams.manage')) {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) return res.status(400).json({ error: 'Stream is not live' });
        const imageData = req.file ? req.file.buffer : (req.body && req.body.image);
        if (!imageData) return res.status(400).json({ error: 'No image data provided' });
        const thumbUrl = await liveThumbs.saveLiveThumbnail(streamId, imageData);
        if (thumbUrl) res.json({ thumbnail_url: thumbUrl });
        else res.status(400).json({ error: 'Invalid image data' });
    } catch (err) {
        console.error('[Thumbnails] Live upload error:', err.message);
        res.status(500).json({ error: 'Failed to save thumbnail' });
    }
});

// ── Regenerate VOD / clip thumbnails (delegated to Media) ────
// Some recordings have no picture to take (audio-only browser broadcasts, a file that is gone): Media answers
// 404, and that stays true. Every visitor's page asks again for a missing thumbnail, so the answer is kept for
// an hour and given as 200 with no thumbnail: the page shows its placeholder, with no failed request in the
// console and no new Media job (VODs 5718 and 5721 logged a 500 on every home-page visit, 2026-10-12).
// Media answers 429 when its job queue is full (a backfill can hold the tenant's 50 slots for hours): no picture
// YET, and nothing failed here. That answer is kept for 5 minutes and given as 200 with no thumbnail too; the
// 429 used to reach every visitor's console (the browser check of release 977747d7, 2026-10-12).
const NO_PICTURE_MS = 60 * 60 * 1000;
const MEDIA_BUSY_MS = 5 * 60 * 1000;
const noPicture = new Map();   // `${kind}:${id}` → until (ms), oldest first
function noPictureKnown(key) {
    const until = noPicture.get(key);
    if (!until) return false;
    if (until > Date.now()) return true;
    noPicture.delete(key);
    return false;
}
function rememberNoPicture(key, ms = NO_PICTURE_MS) {
    if (noPicture.size >= 5000) noPicture.delete(noPicture.keys().next().value);
    noPicture.set(key, Date.now() + ms);
}

async function generateFor(kind, id, req, res) {
    try {
        const meta = kind === 'vod' ? await media.getVod(id) : await media.getClip(id);
        const notFound = () => res.status(404).json({ error: `${kind === 'vod' ? 'VOD' : 'Clip'} not found` });
        // A private item is missing to anyone who may not see it (a 403 would confirm it exists).
        if (!meta || !await access.canView(req.user, meta)) return notFound();
        const canManage = !!req.user && (meta.user_id === req.user.id || can(req.user, 'staff.streams.manage'));
        const isPublic = meta.visibility ? meta.visibility === 'public' : !!meta.is_public;
        if (!canManage && !isPublic) return res.status(403).json({ error: `Not your ${kind}` });
        const key = `${kind}:${Number(id)}`;
        if (noPictureKnown(key)) return res.json({ thumbnail_url: null });
        let out;
        try { out = await media.generateThumbnail(kind, id); } catch (err) {
            if (!(err && err.name === 'MediaApiError' && (err.status === 404 || err.status === 429))) throw err;
            rememberNoPicture(key, err.status === 429 ? MEDIA_BUSY_MS : NO_PICTURE_MS);
            return res.json({ thumbnail_url: null });
        }
        const url = media.publicUrl(out?.url || meta.thumbnail_url);
        if (url) return res.json({ thumbnail_url: url });
        // Media is still working on it (202 with its job): no picture yet, nothing failed.
        if (out && out.job) return res.status(202).json({ thumbnail_url: null });
        res.status(500).json({ error: 'Failed to generate thumbnail' });
    } catch (err) {
        if (err && err.name === 'MediaApiError' && err.status) return res.status(err.status).json(err.body || { error: err.message });
        res.status(502).json({ error: 'Media service unavailable' });
    }
}
router.post('/generate/vod/:id', optionalAuth, async (req, res) => await generateFor('vod', req.params.id, req, res));
router.post('/generate/clip/:id', optionalAuth, async (req, res) => await generateFor('clip', req.params.id, req, res));
// GET variants: image URLs that name a recording (AI moment pastes, <img> fallbacks) point here and
// 302 to its CURRENT thumbnail (file names change on regeneration). Never for a private recording, or the
// redirect would hand its thumbnail URL to anyone who guesses the id.
function _generateRedirect(kind) {
    return async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad id' });
        let meta = null;
        try { meta = kind === 'vod' ? await media.getVod(id) : await media.getClip(id); } catch (err) {
            if (!(err && err.status === 404)) return res.status(502).json({ error: 'Media service unavailable' });
        }
        const visibility = meta && (meta.visibility || (Number(meta.is_public) ? 'public' : 'private'));
        const url = meta && visibility !== 'private' && media.publicUrl(meta.thumbnail_url);
        if (!url) return res.status(404).json({ error: 'No thumbnail' });
        res.set('Cache-Control', 'public, max-age=300');
        res.redirect(302, url);
    };
}
router.get('/generate/vod/:id', _generateRedirect('vod'));
router.get('/generate/clip/:id', _generateRedirect('clip'));

// ── Serve a thumbnail ────────────────────────────────────────
// Live thumbnails come from local disk; everything else 302s to openvibe.media.
router.get('/:filename', async (req, res) => {
    const filename = path.basename(req.params.filename);
    // stream-<id>-live.jpg: whatever that stream's live thumbnail is now (each capture gets a new
    // file name). The broadcaster's RTMP/JSMPEG preview polls it (public/js/broadcast.js
    // startRtmpPreview). Never cached; 404 when there is none, so the preview stays hidden rather
    // than showing the 1×1 placeholder.
    const alias = /^stream-(\d+)-live\.jpg$/.exec(filename);
    if (alias) {
        const current = await liveThumbs.getStreamThumbnailState(Number(alias[1]));
        if (current.exists) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': fs.statSync(current.filePath).size, 'Cache-Control': 'no-cache' });
            return pipeline(fs.createReadStream(current.filePath), res, () => {});
        }
        res.set('Cache-Control', 'no-cache');
        // The fallback frame for a WebRTC stream is a Media thumbnail URL (server/index.js).
        if (/^https:\/\//.test(current.thumbUrl || '')) return res.redirect(302, current.thumbUrl);
        return res.status(404).json({ error: 'No live thumbnail' });
    }
    const localPath = path.join(liveThumbs.THUMB_DIR, filename);
    if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        res.writeHead(200, {
            'Content-Type': filename.endsWith('.png') ? 'image/png' : 'image/jpeg',
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=30',
        });
        return pipeline(fs.createReadStream(localPath), res, () => {});
    }
    if (filename.startsWith('stream-')) {
        // Missing live thumbnail → transparent pixel (old behavior; avoids broken cards).
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': PIXEL.length, 'Cache-Control': 'no-cache' });
        return res.end(PIXEL);
    }
    // TODO(contract): legacy /api/thumbnails/<file> names map onto Media's /t/<file>
    // (Media inherits the same vod-/clip-/moment- thumbnail naming).
    res.set('Cache-Control', 'public, max-age=300');
    res.redirect(302, media.thumbUrl(filename));
});

module.exports = router;
