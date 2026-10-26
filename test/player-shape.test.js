/**
 * The live player takes the stream's own shape (owner, 2026-10-26: "ensure the live feed viewers see is responsive and
 * resizes intelligently and intuitively"; public/js/player-shape.js, channel.css "The player takes the stream's shape").
 *
 * - The box's ratio is the picture's: 16:9, 4:3, square, 9:16, ultrawide, not "16:9 or vertical".
 * - A resolution drop that keeps the shape (WebRTC lowering 720p to 360p) moves nothing; a turn changes the shape.
 * - Each channel's last shape is remembered for its next first paint; another channel starts from its own.
 * - The thumbnail's shape stands in until the picture has one, never after.
 * - A JSMPEG stream (a canvas) is followed the same way.
 * - stream-player.js uses it, features.json loads it before the player, and the CSS reads --video-ar.
 *
 *   node test/player-shape.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** A small element: listeners, style properties, dataset, classes, children, a size. */
function element(tag, props = {}) {
    const listeners = {};
    const classes = new Set();
    const vars = {};
    return Object.assign({
        tagName: tag, children: [], dataset: {}, width: 0, height: 0, clientWidth: 0, clientHeight: 0,
        style: { display: '', setProperty(k, v) { vars[k] = v; }, getPropertyValue(k) { return vars[k]; } },
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
        addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
        fire(t) { for (const f of listeners[t] || []) f(); },
        setAttribute() {}, insertBefore(c) { this.children.unshift(c); },
        getContext: () => ({ drawImage() {} }),
        get firstChild() { return this.children[0] || null; },
        vars,
    }, props);
}

function load({ store = {}, reduce = false } = {}) {
    const observers = [];
    const ctx = {
        window: {}, console, Math, JSON, Number, Object, setInterval: () => 1, clearInterval() {},
        document: { hidden: false, createElement: (t) => element(t) },
        navigator: {},
        matchMedia: () => ({ matches: reduce }),
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
        MutationObserver: function (cb) { this.observe = (el) => observers.push({ el, cb }); },
        IntersectionObserver: function () { this.observe = () => {}; },
        ResizeObserver: function () { this.observe = () => {}; },
    };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(read('public/js/player-shape.js'), ctx);
    return { api: ctx.window.OVPlayerShape, store, mutate: () => observers.forEach((o) => o.cb()) };
}

const ratio = (box) => Number(box.vars['--video-ar']);
const near = (a, b) => Math.abs(a - b) < 0.001;

// ── The box follows the picture's shape ──
{
    const { api, store } = load();
    const video = element('video');
    const box = element('div', { clientWidth: 1120, clientHeight: 630 });
    api.watch(video, box, { key: 'goosely' });
    assert.ok(near(ratio(box), 16 / 9), 'before the picture: 16:9 (the first paint keeps its box)');
    assert.strictEqual(box.dataset.shape, 'landscape');
    const show = (w, h) => { video.videoWidth = w; video.videoHeight = h; video.fire('resize'); };
    for (const [w, h, shape] of [[960, 720, 'landscape'], [720, 720, 'square'], [1680, 720, 'landscape'], [720, 1280, 'portrait']]) {
        show(w, h);
        assert.ok(near(ratio(box), w / h), `${w}x${h} → ratio ${w / h} (got ${ratio(box)})`);
        assert.strictEqual(box.dataset.shape, shape, `${w}x${h} is ${shape}`);
    }
    assert.ok(box.classList.contains('is-vertical'), 'a portrait picture still marks is-vertical (the chat width keys on it)');
    // A lowered resolution keeps the shape: nothing moves (WebRTC on a weak network: 720x1280 → 540x960 → 360x640 → 358x640).
    const before = box.vars['--video-ar'];
    for (const [w, h] of [[540, 960], [360, 640], [358, 640]]) { show(w, h); assert.strictEqual(box.vars['--video-ar'], before, `${w}x${h} keeps the box`); }
    // The phone turns back: the box turns with it.
    show(1280, 720);
    assert.ok(near(ratio(box), 16 / 9));
    assert.ok(!box.classList.contains('is-vertical'));
    // A broken size is not a shape: the ratio is held to 9:22 .. 32:10.
    show(4000, 100);
    assert.ok(ratio(box) <= 3.2);
    show(1280, 720);
    // The channel's last shape is remembered.
    assert.ok(near(JSON.parse(store.ov_player_shape).goosely, 16 / 9));
    show(720, 1280);
    assert.ok(near(JSON.parse(store.ov_player_shape).goosely, 0.5625));
}

