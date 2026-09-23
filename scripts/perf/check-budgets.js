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

const ROOT = path.join(__dirname, '..', '..');
const BUDGETS = {
    htmlRawKB: 120,          // measured 94.9
    htmlBrotliKB: 30,
    eagerJsFiles: 26,        // measured 23 (incl. route scripts for "/")
    eagerJsRawKB: 1150,      // measured ~1000
    eagerJsBrotliKB: 260,
    blockingCssRawKB: 760,   // measured ~717 (style.css + home + icons + i18n)
    blockingCssBrotliKB: 130,
};
// Code that must never be part of the home page's first load.
const FORBIDDEN_ON_HOME = ['/js/broadcast.js', '/js/broadcast-workspace.js', '/js/dashboard.js', '/js/call.js', '/js/voice-channels.js',
    '/js/stream-player.js', '/js/app-channel.js', '/js/arena.js', '/js/pastes.js', '/css/features/broadcast.css', '/css/features/channel.css'];

const assets = require(path.join(ROOT, 'server/web/assets'));
const SHARED_DIR = require('openvibe-shared/files').dir;
try { assets.setSharedDir(SHARED_DIR); } catch { /* */ }
const html = assets.renderRoute(assets.document('index.html').html, '/');
const fileFor = (url) => {
    const p = url.split('?')[0];
    return p.startsWith('/shared/') ? path.join(SHARED_DIR, path.basename(p)) : path.join(ROOT, 'public', p);
};
const kb = (n) => +(n / 1024).toFixed(1);
const br = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.startsWith('/'));
// <noscript> fallbacks are not fetched by browsers with JavaScript on.
const blockingCss = [...html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '').matchAll(/<link rel="stylesheet" href="([^"]+)"(?![^>]*media="print")[^>]*>/g)].map((m) => m[1]).filter((s) => s.startsWith('/'));
const read = (list) => list.map((u) => { try { return fs.readFileSync(fileFor(u)); } catch { return Buffer.alloc(0); } });
const jsBufs = read(scripts), cssBufs = read(blockingCss);
const sum = (arr, f) => arr.reduce((n, b) => n + f(b), 0);

const measured = {
    htmlRawKB: kb(Buffer.byteLength(html)),
    htmlBrotliKB: kb(br(Buffer.from(html))),
    eagerJsFiles: scripts.length,
    eagerJsRawKB: kb(sum(jsBufs, (b) => b.length)),
    eagerJsBrotliKB: kb(sum(jsBufs, br)),
    blockingCssRawKB: kb(sum(cssBufs, (b) => b.length)),
    blockingCssBrotliKB: kb(sum(cssBufs, br)),
};

let failed = 0;
for (const [k, limit] of Object.entries(BUDGETS)) {
    const v = measured[k];
    const ok = v <= limit;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${k.padEnd(20)} ${String(v).padStart(8)} / ${limit}`);
}
for (const f of FORBIDDEN_ON_HOME) {
    if (scripts.some((s) => s.startsWith(f + '?') || s === f) || blockingCss.some((s) => s.startsWith(f + '?') || s === f)) {
        failed++;
        console.log(`✗ ${f} is loaded by the home page`);
    }
}
console.log(failed ? `\n${failed} budget(s) exceeded` : '\nperformance budgets: all within limits');
process.exit(failed ? 1 : 0);
