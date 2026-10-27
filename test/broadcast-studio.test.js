/**
 * The live studio on a phone (public/js/broadcast-studio.js; owner, 2026-10-16: "I can't change cameras on the
 * whim… all these buttons that don't really mean anything").
 *
 * - Flip goes front ↔ back in one tap: to the first camera facing the other way (a phone lists its main camera
 *   first, then ultra-wide and others), else to the next camera; one camera says so; screen sharing says to stop it.
 * - Mute and camera off are track.enabled = false, and they hold when the track is replaced (a camera switch, a
 *   recovery) because the studio applies them again every second.
 * - Before going live on a phone, a "Go live" bar presses the slot's own Go Live button while that one is two screens
 *   down, under the title, method, capture mode, quality and devices.
 * - The camera buttons are visible once the camera runs: the live view used to show before capture started, which
 *   hid "Switch Cam" for the whole stream.
 * - The live controls say what they do: "watching" (not "total viewers"), no "WEBRTC" badge, RobotStreamer's line
 *   in words (no "VP8 passthrough · 75 ms to RS"), "Test chat voice" / "Skip spoken message" (not "Test TTS" /
 *   "Reset TTS"), and the studio script loads with the broadcast feature.
 *
 * A real browser pass (Chrome's fake camera, phone, sideways phone and desktop) is in the PR; this is what `npm test`
 * can check without one.
 *
 *   node test/broadcast-studio.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const studioSrc = read('public/js/broadcast-studio.js');
const devicesSrc = read('public/js/broadcast-devices.js');
const bc = read('public/js/broadcast.js');
const fragment = read('public/fragments/broadcast.html');
const featuresFile = JSON.parse(read('public/features.json'));
const features = featuresFile.features || featuresFile;
let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`); }
}

/** The source of a top-level function declaration, braces matched. */
function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = src.indexOf('{', m.index);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

function fakeElement(tag) {
    const kids = [];
    const attrs = {};
    return {
        tagName: String(tag).toUpperCase(), style: {}, dataset: {}, hidden: false, children: kids, className: '', textContent: '',
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
        setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k]; },
        addEventListener() {}, append(...n) { kids.push(...n); }, replaceChildren(...n) { kids.splice(0, kids.length, ...n); },
        querySelector() { return null; }, querySelectorAll() { return []; }, remove() {}, before() {}, focus() {},
    };
}
function track(kind, settings = {}, label = '') {
    return { kind, enabled: true, label, getSettings: () => settings, getCapabilities: () => ({}), applyConstraints: async () => {} };
}

/** Load the studio with a stream whose tracks are `stream`; returns its API and what it called. */
function loadStudio({ stream, cameras = [], screenShare = false }) {
    const calls = { switched: [], toasts: [] };
    const ticks = [];
    const els = {};
    const g = {
        window: { matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {}, innerHeight: 900 },
        document: {
            getElementById: (id) => els[id] || null,
            createElement: fakeElement, createComment: () => fakeElement('#comment'),
            querySelector: () => null, addEventListener() {}, activeElement: null,
            body: { classList: fakeElement('body').classList, append() {} },
        },
        setInterval: (fn) => { ticks.push(fn); return 1; },
        navigator: {}, location: { origin: 'https://openvibe.live' },
        broadcastState: { activeStreamId: 7, settings: { screenShare } },
        getActiveStreamState: () => ({ localStream: stream, streamData: { title: 'Test' } }),
        toast: (msg, kind) => calls.toasts.push([kind || 'info', msg]),
        _enumerateBroadcastVideoInputs: async () => cameras,
        _switchActiveCamera: async (id) => { calls.switched.push(id); },
        syncBroadcastLiveButtonVisibility: () => { calls.synced = (calls.synced || 0) + 1; },
    };
    // eslint-disable-next-line no-new-func
    const getHint = new Function(`${extract(devicesSrc, '_getCameraFacingHint')}; return _getCameraFacingHint;`)();
    g._getCameraFacingHint = getHint;
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(g), studioSrc)(...Object.values(g));
    return { api: g.window.bcStudio, calls, tick: () => ticks.forEach((f) => f()), els, g };
}

