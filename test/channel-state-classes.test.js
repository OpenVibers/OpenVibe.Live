/**
 * The channel page's state as classes, not :has() (2026-11-19: 107 :has() rules in channel.css made every style recalc
 * of a channel page cost 30 ms instead of 11 at 4x CPU, 820 ms of one load):
 *   - channel.css keys on body.on-channel, body.on-channel-live, body.on-channel-live-chat, html.on-channel-live,
 *     html.ovnav-hidden and .stream-layout.has-vertical-video, each beside the old relation inside :is() so every rule
 *     keeps the specificity it had; no rule asks body, html or the stream layout with :has() any more;
 *   - the server writes body.on-channel on a channel route (the first paint has it) and on no other;
 *   - app-channel.js mirrors #page-channel's classes and the navbar's onto body and html, and follows them.
 *
 *   node test/channel-state-classes.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const css = read('public/css/features/channel.css').replace(/\/\*[\s\S]*?\*\//g, '');
assert.ok(!/(?:^|[\s,}>~+])(?:body|html|\.stream-layout):(?:not\()?:?has\(/m.test(css), 'no rule asks body, html or the stream layout with :has()');
for (const want of ['body:is(.on-channel, #page-channel.active)', 'body:is(.on-channel-live, #page-channel.active.ch-is-live)',
    'html:is(.on-channel-live, #page-channel.active.ch-is-live)', 'html:is(.ovnav-hidden, .openvibe-navbar.ovnav-hide)',
    '.stream-layout:is(.has-vertical-video, .video-container.is-vertical)', '.stream-layout:not(.has-vertical-video, .ov-never.ov-never)']) {
    assert.ok(css.includes(want), `channel.css keys on ${want}`);
}
assert.ok((css.match(/:has\(/g) || []).length <= 20, 'only local :has() rules are left');

const assets = require('../server/web/assets');
const doc = assets.document('index.html').html;
const bodyOf = (html) => (/<body[^>]*>/i.exec(html) || [''])[0];
assert.match(bodyOf(assets.renderRoute(doc, '/@someone')), /class="[^"]*\bon-channel\b/, 'a channel route paints with body.on-channel');
for (const url of ['/', '/chat', '/broadcast', '/content']) assert.ok(!/on-channel/.test(bodyOf(assets.renderRoute(doc, url))), `${url}: no on-channel`);

// The mirror, in a stand-in document.
const src = /function _mirrorChannelState\(\) \{[\s\S]*?\n\}/.exec(read('public/js/app-channel.js'));
assert.ok(src, '_mirrorChannelState is in app-channel.js');
const classSet = () => { const s = new Set(); return { s, add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => { const want = on === undefined ? !s.has(c) : !!on; if (want) s.add(c); else s.delete(c); return want; } }; };
const page = { classList: classSet() };
const bar = { classList: classSet() };
const body = { classList: classSet() };
const html = { classList: classSet() };
const observers = [];
const ctx = {
    document: { getElementById: (id) => (id === 'page-channel' ? page : null), querySelector: (s) => (s === '.openvibe-navbar' ? bar : null), body, documentElement: html },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe(el) { observers.push([el, this.fn]); } },
    setTimeout,
};
vm.runInNewContext(`${src[0]}; this.mirror = _mirrorChannelState;`, ctx);
const change = (el, fn) => { fn(el.classList); observers.filter(([e]) => e === el).forEach(([, f]) => f()); };
page.classList.add('page'); page.classList.add('active');
ctx.mirror();
assert.deepStrictEqual([...body.classList.s].sort(), ['on-channel'], 'an open channel page');
change(page, (c) => c.add('ch-is-live'));
assert.deepStrictEqual([...body.classList.s].sort(), ['on-channel', 'on-channel-live', 'on-channel-live-chat']);
assert.ok(html.classList.contains('on-channel-live'));
change(page, (c) => c.add('chat-collapsed'));
assert.ok(!body.classList.contains('on-channel-live-chat'), 'the chat folded away');
change(bar, (c) => c.add('ovnav-hide'));
assert.ok(html.classList.contains('ovnav-hidden'), 'the navbar hid');
change(bar, (c) => c.remove('ovnav-hide'));
assert.ok(!html.classList.contains('ovnav-hidden'));
change(page, (c) => c.remove('active'));
assert.deepStrictEqual([...body.classList.s], [], 'another page');
assert.ok(!html.classList.contains('on-channel-live'));
const before = observers.length;
ctx.mirror();
assert.strictEqual(observers.length, before, 'mirrored once');
console.log('channel-state-classes: channel.css keys on classes, the server writes body.on-channel, the page keeps them');
