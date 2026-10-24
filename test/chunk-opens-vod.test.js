'use strict';
// A browser chunk opens a new VOD only for a live stream, and only when it starts a WebM file (server/media-proxy/vods.js
// chunkOpensVod). After Live ended Maticus's stream on 2026-10-23 his browser kept sending its 30-second MediaRecorder
// slices; each one with no recording open made a VOD from a slice with no header, which nothing could play (5939,
// 5940). The answers are what public/js/broadcast.js acts on: stream-ended stops the recorder, needs-header restarts it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chunkOpensVod } = require('../server/media-proxy/vods');

const header = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)]);
const middle = Buffer.concat([Buffer.from([0x43, 0xc3, 0x81, 0x17]), Buffer.alloc(100)]);   // 5939's first bytes
assert.strictEqual(chunkOpensVod({ id: 1, ended_at: null }, header), null, 'a live stream, a file start: a new VOD');
assert.strictEqual(chunkOpensVod({ id: 1, ended_at: null }, middle).status, 'needs-header');
assert.strictEqual(chunkOpensVod({ id: 1, ended_at: '2026-10-23 23:31:42' }, header).status, 'stream-ended');
assert.strictEqual(chunkOpensVod({ id: 1 }, null).status, 'needs-header');

// The browser handles both answers (a static file: these names are its contract with the route).
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast.js'), 'utf8');
assert.ok(/data\.status === 'stream-ended'/.test(js) && /data\.status === 'needs-header'/.test(js), 'broadcast.js reads both 409 answers');
assert.ok(/function restartVodRecording\(/.test(js) && /ss\.vodRecorder !== recorder/.test(js), "a replaced recorder's last slice is dropped");
console.log('chunk-opens-vod: ok');
process.exit(0);
