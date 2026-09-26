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
router.post('/live/:streamId', requireAuth, upload.single('thumbnail'), (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const stream = db.getStreamById(streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && !can(req.user, 'staff.streams.manage')) {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) return res.status(400).json({ error: 'Stream is not live' });
        const imageData = req.file ? req.file.buffer : (req.body && req.body.image);
        if (!imageData) return res.status(400).json({ error: 'No image data provided' });
        const thumbUrl = liveThumbs.saveLiveThumbnail(streamId, imageData);
        if (thumbUrl) res.json({ thumbnail_url: thumbUrl });
        else res.status(400).json({ error: 'Invalid image data' });
    } catch (err) {
        console.error('[Thumbnails] Live upload error:', err.message);
        res.status(500).json({ error: 'Failed to save thumbnail' });
    }
});

// ── Regenerate VOD / clip thumbnails (delegated to Media) ────
async function generateFor(kind, id, req, res) {
    try {
        const meta = kind === 'vod' ? await media.getVod(id) : await media.getClip(id);
        const notFound = () => res.status(404).json({ error: `${kind === 'vod' ? 'VOD' : 'Clip'} not found` });
        // A private item is missing to anyone who may not see it (a 403 would confirm it exists).
        if (!meta || !access.canView(req.user, meta)) return notFound();
        const canManage = !!req.user && (meta.user_id === req.user.id || can(req.user, 'staff.streams.manage'));
        const isPublic = meta.visibility ? meta.visibility === 'public' : !!meta.is_public;
        if (!canManage && !isPublic) return res.status(403).json({ error: `Not your ${kind}` });
        const out = await media.generateThumbnail(kind, id);
        const url = media.publicUrl(out?.url || meta.thumbnail_url);
        if (url) return res.json({ thumbnail_url: url });
        res.status(500).json({ error: 'Failed to generate thumbnail' });
    } catch (err) {
        if (err && err.name === 'MediaApiError' && err.status) return res.status(err.status).json(err.body || { error: err.message });
        res.status(502).json({ error: 'Media service unavailable' });
    }
}
router.post('/generate/vod/:id', optionalAuth, (req, res) => generateFor('vod', req.params.id, req, res));
router.post('/generate/clip/:id', optionalAuth, (req, res) => generateFor('clip', req.params.id, req, res));
// GET variants: <img> onerror fallbacks point here. Media's legacy
// /api/thumbnails/<kind>-<id>-<ts>.jpg route resolves the CURRENT thumbnail for
// that id (names drift on regeneration), so bounce through it with a fake ts.
function _generateRedirect(kind) {
    return (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
        res.set('Cache-Control', 'public, max-age=300');
        res.redirect(302, media.publicUrl(`/api/thumbnails/${kind}-${id}-0.jpg`));
    };
}
router.get('/generate/vod/:id', _generateRedirect('vod'));
router.get('/generate/clip/:id', _generateRedirect('clip'));

// ── Serve a thumbnail ────────────────────────────────────────
// Live thumbnails come from local disk; everything else 302s to openvibe.media.
router.get('/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    // stream-<id>-live.jpg: whatever that stream's live thumbnail is now (each capture gets a new
    // file name). The broadcaster's RTMP/JSMPEG preview polls it (public/js/broadcast.js
    // startRtmpPreview). Never cached; 404 when there is none, so the preview stays hidden rather
    // than showing the 1×1 placeholder.
    const alias = /^stream-(\d+)-live\.jpg$/.exec(filename);
    if (alias) {
        const current = liveThumbs.getStreamThumbnailState(Number(alias[1]));
        if (current.exists) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': fs.statSync(current.filePath).size, 'Cache-Control': 'no-cache' });
            return fs.createReadStream(current.filePath).pipe(res);
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
        return fs.createReadStream(localPath).pipe(res);
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
