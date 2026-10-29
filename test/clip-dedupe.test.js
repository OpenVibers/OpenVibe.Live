/**
 * Content dedupe for moments (owner, 2026-10-29): repeats were getting clipped over and over.
 * The old registry compared the first five ASCII words, so paraphrases slipped through and
 * Japanese became an empty signature. clip-dedupe.js keeps Unicode and compares token sets,
 * and the live cutter now asks the shared registry BEFORE cutting.
 *
 *   node test/clip-dedupe.test.js
 */
'use strict';
const assert = require('assert');
const db = require('../server/db/database');
(async () => {
await db.initDb();
const dedupe = require('../server/ai/clip-dedupe');
const registry = require('../server/ai/moment-registry');
const media = require('../server/media-client');
const autoClip = require('../server/ai/auto-clip-job');

// ── Text identity ──────────────────────────────────────────
assert.strictEqual(dedupe.normalize('びっくり！？'), dedupe.normalize('びっくり'), 'Unicode punctuation is dropped, not the text');
assert.ok(dedupe.shortSignature('配信者が大きな声で叫ぶ').length > 0, 'Japanese produces a signature instead of an empty one');
assert.ok(dedupe.isSameScene('A player is fighting a boss in a dark cave', 'The player is fighting a boss in a dark cave'), 're-worded description is the same scene');
assert.ok(!dedupe.isSameScene('A player is fighting a boss in a dark cave', 'A player is fighting a boss in a bright castle'), 'same topic with a different scene is not blocked');
assert.ok(dedupe.isSameScene('配信者が大きな声で叫ぶ', '配信者が大きな声で叫んだ'), 'Japanese near-duplicate matches');
assert.ok(!dedupe.isSameScene('配信者が静かにゲームをする', '猫がテーブルの上で寝ている'), 'unrelated Japanese is not blocked');
assert.ok(dedupe.isSameSpeech('today we are playing a horror game and it is terrifying', 'today we are playing a horror game and it is very scary'), 'near-duplicate speech matches');
assert.ok(!dedupe.isSameSpeech('today we are playing a horror game', 'we just beat the final boss on the first try'), 'a different conversation is not the same speech');
assert.ok(dedupe.similarity(dedupe.tokens('we are going to play the game now'), dedupe.tokens('now we are going to play the game')) >= 0.8, 're-ordered speech still clears the 0.8 Dice bar');
assert.ok(!dedupe.isSameSpeech('the red car explodes', 'the red car is parked'), 'a below-0.8 token overlap is not the same speech');
assert.ok(!dedupe.isSameScene('The video appears to be a live streaming session with a chat overlay', 'The video appears to be a live streaming session with music'), 'shared boilerplate alone is not the same scene');
assert.ok(!dedupe.isSameSpeech('this is a live stream', 'this is a live chat'), 'shared boilerplate alone is not the same speech');
assert.ok(dedupe.isSameEmbedding([1, 0, 0], [0.99, 0.01, 0]), 'near-identical frame embeddings match');
assert.ok(!dedupe.isSameEmbedding([1, 0, 0], [0, 1, 0]), 'different frame embeddings do not');
console.log('✅ clip-dedupe: Unicode, paraphrases, 0.8 Dice, boilerplate and embedding negatives');

// ── The shared registry ────────────────────────────────────
await db.setState('ai_used_moments', '[]');
registry._reset();
await registry.record({
    kind: 'paste', vod_id: 30, stream_id: 5, offset: 100,
    desc: 'A person sits at a desk in front of a microphone',
    speech: 'today we are playing a horror game and it is terrifying',
});
assert.strictEqual(await registry.usedReason({
    vod_id: 31, offset: 5, desc: 'A person sits at a desk in front of a microphone',
    speech: 'we just beat the final boss on the first try',
}), null, 'static webcam + a NEW conversation is not a repeat');
assert.ok(await registry.usedReason({
    vod_id: 31, offset: 5, desc: 'A person sits at a desk in front of a microphone',
    speech: 'today we are playing a horror game and it is very scary',
}), 'static webcam + the SAME conversation is a repeat');

await registry.record({ kind: 'clip', vod_id: 40, stream_id: 6, offset: 200, desc: 'A red car explodes on the highway' });
assert.ok(await registry.usedReason({ vod_id: 41, offset: 10, desc: 'The red car explodes on the highway' }), 'a silent re-upload is caught by the visual description');

await registry.record({ kind: 'clip', vod_id: 50, stream_id: 7, offset: 300, desc: '配信者が大きな声で叫ぶ瞬間' });
assert.ok(await registry.usedReason({ vod_id: 51, offset: 10, desc: '配信者が大きな声で叫んだ瞬間' }), 'Japanese description is preserved across VODs');

await registry.record({ kind: 'clip', vod_id: 52, stream_id: 8, offset: 400, desc: 'A person sits at a desk', embedding: [1, 0, 0] });
assert.ok(await registry.usedReason({ vod_id: 53, offset: 10, desc: 'A completely different caption', embedding: [0.99, 0.01, 0] }), 'a matching frame embedding blocks even a different description');
assert.strictEqual(await registry.usedReason({ vod_id: 54, offset: 10, desc: 'A completely different caption', embedding: [0, 1, 0] }), null, 'a different frame embedding is free');
console.log('✅ registry: new speech is free, repeats, silent re-uploads and frame embeddings are blocked');

// ── The live cutter asks the registry before spending a clip ──
const created = [];
media.createClip = async (body) => { created.push(body); return { id: 900 + created.length }; };
const recorder = require('../server/streaming/recorder');
recorder.getActiveRecording = () => ({ vodId: 60, startedAt: Date.now() - 100_000 });
const chatReads = require('../server/chat/chat-reads');
chatReads.liveChatBuckets = async () => [
    { count: 1, tsEpoch: Math.floor(Date.now() / 1000) },
    { count: 1 }, { count: 10, tsEpoch: Math.floor(Date.now() / 1000) }, { count: 1 },
];
chatReads.recentChatText = async () => [];
const ai = require('../server/ai/ai-analysis');
ai.isEnabled = () => true;
ai.withinBudget = () => true;
require('../server/ai/ai-service').structured = async () => ({ clip: true, title: 'A moment', desc: 'A person sits at a desk in front of a microphone' });
db.isStreamClipRecordingEnabled = () => true;
await db.setState('auto_clip_log', '[]');

const liveStream = { id: 5, user_id: 3, started_at: new Date(Date.now() - 2 * 3600_000).toISOString().replace('T', ' ').slice(0, 19), title: 'Alice live' };
await registry.record({ kind: 'paste', vod_id: 60, stream_id: 5, offset: 100, desc: 'A person sits at a desk' });
await autoClip._internals.checkLiveStream(liveStream);
assert.strictEqual(created.length, 0, 'the live path never cuts a moment the registry already used');

registry._reset();
await db.setState('ai_used_moments', '[]');
registry._reset();
await autoClip._internals.checkLiveStream(liveStream);
assert.strictEqual(created.length, 1, 'a free moment is still cut (the check does not block everything)');
console.log('✅ live cutter: registry rejection happens before Media.createClip');

registry._reset();
console.log('\n✅ All clip-dedupe tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