// ── The next first paint, another channel, the thumbnail ──
{
    const { api } = load({ store: { ov_player_shape: JSON.stringify({ goosely: 0.5625, other: 1.3333 }) } });
    const video = element('video');
    const box = element('div');
    api.watch(video, box, { key: 'goosely' });
    assert.ok(near(ratio(box), 0.5625), 'a portrait streamer\'s page opens portrait');
    // The element still holds the last channel's size when the next channel starts: it is not taken for the new one.
    video.videoWidth = 720; video.videoHeight = 1280;
    api.watch(video, box, { key: 'newcomer' });
    assert.ok(near(ratio(box), 16 / 9), 'a channel never seen opens 16:9');
    api.hint(box, 4 / 3);
    assert.ok(near(ratio(box), 4 / 3), 'the thumbnail stands in before the picture');
    video.videoWidth = 1920; video.videoHeight = 1080; video.fire('loadedmetadata');
    assert.ok(near(ratio(box), 16 / 9), 'the picture wins');
    api.hint(box, 9 / 16);
    assert.ok(near(ratio(box), 16 / 9), 'a late thumbnail never overrides the picture');
    api.watch(video, box, { key: 'other' });
    assert.ok(near(ratio(box), 1.3333), 'switching channels starts from that channel\'s shape');
}

// ── A JSMPEG stream: the canvas's size ──
{
    const { api, mutate } = load();
    const video = element('video');
    const canvas = element('canvas');
    const box = element('div');
    api.watch(video, box, { key: 'pi', canvas });
    canvas.width = 640; canvas.height = 480; mutate();
    assert.ok(near(ratio(box), 4 / 3), 'the canvas drives the shape while it is the picture');
}

// ── The glow is not made for reduced motion; the page wiring ──
{
    const { api } = load({ reduce: true });
    const box = element('div');
    api.watch(element('video'), box, { key: 'x' });
    assert.strictEqual(box.children.length, 0, 'no glow canvas with reduced motion');
    const withGlow = element('div');
    load().api.watch(element('video'), withGlow, { key: 'y' });
    assert.strictEqual(withGlow.children[0] && withGlow.children[0].className, 'player-shape-glow');

    const player = read('public/js/stream-player.js');
    assert.match(player, /OVPlayerShape\.watch\(vid, document\.getElementById\('video-container'\)/);
    assert.match(player, /OVPlayerShape\.hint\(document\.getElementById\('video-container'\), img\.naturalWidth \/ img\.naturalHeight\)/);
    assert.ok(!/_detectVerticalVideo/.test(player), 'the old two-shape rule is gone');
    const features = JSON.parse(read('public/features.json')).features;
    const js = features.player.js;
    assert.ok(js.indexOf('/js/player-shape.js') >= 0 && js.indexOf('/js/player-shape.js') < js.indexOf('/js/stream-player.js'), 'loaded before the player');
    const css = read('public/css/features/channel.css');
    assert.match(css, /#page-channel \.video-container \{[^}]*aspect-ratio: var\(--video-ar, 16 \/ 9\);[^}]*max-height: var\(--player-max-h\)/);
    // The phone on its side still fills the screen: its block comes after the shape block.
    assert.ok(css.indexOf("The player takes the stream's shape") < css.indexOf('A phone on its side: the stream fills the screen'));
}

console.log('✅ player shape: any ratio, resolution drops ignored, turns followed, remembered per channel, thumbnail hint, canvas, wiring');
