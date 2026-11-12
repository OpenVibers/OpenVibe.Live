'use strict';
/**
 * The go-live camera controls do what they say (the owner, 11-12, a phone screenshot: "even though I have back selected,
 * it didn't actually flip the camera … make it work more reliably for all the controls").
 *   - A chosen camera is asked for exactly, with no side beside it (Android settled an "ideal" back camera and an
 *     "ideal" front side in favour of the front);
 *   - when that id has gone stale, the next way asks for the camera's own side exactly, before any camera at all;
 *   - the side comes from the camera chosen; picking Front, Back or a lens tells the page (a change event), so the
 *     settings and the preview follow at once; a switch made while a camera opens is kept and opened right after.
 * Runs the shared capture core (openvibe-shared ov-capture.js) with the page's _glCaptureSetup against a fake phone.
 *   node test/golive-camera-controls.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const workspace = read('public/js/broadcast-workspace.js');
const devices = read('public/js/broadcast-devices.js');
const core = fs.readFileSync(require.resolve('openvibe-shared/ov-capture'), 'utf8');
const slice = (src, start, end) => { const i = src.indexOf(start); const j = src.indexOf(end, i); assert.ok(i >= 0 && j > i, `found ${start}`); return src.slice(i, j); };
const setup = slice(workspace, 'function _glCaptureSetup()', '/** The side of the camera chosen');

class Track { constructor(kind, facing) { this.kind = kind; this.facing = facing; } stop() {} }
class Stream { constructor(t) { this.t = t; } getTracks() { return this.t; } getVideoTracks() { return this.t.filter((x) => x.kind === 'video'); } getAudioTracks() { return this.t.filter((x) => x.kind === 'audio'); } addTrack(x) { this.t.push(x); } }
class DOMEx extends Error { constructor(m, n) { super(m); this.name = n; } }

// A phone with a front camera (id f1) and a back camera (id b1). It honours exact ids, and when asked for a side and a
// device "ideally" at once it settles on the side, as the owner's phone did.
function phone({ staleIds = false } = {}) {
    const calls = [];
    const gum = async (c) => {
        calls.push(JSON.parse(JSON.stringify(c)));
        const v = c.video;
        let facing = null;
        if (v) {
            if (v.deviceId && v.deviceId.exact) { if (staleIds) throw new DOMEx('no such device', 'OverconstrainedError'); facing = v.deviceId.exact === 'b1' ? 'environment' : 'user'; }
            else if (v.facingMode && v.facingMode.exact) facing = v.facingMode.exact;
            else if (v.facingMode && v.facingMode.ideal) facing = v.facingMode.ideal;
            else facing = 'user';
        }
        return new Stream([...(v ? [new Track('video', facing)] : []), ...(c.audio ? [new Track('audio')] : [])]);
    };
    const ctx = vm.createContext({ navigator: { userAgent: 'Android Chrome', mediaDevices: { getUserMedia: gum, enumerateDevices: async () => [] } }, MediaStream: Stream, DOMException: DOMEx,
        setTimeout, clearTimeout, console, localStorage: { getItem: () => null, setItem() {} }, document: { addEventListener() {} } });
    ctx.window = ctx;
    vm.runInContext(core, ctx);
    vm.runInContext(setup, ctx);
    ctx._glCaptureSetup();
    return { ctx, calls };
}

(async () => {
    // Back chosen while the saved side still says front: the back camera opens, asked for exactly.
    let t = phone();
    let s = await t.ctx.OVCapture.open({ mode: 'camera', lens: 'b1', facing: 'environment', resolution: '720' });
    assert.strictEqual(s.getVideoTracks()[0].facing, 'environment', 'Back is the back camera');
    assert.deepStrictEqual(t.calls[0].video.deviceId, { exact: 'b1' });
    assert.ok(!('facingMode' in t.calls[0].video), 'no side asked beside a chosen camera');
    // Even when a stale side is passed with it, the chosen camera wins.
    t = phone();
    s = await t.ctx.OVCapture.open({ mode: 'camera', lens: 'b1', facing: 'user', resolution: '720' });
    assert.strictEqual(s.getVideoTracks()[0].facing, 'environment', 'the chosen camera, whatever side was saved');

    // The id went stale (a new browser profile): its side, exactly, before any camera.
    t = phone({ staleIds: true });
    s = await t.ctx.OVCapture.open({ mode: 'camera', lens: 'b1', facing: 'environment', resolution: '1080' });
    assert.strictEqual(s.getVideoTracks()[0].facing, 'environment', 'still the back camera');
    assert.deepStrictEqual(t.calls[t.calls.length - 1].video.facingMode, { exact: 'environment' });
    assert.strictEqual(JSON.stringify(t.ctx.OVCapture.strategies.list().map((x) => x.name)), JSON.stringify(['preferred', 'separately', 'side', 'basic']));

    // Set up once, however many times the preview starts.
    t.ctx._glCaptureSetup();
    assert.strictEqual(JSON.stringify(t.ctx.OVCapture.strategies.list().map((x) => x.name)), JSON.stringify(['preferred', 'separately', 'side', 'basic']));

    // The page: the side comes from the chosen camera; a pick tells the page; a switch while one opens is kept.
    assert.ok(/const facing = _glChosenFacing\(\) \|\|/.test(workspace), 'the side comes from the camera chosen');
    assert.ok(!/facing: window\._glCamSettings\?\.facing \|\| 'user', resolution \}\)/.test(workspace), 'never the saved side over the chosen camera');
    assert.ok(/if \(_glPv\.starting\) \{ _glPv\.pending = true; return; \}/.test(workspace) && /if \(_glPv\.pending\) \{ _glPv\.pending = false; _glPreviewSync\(\); \}/.test(workspace), 'a switch made meanwhile opens right after');
    assert.ok(/goLiveSelect\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/.test(devices), 'Front, Back and a lens tell the page like a pick from the list');
    console.log('golive-camera-controls: the chosen camera exactly, its side when the id is stale, the side from the camera, every switch followed');
})().catch((e) => { console.error(e); process.exit(1); });
