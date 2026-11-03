'use strict';
// The AI's used moments are durable (item 151, C06; migration 0024): nothing falls out at 800 entries, the old JSON
// list in app_state moves in once, the same-recording check finds a moment among thousands, and rows go after 90 days.
const assert = require('assert');
const db = require('../server/db/database');
(async () => {
    await db.initDb();
    const reg = require('../server/ai/moment-registry');

    // The old list moves in once: a row per entry, then the state is not read again.
    await db.run('DELETE FROM ai_moments');
    await db.setState('ai_moments_moved', '');
    await db.setState('ai_used_moments', JSON.stringify([
        { kind: 'clip', vod_id: 5001, stream_id: 77, offset: 600, sig: 'cat walks keyboard', title: 'Cat on keys', ts: Date.now() - 3600_000 },
        { kind: 'paste', vod_id: 5002, offset: 60, sig: 'big win screen', title: 'Big win', ts: Date.now() - 7200_000 },
    ]));
    reg._reset();
    assert.ok(await reg.isUsed({ vod_id: 5001, offset: 650 }), 'a moved entry blocks its spot');
    assert.strictEqual(Number((await db.get('SELECT count(*)::int AS n FROM ai_moments')).n), 2);
    await db.setState('ai_used_moments', JSON.stringify([{ kind: 'clip', vod_id: 9999, offset: 1, ts: Date.now() }]));
    reg._reset();
    assert.ok(!await reg.isUsed({ vod_id: 9999, offset: 1 }), 'moved once: the list is not read again');

    // Nothing falls out at 800: the first of 900 moments still blocks its spot.
    await reg._clear();
    await reg.record({ kind: 'clip', vod_id: 1, offset: 100, title: 'The first one' });
    for (let i = 0; i < 900; i++) await reg.record({ kind: 'clip', vod_id: 1000 + i, offset: 100, title: `Moment ${i} of a long week` });
    assert.match(await reg.usedReason({ vod_id: 1, offset: 150 }), /^clip already made at 100s of this VOD$/);
    assert.ok(!await reg.isUsed({ vod_id: 1, offset: 400 }), 'two minutes away is free');
    assert.match(await reg.usedReason({ stream_id: null, vod_id: 1500, offset: 30 }) || '', /already made at 100s/);
    assert.deepStrictEqual(await reg.usedOffsets(1), [100]);
    assert.strictEqual((await reg.lastOfKind('clip', { vod_id: 1 })).title, 'The first one');

    // Rows past 90 days no longer block, and are pruned.
    await db.run("UPDATE ai_moments SET created_at = now() - interval '91 days' WHERE vod_id = '1'");
    assert.ok(!await reg.isUsed({ vod_id: 1, offset: 120 }), 'past 90 days it is free');
    console.log('moment registry durable: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
