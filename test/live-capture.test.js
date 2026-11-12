'use strict';
/**
 * Live's own capture system (public/js/live-capture.js, window.OVCapture), run against a fake browser: the strategies in
 * order and the first that opens wins; a refusal stops at once; a strategy that hangs is timed out; every part can be
 * replaced (and the replaced one called through); strategies can be added, removed and replaced; this device's settings
 * go through the 'store' part; and the module talks to no other site.
 *   node test/live-capture.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'live-capture.js'), 'utf8');
assert.ok(!/https?:\/\//.test(source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')), 'the module fetches nothing from anywhere');

class FakeTrack { constructor(kind) { this.kind = kind; this.stopped = false; } stop() { this.stopped = true; } }
class FakeStream {
    constructor(tracks = []) { this.tracks = tracks.slice(); }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    addTrack(t) { this.tracks.push(t); }
}
class FakeDOMException extends Error { constructor(message, name) { super(message); this.name = name; } }

function load(gum) {
    const store = new Map();
    const calls = [];
    const navigator = {
        userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36', maxTouchPoints: 5, onLine: true,
        mediaDevices: { getUserMedia: (c) => { calls.push(c); return gum(c, calls.length); }, enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'a', label: 'Front' }] },
    };
    const window = {};
    const ctx = vm.createContext({ window, navigator, MediaStream: FakeStream, DOMException: FakeDOMException, setTimeout, clearTimeout, console,
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }, document: { addEventListener() {} } });
    ctx.globalThis = ctx;
    vm.runInContext(source.replace("(function () {", "(function () { const window = globalThis.window;"), ctx);
    return { capture: window.OVCapture, calls, store };
}
// Values made inside the vm come from another realm: compare them as JSON.
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
const both = (c) => new FakeStream([...(c.video ? [new FakeTrack('video')] : []), ...(c.audio ? [new FakeTrack('audio')] : [])]);

(async () => {
    // The preferred way opens it: one call, with the chosen facing and resolution.
    let t = load(async (c) => both(c));
    let s = await t.capture.open({ mode: 'camera', facing: 'environment', resolution: '1080' });
    assert.strictEqual(s.getVideoTracks().length, 1);
    assert.strictEqual(t.calls.length, 1);
    same(t.calls[0].video.facingMode, { ideal: 'environment' });
    assert.strictEqual(t.calls[0].video.height.ideal, 1080);

    // Both at once refused by the hardware (an Android phone): the camera, then the microphone, each on its own.
    t = load(async (c) => { if (c.video && c.audio) throw new FakeDOMException('busy', 'OverconstrainedError'); return both(c); });
    const seen = [];
    t.capture.on('failed', (e) => seen.push(`failed:${e.strategy}`));
    t.capture.on('opened', (e) => seen.push(`opened:${e.strategy}`));
    s = await t.capture.open({ mode: 'camera' });
    assert.strictEqual(s.getVideoTracks().length + s.getAudioTracks().length, 2);
    same(seen, ['failed:preferred', 'opened:separately']);

    // A refusal is the person's answer: no second way of asking.
    t = load(async () => { throw new FakeDOMException('denied', 'NotAllowedError'); });
    await assert.rejects(t.capture.open({ mode: 'camera' }), (e) => e.name === 'NotAllowedError');
    assert.strictEqual(t.calls.length, 1, 'stopped after the refusal');
    assert.match(t.capture.explain({ name: 'NotAllowedError' }, 'camera').title, /said no/);

    // Several failures: the one that says most about what to do is the one reported.
    t = load(async (c, n) => { throw new FakeDOMException('x', n === 1 ? 'NotFoundError' : 'NotReadableError'); });
    await assert.rejects(t.capture.open({ mode: 'camera' }), (e) => e.name === 'NotReadableError');

    // A strategy that never answers is timed out, and the next one runs.
    t = load(async (c, n) => (n === 1 ? new Promise(() => {}) : both(c)));
    t.capture.use('timeoutMs', 30);
    s = await t.capture.open({ mode: 'camera' });
    assert.ok(s.getVideoTracks().length, 'opened after the timed-out strategy');

    // Asked for a camera and given none: not opened (and its tracks are stopped).
    t = load(async () => new FakeStream([new FakeTrack('audio')]));
    await assert.rejects(t.capture.open({ mode: 'camera' }), (e) => e.name === 'NotFoundError');

    // Every part can be replaced, and the one it replaced called through.
    t = load(async (c) => both(c));
    const before = t.capture.use('constraints', (o) => ({ ...before(o), audio: { echoCancellation: false } }));
    await t.capture.open({ mode: 'camera' });
    same(t.calls[0].audio, { echoCancellation: false });
    assert.throws(() => t.capture.part('nope'), /no capture part "nope"/);
    assert.ok(['constraints', 'getUserMedia', 'enumerate', 'meter', 'network', 'store', 'explain', 'timeoutMs'].every((p) => t.capture.parts().includes(p)));

    // Strategies: listed, added before another, removed, replaced.
    t = load(async (c) => both(c));
    same(t.capture.strategies.list().map((x) => x.name), ['preferred', 'separately', 'basic']);
    let ran = '';
    t.capture.strategies.add({ name: 'mine', open: async (o, c) => { ran = 'mine'; return both({ video: true, audio: true }); } }, { before: 'preferred' });
    same(t.capture.strategies.list().map((x) => x.name), ['mine', 'preferred', 'separately', 'basic']);
    await t.capture.open({ mode: 'camera' });
    assert.strictEqual(ran, 'mine');
    t.capture.strategies.remove('mine');
    t.capture.strategies.replace('basic', { open: async () => both({ video: true, audio: true }) });
    same(t.capture.strategies.list().map((x) => x.name), ['preferred', 'separately', 'basic']);
    assert.throws(() => t.capture.strategies.add({ name: 'x' }), /a strategy is/);

    // This device's settings, through the 'store' part, with a 'settings' event.
    t = load(async (c) => both(c));
    let saved = null;
    t.capture.on('settings', (e) => { saved = e.settings; });
    t.capture.settings.save({ mirror: false, resolution: '1080' });
    assert.strictEqual(t.capture.settings.load().resolution, '1080');
    assert.strictEqual(saved.mirror, false);
    assert.ok(t.store.get('ov_capture_settings').includes('1080'), 'kept on this device');
    const mem = {};
    t.capture.use('store', { load: () => mem.v || {}, save: (v) => { mem.v = v; } });
    t.capture.settings.save({ lens: 'back-wide' });
    assert.strictEqual(mem.v.lens, 'back-wide', 'a replaced store is used');

    // No camera API at all (an in-app browser): a NoApi error the card explains.
    t = load(async (c) => both(c));
    delete t.capture; // reload with no mediaDevices
    const store = new Map();
    const w = {};
    const ctx = vm.createContext({ window: w, navigator: { userAgent: 'Instagram 350', onLine: true }, MediaStream: FakeStream, DOMException: FakeDOMException, setTimeout, clearTimeout, console,
        localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) }, document: { addEventListener() {} } });
    ctx.globalThis = ctx;
    vm.runInContext(source.replace("(function () {", "(function () { const window = globalThis.window;"), ctx);
    await assert.rejects(w.OVCapture.open({}), (e) => e.name === 'NoApi');
    assert.match(w.OVCapture.explain({ name: 'NoApi' }, 'camera').steps.join(' '), /inside another app/);

    console.log('live-capture: strategies in order, refusals stop, time limits, every part and strategy replaceable, settings on this device');
})().catch((e) => { console.error(e); process.exit(1); });
