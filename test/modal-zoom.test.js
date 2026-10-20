/**
 * Dialogs when the page is zoomed in (owner, 2026-10-20: "when zooming into the website the popovers like this are all
 * messed up and hard to scroll through" — the restream destination form under the navbar, cut off at both ends).
 *
 * A full-screen overlay that centres its dialog with flexbox pushes a dialog taller than the window off both edges,
 * where nothing can scroll to it. Every such overlay is in style.css's `body :is(…)` rule (it scrolls, centres only
 * while the dialog fits, and keeps the scroll off the page behind), and sits above the navbar.
 *
 *   node test/modal-zoom.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cssDir = path.join(root, 'public/css');
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.css') && !e.name.endsWith('.core.css')) files.push(p);
    }
})(cssDir);

const style = fs.readFileSync(path.join(cssDir, 'style.css'), 'utf8');
const ruleMatch = /body :is\(([^)]*)\) \{([^}]*)\}/.exec(style);
assert.ok(ruleMatch, "style.css has the overlays' body :is(…) rule");
const covered = new Set(ruleMatch[1].split(',').map((s) => s.trim()));
assert.match(ruleMatch[2], /overflow-y: auto;/);
assert.match(ruleMatch[2], /overscroll-behavior: contain;/);
assert.match(ruleMatch[2], /align-items: safe center;/);

// Every full-screen overlay that centres a dialog, in every stylesheet.
const NAVBAR_Z = 1000;
const missing = [];
const below = [];
for (const file of files) {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2];
        const fixed = /position:\s*fixed/.test(body) && (/inset:\s*0\b/.test(body) || (/top:\s*0\b/.test(body) && /bottom:\s*0\b/.test(body)));
        if (!fixed || !/align-items:\s*center/.test(body) || /overflow(-y)?:\s*(auto|scroll)/.test(body)) continue;
        for (const sel of m[1].split(',').map((s) => s.trim())) {
            if (!/^\.[\w-]+$/.test(sel)) continue;
            // Full-screen surfaces that are not dialogs: a call's own view and the stats page's chart viewer.
            if (['.vc-call-overlay', '.sn-overlay'].includes(sel)) continue;
            if (!covered.has(sel)) missing.push(`${path.relative(root, file)} ${sel}`);
            const z = /z-index:\s*(\d+)/.exec(body);
            if (z && Number(z[1]) < NAVBAR_Z) below.push(`${sel} (z-index ${z[1]})`);
        }
    }
}
assert.deepStrictEqual(missing, [], 'a centred full-screen overlay must scroll when its dialog is taller than the window');
assert.deepStrictEqual(below, [], 'a dialog overlay sits above the navbar (z-index 1000)');

// The restream form's dialog scrolls inside too, and its overlay is above the navbar.
const features = fs.readFileSync(path.join(cssDir, 'features/broadcast.css'), 'utf8');
const dialog = /\.bc-ws-confirm-dialog \{([^}]*)\}/.exec(features)[1];
assert.match(dialog, /max-height: calc\(100dvh - 32px\);/);
assert.match(dialog, /overflow-y: auto;/);
const overlay = /\.bc-ws-confirm-overlay \{([^}]*)\}/.exec(fs.readFileSync(path.join(cssDir, 'broadcast.css'), 'utf8'))[1];
assert.match(overlay, /z-index: 2000;/);

console.log(`modal zoom: ${covered.size} dialog overlays scroll when zoomed in, above the navbar — all checks passed`);
