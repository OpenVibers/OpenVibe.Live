#!/usr/bin/env node
'use strict';
/**
 * Size budgets for the home page, computed from what the server actually renders for "/" — no
 * browser, no network, deterministic. Fails (exit 1) when a budget is exceeded, so a change that
 * quietly puts the broadcast desk back on the front page is caught in `npm test`.
 *
 *   npm run perf:budget
 *
 * Budgets sit a little above the 2026-09-17 measurements (docs/performance-audit.md). Raising one
 * should be a decision, not an accident: say why in the commit.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { check, format, assetsOf } = require('openvibe-shared/perf-budget');

const ROOT = path.join(__dirname, '..', '..');
// openvibe-shared/perf-budget names; "js" is the eager scripts (incl. route scripts for "/"),
// "css" the render-blocking stylesheets.
const BUDGETS = {
    htmlRawKB: 120,          // measured 94.9
    htmlBrotliKB: 30,
    jsFiles: 26,             // measured 23 (incl. route scripts for "/")
    jsRawKB: 1150,           // measured ~1000
    jsBrotliKB: 260,
    cssRawKB: 760,           // measured ~717 (style.css + home + icons + i18n)
    cssBrotliKB: 130,
};
// Code that must never be part of the home page's first load.
const FORBIDDEN_ON_HOME = ['/js/broadcast.js', '/js/broadcast-workspace.js', '/js/dashboard.js', '/js/call.js', '/js/voice-channels.js',
    '/js/stream-player.js', '/js/app-channel.js', '/js/arena.js', '/js/pastes.js', '/css/features/broadcast.css', '/css/features/channel.css'];

// perf-budget's measure() fetches from a running server; this script stays offline, so it reads
// what the server would render for "/" and hands check() the same measurement shape.
const assets = require(path.join(ROOT, 'server/web/assets'));
const SHARED_DIR = require('openvibe-shared/files').dir;
try { assets.setSharedDir(SHARED_DIR); } catch { /* */ }
const html = assets.renderRoute(assets.document('index.html').html, '/');
const fileFor = (url) => {
    const p = url.split('?')[0];
    return p.startsWith('/shared/') ? path.join(SHARED_DIR, path.basename(p)) : path.join(ROOT, 'public', p);
};
const kb = (n) => Math.round((n / 1024) * 10) / 10;
const br = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

// <noscript> fallbacks are not fetched by browsers with JavaScript on.
const named = assetsOf(html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, ''));
const local = (u) => u.startsWith('/') && !u.startsWith('//');
const scripts = named.js.filter(local);
const blockingCss = named.css.filter(local);
const read = (list) => list.map((u) => { try { return fs.readFileSync(fileFor(u)); } catch { return Buffer.alloc(0); } });
const total = (list) => {
    const bufs = read(list);
    return { files: list.length, rawKB: kb(bufs.reduce((n, b) => n + b.length, 0)), brotliKB: kb(bufs.reduce((n, b) => n + br(b), 0)) };
};
const htmlBuf = Buffer.from(html);
const measured = {
    url: '/', html: { rawKB: kb(htmlBuf.length), brotliKB: kb(br(htmlBuf)) },
    js: total(scripts), css: total(blockingCss),
    external: [...named.js, ...named.css].filter((u) => !local(u)), urls: { js: scripts, css: blockingCss },
};

const over = check(measured, BUDGETS);
console.log(format(measured, over));
let failed = over.length;
for (const f of FORBIDDEN_ON_HOME) {
    if (scripts.some((s) => s.startsWith(f + '?') || s === f) || blockingCss.some((s) => s.startsWith(f + '?') || s === f)) {
        failed++;
        console.log(`✗ ${f} is loaded by the home page`);
    }
}
console.log(failed ? `\n${failed} budget(s) exceeded` : '\nperformance budgets: all within limits');
process.exit(failed ? 1 : 0);
