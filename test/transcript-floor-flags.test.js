'use strict';
// A transcribed window OpenVibe.AI delivers flagged by the hard floor (AI #597: a transcript is flagged, never
// dropped) is counted for the operator alert (live_transcript_floor_flags_total{rule}) and logged with the
// recording's path and the window's start, never the words or the signed URL's query; its segments are kept. It is also
// kept for staff review (transcript_flags, plan §AD.11 item 3): the VOD or clip and the second, once per window.
const assert = require('assert');
const db = require('../server/db/database');
const flags = require('../server/admin/transcript-flags');
const aiService = require('../server/ai/ai-service');
const ma = require('../server/ai/media-analysis');

const seen = [];
ma.registerMetrics({ counter: (def) => { assert.strictEqual(def.name, 'live_transcript_floor_flags_total'); return { inc: (labels) => seen.push(labels) }; } });
const logged = [];
const warn = console.warn;
console.warn = (line) => logged.push(String(line));

(async () => {
    await db.initDb();
    const segs = [{ start: 0, end: 4, text: 'hello chat' }];
    aiService.run = async () => ({ status: 'succeeded', output: { text: 'hello chat', segments: segs, floor: { rule: 'minors', detail: 'this request breaks the hard floor (sexual content involving minors)' } } });
    const w = await ma._aiWindow('https://media.openvibe.live/vods/6501/vod.mp4?sig=SECRET123&exp=9', 300, 300, 'en', { kind: 'vod', id: '6501', userId: null });
    assert.strictEqual(w.ok, true, 'the window is kept');
    assert.deepStrictEqual(w.segments, segs, 'with its words');
    assert.strictEqual(w.floor && w.floor.rule, 'minors', 'and the finding');
    assert.deepStrictEqual(seen, [{ rule: 'minors' }], 'counted by rule');
    assert.strictEqual(logged.length, 1);
    assert.match(logged[0], /\/vods\/6501\/vod\.mp4 at 300 s reads as the floor's minors line/);
    assert.ok(!/SECRET123|hello chat/.test(logged[0]), 'never the signed query or the words');
    let q = await flags.list();
    assert.strictEqual(q.open, 1, 'kept for review');
    assert.deepStrictEqual([q.flags[0].kind, q.flags[0].item_id, q.flags[0].start_sec, q.flags[0].rule, q.flags[0].status, q.flags[0].url],
        ['vod', '6501', 300, 'minors', 'open', '/vod/6501?t=300'], 'the VOD and the second, opened there');
    assert.ok(!/SECRET123|hello chat/.test(JSON.stringify(q)), 'the queue holds neither the words nor the signed query');
    // A retried window is the same flag; a recording nobody named is kept by its path.
    await ma._aiWindow('https://media.openvibe.live/vods/6501/vod.mp4?sig=OTHER&exp=10', 300, 300, 'en', { kind: 'vod', id: '6501' });
    await ma._aiWindow('https://media.openvibe.live/x/7/a.mp4?sig=SECRET9', 0, 300, 'en');
    q = await flags.list();
    assert.strictEqual(q.open, 2, 'one flag a window');
    assert.deepStrictEqual([q.flags[0].kind, q.flags[0].url, q.flags[0].path], ['media', null, '/x/7/a.mp4']);
    assert.ok(!/SECRET9/.test(JSON.stringify(q)));

    aiService.run = async () => ({ status: 'succeeded', output: { text: 'gg', segments: [{ start: 0, end: 1, text: 'gg' }] } });
    const clean = await ma._aiWindow('https://media.openvibe.live/vods/6502/vod.mp4', 0, 300, 'en');
    assert.strictEqual(clean.floor, null);
    assert.strictEqual(seen.length, 3, 'a clean window is not counted');
    assert.strictEqual((await flags.list()).open, 2, 'nor kept');
    console.warn = warn;
    console.log('transcript-floor-flags: a flagged window is kept, counted by rule, logged and queued for staff without its words');
    process.exit(0);
})().catch((e) => { console.warn = warn; console.error(e); process.exit(1); });
