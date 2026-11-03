'use strict';
// A sound the stream hears all evening is its background, not a moment (item 151, C08 follow-up). In production
// (2026-11-03) "Explosion" and "Gunshot, gunfire" at 0.6 or more ran into the thousands across 200+ streams while
// laughter was rare, so a shooter's every explosion counted as "a strong sound" for the clip score. clip-score.rareSounds
// keeps the labels heard at most 12 times an hour in the stream; the VOD picker and the live score use only those.
const assert = require('assert');
const db = require('../server/db/database');
console.warn = () => {};

(async () => {
    const clipScore = require('../server/ai/clip-score');
    const boom = (t) => ({ label: 'Explosion', confidence: 0.8, start_sec: t });
    const laugh = (t) => ({ label: 'Laughter', confidence: 0.8, start_sec: t });

    // ── Pure ──
    const evening = [...Array.from({ length: 60 }, (_, i) => boom(i * 120)), laugh(3000)];
    assert.deepStrictEqual(clipScore.rareSounds(evening, 7200).map((e) => e.label), ['Laughter'], '60 explosions in two hours are the game, one laugh is news');
    assert.strictEqual(clipScore.rareSounds([boom(10), boom(20), boom(30)], 7200).length, 3, 'three in two hours are rare');
    assert.strictEqual(clipScore.rareSounds([boom(10), boom(20), boom(30), boom(40)], 120).length, 0, 'a short span counts as a quarter hour: four is 16 an hour');
    assert.deepStrictEqual(clipScore.rareSounds(null, 100), []);

    // ── The VOD picker (AI off): the laugh is the moment, the explosions are not ──
    await db.initDb();
    const chatReads = require('../server/chat/chat-reads');
    const media = require('../server/media-client');
    const ai = require('../server/ai/ai-analysis');
    const moments = require('../server/ai/ai-moments-job');
    await require('../server/ai/moment-registry')._clear();
    await db.run(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
                  VALUES (31, 'rosa', 'rosa', 'rosa@x', 'x', 'streamer', '2025-01-01 00:00:00') ON CONFLICT DO NOTHING`);
    const sid = (await db.get(`INSERT INTO streams (user_id, title, started_at, ended_at) VALUES (31, 'shooter night', '2026-11-01 10:00:00', '2026-11-01 12:00:00') RETURNING id`)).id;
    ai.isEnabled = async () => false;
    db.getStreamMemories = async () => [{ offset_seconds: 3000, description: 'The streamer laughs at a teammate falling off a ledge' }, { offset_seconds: 600, description: 'A firefight on a bridge' }];
    db.getStreamTranscriptSegments = async () => [{ start: 2995, end: 3004, text: 'no way he just walked off the bridge oh my god' }];
    db.getTimeline = async () => evening;
    chatReads.spikeOffsets = async () => [];
    chatReads.streamStats = async () => ({ messages: 0 });
    media.listClips = async () => ({ clips: [] });
    const v = { vod_id: 701, stream_id: sid, duration: 7200, title: 'Shooter night' };
    const m = await moments.findBestMoment(v, { flavor: 'clip' });
    assert.ok(m, 'a clip moment is found');
    assert.strictEqual(m.offset, 3000, 'the laugh, not the first explosion');
    assert.strictEqual(m.evidence.picked_by, 'sound');
    assert.deepStrictEqual(m.evidence.sounds.map((e) => e.label), ['Laughter'], 'the explosions nearby are not evidence');

    db.getTimeline = async () => evening.filter((e) => e.label === 'Explosion');
    assert.strictEqual(await moments.findBestMoment(v, { flavor: 'clip' }), null, 'a stream of nothing but its background gives no clip');

    console.log('rare sounds: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
