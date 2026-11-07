'use strict';
// A moment frame or paste image on the home page must be one a browser can load (server/home/routes.js
// _loadableShot; 2026-11-07, the owner's phone: every AI moment and image paste was a broken image). Screenshots are
// private Media objects, so a stored https://openvibe.media/o/med_… is read through Community's guarded
// /p/<slug>/screenshot, and a frame without a paste to point at is dropped instead of drawn broken.
//   node --import ./test/helpers/pg-preload.mjs test/home-moment-thumbs.test.js
const assert = require('assert');
const { _loadableShot } = require('../server/home/routes');

const OBJ = 'https://openvibe.media/o/med_01M6SM78JFYD26R13Q3Q3WDHDN';
assert.strictEqual(_loadableShot(OBJ, 'wild-vibe-2564'), 'https://openvibe.community/p/wild-vibe-2564/screenshot', 'a private object becomes the guarded paste address');
assert.strictEqual(_loadableShot(`${OBJ}?w=480`, 'wild-vibe-2564'), 'https://openvibe.community/p/wild-vibe-2564/screenshot', 'with a size query too');
assert.strictEqual(_loadableShot(OBJ, null), null, 'no paste to point at: dropped, never drawn broken');
assert.strictEqual(_loadableShot(OBJ, '../../admin'), null, 'a slug that is not a slug is never put in a URL');
assert.strictEqual(_loadableShot('https://openvibe.media/t/clip-538-1.jpg', 'x'), 'https://openvibe.media/t/clip-538-1.jpg', 'a thumbnail URL is left alone');
assert.strictEqual(_loadableShot('https://openvibe.community/p/a/screenshot', 'a'), 'https://openvibe.community/p/a/screenshot', 'an already guarded address is left alone');
assert.strictEqual(_loadableShot(null, 'a'), null);
console.log('home moment thumbs: ok');
