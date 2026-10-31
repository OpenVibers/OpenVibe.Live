'use strict';
// The streamer sees what the server really receives (plan L23 R2). Stream 2827 (2026-10-30) looked healthy in the
// studio while no picture reached the server. Every 5 s the server sends the broadcaster ingest-health (video and
// audio: present, kbps, score); two reports in a row with the camera on and no video arriving turn the health pill
// "No picture" and say once what to do.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── the studio's side, run for real ──
const bc = read('public/js/broadcast.js');
const start = bc.indexOf('function _applyIngestHealth(');
let i = bc.indexOf('{', bc.indexOf(')', start)), depth = 0;
for (; i < bc.length; i++) { if (bc[i] === '{') depth++; else if (bc[i] === '}' && --depth === 0) break; }
const toasts = [];
const ctx = vm.createContext({ toast: (m, k) => toasts.push([m, k]), broadcastState: { activeStreamId: 7 } });
vm.runInContext(bc.slice(start, i + 1), ctx);
const apply = (ss, msg) => vm.runInContext('_applyIngestHealth', ctx)(7, ss, msg);

const cam = (on = true) => ({ getVideoTracks: () => [{ readyState: 'live', enabled: on }] });
const ss = { localStream: cam() };
apply(ss, { video: { present: false, kbps: null }, audio: { present: true, kbps: 40 } });
assert.strictEqual(ss.ingestNoPicture, false, 'one report is not enough: a camera may still be starting');
apply(ss, { video: { present: false, kbps: null }, audio: { present: true, kbps: 40 } });
assert.strictEqual(ss.ingestNoPicture, true, 'two in a row: no picture');
assert.strictEqual(toasts.length, 1, 'said once');
assert.match(toasts[0][0], /Viewers aren't getting your camera/);
apply(ss, { video: { present: true, kbps: 0 } });
assert.strictEqual(toasts.length, 1, 'not again while it lasts');
apply(ss, { video: { present: true, kbps: 2400, score: 10 } });
assert.strictEqual(ss.ingestNoPicture, false, 'the picture arrives: all clear');

const off = { localStream: cam(false) };
apply(off, { video: { present: false } }); apply(off, { video: { present: false } });
assert.strictEqual(off.ingestNoPicture, false, 'a camera the streamer turned off is not a problem');

// The health pill takes the server's word.
assert.match(bc, /if \(ss\.ingestNoPicture\) \{ health = 'No picture'; color = '#ef4444'; \}/);
assert.match(read('public/js/broadcast-studio.js'), /'no picture': \['is-bad', 'No picture'\]/);

// ── the server's side ──
const server = read('server/streaming/broadcast-server.js');
assert.match(server, /room\.broadcaster = ws;[\s\S]{0,200}this\._startIngestHealth\(streamId, room\);/, 'it starts with the broadcaster');
assert.match(server, /if \(room\.broadcaster === ws\) this\._stopIngestHealth\(room\);/, 'it stops when the broadcaster leaves');
assert.match(server, /this\._stopIngestHealth\(room\);\s*\n\s*\/\/ Notify all viewers\s*\n\s*for \(const \[, viewerWs\] of room\.viewers\) \{\s*\n\s*this\.safeSend\(viewerWs, \{ type: 'stream-ended' \}\);/, 'and when the stream ends');
assert.match(server, /room\._ingestTimer = setInterval\(async \(\) => \{[\s\S]{0,1600}\}, 5000\);/, 'every 5 s');
assert.match(server, /type: 'ingest-health',\s*\n\s*video: \{ present: h\.video\.present, kbps: kbps\('video'\), score: h\.video\.score \},/);
assert.match(read('server/streaming/webrtc-sfu.js'), /async ingestHealth\(roomId\) \{[\s\S]{0,900}producer\.getStats\(\)/);

console.log('ingest health: the studio shows what the server receives, and says "No picture" when it gets none');
