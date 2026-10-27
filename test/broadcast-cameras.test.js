/**
 * Cameras by name (public/js/broadcast-devices.js _bcCameraChoices; owner, 2026-10-27: "camera 1, facing front …
 * unformatted camera names is trash"), the go-live chooser over the camera select, and the Go Live page's phone bar
 * (broadcast-studio.js syncGoLiveDock), which no longer says "Go live" while a stream of theirs is live.
 *
 *   node test/broadcast-cameras.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const devices = read('public/js/broadcast-devices.js');
const fn = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    let i = src.indexOf('{', src.indexOf(') {', start)), depth = 0;   // the body, past a destructured parameter
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
};
const lensTable = /const _BC_LENSES = .*;/.exec(devices)[0];
// eslint-disable-next-line no-new-func
const choices = new Function(`${lensTable}\n${fn(devices, '_getCameraFacingHint')}\n${fn(devices, '_bcCameraChoices')}; return _bcCameraChoices;`)();
// eslint-disable-next-line no-new-func
const mics = new Function(`${fn(devices, '_bcMicChoices')}; return _bcMicChoices;`)();
const dev = (deviceId, label) => ({ kind: 'videoinput', deviceId, label });

// Android lists its cameras in no useful order; "camera 0, facing back" is the main one. A camera listed twice is one.
const phone = choices([dev('a', 'camera 1, facing front'), dev('b', 'camera 3, facing front'), dev('c', 'camera 2, facing back'), dev('d', 'camera 0, facing back'), dev('e', 'camera 0, facing back')]);
assert.deepStrictEqual(phone.map((c) => [c.deviceId, c.name]), [['a', 'Front camera'], ['b', 'Front camera 2'], ['d', 'Back camera'], ['c', 'Back camera 2']]);
assert.deepStrictEqual(phone.map((c) => c.facing), ['user', 'user', 'environment', 'environment']);
// Android only numbers its lenses: the main one, then Lens 2…
assert.deepStrictEqual(phone.map((c) => c.lens), ['Main', 'Lens 2', 'Main', 'Lens 2']);
// An iPhone names them (owner, 2026-10-27: the chips said "Main" and "2"): the plain camera is the Wide one, then by lens.
const iphone = choices([dev('t', 'Back Triple Camera'), dev('f', 'Front Camera'), dev('u', 'Back Ultra Wide Camera'), dev('r', 'Back Camera'), dev('p', 'Back Telephoto Camera'), dev('w', 'Back Dual Wide Camera')]);
assert.deepStrictEqual(iphone.map((c) => [c.name, c.lens]), [['Front camera', 'Main'], ['Back camera', 'Wide'], ['Back camera (ultra wide)', 'Ultra wide'],
    ['Back camera (telephoto)', 'Telephoto'], ['Back camera (dual wide)', 'Dual wide'], ['Back camera (triple)', 'Triple']]);
// A computer's cameras keep their names, without the USB ids.
assert.deepStrictEqual(choices([dev('x', 'HD Pro Webcam C920 (046d:082d)'), dev('y', 'Integrated Camera (04f2:b6dd)'), dev('z', 'OBS Virtual Camera')]).map((c) => c.name),
    ['HD Pro Webcam C920', 'Integrated Camera', 'OBS Virtual Camera']);
// No labels (no permission yet): nothing to name.
assert.deepStrictEqual(choices([dev('', ''), dev('', '')]), []);

// Microphones: the system default first, named when the browser says which; each once; no USB ids; Communications out.
assert.deepStrictEqual(mics([
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Blue Yeti Stereo Microphone (b58e:9e84)' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Blue Yeti Stereo Microphone (b58e:9e84)' },
    { kind: 'audioinput', deviceId: 'm1', label: 'Blue Yeti Stereo Microphone (b58e:9e84)' },
    { kind: 'audioinput', deviceId: 'm2', label: 'Integrated Microphone Array' },
    { kind: 'audioinput', deviceId: 'm3', label: 'Integrated Microphone Array' },
    { kind: 'videoinput', deviceId: 'x', label: 'HD Pro Webcam C920' },
]).map((m) => [m.deviceId, m.name]), [['default', 'Default · Blue Yeti Stereo Microphone'], ['m1', 'Blue Yeti Stereo Microphone'], ['m2', 'Integrated Microphone Array']]);
assert.deepStrictEqual(mics([{ kind: 'audioinput', deviceId: 'i1', label: 'iPhone Microphone' }]).map((m) => m.name), ['Default', 'iPhone Microphone'], 'Default is always a choice');

// The setup card (owner, 2026-10-27: "the camera design conflicts with the microphone section … total overhaul"): one
// card, a row each for the camera, its lens and the microphone; the old "On this device" banner and refresh button gone.
const ws = read('public/js/broadcast-workspace.js');
assert.ok(ws.includes('<div class="bc-setup-card">') && !ws.includes('bc-ws-device-local-label'));
assert.ok(ws.includes('data-pick-for="bc-create-camera"') && ws.includes('data-pick-for="bc-create-audio"'), 'each row shows its choice');
assert.ok(ws.includes('<select id="bc-create-camera" class="bc-setup-native"') && ws.includes('<select id="bc-create-audio" class="bc-setup-native"'), 'the selects stay the source of truth');
assert.ok(ws.includes("_wsInitDevicePicker('browser', mode).catch(() => {});"), 'back from Screen Share, the camera and mic come back');
// The chooser: Front | Back (and USB) in the camera's row on a phone, a Lens row when the side has more than one,
// remembered per side; elsewhere the row opens the list. "Default" is replaced by a real camera.
const render = fn(devices, '_bcRenderCameraChooser');
assert.ok(render.includes("[['user', 'Front', 'fa-user'], ['environment', 'Back', 'fa-mountain-sun'], [null, 'USB', 'fa-video']]"));
assert.ok(render.includes('const switcher = phone && groups.length > 1;'), 'a switch only with two sides to switch between');
assert.ok(render.includes('b.textContent = c.lens;'), 'lens chips by lens name');
assert.ok(render.includes('_syncCameraSelectionUI((phone && front ? front : choices[0]).deviceId, { persist: false })'), 'no "Default"');
assert.ok(/localStorage\.setItem\(`bc-last-camera-\$\{facing\}`, normalized\)/.test(fn(devices, '_syncCameraSelectionUI')), 'the last camera on each side is remembered');
assert.ok(read('public/js/broadcast.js').includes('.then(_populateCreateDeviceDropdowns)'), 'a camera or headset plugged in shows up without a refresh');

// The Go Live page's phone bar: nothing before the streams are known; "Resume your stream" while one of theirs is live.
const dock = fn(read('public/js/broadcast-studio.js'), 'syncGoLiveDock');
assert.ok(dock.includes('!!window._bcMyLoaded'), 'no bar before the page knows the streams (it flashed "Go live" on every load)');
assert.ok(dock.includes("mode = 'resume'") && dock.includes("'Resume your stream'"));
const bc = read('public/js/broadcast.js');
assert.ok(bc.includes("api('/streams/mine?limit=30&vods=1')") && bc.includes('window._bcMyLive = live;'));
assert.ok(bc.includes('if (s.is_live) return _renderLiveStreamCard(s);'));
assert.ok(read('server/streaming/routes.js').includes("if (req.query.vods === '1') {"), 'the last streams carry their replays');
console.log('broadcast cameras: all checks passed');
