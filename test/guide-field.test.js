'use strict';
// The guides' form field (public/js/ov-guide.js ui.field): .ovg-field is a grid, so the label's text and its
// "(optional)" note must be ONE grid item, or the note lands on a row of its own in heading weight (the go-live
// setup's "One line about it", 2026-10-15). The note itself is lighter than the label.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ov-guide.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'ov-guide.css'), 'utf8');
assert.ok(js.includes('field: (label, inputHtml) => `<label class="ovg-field"><span class="ovg-field-text">${label}</span>${inputHtml}</label>`'), 'the label text is wrapped as one grid item');
assert.match(css, /\.ovg-field-text \.muted \{ font-weight: 500;/, 'the optional note is lighter than the label');
console.log('guide field: the label and its note share one row');
