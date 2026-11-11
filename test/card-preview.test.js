'use strict';
// A card's moving preview (public/js/card-preview.js, ask 355): which rows get one, how unsafe addresses are refused,
// and that the home and channel features load it before the files that render cards.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public/js/card-preview.js'), 'utf8');
const listeners = [];
const win = {
    matchMedia: () => ({ matches: false }),
    addEventListener: (t) => listeners.push(`window:${t}`),
    innerHeight: 800,
};
const doc = {
    documentElement: { getAttribute: () => null },
    addEventListener: (t) => listeners.push(`document:${t}`),
    querySelectorAll: () => [],
    head: { appendChild() {} },
};
const ctx = { window: win, document: doc, navigator: {}, setTimeout, clearTimeout };
win.window = win;
vm.createContext(ctx);
vm.runInContext(src, ctx);

const { previewAttrs } = win.cardPreview;
assert.strictEqual(typeof win.previewAttrs, 'function', 'renderers call the global previewAttrs');

// A recording or clip: the MP4 with the WebM beside it.
const vod = previewAttrs({ preview_url: 'https://openvibe.media/t/vod-6329-1.mp4', preview_webm_url: 'https://openvibe.media/t/vod-6329-1.webm' });
assert.strictEqual(vod, ' data-preview="https://openvibe.media/t/vod-6329-1.mp4" data-preview-webm="https://openvibe.media/t/vod-6329-1.webm"');
// A live row: the DVR playlist, marked as HLS.
assert.strictEqual(previewAttrs({ preview_url: 'https://openvibe.media/v/6337/dvr.m3u8' }), ' data-preview="https://openvibe.media/v/6337/dvr.m3u8" data-preview-hls');
// Same-origin paths are fine; nothing, protocol-relative, javascript: and http: are not.
assert.ok(previewAttrs({ preview_url: '/t/x.mp4' }).includes('data-preview="/t/x.mp4"'));
for (const bad of [null, '', '//evil.example/x.mp4', 'javascript:alert(1)', 'http://openvibe.media/t/x.mp4']) {
    assert.strictEqual(previewAttrs({ preview_url: bad }), '', `refused: ${bad}`);
}
assert.strictEqual(previewAttrs(null), '');
// An attribute value cannot break out of its quotes.
assert.ok(!/"[^"]*"x/.test(previewAttrs({ preview_url: 'https://a.example/"x.mp4' })) && previewAttrs({ preview_url: 'https://a.example/"x.mp4' }).includes('&quot;'));
// The WebM is only added when it is safe too.
assert.strictEqual(previewAttrs({ preview_url: 'https://a.example/x.mp4', preview_webm_url: 'javascript:1' }), ' data-preview="https://a.example/x.mp4"');

// It listens for the mouse, the keyboard, the scroll and leaving the page.
for (const t of ['document:pointerover', 'document:pointerout', 'document:focusin', 'document:focusout', 'window:scroll', 'document:visibilitychange']) {
    assert.ok(listeners.includes(t), `listens for ${t}`);
}

// Loaded before the files that render cards.
const feats = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/features.json'), 'utf8'));
const F = feats.features || feats;
for (const [name, renderer] of [['home', '/js/app-home.js'], ['channel', '/js/app-channel.js']]) {
    const js = F[name].js;
    assert.ok(js.indexOf('/js/card-preview.js') >= 0 && js.indexOf('/js/card-preview.js') < js.indexOf(renderer), `${name} loads card-preview.js before ${renderer}`);
}
// The cards that have previews ask for them.
const home = fs.readFileSync(path.join(ROOT, 'public/js/app-home.js'), 'utf8');
assert.ok(/previewAttrs\(s\.is_nsfw \? null : \(isLive \? s :/.test(home), 'home cards: live DVR or the recording; never on an 18+ card');
const channel = fs.readFileSync(path.join(ROOT, 'public/js/app-channel.js'), 'utf8');
assert.strictEqual((channel.match(/previewAttrs\(cl\)/g) || []).length, 3, 'every clip grid');
assert.ok(channel.includes('previewAttrs(v)') && channel.includes('previewAttrs(ls)'), 'recordings and the recording in progress');
console.log('card-preview: rows, refused addresses, listeners, load order, cards');
