'use strict';
/**
 * A screen share's camera as a stream of its own (owner, 2026-10-26: "when a browser streamer uses the PIP feature for
 * their camera, the PIP camera should actually be using it's own independent stream … own vods"). public/js/
 * broadcast-cam-pip.js, run here in a VM with a stub api():
 * - the camera's slot: an idle one of the streamer's own already listed as this slot's PIP, else a new "<title> camera"
 *   slot added as a PIP where the screen share settings put the camera (the newest camera takes the last place when
 *   the list is full);
 * - it goes live on that slot; if it cannot, the camera stream it started is ended and the streamer is told;
 * - broadcast.js sends the camera out on its own when the setting says so (the default) and the stream has a slot, and
 *   ends it with the stream or when the camera is turned off.
 *
 *   node test/broadcast-cam-pip.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SRC = read('public/js/broadcast-cam-pip.js');

function load({ pips = [], max = 3, settings = {}, failSocket = true, onStreamPost = null } = {}) {
    const calls = [];
    const toasts = [];
    let nextSlot = 77;
    const api = async (p, opts = {}) => {
        calls.push([opts.method || 'GET', p, opts.body ? JSON.parse(JSON.stringify(opts.body)) : null]);   // a copy in this realm (the VM's objects compare unequal)
        if (p.endsWith('/pips') && !opts.method) return { pips, max };
        if (p.endsWith('/pips') && opts.method === 'PUT') return { pips: opts.body.pips, max };
        if (p === '/streams/managed' && opts.method === 'POST') return { managed_stream: { id: nextSlot++ } };
        if (p === '/streams' && opts.method === 'POST') { if (onStreamPost) onStreamPost(); return { stream: { id: 9001 } }; }
        if (opts.method === 'DELETE') return { ok: true };
        throw new Error(`unexpected ${p}`);
    };
    class FakeSocket {
        constructor(url) { this.url = url; this.listeners = {}; calls.push(['WS', url]); setTimeout(() => (this.listeners[failSocket ? 'error' : 'open'] || []).forEach((f) => f()), 5); }
        addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
        send() {} close() {}
    }
    const window = { location: { protocol: 'https:', host: 'openvibe.live' } };
    const ctx = vm.createContext({
        window, api, WebSocket: FakeSocket, console: { log() {}, warn() {} }, setTimeout, clearTimeout,
        localStorage: { getItem: () => 'tok_abc' }, toast: (m, k) => toasts.push([m, k]),
        currentUser: { username: 'Goosely' }, broadcastState: { settings }, encodeURIComponent,
    });
    vm.runInContext(SRC, ctx);
    return { cam: window.OVCamPip, calls, toasts };
}
const track = () => ({ stopped: false, stop() { this.stopped = true; } });
const camStream = () => { const t = track(); return { t, getVideoTracks: () => [t], getTracks: () => [t] }; };
const ss = (msid = 10) => ({ streamData: { id: 600, managed_stream_id: msid, title: 'Coding' } });
const tick = () => new Promise((r) => setTimeout(r, 30));

(async () => {
    // Where it starts: the screen share settings' corner and size, as fractions (16:9, 0.02 from the edges).
    {
        const { cam } = load();
        assert.deepStrictEqual({ ...cam.placeOf('bottom-right', 'small') }, { w: 0.18, x: 0.8, y: 1 - 0.18 * 9 / 16 - 0.02 });
        assert.deepStrictEqual({ ...cam.placeOf('top-left', 'large') }, { w: 0.35, x: 0.02, y: 0.02 });
        assert.strictEqual(cam.wanted(ss()), true, 'its own stream by default');
        assert.strictEqual(cam.wanted({ streamData: { id: 1, managed_stream_id: null } }), false, 'not without a slot');
        assert.strictEqual(load({ settings: { screenCamMode: 'overlay' } }).cam.wanted(ss()), false, '"drawn into the screen" keeps the composite');
    }

    // An idle slot of the streamer's own already listed as a PIP is the camera's.
    {
        const pips = [{ source_msid: 12, username: 'cohost', live: false, defaults: { x: 0, y: 0, w: 0.2 }, muted: true },
            { source_msid: 11, username: 'goosely', live: true, defaults: { x: 0, y: 0, w: 0.2 }, muted: true },
            { source_msid: 13, username: 'goosely', live: false, defaults: { x: 0.5, y: 0.5, w: 0.25 }, muted: true }];
        const { cam, calls, toasts } = load({ pips });
        const s = camStream();
        assert.strictEqual(await cam.start(ss(), s), false, 'the fake socket fails');
        assert.deepStrictEqual(calls.filter((c) => c[0] !== 'WS').map((c) => [c[0], c[1], c[2] ? c[2].managed_stream_id : undefined]), [
            ['GET', '/streams/managed/10/pips', undefined],
            ['POST', '/streams', 13],
            ['DELETE', '/streams/9001', undefined],
        ], "its own idle PIP slot (not the live one, not someone else's); no new slot; the camera stream it started is ended when it cannot publish");
        assert.match(calls.find((c) => c[0] === 'WS')[1], /^wss:\/\/openvibe\.live\/ws\/broadcast\?token=tok_abc&streamId=9001&role=broadcaster$/);
        assert.ok(s.t.stopped, 'the camera is let go');
        assert.match(toasts[0][0], /could not go live as its own stream .* The screen share carries on\./);
        assert.strictEqual(cam._sessions.size, 0);
    }

    // None: a new "<title> camera" slot, added as a PIP where the settings put the camera.
    {
        const pips = [{ source_msid: 12, username: 'cohost', live: false, defaults: { x: 0.02, y: 0.02, w: 0.2 }, muted: false }];
        const { cam, calls } = load({ pips, settings: { screenPipPos: 'top-right', screenPipSize: 'medium' } });
        await cam.start(ss(), camStream());
        const made = calls.find((c) => c[1] === '/streams/managed');
        assert.deepStrictEqual(made[2], { title: 'Coding camera', protocol: 'webrtc', streaming_method: 'browser' });
        const put = calls.find((c) => c[0] === 'PUT');
        assert.deepStrictEqual(put[2].pips.map((p) => [p.source_msid, p.w, p.muted]), [[12, 0.2, false], [77, 0.25, true]], 'the PIPs it had, then the camera');
        assert.deepStrictEqual([put[2].pips[1].x, put[2].pips[1].y], [1 - 0.25 - 0.02, 0.02], 'top right, medium');
        assert.deepStrictEqual(calls.find((c) => c[1] === '/streams')[2], { title: 'Coding · camera', protocol: 'webrtc', managed_stream_id: 77 });
    }

    // A full list: the newest camera takes the last place.
    {
        const pips = [1, 2, 3].map((i) => ({ source_msid: 20 + i, username: 'other', live: false, defaults: { x: 0, y: 0, w: 0.2 }, muted: true }));
        const { cam, calls } = load({ pips });
        await cam.start(ss(), camStream());
        assert.deepStrictEqual(calls.find((c) => c[0] === 'PUT')[2].pips.map((p) => p.source_msid), [21, 22, 77]);
    }

    // Stopped while it was starting: early, no camera stream is started at all; during the go-live request, the stream
    // it then started is ended.
    {
        const early = load({ failSocket: false });
        const p1 = early.cam.start(ss(), camStream());
        early.cam.stop(600);
        assert.strictEqual(await p1, false);
        assert.ok(!early.calls.some((c) => c[1] === '/streams' && c[0] === 'POST'), 'stopped early: nothing goes live');
        let late = null;
        late = load({ failSocket: false, onStreamPost: () => late.cam.stop(600) });
        assert.strictEqual(await late.cam.start(ss(), camStream()), false);
        await tick();
        assert.ok(late.calls.some((c) => c[0] === 'DELETE' && c[1] === '/streams/9001'), 'stopped during go-live: never left live');
        assert.ok(!late.calls.some((c) => c[0] === 'WS'), 'and never published');
    }

    // broadcast.js: the camera goes out on its own when wanted, the composite otherwise; it ends with the stream.
    {
        const b = read('public/js/broadcast.js');
        assert.ok(/if \(camStream && window\.OVCamPip && OVCamPip\.wanted\(ss\)\) \{[\s\S]{0,700}OVCamPip\.start\(ss, camStream\);\n\s+\} else if \(camStream\) \{\n\s+_startPipComposite\(/.test(b));
        assert.ok(/\/\/ Screen share without camera overlay \(a camera that was its own stream ends with it\)\n\s+if \(window\.OVCamPip\) OVCamPip\.stop\(streamId\);/.test(b), 'turning the camera off ends its stream');
        assert.ok(/_cleanupComposite\(ss\);\n\s+if \(window\.OVCamPip\) OVCamPip\.stop\(streamId\);/.test(b), 'ending the stream ends the camera');
        const feats = JSON.parse(read('public/features.json')).features.broadcast.js;
        assert.ok(feats.indexOf('/js/broadcast-cam-pip.js') === feats.indexOf('/js/broadcast.js') + 1, 'loads right after broadcast.js (its helpers)');
        const ws = read('public/js/broadcast-workspace.js');
        assert.ok(ws.includes('id="bc-ws-screen-cam-mode"') && ws.includes("screenCamMode: document.getElementById('bc-ws-screen-cam-mode')?.value || 'stream',"), 'the choice is in the screen share settings and saved');
    }

    console.log('camera PiP as its own stream: slot, go-live, failure and stop paths, and broadcast.js wiring all pass');
})().catch((e) => { console.error(e); process.exit(1); });
