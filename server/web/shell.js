'use strict';

/**
 * sendShell for the SPA fallback (server/web/page-status.js spaFallback): the page shell from seo.shellHtml for a URL,
 * with the status the fallback set (a 404 shell is noindex with no canonical), or the plain index.html when the SEO
 * shell is unavailable. Kept out of server/index.js so the page-status test exercises this exact function.
 *
 * seo.shellHtml is async (server/seo/pages.js): its result must be awaited. Sending the unawaited Promise answered every
 * page without its own SEO renderer (channels, /updates, /settings, /documentation, …) with `{}` after the PostgreSQL
 * switch (2026-10-08).
 */
function createSendShell({ shellHtml, sendDocument, assets }) {
    return async function sendShell(res, urlPath) {
        let html = null;
        try { html = shellHtml ? await shellHtml(urlPath, res.statusCode) : null; } catch { html = null; }
        if (typeof html !== 'string' || !html) return sendDocument(res, 'index.html', urlPath);
        if (!res.getHeader('Cache-Control')) assets.setNoCache(res);
        try { res.setHeader('Content-Security-Policy-Report-Only', assets.cspReportOnly(html)); } catch { /* the header is optional */ }
        res.type('html').send(html);
        return true;
    };
}

module.exports = { createSendShell };
