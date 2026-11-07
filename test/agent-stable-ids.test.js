'use strict';
// AGT-4: agent.json says what an id in a Live address is and where it goes, as the routes really behave.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { agentManifest } = require('openvibe-shared/agent-layer');

const m = agentManifest(require('../server/agent-descriptor'));
const ids = m.policy.stableIds;
assert.deepStrictEqual(ids.map((x) => [x.kind, x.url]), [
    ['channel', 'https://openvibe.live/@{username}'],
    ['recording', 'https://openvibe.live/vod/{id}'],
    ['clip', 'https://openvibe.live/clip/{id}'],
]);
// The claims are the routes': a renamed channel's old name 301s to the current one, and a numeric VOD or clip id 301s
// to OpenVibe.Video's watch page.
const status = fs.readFileSync(path.join(__dirname, '..', 'server', 'web', 'page-status.js'), 'utf8');
assert.match(status, /a renamed one's old name\s*\n\s*\*\s+answers 301 → \/@current/);
assert.match(status, /\/vod\/:id\s+\/clip\/:id\s+a numeric id 301s to OpenVibe\.Video/);
const { videoUrl } = require('../server/web/video-url');
assert.strictEqual(videoUrl('vod', 12), 'https://openvibe.video/v/12');
assert.strictEqual(videoUrl('clip', 12), 'https://openvibe.video/c/12');
// A row's watch id (Media mints one for every VOD and clip) names the page in YouTube's shape, the moment after it.
assert.strictEqual(videoUrl('vod', 12, null, 'dQw4w9WgXcQ'), 'https://openvibe.video/watch?v=dQw4w9WgXcQ');
assert.strictEqual(videoUrl('vod', 12, 95, 'dQw4w9WgXcQ'), 'https://openvibe.video/watch?v=dQw4w9WgXcQ&t=95');
assert.strictEqual(videoUrl('clip', 12, null, 'dQw4w9WgXcQ'), 'https://openvibe.video/watch?v=dQw4w9WgXcQ');
assert.strictEqual(videoUrl('vod', 12, null, 'too-short'), 'https://openvibe.video/v/12', 'a malformed id is not used');
console.log('agent stable ids: ok');
