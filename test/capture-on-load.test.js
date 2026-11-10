/**
 * No capture until a press: a devicechange (plug/unplug) is a hardware event, not
 * a person press, so it must only re-enumerate. It must never reach getUserMedia
 * through populateDeviceLists / bcMediaSetup.request / startMediaCapture.
 * Permission still comes only from the "Turn on camera / microphone" press.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const broadcast = read('public/js/broadcast.js');
const devices = read('public/js/broadcast-devices.js');

// The devicechange handler must be enumerate-only.
const at = broadcast.indexOf("addEventListener('devicechange'");
assert.ok(at !== -1, 'broadcast.js must listen for devicechange');
const handler = broadcast.slice(at, broadcast.indexOf('});', broadcast.indexOf("addEventListener('devicechange'")) + 3);
assert.ok(/refreshDeviceLists\(\)/.test(handler), 'devicechange re-enumerates via refreshDeviceLists (enumerate-only)');
for (const bad of ['populateDeviceLists', 'bcMediaSetup.request', 'getUserMedia(', 'startMediaCapture']) {
    assert.ok(!handler.includes(bad), `devicechange must not reach ${bad}`);
}
console.log('OK capture-on-load: devicechange only re-enumerates');

// The permission flow itself is unchanged: it still asks through the explainer.
const populate = devices.slice(devices.indexOf('async function populateDeviceLists()'),
                               devices.indexOf('function _getPreferredCameraId()'));
assert.ok(populate.includes("bcMediaSetup.request('mic')") && populate.includes("bcMediaSetup.request('camera')"),
    'populateDeviceLists must still ask per-device through the explainer');
console.log('OK capture-on-load: permission flow unchanged (explainer, on press)');

console.log('✅ capture on load test passed');
