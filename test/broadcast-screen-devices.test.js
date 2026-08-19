/**
 * Regression: the screen-share capture path must read the controls the UI actually renders.
 *
 * broadcast-workspace.js renders the screen-share panel with bc-ws-screen-mic /
 * -mic-select / -cam / -cam-select. createNewStream() in broadcast.js read a different,
 * older set of ids (bc-screen-mic-enabled / bc-screen-audio / bc-screen-cam-enabled /
 * bc-screen-camera) which survive only as hidden stubs carrying hardcoded values:
 *
 *     <input type="checkbox" id="bc-screen-mic-enabled" checked style="display:none">
 *     <input type="checkbox" id="bc-screen-cam-enabled"         style="display:none">
 *     <select  id="bc-screen-audio"  style="display:none"><option value="default">…
 *     <select  id="bc-screen-camera" style="display:none"><option value="default">…
 *
 * Nothing ever copied the streamer's SELECTION into those stubs — the workspace mirrored
 * the option list and not the chosen value — so every screen share captured with
 * audioId 'default' and cameraId 'default', and screenCamEnabled read as false:
 *
 *   - the microphone the streamer picked was discarded and capture silently fell back to
 *     the OS default input. When that default was not the intended mic, viewers heard
 *     nothing at all, and the UI kept reporting "Default".
 *   - the camera overlay never ran, because its enable flag came from a stub that is
 *     never checked.
 *
 * These assertions pin the contract in both directions: the ids the UI renders, and the
 * ids the capture path reads.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const broadcast = fs.readFileSync(path.join(root, 'public/js/broadcast.js'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'public/js/broadcast-workspace.js'), 'utf8');

// ── A: the workspace still renders the controls we claim to read ─────────────────────
for (const id of ['bc-ws-screen-mic', 'bc-ws-screen-mic-select', 'bc-ws-screen-cam', 'bc-ws-screen-cam-select']) {
    assert.ok(workspace.includes(`id="${id}"`),
        `broadcast-workspace.js must render #${id} (the screen-share capture path reads it)`);
}
console.log('OK A: workspace renders the four screen-share device controls');

// ── B: the capture path reads those ids, not only the hidden stubs ───────────────────
const capture = broadcast.slice(broadcast.indexOf('async function createNewStream()'),
                                broadcast.indexOf('await startMediaCapture(streamData.id, captureOpts)'));
assert.ok(capture.length > 0, 'could not locate createNewStream() capture section');

for (const id of ['bc-ws-screen-mic', 'bc-ws-screen-mic-select', 'bc-ws-screen-cam', 'bc-ws-screen-cam-select']) {
    assert.ok(capture.includes(`'${id}'`),
        `createNewStream() must read #${id} — reading only the hidden stub discards the streamer's choice`);
}
console.log('OK B: createNewStream() reads the real controls');

// ── C: the stubs must never be the ONLY source for these four values ─────────────────
// If a legacy id appears without its bc-ws- counterpart on the same lookup, the value is
// coming from a hardcoded hidden input again.
const legacyPairs = [
    ['bc-screen-mic-enabled', 'bc-ws-screen-mic'],
    ['bc-screen-cam-enabled', 'bc-ws-screen-cam'],
    ['bc-screen-audio', 'bc-ws-screen-mic-select'],
    ['bc-screen-camera', 'bc-ws-screen-cam-select'],
];
for (const [legacy, real] of legacyPairs) {
    for (const line of capture.split('\n')) {
        if (line.includes(`'${legacy}'`) && !line.includes('//')) {
            assert.ok(line.includes(`'${real}'`),
                `capture path reads #${legacy} without #${real} on the same lookup — the stub is hardcoded, so this silently ignores the streamer's selection`);
        }
    }
}
console.log('OK C: every legacy-id lookup is paired with the real control as the preferred source');

// ── D: the hidden stubs really are hardcoded (so C is not paranoia) ──────────────────
assert.ok(/id="bc-screen-mic-enabled"[^>]*checked/.test(workspace),
    'bc-screen-mic-enabled stub is hardcoded checked — reading it can never reflect the toggle');
assert.ok(/id="bc-screen-cam-enabled"(?![^>]*checked)/.test(workspace),
    'bc-screen-cam-enabled stub is never checked — reading it always disables the camera overlay');
console.log('OK D: confirmed the stubs carry fixed values and cannot reflect user intent');

// ── E: the camera overlay flag is derived from the toggle, before capture starts ──────
assert.ok(/ss\._cameraOverlayEnabled\s*=\s*screenCamEnabled/.test(broadcast),
    'the camera overlay flag must come from the screen-share camera toggle');
const flagAt = broadcast.indexOf('ss._cameraOverlayEnabled = screenCamEnabled');
const captureAt = broadcast.indexOf('await startMediaCapture(streamData.id, captureOpts)');
assert.ok(flagAt > 0 && flagAt < captureAt,
    'the overlay flag must be set before startMediaCapture() reads it');
console.log('OK E: camera overlay flag set from the toggle, before capture');

console.log('✅ broadcast screen-share device wiring test passed');
