'use strict';
// A transcribed window OpenVibe.AI delivers flagged by the hard floor (AI #597: a transcript is flagged, never
// dropped) is counted for the operator alert (live_transcript_floor_flags_total{rule}) and logged with the
// recording's path and the window's start, never the words or the signed URL's query; its segments are kept.
const assert = require('assert');
const aiService = require('../server/ai/ai-service');
const ma = require('../server/ai/media-analysis');

const seen = [];
ma.registerMetrics({ counter: (def) => { assert.strictEqual(def.name, 'live_transcript_floor_flags_total'); return { inc: (labels) => seen.push(labels) }; } });
const logged = [];
const warn = console.warn;
console.warn = (line) => logged.push(String(line));

(async () => {
    const segs = [{ start: 0, end: 4, text: 'hello chat' }];
    aiService.run = async () => ({ status: 'succeeded', output: { text: 'hello chat', segments: segs, floor: { rule: 'minors', detail: 'this request breaks the hard floor (sexual content involving minors)' } } });
    const w = await ma._aiWindow('https://media.openvibe.live/vods/6501/vod.mp4?sig=SECRET123&exp=9', 300, 300, 'en');
    assert.strictEqual(w.ok, true, 'the window is kept');
    assert.deepStrictEqual(w.segments, segs, 'with its words');
    assert.strictEqual(w.floor && w.floor.rule, 'minors', 'and the finding');
    assert.deepStrictEqual(seen, [{ rule: 'minors' }], 'counted by rule');
    assert.strictEqual(logged.length, 1);
    assert.match(logged[0], /\/vods\/6501\/vod\.mp4 at 300 s reads as the floor's minors line/);
    assert.ok(!/SECRET123|hello chat/.test(logged[0]), 'never the signed query or the words');

    aiService.run = async () => ({ status: 'succeeded', output: { text: 'gg', segments: [{ start: 0, end: 1, text: 'gg' }] } });
    const clean = await ma._aiWindow('https://media.openvibe.live/vods/6502/vod.mp4', 0, 300, 'en');
    assert.strictEqual(clean.floor, null);
    assert.strictEqual(seen.length, 1, 'a clean window is not counted');
    console.warn = warn;
    console.log('transcript-floor-flags: a flagged window is kept, counted by rule and logged without its words');
})().catch((e) => { console.warn = warn; console.error(e); process.exit(1); });
