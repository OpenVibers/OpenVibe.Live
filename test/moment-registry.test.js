'use strict';
// The paste job and the clip job share ONE registry of used moments, so they can never pick the
// same second or the same scene of a VOD (the "same title on the clip and the paste" bug).
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-registry-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const db = require('../server/db/database'); db.initDb();
const reg = require('../server/ai/moment-registry');

// Legacy logs are imported once so history is not lost on upgrade.
db.setState('auto_clip_log', JSON.stringify([{ stream_id: 5, vod_id: 900, start_time: 100, title: 'Old clip', sig: 'old clip scene', ts: Date.now() - 3600_000 }]));
db.setState('home_hero_moments', JSON.stringify({ moments: [{ vodId: 901, offset: 300, title: 'Orange Shirt Shocked in aisle' }], usedSigs: ['a person wearing an orange'], updated_at: Date.now() - 7200_000 }));
reg._reset();
assert.ok(reg.isUsed({ vod_id: 900, offset: 116 }), 'legacy clip (start + pre-roll) blocks the spot');
assert.ok(reg.isUsed({ vod_id: 901, offset: 330 }), 'legacy paste blocks within the gap');
assert.ok(reg.isUsed({ desc: 'A person wearing an orange shirt is shown leaning' }), 'legacy scene signature blocks the same scene');
assert.ok(!reg.isUsed({ vod_id: 901, offset: 900, desc: 'A dog steals the mic' }), 'far away + new scene is free');
assert.deepStrictEqual(reg.usedOffsets(901), [300]);
console.log('✅ legacy logs imported');

reg.record({ kind: 'paste', vod_id: 42, stream_id: 7, offset: 1000, title: 'Depth Estimation tease', desc: 'The video appears to be a live streaming session with a chat overlay' });
assert.strictEqual(reg.usedReason({ vod_id: 42, offset: 1050 }), 'paste already made at 1000s of this VOD', 'same VOD within 2 min is blocked');
assert.ok(/same scene as a recent paste/.test(reg.usedReason({ vod_id: 43, offset: 5, desc: 'the video appears to be a live streaming session with music' })), 'same opening words = same scene, even on another VOD');
assert.strictEqual(reg.usedReason({ vod_id: 42, offset: 1300, desc: 'A robot arm knocks over the coffee' }), null, '≥ 2 min away with a different scene is fine');
assert.ok(reg.isUsed({ stream_id: 7, offset: 1010 }), 'live streams are matched by stream id too');
reg.record({ kind: 'clip', vod_id: 42, stream_id: 7, offset: 1300, title: 'Robot arm vs coffee' });
assert.deepStrictEqual(reg.usedOffsets(42), [1000, 1300]);
assert.strictEqual(reg.lastOfKind('paste', { stream_id: 7 }).offset, 1000);
assert.strictEqual(reg.lastOfKind('clip', { vod_id: 42 }).title, 'Robot arm vs coffee');
assert.ok(reg.recent(1).length >= 2);
reg._reset();
assert.ok(reg.isUsed({ vod_id: 42, offset: 1290 }), 'persisted across a cache reset');
console.log('✅ shared paste/clip registry: spots, scenes, persistence');

const ai = require('../server/ai/ai-analysis');
assert.deepStrictEqual(['gaming', 'Just Chatting', 'coding', 'nonsense', ''].map(ai.normalizeCategory), ['gaming', 'irl', 'desktop', null, null]);
console.log('✅ category taxonomy normalisation');
console.log('\n✅ All moment-registry tests passed');
process.exit(0);
