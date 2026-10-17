'use strict';
// The home page's Featured live card shows the AI note alone in "Right now": the raw speech-to-text after " — heard:"
// (up to 500 characters, often another language) is never shown (owner, 2026-10-17: a Greek stream's transcript
// filled the card).
//
//   node test/home-featured-note.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'home-featured.js'), 'utf8');
const m = /const now = m && m\.description \? String\(m\.description\)\.replace\((\/[^\n]*?\/), ''\)\.trim\(\) : '';/.exec(src);
assert.ok(m, 'the card cuts the heard clause before showing the note');
// eslint-disable-next-line no-eval
const re = eval(m[1]);
assert.strictEqual('The main screen is black. — heard: "Δεν θα πούμε άλλο."'.replace(re, '').trim(), 'The main screen is black.');
assert.strictEqual('A quiet desk, chat is busy.'.replace(re, '').trim(), 'A quiet desk, chat is busy.', 'a note without one stays whole');
assert.ok(/\$\{escText\(now\)\}/.test(src) && !/\$\{escText\(m\.description\)\}/.test(src), 'what is shown is the cut note');
console.log('home featured note: all checks passed');
