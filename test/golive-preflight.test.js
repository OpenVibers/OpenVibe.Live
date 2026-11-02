'use strict';
/**
 * The Go Live section says what viewers will get before the button (market outcomes 5 and 6; broadcast-workspace.js
 * _wsPreflight): the picture and sound by device name (the setup card's own [data-pick-for] labels, kept current by
 * _bcSyncPicks), what can change once live and what means a new stream, and the browsers it works in.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-workspace.js'), 'utf8');
const start = src.indexOf('function _wsPreflight(mode)');
const end = src.indexOf('\nfunction _wsPermHint', start);
assert.ok(start > 0 && end > start, 'the function is there');
const preflight = new Function(`${src.slice(start, end)}; return _wsPreflight;`)();

const cam = preflight('camera');
assert.ok(cam.includes('Picture from <b data-pick-for="bc-create-camera">') && cam.includes('Sound from <b data-pick-for="bc-create-audio">'), 'camera: the chosen devices by name');
assert.ok(cam.includes('you can mute, turn the camera off or switch cameras') && cam.includes('Sharing your screen instead means a new stream'), 'what can change once live, and what cannot');
assert.ok(cam.includes('Works in Chrome, Edge, Firefox and Safari.'), 'the browsers');
assert.ok(preflight('screen').includes('your browser asks which when you press Go Live'), 'screen: what is captured is picked at the button');
assert.ok(preflight('mic_only').includes('No picture') && !preflight('mic_only').includes('bc-create-camera'), 'sound only');
assert.ok(preflight('camera_only').includes('No sound') && !preflight('camera_only').includes('bc-create-audio'), 'picture only');
assert.ok(src.includes('${_wsPreflight(browserMode)}'), 'it sits in the Go Live section');
const syncer = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-devices.js'), 'utf8');
assert.ok(syncer.includes("document.querySelectorAll('[data-pick-for]')"), 'and _bcSyncPicks keeps every [data-pick-for] current');
console.log('golive-preflight: what viewers will get, said before the button');
