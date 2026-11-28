/**
 * The home costs little while it sits still (2026-11-28; a tablet at 4x CPU, idle: 5.1 s of every 10 s on the main thread).
 *
 * - The Live Now dot's glow is a layer of its own that only fades (an animated drop-shadow filter re-layered the whole page
 *   every frame, 2.3 s of every 10 s); the dot itself only scales.
 * - The hero buttons' wave, pulse and spark play three times when the row comes into view, then rest; they exist only
 *   while the row is .fx-live, so each arrival starts them from the top. Hover still lifts the icon.
 *
 *   node test/home-idle-rests.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'home-fx.css'), 'utf8');
const live = /@keyframes hfxLive \{([^\n]*)\}\n/.exec(css)[1];
assert.ok(!/filter|shadow/.test(live), `the dot only scales: ${live}`);
assert.ok(/@keyframes hfxLiveGlow \{ 0%,100% \{ opacity: 0; \} 50% \{ opacity: 1; \} \}/.test(css), 'its glow only fades');
assert.ok(/#page-home \.section-header h2 \.live-dot::after \{[^}]*animation: hfxLiveGlow [^;]*infinite;/.test(css), 'the glow is the dot\'s own layer');

assert.ok(css.includes('#page-home .hero-cta.fx-live .hb::before { animation: hbWave var(--hb-wave) linear 3;'), 'the wave: three, while the row is live');
assert.ok(css.includes('#page-home .hero-cta.fx-live .hb-ico { animation: hbPulse var(--hb-wave) var(--ov-ease-in-out, ease-in-out) 3;'), 'the pulse: three');
assert.ok(css.includes('#page-home .hero-cta.fx-live .hb-vibe .hb-ico::after { animation: hbSpark 4.4s var(--ov-ease-out, ease-out) 3; }'), 'the spark: three');
assert.ok(!/hb(Wave|Pulse|Spark) [^;]*infinite/.test(css), 'none of them endless');
assert.ok(css.includes('#page-home .hero-cta .hb:is(:hover, :focus-visible) .hb-ico { animation: none; }'), 'hover still lifts the icon (the pulse steps aside)');
// They rest where the loop would: the wave off the button, the icon at its size, the spark gone.
assert.ok(/@keyframes hbWave \{[^}]*\} 22%, 100% \{ transform: translateX\(330%\); \} \}/.test(css));
assert.ok(/@keyframes hbPulse \{ 0%, 100% \{ transform: scale\(1\); \}/.test(css));
assert.ok(/@keyframes hbSpark \{[\s\S]*?100% \{ opacity: 0;/.test(css));
console.log('home-idle-rests: the live dot glows on its own layer; the hero buttons wave three times and rest');
