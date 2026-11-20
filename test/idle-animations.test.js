'use strict';
// An idle channel page stops repainting what nobody is watching (2026-11-20: 690 ms of style work every 3 idle seconds
// on a slow laptop, 9,500 elements restyled; 160 ms and 900 after):
//   - a go-live card's ring pulses for its first ten minutes only, as a transform/opacity ring (the compositor's), never
//     a box-shadow; motion Off stops it; an old card's ring is still;
//   - the end-of-rail "loading more" placeholder shimmers only once it loads.
//   node test/idle-animations.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const chat = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
assert.ok(!/chatEvPulse/.test(chat), 'the box-shadow pulse is gone');
assert.match(chat, /\.chat-ev--live \.chat-ev-icon\{box-shadow:0 0 0 2px var\(--ev\)\}/, 'an old card keeps a still ring');
const ring = /@keyframes chatEvRing\{([^\n]*)\}\}/.exec(chat);
assert.ok(ring && /transform/.test(ring[1]) && /opacity/.test(ring[1]) && !/box-shadow/.test(ring[1]), 'the pulse animates transform and opacity only');
assert.match(chat, /\.chat-ev--fresh \.chat-ev-icon::after\{[^}]*animation:chatEvRing/);
assert.match(chat, /html\[data-ov-motion=off\] \.chat-ev--fresh \.chat-ev-icon::after\{animation:none/);

// _chatEvFreshen: fresh for ten minutes from the go-live, then not.
const start = chat.indexOf('const _CHAT_EV_FRESH_MS');
const end = chat.indexOf('function renderChatEventCard(');
const timers = [];
const { _chatEvFreshen } = new Function('setTimeout', 'clearTimeout', `${chat.slice(start, end)}; return { _chatEvFreshen };`)(
    (fn, ms) => { timers.push([fn, ms]); return timers.length; }, () => {});
const card = () => { const set = new Set(); return { classList: { toggle(c, on) { if (on) set.add(c); else set.delete(c); }, remove(c) { set.delete(c); }, contains: (c) => set.has(c) } }; };
const a = card();
_chatEvFreshen(a, Date.now() - 60 * 1000);
assert.ok(a.classList.contains('chat-ev--fresh'), 'a minute old: it pulses');
assert.ok(timers.length === 1 && timers[0][1] > 8.9 * 60 * 1000 && timers[0][1] <= 9 * 60 * 1000, 'and stops at ten minutes');
timers[0][0]();
assert.ok(!a.classList.contains('chat-ev--fresh'));
const b = card();
_chatEvFreshen(b, Date.now() - 3 * 3600 * 1000);
assert.ok(!b.classList.contains('chat-ev--fresh') && timers.length === 1, 'hours old: still, no timer');

// The rail's end placeholder.
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'channel.css'), 'utf8');
assert.match(css, /#page-channel \.ch-rail-skeleton\[role="status"\]:not\(\.is-loading\) \{ animation: none; \}/);
const channel = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
assert.match(channel, /sentinel\.classList\.add\('is-loading'\);\s*loadNext\(\);/, 'it shimmers once it loads');
console.log('idle animations: fresh go-live rings only, compositor-only; rail placeholders still until they load');
