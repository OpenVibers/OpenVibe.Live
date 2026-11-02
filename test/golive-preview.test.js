'use strict';

/**
 * The ready card's preview (golive-setup redesign, part 2) holds the camera only while it may: never asking for
 * permission by itself, letting go before Go live opens the camera for the studio (a phone cannot open one camera
 * twice), and off when the tab hides, the page changes or a stream is live. Turning it off is remembered.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ws = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-workspace.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'broadcast.css'), 'utf8');
const fn = (name) => { const i = ws.indexOf(`function ${name}(`); assert.ok(i > 0, name); return ws.slice(i, ws.indexOf('\n}\n', i)); };

const want = fn('_glPreviewWant');
assert.ok(want.includes("document.getElementById('bc-device-selects')") && want.includes("devices.style.display === 'none'"), 'only once the browser may use the devices: the preview never asks by itself');
assert.ok(want.includes('document.hidden'), 'a hidden tab lets go of the camera');
assert.ok(want.includes('box.getClientRects().length'), 'another page (the studio section hidden) lets go of it');
assert.ok(want.includes('broadcastState.streams.size'), 'a live stream owns the camera');
assert.ok(want.includes('_glPv.hold > Date.now()'), 'Go live holds it off');
assert.ok(want.includes("mode === 'screen'"), 'a screen share has nothing to preview');

// Go live: stop the preview before the studio opens the camera, and release the hold whatever happens.
const golive = ws.slice(ws.indexOf('async function goLiveFromWorkspace('), ws.indexOf('function updateWorkspaceLiveStatus('));
const stopAt = golive.indexOf('_glPreviewStop();');
assert.ok(stopAt > 0 && stopAt < golive.indexOf('await createNewStream()'), 'the preview lets go before going live');
assert.ok(/try \{\s*await createNewStream\(\);\s*\} finally \{[\s\S]*?_glPv\.hold = 0;/.test(golive), 'the hold ends when going live succeeds or fails');

// A camera that opened after things moved on is closed again; every track stops.
assert.ok(fn('_glPreviewStart').includes('if (_glPreviewWant() !== key) { stream.getTracks().forEach((t) => t.stop()); return; }'), 'a late camera is let go');
assert.ok(fn('_glPreviewStop').includes("getTracks().forEach((t) => { try { t.stop(); }"), 'stopping stops every track');
assert.ok(fn('_glPreviewToggle').includes("localStorage.setItem(_GL_PV_OFF"), 'off is remembered on this device');
assert.ok(fn('_glPreviewStart').includes("localStorage.getItem('ov_bc_mirror_preview') === '1'"), 'mirroring follows the studio\'s own choice');

// One watch for the page, started from the panel render.
assert.ok(/\n {4}_glSyncSummaries\(\);\n {4}_glPreviewWatch\(\);/.test(ws), 'the panel starts the watch');
assert.ok(fn('_glPreviewWatch').includes('if (_glPv.timer) return;'), 'one watch only');

// Over the picture: the camera, the microphone's level and the network; a phone keeps Go live on the first screen.
const html = fn('_glPreviewHTML');
for (const part of ['data-pick-for="bc-create-camera"', 'id="gl-pv-lvl"', 'id="gl-pv-net"', 'id="gl-pv-off"', 'muted playsinline autoplay']) assert.ok(html.includes(part), part);
assert.ok(/\.gl-preview \{[^}]*max-height: min\(52vh, 520px\)/.test(css), 'capped on a phone');
assert.ok(/@media \(pointer: coarse\) \{ \.gl-pv-off \{ width: 44px; height: 44px; \} \}/.test(css), 'the off button is thumb-sized on touch');

console.log('golive-preview: all passed');
