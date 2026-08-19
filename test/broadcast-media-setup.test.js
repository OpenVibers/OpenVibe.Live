/**
 * Tranche 1 contract: device permission flow, mic preview, capture summary.
 *
 * These are DOM-driven features, so this pins the wiring that silently rots —
 * the same class of failure as the bc-screen-* id mismatch: a handler that names
 * an element nobody renders, or a control that renders with no handler.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const setup = read('public/js/broadcast-media-setup.js');
const workspace = read('public/js/broadcast-workspace.js');
const devices = read('public/js/broadcast-devices.js');
const html = read('public/index.html');
const css = read('public/css/broadcast.css');

// ── A: the module is actually loaded, and before its consumers ───────────────────────
assert.ok(html.includes('/js/broadcast-media-setup.js'), 'index.html must load broadcast-media-setup.js');
const at = (f) => html.indexOf(f);
assert.ok(at('/js/broadcast-media-setup.js') < at('/js/broadcast-workspace.js'),
    'media-setup must load before broadcast-workspace.js, which calls into it');
assert.ok(at('/js/broadcast-media-setup.js') < at('/js/broadcast-devices.js'),
    'media-setup must load before broadcast-devices.js, which calls into it');
console.log('OK A: broadcast-media-setup.js is loaded ahead of both consumers');

// ── B: the public surface consumers rely on exists ───────────────────────────────────
for (const fn of ['request', 'startMeter', 'stopMeter', 'renderSummary', 'permissionState', 'listDevices']) {
    assert.ok(new RegExp(`\\b${fn}\\b`).test(setup.slice(setup.indexOf('window.bcMediaSetup'))),
        `bcMediaSetup must export ${fn}()`);
}
console.log('OK B: bcMediaSetup exports the full surface its callers use');

// ── C: every element the JS touches is actually rendered ─────────────────────────────
const rendered = new Set([...workspace.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
for (const id of ['bc-ws-mic-meter', 'bc-ws-mic-meter-status', 'bc-ws-mic-meter-wrap', 'bc-ws-capture-summary']) {
    assert.ok(rendered.has(id), `workspace must render #${id}`);
    assert.ok(workspace.includes(`'${id}'`), `workspace JS must reference #${id}`);
}
console.log('OK C: meter canvas, status, wrapper and summary container are all rendered and referenced');

// ── D: device changes re-run the preview — a meter pinned to the old device would ────
//      happily show a healthy signal for the exact bug this feature exists to catch.
assert.ok(/id="bc-ws-screen-mic-select"[^>]*onchange="_wsOnMicDeviceChange\(\)"/.test(workspace),
    'changing the microphone must re-run the meter via _wsOnMicDeviceChange()');
assert.ok(/function _wsOnMicDeviceChange\(\)[\s\S]{0,200}_wsStartMicMeter\(\)/.test(workspace),
    '_wsOnMicDeviceChange must restart the meter');
assert.ok(/deviceId: \{ exact: deviceId \}/.test(setup),
    'the meter must open the SELECTED device with an exact constraint, not the OS default');
console.log('OK D: the meter follows the selected device, with an exact deviceId constraint');

// ── E: permission is explained before it is requested ────────────────────────────────
const requestFn = setup.slice(setup.indexOf('async function request('), setup.indexOf('/* ── Live microphone meter'));
// Match the CALL that actually prompts, not the `navigator.mediaDevices?.getUserMedia`
// capability check that legitimately precedes everything.
const promptAt = requestFn.indexOf('getUserMedia(meta.constraints)');
assert.ok(promptAt > 0, 'request() must call getUserMedia(meta.constraints)');
assert.ok(requestFn.indexOf('explain(') < promptAt,
    'the explainer must run before getUserMedia() fires the browser prompt');
assert.ok(/listDevices\(meta\.deviceKind\)/.test(requestFn),
    'devices must be re-enumerated AFTER the grant — labels and deviceIds are empty before it');
assert.ok(/unblockHint/.test(setup), 'a denied permission must come with recovery instructions');
console.log('OK E: explain -> prompt -> re-enumerate, with a recovery path when denied');

// ── F: the blunt combined prompt is gone ─────────────────────────────────────────────
const populate = devices.slice(devices.indexOf('async function populateDeviceLists()'),
                               devices.indexOf('function _getPreferredCameraId()'));
assert.ok(populate.includes("bcMediaSetup.request('mic')") && populate.includes("bcMediaSetup.request('camera')"),
    'populateDeviceLists must ask per-device through the explainer');
const combinedIdx = populate.indexOf('{ audio: true, video: true }');
assert.ok(combinedIdx === -1 || populate.lastIndexOf('window.bcMediaSetup') < combinedIdx,
    'the combined audio+video prompt may only survive as a no-bcMediaSetup fallback');
console.log('OK F: camera and mic are requested separately, each behind its own explainer');

// ── G: the meter releases the device when the mic is switched off ────────────────────
assert.ok(/_wsScreenMicToggle[\s\S]{0,400}stopMeter\('bc-ws-mic-meter'\)/.test(workspace),
    'turning the mic off must stop the meter, or the OS in-use indicator stays lit');
console.log('OK G: preview device released when the microphone is switched off');

// ── H: styles exist for everything the JS emits ──────────────────────────────────────
for (const cls of ['bc-perm-overlay', 'bc-perm-card', 'bc-perm-mock', 'bc-mic-meter', 'bc-cap-row', 'bc-cap-warn']) {
    assert.ok(css.includes(`.${cls}`), `broadcast.css must style .${cls}`);
}
console.log('OK H: permission card, meter and capture summary are all styled');

console.log('✅ broadcast media setup test passed');
