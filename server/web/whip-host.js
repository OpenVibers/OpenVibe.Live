'use strict';
/**
 * The WHIP ingest host (config.whip.publicUrl, whip.openvibe.live) answers WHIP only: /whip and /whip/* (and
 * /api/health), and every other path moves to the site's own address with a 301. The same process serves both
 * names, so opened in a browser it showed the whole site on a second origin: a second copy of every page, and API
 * calls the credentialed CORS allowlist refused (logged once an hour, 2026-10-23).
 *
 *   app.use(createWhipHostRedirect({ whipUrl: () => …, siteUrl: () => … }))
 *
 * Both are read per request: config.whip is filled by the URL-registry refresh after the middleware is built. With
 * no WHIP host, or one that is the site's own, it does nothing.
 */
function hostOf(url) {
    try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
}

function createWhipHostRedirect({ whipUrl, siteUrl }) {
    return function whipHostRedirect(req, res, next) {
        const whip = hostOf(whipUrl());
        const site = hostOf(siteUrl());
        if (!whip || !site || whip.hostname === site.hostname || req.hostname !== whip.hostname) return next();
        if (req.path === '/whip' || req.path.startsWith('/whip/') || req.path === '/api/health') return next();
        return res.redirect(301, `${site.origin}${req.originalUrl}`);
    };
}

module.exports = { createWhipHostRedirect };
