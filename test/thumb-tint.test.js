'use strict';
// A card's picture sits on its streamer's colour until it arrives (plan L52; the owner, 11-01: "placeholder elements
// while it loads, a fake thumbnail… so it is not jarring"). The function is public/js/app-home.js's own, run here.
//   node test/thumb-tint.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
const body = /function _thumbTint\(s\) \{[\s\S]*?\n\}\n/.exec(src);
assert.ok(body, 'app-home.js has _thumbTint');
const _thumbTint = new Function(`${body[0]}; return _thumbTint;`)();

assert.strictEqual(_thumbTint({ profile_color: '#3366ff', username: 'ana' }), '#3366ff', 'the streamer\'s own colour');
assert.match(_thumbTint({ profile_color: 'red;background:url(x)', username: 'ana' }), /^hsl\(\d+ 45% 34%\)$/, 'anything but a plain colour is not used');
assert.strictEqual(_thumbTint({ username: 'ana' }), _thumbTint({ username: 'ana' }), 'the same name, the same colour');
assert.notStrictEqual(_thumbTint({ username: 'ana' }), _thumbTint({ username: 'kai' }), 'another name, another colour');
assert.match(_thumbTint({}), /^hsl\(0 45% 34%\)$/);
assert.match(src, /<div class="stream-card-thumb\$\{[^}]+\}" style="--thumb-tint:\$\{esc\(_thumbTint\(s\)\)\}">/, 'the card wears it');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
assert.match(css, /\.stream-card-thumb \{\s*aspect-ratio: 16\/9;[\s\S]{0,200}var\(--thumb-tint/, 'the box is drawn in it');
console.log('thumb tint: all checks passed');
