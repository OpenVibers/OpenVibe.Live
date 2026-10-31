'use strict';
// The broadcaster always comes back (plan L23 R1, owner 2026-10-31: "even if the client disconnects, their phone
// reboots… resuming should be a piece of cake"). The server keeps a stream live for five minutes after its broadcaster's
// connection drops (it was 60 s, shorter than a phone's reboot); viewers wait as long and see "The streamer is
// reconnecting…"; the studio reconnects the moment the network is back, and never waits more than 15 s between tries.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const server = read('server/streaming/broadcast-server.js');
assert.match(server, /const RESUME_GRACE_MS = Math\.max\(30000, Number\(process\.env\.BROADCAST_RESUME_GRACE_MS\) \|\| 5 \* 60 \* 1000\);/, 'five minutes, settable');
assert.match(server, /room\._disconnectTimer = setTimeout\(async \(\) => \{[\s\S]{0,2500}\}, RESUME_GRACE_MS\);/, 'the stream ends only after the grace');
assert.match(server, /safeSend\(viewerWs, \{ type: 'broadcaster-disconnected', graceMs: RESUME_GRACE_MS \}\)/, 'viewers are told how long');
assert.ok(!/\}, 60000\);\s*\n\s*\/\/ Notify all viewers/.test(server), 'no 60 s timer left');

const player = read('public/js/stream-player.js');
assert.match(player, /\}, Math\.max\(30000, Number\(msg\.graceMs\) \|\| 300000\) \+ 5000\);/, 'the viewer waits as long as the server');
assert.ok(player.includes('The streamer is reconnecting…'), 'and says who is reconnecting');

const bc = read('public/js/broadcast.js');
assert.match(bc, /window\.addEventListener\('online', \(\) => _bcReconnectNow\('Network back'\)\);/, 'the network coming back reconnects now');
assert.match(bc, /navigator\.connection\.addEventListener\('change'/, 'so does a network change');
assert.match(bc, /function _bcReconnectNow\(reason\) \{[\s\S]{0,700}ss\.signalingReconnectDelay = 3000;[\s\S]{0,200}connectSignaling\(streamId\);/, 'the backoff starts over');
assert.match(bc, /ss\.signalingReconnectDelay = Math\.min\(ss\.signalingReconnectDelay \* 1\.5, 15000\);/, 'at most 15 s between tries');

// Leaving the site while live asks first (the studio module runs on every screen size).
assert.match(read('public/js/broadcast-studio.js'), /window\.addEventListener\('beforeunload', \(e\) => \{\s*if \(!localStream\(\)\) return;\s*e\.preventDefault\(\);/);

// Moving inside the site never stops a broadcast: the route teardown has no broadcast stop in it.
const app = read('public/js/app.js');
const teardown = app.slice(app.indexOf('function teardownRoute('), app.indexOf('\n}\n', app.indexOf('function teardownRoute(')));
assert.ok(!/stopBroadcast|cleanupStream|endStream|stopAllStreams/.test(teardown), 'a page change leaves the broadcast running');

console.log('always live: 5 min grace, viewers wait and say so, the studio reconnects at once, leave asks first');
