/**
 * The live player's bar has one clock (owner, 2026-10-20: "why is there two spots for this and why is one inaccurate").
 * At the live edge the DVR time showed the recorded buffer's length ("1:30:00 [LIVE]"), which trails the stream by a
 * segment or more, next to the uptime ("1:30:17"). Now the bar shows no time of its own at the live edge; rewound, it
 * shows how far behind live you are. The LIVE button is a dot and a word, grey with "Go live" when behind.
 *
 *   node test/player-live-clock.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const src = read('public/js/stream-player.js');

/** The source of a top-level function declaration, braces matched (after its parameter list). */
function extract(name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = m.index + m[0].length;
    for (let parens = 1; parens; i++) { if (src[i] === '(') parens++; else if (src[i] === ')') parens--; }
    i = src.indexOf('{', i);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

const els = {
    'dvr-progress-fill': { style: {} },
    'dvr-time-display': { hidden: false, textContent: '0:00 / 0:00', title: '' },
    'video-container': { classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } } },
    'video-element': { currentTime: 0 },
};
const ctx = { document: { getElementById: (id) => els[id] || null }, Date, Math, isNaN, isFinite, String };
vm.createContext(ctx);
vm.runInContext(`${extract('_dvrFmtTime')}\n${extract('updateDVRUI')}\nthis.run = updateDVRUI;`, ctx);

// At the live edge: no time of its own (the buffer is 1:30:00 while the stream is 1:30:17 old).
ctx.dvrState = { active: true, isLive: true, duration: 5400, streamStartTime: Date.now() - 5417000, seeking: false };
vm.runInContext('var dvrState = this.dvrState;', ctx);
ctx.run();
const time = els['dvr-time-display'];
assert.strictEqual(time.hidden, true, 'no second clock at the live edge');
assert.strictEqual(time.textContent, '');
assert.ok(!src.includes('} [LIVE]`'), 'the "[LIVE]" time is gone');

// Rewound 42 s: how far behind live, with the position as the title.
vm.runInContext('dvrState.isLive = false;', ctx);
els['video-element'].currentTime = 5358;
ctx.run();
assert.strictEqual(time.hidden, false);
assert.strictEqual(time.textContent, '−0:42');
assert.match(time.title, /^1:29:18 of 1:30:00 recorded; behind live$/);
assert.ok(els['video-container'].classList.set.has('dvr-rewound'));

// The LIVE button: a dot and a word; grey "Go live" when behind.
assert.ok(src.includes(`liveBtn.innerHTML = '<span class="live-dot"></span>Go live';`));
assert.ok(src.includes(`liveBtn.innerHTML = '<span class="live-dot"></span>LIVE';`));
const fragment = read('public/fragments/channel.html');
assert.ok(fragment.includes('<button class="vc-btn dvr-live-btn" id="dvr-live-btn" title="Jump to live" style="display:none"><span class="live-dot"></span>LIVE</button>'));
assert.ok(fragment.includes('<span class="dvr-time-display" id="dvr-time-display" style="display:none" hidden></span>'));
const css = read('public/css/style.css');
assert.match(css, /\.dvr-time-display\[hidden\] \{ display: none !important; \}/);
assert.match(css, /\.dvr-live-btn\.dvr-behind \.live-dot \{[^}]*animation: none;/);
assert.ok(!/\.dvr-live-btn \{[^}]*livePulse/.test(css), 'no pulsing red box');
assert.match(read('public/css/features/channel.css'), /\.viewer-badge, \.uptime-badge \{[^}]*font-variant-numeric: tabular-nums;/);

// The bar looks like the network's player (openvibe-shared player.css): the same backdrop, 38 px buttons, a focus ring.
const backdrop = 'linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.62) 42%, rgba(0,0,0,0.22) 75%, transparent 100%)';
assert.ok(new RegExp(`\\.video-overlay \\{[^}]*background: ${backdrop.replace(/[().]/g, '\\$&')};`).test(css), 'the shared backdrop');
let shared = null;
try { shared = read('node_modules/openvibe-shared/player.css'); } catch { /* a pin older than 4.7.0 */ }
if (shared) assert.ok(shared.replace(/, /g, ',').includes(backdrop.replace(/, /g, ',')), 'still the shared player\'s backdrop');
assert.match(css, /\.vc-btn \{[^}]*min-width: 38px; min-height: 38px;/);
assert.match(css, /\.vc-btn:focus-visible \{[^}]*outline: 2px solid var\(--accent\);/);

console.log('player live clock: one clock at the live edge, "behind live" when rewound — all checks passed');
