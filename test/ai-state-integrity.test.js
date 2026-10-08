/** AI state, memory uniqueness, and timeline adoption on the migrated schema. */
'use strict';
const assert = require('assert');
const db = require('../server/db/database');

(async () => {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (1, 'ai-owner', 'x')");
    await db.run('INSERT INTO streams (id, user_id) OVERRIDING SYSTEM VALUE VALUES (900, 1), (901, 1), (902, 1)');

    const transcript = JSON.stringify([{ start: 0, end: 2, text: 'the full transcript' }]);
    await db.run(`INSERT INTO vod_ai_state (vod_id, ai_transcript_json, transcript_status, transcript_attempts)
        VALUES (100, ?, 'done', 1)`, [transcript]);
    await db.run(`UPDATE vod_ai_state SET ai_overview_short = 'the overview', transcript_attempts = 2 WHERE vod_id = 100`);
    await db.run('INSERT INTO vod_ai_state (vod_id) VALUES (101) ON CONFLICT DO NOTHING');
    for (let i = 0; i < 4; i++) await db.run('INSERT INTO vod_ai_state (vod_id) VALUES (101) ON CONFLICT DO NOTHING');
    await db.run(`INSERT INTO clip_ai_state (clip_id, ai_overview_short, clip_notified, clip_notify_at)
        VALUES (200, 'clip overview', 1, '1234')`);
    await db.run('INSERT INTO clip_ai_state (clip_id) VALUES (200) ON CONFLICT DO NOTHING');

    const count = async (sql) => (await db.get(sql)).n;
    assert.strictEqual(await count('SELECT COUNT(*) n FROM vod_ai_state'), 2);
    assert.strictEqual(await count('SELECT COUNT(*) n FROM clip_ai_state'), 1);
    const v100 = await db.getVodAiState(100);
    assert.ok(v100.ai_transcript_json.includes('the full transcript'));
    assert.strictEqual(v100.ai_overview_short, 'the overview');
    assert.strictEqual(v100.transcript_status, 'done');
    console.log('OK 1: transcript, overview and settled status coexist on the unique state row');

    const clip = await db.get('SELECT * FROM clip_ai_state WHERE clip_id = 200');
    assert.strictEqual(clip.clip_notified, 1);
    assert.strictEqual(clip.clip_notify_at, '1234');
    assert.strictEqual(clip.ai_overview_short, 'clip overview');
    console.log('OK 2: clip-specific columns survive repeated seeds');

    const queue = (await db.getVodsNeedingOverview(4)).map(r => r.id);
    assert.strictEqual(queue.length, new Set(queue).size, `overview queue still returns duplicates: ${queue}`);
    assert.ok(queue.includes(101));
    assert.ok(!queue.includes(100));
    console.log('OK 3: overview queue returns distinct VODs');

    for (let i = 0; i < 5; i++) await db.setVodTranscriptStatus(100, 'pending');
    assert.strictEqual(await count('SELECT COUNT(*) n FROM vod_ai_state WHERE vod_id = 100'), 1);
    assert.ok((await db.getVodAiState(100)).ai_transcript_json.includes('the full transcript'));
    console.log('OK 4: re-seeds leave one row and preserve its transcript');

    await db.addStreamMemory({ stream_id: 900, offset_seconds: 15, description: 'a red figure by a brick building' });
    await db.addStreamMemory({ stream_id: 900, offset_seconds: 15, description: 'a red horse statue by a brick building' });
    await db.addStreamMemory({ stream_id: 900, offset_seconds: 23, description: 'a different moment' });
    assert.strictEqual(await count('SELECT COUNT(*) n FROM stream_memories WHERE stream_id = 900'), 2);
    console.log('OK 5: duplicate moments rejected, distinct moments kept');

    const spoken = (arr) => arr.reduce((n, x) => n + String(x.text || '').trim().length, 0);
    const choose = (timeline, blob) => (spoken(blob) > spoken(timeline) ? blob : timeline);
    const partialTimeline = [{ start: 0, text: 'x'.repeat(426) }];
    const fullBlob = [{ start: 0, text: 'y'.repeat(3548) }];
    assert.strictEqual(spoken(choose(partialTimeline, fullBlob)), 3548);
    assert.strictEqual(spoken(choose(fullBlob, partialTimeline)), 3548);
    assert.strictEqual(spoken(choose([], [])), 0);
    console.log('OK 6: fuller transcript source wins');

    await db.addTimelineEvents([
        { stream_id: 901, kind: 'speech', start_sec: 1, end_sec: 2, text: 'live speech', vod_id: 500 },
        { stream_id: 901, kind: 'sound', start_sec: 3, end_sec: 4, label: 'laughter', vod_id: 500 },
    ]);
    assert.strictEqual((await db.getTimelineByVod(500)).length, 2);
    assert.strictEqual(await db.getTimelineVodId(901), 500);
    await db.addTimelineEvents([{ stream_id: 902, kind: 'speech', start_sec: 1, text: 'orphan' }]);
    assert.strictEqual((await db.getTimelineByVod(501)).length, 0);
    await db.linkTimelineToVod(902, 501);
    assert.strictEqual((await db.getTimelineByVod(501)).length, 1);
    console.log('OK 7: live timeline rows reachable; orphans adoptable');

    await db.addTimelineEvents([
        { stream_id: 902, kind: 'speech', start_sec: 90, text: 'transcribed after vod.ready' },
        { stream_id: 902, kind: 'speech', start_sec: 120, text: 'and later still' },
    ]);
    assert.strictEqual((await db.getTimelineByVod(501)).length, 1);
    await db.adoptOrphanedTimelineRows();
    assert.strictEqual((await db.getTimelineByVod(501)).length, 3);
    await db.addTimelineEvents([{ stream_id: 900, kind: 'speech', start_sec: 5, text: 'never recorded' }]);
    await db.adoptOrphanedTimelineRows();
    assert.strictEqual(await count('SELECT COUNT(*) n FROM stream_timeline_events WHERE stream_id = 900 AND vod_id IS NULL'), 1);
    console.log('OK 8: late rows adopted; VOD-less streams left alone');
    console.log('✅ AI state integrity regression test passed');
})().catch((e) => { console.error(e); process.exit(1); });
