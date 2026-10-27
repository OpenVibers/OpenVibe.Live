/**
 * The Content page's "New paste" (owner, 2026-10-27: "This button does nothing."). The button sits in the page header,
 * beside AI Moments, outside the filter bar the feed listened to, so its taps never reached the feed's controls; and the
 * paste box was shrunk to two lines by `textarea.form-input`'s 60px minimum.
 *
 *   node test/content-new-paste.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const feed = read('public/js/content-feed.js');
const fragment = read('public/fragments/content.html');

// The button is in the header, and the header's clicks go through the same controls as the filter bar's.
const head = fragment.slice(fragment.indexOf('<header class="cf-head">'), fragment.indexOf('</header>'));
assert.ok(head.includes('data-cf-new-paste'), 'New paste sits in the header');
const headListener = /scope\.listen\(wrap\.querySelector\('\.cf-head'\), 'click', \(e\) => \{[\s\S]*?\n {8}\}\);/.exec(feed);
assert.ok(headListener, 'the header has a click listener');
assert.ok(/onControl\(e\);/.test(headListener[0]), 'its clicks reach onControl, which opens the paste form');
assert.ok(feed.includes("if (window.ov) ov.load('pastes').then(go, go); else go();"), 'a failed feature load still lands on the paste form (the pastes page)');

// The paste box keeps its 240px: a selector at least as specific as textarea.form-input, and later in the file.
const css = read('public/css/style.css');
const generic = css.indexOf('textarea.form-input { resize: vertical; min-height: 60px; }');
const paste = css.indexOf('textarea.paste-textarea {');
assert.ok(generic > -1 && paste > generic, 'textarea.paste-textarea comes after textarea.form-input');
assert.ok(/textarea\.paste-textarea \{\s*min-height: 240px;/.test(css));

console.log('content new paste: all checks passed');
