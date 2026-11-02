'use strict';
// Avatars and paste pictures ask Media for a width from its ladder (openvibe.media/o/<id>?w=64|96|160|480) instead of
// the original upload: one avatar is 3072 px and 3 MB, drawn at 24-50 px, and the home page fetched 6.8 MB of images
// on a phone (2026-11-01; 53 KB after). The original stays in data-full, and onerror loads it once if the sized copy
// fails (Media answers 404 for an object it cannot resize) before the letter fallback.
//   node test/avatar-widths.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const app = js('app.js');
const fn = /function ovImgW\(url, w\) \{[\s\S]*?\n\}\n/.exec(app);
assert.ok(fn, 'app.js has ovImgW');
const ovImgW = new Function(`${fn[0]}; return ovImgW;`)();
assert.strictEqual(ovImgW('https://openvibe.media/o/med_01M0E4X90R0VPTR7JBXFXC2Y38', 96), 'https://openvibe.media/o/med_01M0E4X90R0VPTR7JBXFXC2Y38?w=96');
assert.strictEqual(ovImgW('https://openvibe.media/o/med_01M0E4X90R0VPTR7JBXFXC2Y38?w=64', 96), 'https://openvibe.media/o/med_01M0E4X90R0VPTR7JBXFXC2Y38?w=64', 'a URL with a query is left alone');
assert.strictEqual(ovImgW('https://example.com/a.png', 96), 'https://example.com/a.png', 'other hosts as they are');
assert.strictEqual(ovImgW('https://openvibe.media/t/vod-1.jpg', 96), 'https://openvibe.media/t/vod-1.jpg', 'thumbnails as they are');
assert.strictEqual(ovImgW(null, 96), '');
assert.match(app, /const OV_IMG_RETRY = 'if\(this\.dataset\.full&&this\.src!==this\.dataset\.full\)\{this\.src=this\.dataset\.full;return\}';/);

// Every avatar path asks for a width and keeps the original for the retry.
const uses = [
    ['app.js', /<img src="\$\{esc\(ovImgW\(url, 160\)\)\}" data-full="\$\{esc\(url\)\}"[^`]*onerror="\$\{OV_IMG_RETRY\}/],
    ['app.js', /<img src="\$\{esc\(ovImgW\(url, 96\)\)\}" data-full="\$\{esc\(url\)\}"[^`]*onerror="\$\{OV_IMG_RETRY\}/],
    ['app-home.js', /ovImgW\(s\.avatar_url, 160\)/],
    ['app-home.js', /ovImgW\(p\.screenshot_url, 480\)/],
    ['chat.js', /ovImgW\(msg\.avatar_url, 64\)[\s\S]*ovImgW\(msg\.avatar_url, 64\)/],
    ['chat.js', /ovImgW\(clip\.creator_avatar, 64\)/],
    ['chat.js', /ovImgW\(u\.avatar_url, 64\)/],
    ['chat-shared.js', /typeof ovImgW === 'function' \? ovImgW\(p\.avatar_url, 64\) : p\.avatar_url/],
    ['messenger.js', /ovImgW\(user\.avatar_url, 96\)/],
];
uses.forEach(([f, re]) => assert.match(js(f), re, `${f}: ${re}`));
// Read by name too, so the test runner maps the kiosk-safe chat file and the messenger to this test.
const chatShared = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat-shared.js'), 'utf8');
assert.match(chatShared, /data-full="\$\{esc\(p\.avatar_url\)\}"/);
const messenger = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'messenger.js'), 'utf8');
assert.match(messenger, /data-full="\$\{esc\(user\.avatar_url\)\}"/);
// The content feed (Content, AI Moments) builds its avatars as nodes.
const feed = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'content-feed.js'), 'utf8');
assert.match(feed, /typeof ovImgW === 'function' \? ovImgW\(full, 64\) : full/);
assert.match(feed, /if \(img\.src !== full && !img\.dataset\.retried\) \{ img\.dataset\.retried = '1'; img\.src = full; return; \}/);
// Context cards, the after-show recap and the channel header too.
const cards = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'context-cards.js'), 'utf8');
assert.match(cards, /ovImgW\(u\.avatar_url, size > 72 \? 320 : size > 40 \? 160 : 96\)/);
const recap = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'recap.js'), 'utf8');
assert.match(recap, /ovImgW\(u\.avatar_url, size > 72 \? 320 : size > 40 \? 160 : 96\)/);
const channel = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
assert.match(channel, /img\.src = typeof ovImgW === 'function' \? ovImgW\(full, 160\) : full;/);
assert.match(feed, /ovImgW\(url, 640\)/, 'feed pictures at 640');
assert.match(js('app-home.js'), /ovImgW\(item\.thumbnail, 320\)/, 'hero cards at 320 (a 2460 px paste was drawn at 129)');
console.log('avatar widths: all checks passed');
