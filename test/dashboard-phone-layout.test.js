'use strict';
/**
 * The streamer dashboard on a phone (signed-in sweep, 2026-11-09):
 * - "Bench on stream" was static markup in the Home grid, so it came first on every dashboard, above the profile. It is
 *   a round chat votes on: it now lives in the Chat tab, after Scenes, relocated like every other card.
 * - The phone grid was `1fr`, which grows to its widest content: one long line made every Chat-tab card 466 px wide on a
 *   390 px phone and the page zoomed out. It is `minmax(0, 1fr)` now.
 * - Address rows (chat overlay, scenes) showed two unlabeled full-width grey bars; they read Copy and Preview, side by side.
 *
 *   node test/dashboard-phone-layout.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/fragments/dashboard.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/features/dashboard.css'), 'utf8');

const home = html.slice(html.indexOf('id="dash-grid-home"'), html.indexOf('id="dash-panel-chatai"'));
assert.ok(!home.includes('dash-bench-stream'), 'Bench is not static markup in the Home grid');
const staging = html.slice(html.indexOf('id="dash-staging"'));
assert.ok(staging.includes('id="dash-bench-stream"'), 'Bench is authored in the staging grid like the other cards');
assert.ok(/chatai:\s*\[[^\]]*'dash-card-scenes', 'dash-bench-stream'/.test(js), 'Bench is relocated into the Chat tab after Scenes');
assert.ok(/home:\s*\['dash-card-profile'/.test(js), 'the profile leads Home');
assert.ok(/chat votes for the better one with !1, !2 or !tie/.test(staging), 'the card says what a round is');

const phone = css.slice(css.indexOf('@media (max-width: 768px)'));
assert.ok(/\.dash-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(phone), 'the phone column can shrink below its content');
assert.ok(/\.dash-card \.key-display \{ flex-direction: row; \}/.test(phone), 'Copy and Preview share a row on a phone');

assert.ok(/fa-copy" aria-hidden="true"><\/i> Copy'/.test(js) && /aria-hidden="true"><\/i> Preview'/.test(js), 'scene buttons are labelled');
assert.ok(/copyDashObsOverlayUrl\(\)[^>]*>\s*<i class="fa-solid fa-copy" aria-hidden="true"><\/i> Copy/.test(html), 'the overlay copy button is labelled');

console.log('dashboard on a phone: Bench in the Chat tab, columns that shrink, labelled address buttons');
