'use strict';
/**
 * The shell, on the server's side: the early hints (openvibe-shared/sw, Shared 4.164.0) and the manifest the shared worker
 * reads.
 *
 * The hints: the browser gets the navbar, the theme loader, the first paint CSS and the site's own app script before the
 * HTML arrives, so they download while the server is still writing the page (RFC 8297, a 103 Early Hints response). The
 * same links ride in the page's Link header, so a proxy that drops the 103 still hands the browser the hint.
 *
 * The manifest: the files the shared worker (openvibe-sw.js) keeps in its cache, by content hash, so the worker warms the
 * shell without downloading a second copy of a file the page already asks for.
 *
 * The shared helper lands with the next openvibe-shared pin; until then this file does the same things by hand, and the
 * pin makes the shared one take over (the same answer, one place).
 */
const assets = require('./assets');

let shared = null;
try { shared = require('openvibe-shared/sw'); } catch { /* the pin that carries the shared helper has not landed yet */ }

/**
 * The files every Live page loads, by content hash: the shell's scripts and the first paint CSS. The hash means the browser
 * can keep them for a year, and means a release that changes them hands out new URLs.
 */
function shellLinks() {
    return [
        { href: assets.versioned('/css/style.core.css'), as: 'style' },
        { href: assets.versioned('/shared/navbar.js'), as: 'script' },
        { href: assets.versioned('/shared/theme-loader.js'), as: 'script' },
        { href: assets.versioned('/js/app.js'), as: 'script' },
    ].filter((l) => l && l.href);
}

/** Send the hints for a response. Returns true when a 103 went out. */
function earlyHints(res, links) {
    if (shared && typeof shared.earlyHints === 'function') return shared.earlyHints(res, links);
    const list = (links || []).filter((l) => l && l.href);
    if (!list.length || !res) return false;
    const header = list.map((l) => '<' + l.href + '>; rel=preload' + (l.as ? '; as=' + l.as : '')).join(', ');
    let sent = false;
    if (typeof res.writeEarlyHints === 'function') {
        try { res.writeEarlyHints({ link: list.map((l) => '<' + l.href + '>; rel=preload' + (l.as ? '; as=' + l.as : '')) }); sent = true; } catch { /* the response was already on its way */ }
    }
    if (!res.headersSent) {
        try { res.setHeader('Link', header); } catch { /* the header was set already */ }
    }
    return sent;
}

/**
 * Express middleware: hint a page, never a file. A file request already knows its own URL, and the API is none of the
 * browser's business.
 */
function hints() {
    return function liveEarlyHints(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const p = String(req.path || '');
        if (p.startsWith('/api/') || p.startsWith('/shared/') || p.startsWith('/js/') || p.startsWith('/css/')) return next();
        const accept = String(req.headers.accept || '');
        if (accept && accept.indexOf('text/html') < 0) return next();
        try { earlyHints(res, shellLinks()); } catch { /* a hint is never worth a page */ }
        return next();
    };
}

/**
 * The shell the worker keeps: the shared files every Live page loads, by content hash. The worker asks for this once and
 * puts the answers in its cache, so a later visit does not wait for the network at all.
 */
function manifest() {
    const files = [
        '/shared/navbar.js',
        '/shared/theme-loader.js',
        '/shared/web-runtime.js',
        '/shared/footer.js',
        '/shared/nav-icons.js',
    ];
    return { version: shared && shared.VERSION ? shared.VERSION : null, shell: files.map((f) => assets.versioned(f)).filter(Boolean) };
}

module.exports = { shellLinks, manifest, earlyHints, hints };
