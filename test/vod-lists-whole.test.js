'use strict';
// Lists people see show a broadcast recorded in parts as one video with its whole length (media-client listVods
// { whole: true }: the first part answers for the joined recording). The home's Recent VODs row read "14:46" for
// iZoR_One's 36:51 broadcast though 32:15 was recorded in two parts Media had joined (2026-11-19). What this proves:
//   - wholeVideo turns a joined recording's first part into the whole video, and leaves a later part or a single one;
//   - every list a person sees asks for it: Recent VODs, the home's VOD row, the VOD pages and search documents.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const client = src('server/media-client.js');
const start = client.indexOf('function wholeVideo(v)');
assert.ok(start > 0, 'wholeVideo is in media-client.js');
const wholeVideo = new Function(`${client.slice(start, client.indexOf('\n}\n', start) + 2)}; return wholeVideo;`)();

const first = wholeVideo({ id: 6619, duration_seconds: 886, recording: { parts: 2, duration_ms: 1935067, first_vod_id: 6619 } });
assert.deepStrictEqual([first.duration_seconds, first.duration, first.part_duration_seconds], [1935, 1935, 886], 'the first part is the whole video');
const later = wholeVideo({ id: 6620, duration_seconds: 1049, recording: { parts: 2, duration_ms: 1935067, first_vod_id: 6619 } });
assert.strictEqual(later.duration_seconds, 1049, 'a later part keeps its own length');
const single = wholeVideo({ id: 7000, duration_seconds: 300 });
assert.strictEqual(single.duration_seconds, 300);

for (const [file, pattern, what] of [
    ['server/streaming/routes.js', /media\.listVods\(\{ limit, offset \}, \{ whole: true \}\)/, 'Recent VODs (/api/streams/recent-vods)'],
    ['server/home/routes.js', /media\.listVods\(\{ limit: 12 \}, \{ whole: true \}\)/, "the home's VOD row"],
    ['server/media-proxy/vods.js', /media\.listVods\(await usernameToUserId\(req\.query\), \{ whole: true \}\)/, 'the VOD pages'],
    ['server/events/search-media-documents.js', /media\.listVods\(\{ limit, offset \}, \{ timeoutMs: 20000, whole: true \}\)/, 'search documents'],
]) assert.match(src(file), pattern, `${what} ask for whole videos`);
console.log('vod-lists-whole: a joined recording is one video with its whole length in every list people see');