(async () => {
    await check('Mute and camera off disable the tracks, and hold when a track is replaced', async () => {
        const audio = track('audio');
        const video = track('video', { deviceId: 'front', facingMode: 'user' });
        const tracks = { a: [audio], v: [video] };
        const stream = { getAudioTracks: () => tracks.a, getVideoTracks: () => tracks.v, getTracks: () => [...tracks.a, ...tracks.v] };
        const s = loadStudio({ stream });
        s.api.toggleMic();
        s.api.toggleCamera();
        assert.deepStrictEqual([audio.enabled, video.enabled], [false, false]);
        // A camera switch or a recovery hands the stream a new, enabled track: the next tick turns it off again.
        const fresh = track('video', { deviceId: 'back' });
        tracks.v = [fresh];
        s.tick();
        assert.strictEqual(fresh.enabled, false, 'the replaced camera track stays off');
        s.api.toggleMic();
        s.api.toggleCamera();
        assert.deepStrictEqual([audio.enabled, fresh.enabled], [true, true]);
    });

    await check('Flip goes to the main camera facing the other way, then back', async () => {
        const cams = [
            { deviceId: 'b0', label: 'camera2 0, facing back' },
            { deviceId: 'f1', label: 'camera2 1, facing front' },
            { deviceId: 'b2', label: 'camera2 2, facing back' },
        ];
        let current = track('video', { deviceId: 'f1', facingMode: 'user' });
        const stream = { getAudioTracks: () => [], getVideoTracks: () => [current], getTracks: () => [current] };
        const s = loadStudio({ stream, cameras: cams });
        await s.api.flip();
        assert.deepStrictEqual(s.calls.switched, ['b0'], 'front → the first back camera (the main one, not the ultra-wide)');
        current = track('video', { deviceId: 'b0', facingMode: 'environment' });
        await s.api.flip();
        assert.deepStrictEqual(s.calls.switched, ['b0', 'f1'], 'back → front');
    });

    await check('Flip without facing labels goes to the next camera; one camera or a shared screen says so', async () => {
        const cams = [{ deviceId: 'x', label: 'USB Camera' }, { deviceId: 'y', label: 'HD Webcam' }];
        const cur = track('video', { deviceId: 'x' }, 'USB Camera');
        const stream = { getAudioTracks: () => [], getVideoTracks: () => [cur], getTracks: () => [cur] };
        const s = loadStudio({ stream, cameras: cams });
        await s.api.flip();
        assert.deepStrictEqual(s.calls.switched, ['y']);
        const one = loadStudio({ stream, cameras: [cams[0]] });
        await one.api.flip();
        assert.deepStrictEqual([one.calls.switched, one.calls.toasts[0][1]], [[], 'This device has only one camera']);
        const screen = loadStudio({ stream, cameras: cams, screenShare: true });
        await screen.api.flip();
        assert.ok(screen.calls.switched.length === 0 && /sharing your screen/.test(screen.calls.toasts[0][1]));
    });

    await check('the camera buttons show once the camera runs (the live view used to hide them for good)', async () => {
        const stream = { getAudioTracks: () => [], getVideoTracks: () => [], getTracks: () => [] };
        const s = loadStudio({ stream });
        s.tick();
        assert.strictEqual(s.calls.synced, 1, 'a stream appearing re-syncs the live buttons');
        const create = extract(bc, 'createNewStream');
        assert.ok(/await startMediaCapture\(streamData\.id, \{ cameraId: createCamera, audioId: createAudio \}\);\s*\}\s*\/\/[^\n]*\n\s*syncBroadcastLiveButtonVisibility\(\);/.test(create), 'and again right after capture starts');
        assert.strictEqual((bc.match(/function syncBroadcastLiveButtonVisibility\(/g) || []).length, 1, 'defined once');
    });

    await check('the live controls say what they do', async () => {
        assert.ok(!/total viewers/.test(fragment) && /<strong id="bc-viewer-count">0<\/strong> watching/.test(fragment));
        for (const gone of ['Switch Cam', 'Test TTS', 'Reset TTS', '> Viewer', '> Stats']) assert.ok(!fragment.includes(gone), `no "${gone}"`);
        for (const label of ['Flip camera', 'Choose camera', 'Mute', 'Camera off', 'Stream health', 'Test chat voice', 'Skip spoken message', 'Media requests', 'Hide preview', 'Watch as viewer']) assert.ok(fragment.includes(label), `"${label}"`);
        const status = extract(bc, 'updateBroadcastStatus');
        assert.ok(!/toUpperCase/.test(status) && /connected:\s+\{ text: '',/.test(status), 'no protocol badge ("WEBRTC") while connected');
        const rs = extract(bc, 'rsDetailLine');
        assert.ok(!/passthrough`|to RS`/.test(rs) && /ms delay/.test(rs) && /reconnected once/.test(rs), 'RobotStreamer in words');
    });

    await check('before going live on a phone, a "Go live" bar presses the slot\'s own button while it is off screen', async () => {
        const dock = extract(studioSrc, 'syncGoLiveDock');
        assert.ok(/NARROW\.matches && onBroadcastPage\(\) && !localStream\(\)/.test(dock), 'phones, on /broadcast, not live yet');
        assert.ok(/getBoundingClientRect\(\)/.test(dock) && /const show = !!real && !inView/.test(dock), 'only while the real button is out of view');
        assert.ok(/b && !b\.disabled\) b\.click\(\)/.test(dock), 'it clicks the real Go Live button (same checks, same settings)');
        assert.ok(/id="bc-ws-golive-btn"/.test(read('public/js/broadcast-workspace.js')), 'the button it presses exists');
    });

    await check('nothing in the studio takes a phone off the live tab (that ended the owner\'s stream, 10-16)', async () => {
        const chat = read('public/js/chat.js');
        assert.ok(/opts\.live && !_broadcastingHere\(\) \? '<button type="button" class="chat-deploy-reload"/.test(chat), 'no "Reload to update" for the broadcaster');
        assert.ok(/if \(_broadcastingHere\(\)\) \{[^}]*Reloading would end your stream/.test(chat), 'and a reload click is refused while broadcasting');
        const viewer = extract(bc, 'openViewerPreview');
        assert.ok(/bcStudio\.phone\(\) && getStreamState\(streamId\)\?\.localStream\) return bcStudio\.showViewer\(url\)/.test(viewer), 'the viewer preview opens in the page on a phone');
        const show = extract(studioSrc, 'showViewer');
        assert.ok(/m\.muted = true/.test(show), 'with its sound off (the mic would hear it)');
        assert.ok(!/navigator\.share/.test(studioSrc), 'Copy link, not the system share sheet');
        assert.ok(/addEventListener\('beforeunload'[\s\S]{0,120}localStream\(\)[\s\S]{0,80}preventDefault/.test(studioSrc), 'leaving while live asks first');
        const css = read('public/css/features/broadcast.css');
        assert.ok(/body\.bc-studio-on #bc-chat-messages \.chat-deploy/.test(css), 'update cards stay out of the studio chat');
        assert.ok(/height: min\(24dvh, 180px\)/.test(css), 'the studio chat keeps to the bottom quarter');
    });

    await check('pinch on the picture zooms the camera itself; a double tap is 1x; it holds on a recovery, resets on a flip', async () => {
        // The zoom code from the studio itself, with a camera whose track can zoom 1-8x in 0.1 steps.
        const fnNames = ['zoomRange', 'trackZoom', 'trackDevice', 'showZoom', 'setZoom', 'onZoomTouchStart', 'onZoomTouchMove', 'onZoomTouchEnd', 'keepZoom'];
        const zoomDecl = /const zoom = \{[^\n]*\};/.exec(studioSrc)[0];
        const fingersDecl = /const fingers = [^\n]*;/.exec(studioSrc)[0];
        const applied = [];
        const toasts = [];
        let current = { zoom: 1, deviceId: 'back' };
        let caps = { zoom: { min: 1, max: 8, step: 0.1 } };
        const cam = { getCapabilities: () => caps, getSettings: () => current, applyConstraints: async (c) => { applied.push(c.advanced[0].zoom); current = { ...current, zoom: c.advanced[0].zoom }; } };
        const badge = { hidden: true, textContent: '' };
        const body = `${zoomDecl}\n${fingersDecl}\n${fnNames.map((n) => extract(studioSrc, n)).join('\n')}\nreturn { zoom, ${fnNames.join(', ')} };`;
        // eslint-disable-next-line no-new-func
        const z = new Function('videoTrack', '$', 'say', 'setTimeout', 'clearTimeout', 'Date', body)(() => cam, (id) => (id === 'bcs-zoom' ? badge : null), (m) => toasts.push(m), () => 0, () => {}, Date);
        const settle = () => new Promise((r) => setImmediate(r));
        const touch = (...pts) => ({ touches: pts.map(([x, y]) => ({ clientX: x, clientY: y })), prevented: false, preventDefault() { this.prevented = true; } });

        const start = touch([100, 300], [200, 300]);
        z.onZoomTouchStart(start);
        assert.ok(start.prevented, 'the page does not zoom instead');
        z.onZoomTouchMove(touch([50, 300], [250, 300]));            // fingers twice as far apart
        await settle();
        assert.strictEqual(applied[applied.length - 1], 2, 'twice the distance is 2x, on the camera itself');
        assert.strictEqual(badge.textContent, '2.0×');
        z.onZoomTouchMove(touch([0, 300], [1000, 300]));            // far past the camera's max
        await settle();
        assert.strictEqual(applied[applied.length - 1], 8, 'clamped to what the camera can do');
        z.onZoomTouchEnd(touch());

        // A double tap goes back to 1x.
        z.onZoomTouchStart(touch([10, 10]));
        const second = touch([10, 10]);
        z.onZoomTouchStart(second);
        await settle();
        assert.ok(second.prevented);
        assert.strictEqual(applied[applied.length - 1], 1);

        // Held when a recovery hands the same camera a fresh track at 1x; forgotten when the camera changes.
        z.setZoom(3);
        await settle();
        current = { zoom: 1, deviceId: 'back' };
        z.keepZoom();
        await settle();
        assert.strictEqual(applied[applied.length - 1], 3, 'the same camera gets its zoom back');
        current = { zoom: 1, deviceId: 'front' };
        const before = applied.length;
        z.keepZoom();
        await settle();
        assert.strictEqual(applied.length, before, 'another camera starts at its own 1x');
        assert.strictEqual(z.zoom.level, null);

        // A camera without zoom says so, once, and the page is left alone.
        caps = {};
        const noZoom = touch([100, 300], [200, 300]);
        z.onZoomTouchStart(noZoom);
        z.onZoomTouchStart(touch([100, 300], [200, 300]));
        assert.deepStrictEqual(toasts, ['This camera cannot zoom']);
        assert.strictEqual(noZoom.prevented, false);

        assert.ok(/zoom\.level = null;\s*await _switchActiveCamera\(next\.deviceId\)/.test(extract(studioSrc, 'flip')), 'a flip starts the new camera at 1x');
        assert.ok(/attachZoom\(\)/.test(extract(studioSrc, 'mount')) && /detachZoom\(\)/.test(extract(studioSrc, 'unmount')));
        assert.ok(/body\.bc-studio-on \.bc-video-container \{ touch-action: none; \}/.test(read('public/css/features/broadcast.css')), 'the browser leaves the pinch to the studio');
    });

    await check('the studio loads with the broadcast feature, after broadcast.js', async () => {
        const js = features.broadcast.js;
        assert.ok(js.indexOf('/js/broadcast-studio.js') > js.indexOf('/js/broadcast.js'));
        assert.ok(/body\.bc-studio-on \.bc-video-container \{[^}]*position: fixed/.test(read('public/css/features/broadcast.css')));
    });

    await check('sideways the rail is two columns under the top bar (three on the shortest), and the chat stops short of it', async () => {
        // Seven buttons in one column are about 470 px: on a phone on its side (about 330 px) they ran 150 px off the top
        // of the screen and over the top bar (Maticus, 2026-10-26). Measured in Chrome: 844x340 and 740x330 fit in two
        // columns below the bar, 667x290 in three.
        const css = read('public/css/features/broadcast.css');
        const side = /@media \(orientation: landscape\) and \(max-height: 520px\) \{([^@]*)\}\n@media \(orientation: landscape\) and \(max-height: 300px\) \{([^@]*)\}/.exec(css);
        assert.ok(side, 'the sideways rules');
        assert.ok(/\.bcs-rail \{ display: grid; grid-template-columns: repeat\(2, 56px\);[^}]*direction: rtl; \}/.test(side[1]), 'two columns, Flip nearest the edge');
        assert.ok(/\.bcs-btn \{ width: 56px; direction: ltr; \}/.test(side[1]) && /\.bcs-ico \{ width: 40px; height: 40px;/.test(side[1]));
        assert.ok(side[1].includes('body.bc-studio-on #bc-chat-sidebar { right: 128px; }'), 'the chat clears two columns');
        assert.ok(side[2].includes('.bcs-rail { grid-template-columns: repeat(3, 56px); }') && side[2].includes('body.bc-studio-on #bc-chat-sidebar { right: 188px; }'));
    });

    if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
    console.log('\nall passed');
})();
