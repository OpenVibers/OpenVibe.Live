/**
 * The live player's fullscreen button never leaves the control bar on a phone (Maticus, 2026-10-26: "it cuts it off
 * right at the scissors … you can't tap the square thing to make it full screen"). Measured in Chrome: at 360 px with
 * larger text while rewinding, the bar (play, volume, time, LIVE, viewers, stats, clip, fullscreen) was 6 px wider than
 * the player and the container clipped the last button. Buttons keep their size; the readouts give way; the stats gauge
 * steps aside on a narrow phone.
 *
 *   node test/player-controls-fit.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
const frag = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'channel.html'), 'utf8');

assert.ok(css.includes('.video-controls > * { flex-shrink: 0; }'), 'no button shrinks or is pushed out');
const giving = css.match(/\.video-controls > \.dvr-time-display,\s*\.video-controls > \.viewer-badge,\s*\.video-controls > \.uptime-badge \{([^}]*)\}/);
assert.ok(giving && /flex-shrink: 1/.test(giving[1]) && /min-width: 0/.test(giving[1]) && /text-overflow: ellipsis/.test(giving[1]), 'the readouts give way');
assert.match(css, /@media \(max-width: 420px\) \{\s*\.video-controls > #btn-stats \{ display: none; \}\s*\}/, 'the gauge steps aside on a narrow phone');

// Fullscreen stays the bar's last button, right after the clip button.
const bar = frag.slice(frag.indexOf('<div class="video-controls">'), frag.indexOf('<!-- Stream stats overlay'));
const ids = [...bar.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
assert.deepStrictEqual(ids.slice(-2), ['btn-clip', 'btn-fullscreen']);

console.log('player controls fit: fullscreen stays on the bar at phone widths');
