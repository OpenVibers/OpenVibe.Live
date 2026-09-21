'use strict';
/**
 * Privacy/security proxy for images that live outside OpenVibe (offline-screen HTML, panels,
 * anywhere a streamer can paste a third-party URL). Without this, a viewer's browser fetches
 * the image directly — leaking their IP, User-Agent and Referer to a host the streamer chose,
 * a classic tracking-pixel vector. We fetch it here instead, so the third party only ever sees
 * OpenVibe's server, and we cache the result so repeat views don't re-fetch it at all.
 *
 * SSRF-guarded via server/net/egress.js (connect-time address policy on every redirect hop, the
 * same mechanism the kiosk link-preview and media-downloader routes use for user-chosen URLs).
 */
const express = require('express');
const egress = require('../net/egress');
const router = express.Router();

const FETCH_TIMEOUT_MS = 5000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
// SVG is deliberately excluded: a browser that navigates directly to a proxied URL (new tab,
// "open image") executes any <script> inside an SVG document. Every other image type is inert.
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);

function normalizeUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u;
}

// ── GET /api/img-proxy?url=<external image URL> ─────────────────────
router.get('/', async (req, res) => {
    const u = normalizeUrl(req.query.url);
    if (!u) return res.status(400).json({ error: 'Invalid image URL' });

    let r;
    try {
        r = await egress.fetchBuffer(u.href, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES, maxRedirects: 3 });
    } catch (e) {
        const denied = e && e.code === 'EGRESS_DENIED';
        return res.status(denied ? 403 : 502).json({ error: denied ? 'That address cannot be fetched' : 'Fetch failed' });
    }
    if (r.status < 200 || r.status >= 300) return res.status(502).json({ error: `Upstream returned ${r.status}` });

    const type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) return res.status(415).json({ error: 'Not a supported image type' });
    if (!r.body.length) return res.status(502).json({ error: 'Empty response' });

    // Cacheable and immutable from the client/CDN's point of view — the URL is the cache key, and
    // a streamer who wants a fresh image at the same URL should change the URL (as with any CDN
    // asset). Cloudflare sits in front of this site, so this also gets us edge caching for free:
    // repeat viewers never reach this route, and the third-party host is fetched at most once
    // per Cloudflare PoP per day.
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Content-Disposition', 'inline');
    // No Referer/identifying headers are forwarded to the client here — nothing about the
    // original fetch (redirect chain, upstream headers) leaks past content-type.
    res.end(r.body);
});

module.exports = router;
