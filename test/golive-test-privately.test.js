'use strict';

/**
 * Test privately (golive-setup redesign, part 3): ten seconds of the preview, recorded in the browser and played back in
 * the card. Nothing leaves the device: the test code calls no API and no fetch, the recording is an object URL revoked on
 * Done, and going live (or the preview letting go of the camera) ends a test that is running.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ws = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-workspace.js'), 'utf8');
const start = ws.indexOf('/* ── Test privately');
const block = ws.slice(start, ws.indexOf('\n/* ── Tab switching', start));
assert.ok(start > 0 && block.length > 500, 'the Test privately block');

assert.ok(!/\bapi\(|fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(block), 'nothing is sent anywhere');
assert.ok(block.includes('new MediaRecorder(stream'), 'it records the preview the card already holds (no second camera)');
assert.ok(/_glT\.left = 10;/.test(block), 'ten seconds');
assert.ok(block.includes('URL.revokeObjectURL(_glT.url)'), 'Done frees the recording');
assert.ok(block.includes("rec.onstop = null"), 'a discarded test is never played back');

const golive = ws.slice(ws.indexOf('async function goLiveFromWorkspace('), ws.indexOf('function updateWorkspaceLiveStatus('));
assert.ok(golive.indexOf('_glTestStop(true);') > 0 && golive.indexOf('_glTestStop(true);') < golive.indexOf('_glPreviewStop();'), 'going live ends a running test first');
const stop = ws.slice(ws.indexOf('function _glPreviewStop() {'), ws.indexOf('\n}\n', ws.indexOf('function _glPreviewStop() {')));
assert.ok(stop.includes('if (_glT.rec) _glTestStop(true);'), 'the preview letting go ends a running test');

// The button: under Go live, not for a screen share (the browser picks the screen only when going live).
const panel = ws.slice(ws.indexOf('function _wsRenderPanel()'), ws.indexOf('\n}\n', ws.indexOf('function _wsRenderPanel()')));
assert.ok(/\$\{browserMode === 'screen' \? '' : `<button type="button" class="gl-test-btn" id="gl-test-btn" onclick="_glTestPrivately\(\)">/.test(panel), 'the button, except for a screen share');
assert.ok(panel.indexOf('id="gl-test-btn"') > panel.indexOf('id="bc-ws-golive-btn"'), 'under Go live');

console.log('golive-test-privately: all passed');
