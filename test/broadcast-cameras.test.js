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
// eslint-disable-next-line no-new-func
const choices = new Function(`${fn(devices, '_getCameraFacingHint')}\n${fn(devices, '_bcCameraChoices')}; return _bcCameraChoices;`)();
const dev = (deviceId, label) => ({ kind: 'videoinput', deviceId, label });

// Android lists its cameras in no useful order; "camera 0, facing back" is the main one. A camera listed twice is one.
const phone = choices([dev('a', 'camera 1, facing front'), dev('b', 'camera 3, facing front'), dev('c', 'camera 2, facing back'), dev('d', 'camera 0, facing back'), dev('e', 'camera 0, facing back')]);
assert.deepStrictEqual(phone.map((c) => [c.deviceId, c.name]), [['a', 'Front camera'], ['b', 'Front camera 2'], ['d', 'Back camera'], ['c', 'Back camera 2']]);
assert.deepStrictEqual(phone.map((c) => c.facing), ['user', 'user', 'environment', 'environment']);
// iOS and older Android names.
assert.deepStrictEqual(choices([dev('f', 'Front Camera'), dev('r', 'Back Camera'), dev('u', 'Back Ultra Wide Camera')]).map((c) => c.name), ['Front camera', 'Back camera', 'Back camera 2']);
// A computer's cameras keep their names, without the USB ids.
assert.deepStrictEqual(choices([dev('x', 'HD Pro Webcam C920 (046d:082d)'), dev('y', 'Integrated Camera (04f2:b6dd)'), dev('z', 'OBS Virtual Camera')]).map((c) => c.name),
    ['HD Pro Webcam C920', 'Integrated Camera', 'OBS Virtual Camera']);
// No labels (no permission yet): nothing to name.
assert.deepStrictEqual(choices([dev('', ''), dev('', '')]), []);

// The chooser: over the select (still the source of truth), Front | Back with lens chips on a phone, cards elsewhere,
// remembered per side; "Default" is replaced by a real camera.
const render = fn(devices, '_bcRenderCameraChooser');
assert.ok(render.includes("['user', 'Front', 'fa-user'], ['environment', 'Back', 'fa-mountain-sun']"));
assert.ok(render.includes("i === 0 ? 'Main' : String(i + 1)"), 'a chip per camera on the chosen side');
assert.ok(render.includes('_syncCameraSelectionUI((phone && sides.user[0] ? sides.user[0] : choices[0]).deviceId, { persist: false })'), 'no "Default"');
assert.ok(/localStorage\.setItem\(`bc-last-camera-\$\{facing\}`, normalized\)/.test(fn(devices, '_syncCameraSelectionUI')), 'the last camera on each side is remembered');
assert.ok(read('public/js/broadcast-workspace.js').includes('<div class="bc-cam-select-row"'), 'the select row the chooser replaces');

// The Go Live page's phone bar: nothing before the streams are known; "Resume your stream" while one of theirs is live.
const dock = fn(read('public/js/broadcast-studio.js'), 'syncGoLiveDock');
assert.ok(dock.includes('!!window._bcMyLoaded'), 'no bar before the page knows the streams (it flashed "Go live" on every load)');
assert.ok(dock.includes("mode = 'resume'") && dock.includes("'Resume your stream'"));
const bc = read('public/js/broadcast.js');
assert.ok(bc.includes("api('/streams/mine?limit=30&vods=1')") && bc.includes('window._bcMyLive = live;'));
assert.ok(bc.includes('if (s.is_live) return _renderLiveStreamCard(s);'));
assert.ok(read('server/streaming/routes.js').includes("if (req.query.vods === '1') {"), 'the last streams carry their replays');
console.log('broadcast cameras: all checks passed');
