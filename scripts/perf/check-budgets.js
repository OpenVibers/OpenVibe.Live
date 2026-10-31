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
    jsRawKB: 1245,   // 1244.3 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 1243.5 with openvibe-shared 4.64.0: the look travels between sites, the Look panel in the menu (2026-10-31); 1242.7 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face, and the ring on page moves (2026-10-31); 1238.8 with the home's featured stream once and the intro closed on phones (2026-10-31); 1237.4 with the home's two more tab blocks on phones (2026-10-30); 1233.9 with the home's Catch up tabs on phones (2026-10-30); 1230.8 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 1227.8 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 1223.5 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 1215.4 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); measured 1203.9 (2026-10-28: openvibe-shared 4.30.0, the bell center: tabs with counts, the Unread filter, thumbnails, swipe, the phone sheet; 4.31.0's ✦ adds about 3 KB); 1187.2 (2026-10-28: openvibe-shared 4.27.0, Notifications 2.0: opaque themed toasts held while a menu is open, grouping, priority, System cards and the rich bell panel); 1158.8 (2026-10-28: openvibe-shared 4.25.0, the menu's orb, messages, the phone sheet and auto-hide in the navbar; the messenger opens from the bar)
    jsBrotliKB: 292,   // 291.1 with openvibe-shared 4.57.1 (the Dock's async token and scope-aware controls, 4.57.0; the tool frame's facts, 4.56.0) (2026-10-31); 290.6 with the home's two more tab blocks on phones (2026-10-30); 289.8 with the home's Catch up tabs on phones (2026-10-30); 288.2 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 287.4 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); measured 283.2 (2026-10-28: openvibe-shared 4.30.0, the bell center as above); 279.6 (2026-10-28: openvibe-shared 4.27.0, Notifications 2.0 as above); 273.1 (2026-10-28: openvibe-shared 4.25.0 as above); 270.5 (2026-10-28: openvibe-shared 4.22.0, the navbar's search magnifier with / and Ctrl+K and the More menu; search.js and loading.js load only when used); 269.6 (2026-10-28: openvibe-shared 4.19.0, the account menu's gear and people-group icons inline; 268 on 2026-10-27: openvibe-shared 4.16.0, the folded balance chip, Across OpenVibe with site marks and the icon preload in the navbar); 265.3 (2026-10-27: openvibe-shared 4.15.0, the compact footer opens into the whole one, and the pulse line); 263.3 on 10-23 (openvibe-shared 4.9.0, status text twins in every theme); 262.5 on 10-17 (openvibe-shared 4.4.0, every site in the launcher)
    cssRawKB: 270,           // measured ~243 since the first-paint subset (style.core.css) replaced style.css (~717 before)
    cssBrotliKB: 55,         // measured ~47.5 (was ~130)
};
// Code that must never be part of the home page's first load.
const FORBIDDEN_ON_HOME = ['/js/broadcast.js', '/js/broadcast-workspace.js', '/js/dashboard.js', '/js/call.js', '/js/voice-channels.js',
    '/js/stream-player.js', '/js/app-channel.js', '/js/rundown.js', '/js/pastes.js', '/css/features/broadcast.css', '/css/features/channel.css'];

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
