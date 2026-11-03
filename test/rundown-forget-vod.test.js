'use strict';
/**
 * Deleting a VOD takes what the Rundown made from it (server/rundown/desk.js forgetVod, called by
 * server/media-proxy/purge.js afterDelete on every delete path): its segments and their reactions, the episode of the
 * stream they fed, and the page of each topic they were filed under (recounted, cleared to be written again). Another
 * VOD's segments, and the stream's reading progress, stay.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/rundown-forget-vod.test.js
 */
const assert = require('assert');
const db = require('../server/db/database');

(async () => {
    await db.initDb();
    const desk = require('../server/rundown/desk');
    const purge = require('../server/media-proxy/purge');

    await db.createUser({ username: 'forgetme', email: 'forgetme@x', password_hash: 'x', display_name: 'forgetme', stream_key: 'forgetme'.padEnd(32, '0') });
    const uid = (await db.get('SELECT id FROM users WHERE username = ?', ['forgetme'])).id;
    await db.ensureChannel(uid);
    const sid = Number((await db.createStream({ user_id: uid, title: 'Two parts', category: 'Just Chatting', protocol: 'rtmp' })).lastInsertRowid);
    const other = Number((await db.createStream({ user_id: uid, title: 'Another day', category: 'Just Chatting', protocol: 'rtmp' })).lastInsertRowid);
    const topic = (await db.get(`INSERT INTO rundown_topics (slug, title, headline, summary, summary_takes, summary_at, takes, streamers, first_seen_at, last_seen_at)
        VALUES ('fridges', 'Fridges', 'Fridges, again', 'Everyone is talking fridges', 3, ov_now(), 3, 1, ov_now(), ov_now()) RETURNING id`)).id;
    const seg = async (stream, vod, title) => (await db.get(`INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, vod_id, said_at)
        VALUES (?, ?, ?, 10, 60, ?, 'what was said', ?, ov_now()) RETURNING id`, [stream, uid, topic, title, vod])).id;
    const gone1 = await seg(sid, 900, 'Fridge hack');
    const gone2 = await seg(sid, 900, 'Fridge passwords');
    const kept = await seg(other, 901, 'Fridges are fine');
    await db.run(`INSERT INTO rundown_episodes (stream_id, user_id, title, logline, recap, chapters_json, vod_id, minutes, aired_at) VALUES (?, ?, 'Two parts', 'fridges', 'recap', '[]', 900, 60, ov_now())`, [sid, uid]);
    await db.run(`INSERT INTO rundown_episodes (stream_id, user_id, title, logline, recap, chapters_json, vod_id, minutes, aired_at) VALUES (?, ?, 'Another day', 'fine', 'recap', '[]', 901, 30, ov_now())`, [other, uid]);
    await db.run("INSERT INTO rundown_reactions (item_type, item_id, voter, reaction) VALUES ('segment', ?, 'v1', 'up'), ('segment', ?, 'v1', 'up'), ('episode', ?, 'v1', 'up'), ('episode', ?, 'v1', 'up')", [gone1, kept, sid, other]);
    await db.run('INSERT INTO rundown_progress (stream_id, read_to) VALUES (?, 3600) ON CONFLICT DO NOTHING', [sid]).catch(() => {});

    // Deleting VOD 900 through the one hook every delete path calls.
    await purge.afterDelete('vod', 900);

    const ids = (await db.all('SELECT id FROM rundown_segments WHERE topic_id = ? ORDER BY id', [topic])).map((r) => Number(r.id));
    assert.deepStrictEqual(ids, [Number(kept)], 'the deleted VOD\'s segments are gone; another VOD\'s stay');
    assert.ok(!await db.get('SELECT 1 FROM rundown_episodes WHERE stream_id = ?', [sid]), 'the episode they fed is gone');
    assert.ok(await db.get('SELECT 1 FROM rundown_episodes WHERE stream_id = ?', [other]), 'another stream\'s episode stays');
    const reactions = await db.all('SELECT item_type, item_id FROM rundown_reactions ORDER BY item_type, item_id');
    assert.deepStrictEqual(reactions.map((r) => `${r.item_type}:${Number(r.item_id)}`).sort(), [`episode:${other}`, `segment:${kept}`].sort(), 'only the surviving items keep their reactions');
    const t = await db.get('SELECT takes, streamers, headline, summary, summary_takes, summary_at FROM rundown_topics WHERE id = ?', [topic]);
    assert.deepStrictEqual([Number(t.takes), Number(t.streamers)], [1, 1], 'the topic is recounted');
    assert.deepStrictEqual([t.headline, t.summary, Number(t.summary_takes), t.summary_at], [null, null, 0, null], 'its page, written from takes that are gone, is cleared');
    assert.ok(!gone2 || !await db.get('SELECT 1 FROM rundown_segments WHERE id = ?', [gone2]));

    // A VOD the Rundown never used, a clip, and a bad id change nothing.
    assert.deepStrictEqual(await desk.forgetVod(12345), { segments: 0, episodes: 0, topics: 0 });
    assert.deepStrictEqual(await desk.forgetVod('x'), { segments: 0, episodes: 0, topics: 0 });
    await purge.afterDelete('clip', 901);
    assert.ok(await db.get('SELECT 1 FROM rundown_segments WHERE id = ?', [kept]), 'deleting a clip leaves the Rundown alone');

    console.log('rundown forget vod: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
