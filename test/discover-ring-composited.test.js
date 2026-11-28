/**
 * The Discover count's pulse is a ring the compositor draws (2026-11-28). It was a box-shadow that changed every frame:
 * on a channel page that repainted and re-layered the whole page ~20 times a second while it sat still (idle at 4x CPU,
 * 8.5 s of every 10 s on the main thread; 2.7 s with this and Shared 4.344's resting loops).
 *
 * - The count itself does not animate; its ::after ring does, forever, while the board is closed.
 * - The ring's keyframes change only transform and opacity.
 * - The light page (.rs-lite) shows no ring.
 *
 *   node test/discover-ring-composited.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'context-cards.css'), 'utf8');
assert.ok(!/\.dsc-toggle-count\s*\{[^}]*animation/.test(css), 'the count itself does not animate');
assert.ok(/\.dsc-wrap:not\(\.is-open\) \.dsc-toggle-count::after \{[^}]*animation: dscPulse [^;]*infinite;/.test(css), 'its ring pulses while the board is closed');
const frames = /@keyframes dscPulse \{([\s\S]*?)\n\}/.exec(css)[1];
assert.ok(!/box-shadow|width|height|background|border|inset/.test(frames), `only transform and opacity change: ${frames}`);
assert.ok(/transform: scale\(/.test(frames) && /opacity: 0/.test(frames), 'it grows and fades');
assert.ok(css.includes('.rs-lite .dsc-toggle-count::after { animation: none !important; opacity: 0; }'), 'no ring on the light page');
console.log('discover-ring-composited: the Discover count pulses as a ring of its own (transform and opacity only)');
