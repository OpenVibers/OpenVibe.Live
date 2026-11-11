'use strict';
// Content labels on Live's cards and player (L1): each carries data-ov-labels for Shared's ov-labels.js (the viewer's
// own show, blur or hide) and chips in words; the streamer's own content is never marked for them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('public/js/app.js');
const start = app.indexOf('const OV_LABEL_NAMES = ');
const ctx = { currentUser: null, window: {}, esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
vm.createContext(ctx);
vm.runInContext(app.slice(start) + '\n;this.h = { ovLabelsOf, ovLabelsAttr, ovLabelChips, ovIsMine };', ctx);
const { ovLabelsOf, ovLabelsAttr, ovLabelChips } = ctx.h;

const stream = { username: 'carol', content_labels: { labels: ['language', '18+', 'bogus'], suggested: ['nudity'] } };
assert.deepStrictEqual([...ovLabelsOf(stream)], ['language', '18+'], 'only the labels in force, only known ones');
assert.strictEqual(ovLabelsAttr(stream), ' data-ov-labels="language,18+"');
assert.ok(ovLabelChips(stream).includes('<li class="ovk-label" data-label="language">Strong language</li>'), 'chips in words');
assert.ok(ovLabelChips(stream).includes('ovk-label--adult'), '18+ in the warning colour');
assert.strictEqual(ovLabelChips({ content_labels: { labels: [], suggested: ['nudity'] } }), '', 'a suggestion is not a label');
assert.strictEqual(ovLabelsAttr({ username: 'x', content_labels: '{"labels":["graphic"],"suggested":[]}' }), ' data-ov-labels="graphic"', 'a JSON string is read too');
ctx.currentUser = { username: 'Carol' };
assert.strictEqual(ovLabelsAttr(stream), '', 'the streamer\'s own stream is never marked for them');

const home = read('public/js/app-home.js');
assert.match(home, /<a class="stream-card[^"]*"[^>\n]*\$\{ovLabelsAttr\(s\)\}/, 'the home card is marked (a live one also wears is-live and its frame, ask 286)');
assert.ok(home.includes('style="--thumb-tint:${esc(_thumbTint(s))}" data-ov-labels-media>'), 'its picture is what a blur covers');
assert.ok(home.includes('${ovLabelChips(s)}'), 'its chips under the title');
const player = read('public/js/stream-player.js');
assert.ok(player.includes("ovMarkLabels(document.getElementById('video-container'), stream, { opened: true });"), 'the channel player is marked when a stream plays, as its own page (hide covers, never empties it)');
assert.ok(/el\.toggleAttribute\('data-ov-labels-opened', Boolean\(opened && labels\.length\)\)/.test(app), 'opened is set only on a labelled thing');
assert.ok(read('public/fragments/channel.html').includes('<div id="stream-labels" class="stream-labels"></div>'), 'the channel shows the chips under the title');
console.log('labels-view: all passed');
