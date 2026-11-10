'use strict';
/**
 * A phone is not "lite" (the owner, 2026-11-10: "none of the cool animations work even though I have the motion on").
 * Until then every phone was: a coarse pointer, a screen under 820 px or 4 GB of memory put .rs-lite on <html>, and
 * .rs-lite and a phone-width block in home-fx.css switched the home's motion off whatever the person's Motion setting
 * said. Lite is a device that says it is short of memory, or a person saving data; a phone plays the home's motion.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// The decision before first paint, and the same rule in the home's effects script.
const html = read('public/index.html');
const decide = html.slice(html.indexOf('"Lite" rendering'), html.indexOf("classList.add('rs-lite')"));
assert.ok(decide.length > 0, 'index.html decides lite before first paint');
assert.ok(/navigator\.deviceMemory <= 2/.test(decide) && /saveData/.test(decide), 'lite: short of memory, or saving data');
assert.ok(!/pointer: coarse|max-width/.test(decide), 'a touch screen or a narrow one is not lite');
assert.ok(!/data-ov-motion/.test(decide), 'lite does not read the Motion setting: they are two different things');

const fx = read('public/js/home-fx.js');
const lite = /const LITE = ([^;]+);/.exec(fx);
assert.ok(lite && /deviceMemory <= 2/.test(lite[1]) && /saveData/.test(lite[1]) && !/COARSE|max-width/.test(lite[1]), 'home-fx.js: the same rule');
assert.ok(/if \(sparksStop \|\| LITE\) return;/.test(fx), 'the sparks run on a phone (fewer, without the glow)');
assert.ok(/function attachHeroPointer\(\) \{\s+if \(LITE \|\| COARSE\) return;/.test(fx), 'what follows a pointer is left out where there is none');

// The phone block of the home's effects keeps layout and glass rules only: nothing in it stops an animation.
const css = read('public/css/home-fx.css');
const at = css.indexOf('@media (max-width: 820px), (pointer: coarse) {');
assert.ok(at > 0, 'the phone block is there');
const block = css.slice(at, css.indexOf('\n}\n', at));
assert.ok(!/animation:\s*none/.test(block), 'the phone block stops no animation');
assert.ok(/\.hero-collage \{ display: none !important; \}/.test(block), 'it still leaves out the collage, which has no room');

// The base stylesheet's phone block keeps layout and glass rules only too: the hero background's slow pan is
// transform-only, and a narrow screen is not a reason to stop it.
const style = read('public/css/style.css');
const styleAt = style.indexOf('@media (max-width: 720px) {');
assert.ok(styleAt > 0, 'the base stylesheet has its phone block');
const styleBlock = style.slice(styleAt, style.indexOf('\n}\n', styleAt));
assert.ok(!/\.hero-bg-layer\.active\s*\{[^}]*animation:\s*none/.test(styleBlock), 'the hero background keeps its 12s pan on a phone');

console.log('home-lite: ok');
