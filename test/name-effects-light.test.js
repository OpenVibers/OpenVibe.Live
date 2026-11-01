'use strict';
// Name effects on light themes: each effect in cosmetics.css was drawn on a dark page, and on white some names were
// unreadable (Neon and Glitch's #00ff88 at 1.3:1, Ice at 1.6:1, Divine's white). Each has a light-theme variant of the
// same hue, the same block as openvibe-shared 4.88.0's items.css (2026-11-01).
//   node test/name-effects-light.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'cosmetics.css'), 'utf8');
const effects = [...new Set([...css.matchAll(/^\.name-fx-([a-z]+) \{/gm)].map((m) => m[1]))];
assert.ok(effects.length >= 15, `the effects (${effects.length})`);
effects.forEach((fx) => {
    assert.match(css, new RegExp(`html\\[data-theme-mode="light"\\] \\.name-fx-${fx}[ ,{]`), `${fx} has a light-theme variant`);
});
['Fire', 'Ice', 'Neon'].forEach((k) => assert.match(css, new RegExp(`@keyframes nameFx${k}Light \\{`), `${k} has light keyframes`));
console.log('name effects light: all checks passed');
