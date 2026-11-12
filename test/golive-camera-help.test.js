'use strict';
/**
 * Turning the camera on to go live from a browser (broadcast-devices.js requestMediaPermissions, _glFixFor;
 * broadcast-workspace.js the camera card, _glCamCore). The owner, 11-12: a streamer on a phone saw "Could not access
 * camera/mic: Could not load camera controls" and "Error: Could not load camera controls" and said "I don't
 * understand … my brain too tired to figure it out". Now:
 *   - the camera never waits on openvibe.cam: when the kit cannot load, the same core runs from this page;
 *   - the card says what is about to happen and the three steps;
 *   - a failure says what happened and what to tap, for the browser the person is in, and never a raw error;
 *   - the Go Live button turns the camera on first instead of refusing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const devices = read('public/js/broadcast-devices.js');
const workspace = read('public/js/broadcast-workspace.js');

// _glFixFor, run under each browser.
const start = devices.indexOf('function _glFixFor(');
const end = devices.indexOf('\nfunction _glShowFix', start);
assert.ok(start > 0 && end > start, '_glFixFor is there');
const fixUnder = (ua, touch = 0) => new Function('navigator', `${devices.slice(start, end)}; return _glFixFor;`)({ userAgent: ua, maxTouchPoints: touch });
const UA = {
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0',
    desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
};
const text = (fix) => `${fix.title} ${fix.steps.join(' ')}`;
const denied = { name: 'NotAllowedError', message: 'Permission denied' };

let fix = fixUnder(UA.androidChrome)(denied, 'camera');
assert.match(fix.title, /said no to the camera and microphone/);
assert.match(text(fix), /Permissions/, 'Android Chrome: the site settings under the address bar icon');
assert.match(text(fix), /Try again/);
assert.match(text(fixUnder(UA.iphoneSafari)(denied, 'camera')), /aA/, 'iPhone Safari: aA, Website Settings');
assert.match(text(fixUnder(UA.firefox)(denied, 'camera')), /line through it/, 'Firefox: the crossed-out camera icon');
assert.match(text(fixUnder(UA.desktopChrome)(denied, 'camera')), /Always allow/, 'desktop Chrome: Always allow');
assert.match(fixUnder(UA.androidChrome)(denied, 'mic_only').title, /said no to the microphone$/, 'a microphone-only slot names only the microphone');

fix = fixUnder(UA.instagram)({ name: 'NoApi' }, 'camera');
assert.match(text(fix), /inside another app/);
assert.match(text(fix), /Open in Safari/, 'an in-app browser on an iPhone: open it in Safari');
assert.match(text(fixUnder(UA.androidChrome)({ name: 'NotReadableError' }, 'camera')), /Another app is using your camera/);
assert.match(text(fixUnder(UA.androidChrome)({ name: 'NotFoundError' }, 'camera')), /screen instead/, 'no camera: the screen is the way out');
assert.match(fixUnder(UA.androidChrome)(new Error('Could not load camera controls'), 'camera').title, /didn't start/);
for (const ua of Object.values(UA)) {
    for (const name of ['NotAllowedError', 'NotReadableError', 'NotFoundError', 'OverconstrainedError', 'TimeoutError', 'NoApi', 'TypeError']) {
        const t = text(fixUnder(ua)({ name, message: 'raw detail' }, 'camera'));
        assert.ok(!/raw detail|Error\b|getUserMedia|API/.test(t), `${name}: words for people, never the raw error (${t.slice(0, 80)})`);
    }
}

// The failure shows in the card, never as raw text; the button under it says Try again.
assert.ok(devices.includes('_glShowFix(_glFixFor(err, permMode))'), 'a failure fills the card\'s fix box');
assert.ok(!/toast\('Could not access camera\/mic/.test(devices), 'no raw "Could not access camera/mic" toast');
assert.ok(devices.includes("'Try again'") || devices.includes('>Try again<'), 'the button says Try again after a failure');
assert.ok(workspace.includes('<p id="bc-perm-debug" hidden></p>'), 'the debug line is never shown to people');

// The card: what is about to happen and the three steps.
assert.ok(workspace.includes('Your browser will ask first: tap Allow.'), 'the card says the browser will ask');
assert.ok(workspace.includes('id="gl-steps"') && workspace.includes('Press Go Live'), 'the three steps');
assert.ok(workspace.includes('id="gl-fix"'), 'the fix box');

// The camera never waits on openvibe.cam.
const core = workspace.slice(workspace.indexOf('function _glCamCore()'), workspace.indexOf('function _glOtherWays()'));
assert.ok(core.includes('resolve(_glLocalCore)') && !core.includes('reject('), 'a kit that cannot load falls back to the built-in core');
assert.ok(core.includes('setTimeout(() => fallback'), 'and a kit that never answers too');
for (const m of ['devices', 'constraints', 'open', 'stop', 'network', 'meter']) assert.ok(new RegExp(`\\b${m}: `).test(workspace.slice(workspace.indexOf('const _glLocalCore'), workspace.indexOf('function _glCamCore()'))), `the built-in core has ${m}`);

// Go Live turns the camera on first instead of refusing.
const go = workspace.slice(workspace.indexOf('async function goLiveFromWorkspace()'), workspace.indexOf('await _wsFlushSave();', workspace.indexOf('async function goLiveFromWorkspace()')));
assert.ok(go.includes('await requestMediaPermissions()') && !go.includes("toast('Turn on camera before going live'"), 'Go Live does step 1 when the camera is off');
assert.ok(workspace.includes('Turns on your camera first'), 'and says so under its label');
console.log('golive-camera-help: plain help for every camera failure, a camera that never waits on another site, Go Live that does the next step');
