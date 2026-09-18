'use strict';
// Regression: a desktop-dropdown "click outside" handler must never close the mobile drawer, or the hamburger
// opens and closes it in the same click (shipped once, 2026-09-18).
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const body = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, `${name} exists`); let d = 0, j = src.indexOf('{', i); const s = j; for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(s, j + 1); };
assert.ok(!/closeMobileNav\s*\(/.test(body('closeNavDropdowns')), 'closeNavDropdowns leaves the mobile drawer alone');
assert.ok(/closeMobileNav\s*\(/.test(body('closeNavPanels')) && /closeNavDropdowns\s*\(/.test(body('closeNavPanels')), 'closeNavPanels closes everything');
assert.ok(/classList\.toggle\('show'\)/.test(body('toggleMobileNav')), 'hamburger toggles the drawer');
console.log('nav panels: all checks passed');
