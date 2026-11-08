'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const workspace = read('public/js/broadcast-workspace.js');
const helper = workspace.match(/function toursPlaceHandoff\(search\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(helper, 'the studio accepts a Tours handoff');
const handoff = new Function(`${helper}; return toursPlaceHandoff;`)();
const url = 'https://openvibe.tours/place/kubota-garden-plc_0123456789ABCDEFGHJKMNPQRS';
assert.deepEqual(handoff(`?place=Kubota+Garden&place_url=${encodeURIComponent(url)}`), {
    name: 'Kubota Garden', url, title: 'At Kubota Garden',
});
assert.equal(handoff('?place=Kubota+Garden&place_url=https%3A%2F%2Fevil.example%2F'), null);
assert.equal(handoff('?place=Kubota+Garden'), null);
assert.match(workspace, /bc-place-name/);
assert.match(workspace, /bc-place-url/);
assert.match(read('public/js/broadcast.js'), /place_name: document\.getElementById\('bc-place-name'\)/);
assert.match(read('server/streaming/routes.js'), /place_name: placeName \|\| null/);
assert.match(read('server/db/database.js'), /place_name, place_url, is_live/);
assert.match(read('server/media-proxy/clips.js'), /clip\.place_url = source\.place_url/);
console.log('Tours place handoff: studio prefill, validated link, stream and clip metadata pass');
