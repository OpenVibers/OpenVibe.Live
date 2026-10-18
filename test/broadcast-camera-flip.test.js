/**
 * Flipping the camera while live from a phone (owner, 2026-10-17: "When flipping cameras it doesn't have the correct
 * aspect ratio, also seems to bug out and ends/restarts your streams as if you lost connection sometimes").
 *
 * - The frame watchdog (startTrackKeepalive, public/js/broadcast-state.js) follows the stream's current video track.
 *   A switch replaces the track inside the same MediaStream; the watchdog kept watching the stopped one, called the
 *   camera dead 8 s later, and its media recovery restarted the stream (new capture, signaling, restreams).
 * - _switchActiveCamera asks the next camera in landscape terms, as going live does. A phone held upright reports its
 *   track turned (720×1280), and asking for that made Chrome crop a tall slice and turn it sideways.
 * - A browser recording closes its segment before the switch and starts the next after it: MediaRecorder stops when
 *   its stream's tracks change.
 *
 *   node test/broadcast-camera-flip.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const bc = read('public/js/broadcast.js');
const state = read('public/js/broadcast-state.js');

/** The source of a top-level function declaration, braces matched (after its parameter list). */
function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = m.index + m[0].length;
    for (let parens = 1; parens; i++) { if (src[i] === '(') parens++; else if (src[i] === ')') parens--; }
    i = src.indexOf('{', i);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

function fakeTrack(kind, settings = {}) {
    return { kind, readyState: 'live', enabled: true, label: '', getSettings: () => settings, stop() { this.readyState = 'ended'; }, addEventListener() {} };
}
function fakeStream(tracks) {
    const list = [...tracks];
    return {
        getTracks: () => [...list], getVideoTracks: () => list.filter((t) => t.kind === 'video'), getAudioTracks: () => list.filter((t) => t.kind === 'audio'),
        addTrack: (t) => list.push(t), removeTrack: (t) => { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); },
    };
}

(async () => {
    // ── The watchdog follows a replaced track ──
    {
        let now = 1_000_000;
        let tick = null;
        const recoveries = [];
        const ss = { localStream: null };
        const ctx = {
            console: { log() {}, warn() {} },
            Date: { now: () => now },
            setInterval: (fn) => { tick = fn; return 1; },
            clearInterval: () => { tick = null; },
            getStreamState: () => ss,
            scheduleMediaRecovery: (id, reason) => recoveries.push(reason),
            // A frame comes from a live track; a stopped one has none.
            ImageCapture: function (t) { this.grabFrame = () => (t.readyState === 'live' ? Promise.resolve({ close() {} }) : Promise.reject(new Error('ended'))); },
        };
        vm.createContext(ctx);
        const consts = ['KEEPALIVE_INTERVAL_MS', 'WATCHDOG_DEAD_THRESHOLD_MS', 'WATCHDOG_ENDED_THRESHOLD_MS'].map((n) => new RegExp(`const ${n} = [^;]+;`).exec(state)[0]).join('\n');
        vm.runInContext(`${consts}\n${extract(state, 'startTrackKeepalive')}\n${extract(state, 'stopTrackKeepalive')}`, ctx);

        const front = fakeTrack('video');
        ss.localStream = fakeStream([front, fakeTrack('audio')]);
        ctx.startTrackKeepalive(7);
        assert.ok(tick, 'the watchdog ticks');
        const run = async (seconds) => { for (let i = 0; i < seconds; i++) { now += 1000; tick(); await new Promise((r) => setImmediate(r)); } };
        await run(3);

        // The flip: the front track stops and leaves the stream, the back camera's track joins it.
        front.stop();
        ss.localStream.removeTrack(front);
        const back = fakeTrack('video');
        ss.localStream.addTrack(back);
        await run(30);
        assert.deepStrictEqual(recoveries, [], 'a flipped camera is not a dead camera');

        // The watchdog still works on the new track: when it really dies, recovery follows.
        back.stop();
        await run(10);
        assert.deepStrictEqual(recoveries, ['video track dead (watchdog)']);
        console.log('  ✓ the frame watchdog follows the track a camera switch puts in the stream');
    }

    // ── The switch asks in landscape terms and keeps the browser recording going ──
    {
        const order = [];
        const asked = [];
        const front = fakeTrack('video', { deviceId: 'front', facingMode: 'user', width: 720, height: 1280, frameRate: 30 });
        const ss = { localStream: fakeStream([front, fakeTrack('audio')]), vodRecorder: { state: 'recording' } };
        const origStop = front.stop.bind(front);
        front.stop = () => { order.push('old track stopped'); origStop(); };
        const ctx = {
            console: { log() {}, warn() {}, error() {} },
            setTimeout: () => 0, clearTimeout: () => {},
            broadcastState: { activeStreamId: 7, settings: { screenShare: false } },
            getActiveStreamState: () => ss,
            toast: () => {},
            _enumerateBroadcastVideoInputs: async () => [{ deviceId: 'front', label: 'camera2 1, facing front' }, { deviceId: 'back', label: 'camera2 0, facing back' }],
            _getCameraFacingHint: (d) => (d && /front/.test(d.label) ? 'user' : 'environment'),
            getBroadcastFrameRate: () => 30,
            _getUserMediaWithTimeout: async (c) => { asked.push(c); order.push('new camera opened'); return fakeStream([fakeTrack('video', { deviceId: 'back', width: 720, height: 1280 })]); },
            syncRobotStreamerTracks: async () => {}, _syncSfuProducerTracks: async () => {},
            document: { getElementById: () => null },
            _detectBroadcastVerticalPreview: () => {}, attachLocalStreamRecoveryHandlers: () => {}, _warnDeviceMismatch: () => {}, _syncCameraSelectionUI: () => {},
            uploadVodRecording: async (id, opts) => { order.push(`segment closed (${id}, finalize ${opts.finalizeStream})`); ss.vodRecorder = null; },
            startVodRecording: (id) => order.push(`next segment (${id})`),
        };
        vm.createContext(ctx);
        vm.runInContext(extract(bc, '_switchActiveCamera'), ctx);
        await ctx._switchActiveCamera('back');

        const v = asked[0].video;
        assert.deepStrictEqual([v.width.ideal, v.height.ideal], [1280, 720], 'landscape terms, whatever way the phone is held');
        assert.strictEqual(v.deviceId.exact, 'back');
        assert.deepStrictEqual(order, ['segment closed (7, finalize false)', 'old track stopped', 'new camera opened', 'next segment (7)']);
        assert.strictEqual(ss.localStream.getVideoTracks()[0].getSettings().deviceId, 'back');
        console.log('  ✓ the switch asks the next camera for 1280×720 and closes and reopens the browser recording around it');

        // Nothing recording (the server records SFU streams): no segment work.
        order.length = 0;
        ss.vodRecorder = null;
        ctx._enumerateBroadcastVideoInputs = async () => [{ deviceId: 'back', label: 'camera2 0, facing back' }, { deviceId: 'front', label: 'camera2 1, facing front' }];
        ctx._getUserMediaWithTimeout = async (c) => { asked.push(c); order.push('new camera opened'); return fakeStream([fakeTrack('video', { deviceId: 'front' })]); };
        await ctx._switchActiveCamera('front');
        assert.deepStrictEqual(order, ['new camera opened']);
    }
    console.log('broadcast camera flip: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
