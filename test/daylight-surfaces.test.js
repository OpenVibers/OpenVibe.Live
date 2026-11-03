'use strict';
// Light themes (Daylight and the other light ones) read every surface (11-03 Daylight pass). A box with a hard-coded
// dark background and the theme's text colour turned into dark text on a dark box on a light theme: toasts, the
// incoming-call card, the studio's panel and modal. Those take the theme's own card now. Surfaces that cover a video or
// a picture stay dark in every theme, so their words are light whatever the theme: the adult-content gate, the paste chip.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const css = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'css', f), 'utf8');
const rule = (src, sel) => { const i = src.indexOf(`${sel} {`); assert.ok(i >= 0, `${sel} exists`); return src.slice(i, src.indexOf('}', i)); };

const style = css('style.css');
const toast = rule(style, '\n.toast');
assert.match(toast, /background: color-mix\(in srgb, var\(--bg-card\) 94%, transparent\);/);
assert.match(toast, /border: 1px solid var\(--border\);/);
assert.ok(!/rgba\(23, 27, 39/.test(toast), 'no navy toast');
assert.match(rule(style, '.vc-call-toast-card'), /background: color-mix\(in srgb, var\(--bg-card\) 96%, transparent\);/);
assert.match(rule(style, '.home-paste-icon'), /color: #fff;/, 'the chip over a paste\'s picture keeps a light glyph');
assert.match(rule(style, '.stream-nsfw-gate-card h2'), /color: #fff;/);
assert.match(rule(style, '.stream-nsfw-gate-card p'), /color: rgba\(255, 255, 255, 0\.76\);/);
assert.match(rule(css('broadcast.css'), '.bc-modal-content'), /background: var\(--bg-card\);\s*border: 1px solid var\(--border\);/);
assert.match(rule(css('features/broadcast.css'), '.broadcast-main'), /background: color-mix\(in srgb, var\(--bg-card\) 78%, transparent\);/);
console.log('daylight surfaces: all checks passed');
