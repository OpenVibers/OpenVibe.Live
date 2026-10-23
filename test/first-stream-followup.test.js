'use strict';
// The first stream's follow-up (server/streaming/first-stream-followup.js): one notification after someone's first
// stream ends (settled for 5 minutes), never twice, never for a second stream or a test under 30 seconds; it links the
// public recording when Media has it, else the after-show report (8 minutes and up), else the channel; it counts the
// signed-in viewers who watched (watch_time, the streamer left out), never peak_viewers. It names up to three people
// who chatted (never one who only watched), links the most-viewed public clip, and carries the recording's thumbnail.
const assert = require('assert');
const db = require('../server/db/database');
const followup = require('../server/streaming/first-stream-followup');

const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

(async () => {
    await db.initDb();
    const NOW = Date.now();
    const mkUser = async (name) => (await db.createUser({ username: name, email: `${name}@x`, password_hash: 'x', display_name: name, stream_key: name.padEnd(32, '0') })).lastInsertRowid
        || (await db.get('SELECT id FROM users WHERE username = ?', [name])).id;
    const mkStream = async (userId, { endedAgoMin, seconds, live = false }) => {
        const ended = NOW - endedAgoMin * 60000;
        const r = await db.run(`INSERT INTO streams (user_id, title, protocol, is_live, started_at, ended_at, duration_seconds) VALUES (?, 't', 'webrtc', ?, ?, ?, ?) RETURNING id`,
            [userId, live ? 1 : 0, sqlTime(ended - seconds * 1000), live ? null : sqlTime(ended), seconds]);
        return Number(r.lastInsertRowid);
    };

    const ana = await mkUser('fs_ana');      // first stream, 6 minutes, recording on Video
    const bo = await mkUser('fs_bo');        // first stream, 20 minutes, no public recording yet: the report
    const cy = await mkUser('fs_cy');        // a 12-second test
    const di = await mkUser('fs_di');        // ended 2 minutes ago: not settled yet
    const ed = await mkUser('fs_ed');        // a second stream: their first was days ago
    const anaStream = await mkStream(ana, { endedAgoMin: 10, seconds: 360 });
    const boStream = await mkStream(bo, { endedAgoMin: 30, seconds: 1200 });
    await mkStream(cy, { endedAgoMin: 15, seconds: 12 });
    await mkStream(di, { endedAgoMin: 2, seconds: 600 });
    await mkStream(ed, { endedAgoMin: 5000, seconds: 900 });
    await mkStream(ed, { endedAgoMin: 20, seconds: 900 });

    // Ana's stream: two signed-in viewers watched, and her own row (watching herself) is not one of them.
    const v1 = await mkUser('fs_v1');
    const v2 = await mkUser('fs_v2');
    for (const u of [v1, v2, ana]) await db.run('INSERT INTO watch_time (user_id, stream_id, minutes_watched) VALUES (?, ?, 3)', [u, anaStream]);
    await db.run('UPDATE streams SET peak_viewers = 40 WHERE id = ?', [boStream]);

    const sent = [];
    const vodFor = async (s) => (s.id === anaStream ? { id: 77, url: 'https://openvibe.video/v/77', thumbnail: 'https://openvibe.media/t/77.jpg' } : null);
    const clipsAsked = [];
    const clipFor = async (s, vodId) => { clipsAsked.push([s.id, vodId]); return s.id === anaStream ? 'https://openvibe.video/c/9' : null; };
    const chattersFor = async (s) => (s.id === anaStream ? ['fs_v1', 'fs_v2'] : []);
    const out = await followup.run({ now: () => NOW, push: (n) => sent.push(n), vodFor, clipFor, chattersFor });
    assert.strictEqual(out.sent, 2, JSON.stringify(sent));
    const byUser = Object.fromEntries(sent.map((n) => [n.user_id, n]));
    assert.deepStrictEqual(Object.keys(byUser).map(Number).sort(), [ana, bo].map(Number).sort());
    assert.strictEqual(byUser[ana].url, 'https://openvibe.video/v/77');
    assert.match(byUser[ana].message, /^6 minutes live, watched by 2 signed-in viewers\. @fs_v1 and @fs_v2 chatted with you\. The recording is on OpenVibe\.Video/);
    assert.match(byUser[ana].message, /A clip of it is up too: openvibe\.video\/c\/9\./);
    assert.deepStrictEqual(byUser[ana].rich_content, { thumbnail: 'https://openvibe.media/t/77.jpg', context: { stream_id: anaStream, vod_url: 'https://openvibe.video/v/77', clip_url: 'https://openvibe.video/c/9' } });
    assert.deepStrictEqual(clipsAsked.find(([id]) => id === anaStream), [anaStream, 77], 'clips are asked by the stream and its recording');
    assert.deepStrictEqual(byUser[bo].rich_content, { thumbnail: null, context: { stream_id: boStream, vod_url: null, clip_url: null } });
    assert.ok(!/chatted|clip of it/.test(byUser[bo].message), 'nobody chatted and no clip: neither is mentioned');
    assert.match(byUser[ana].message, /share openvibe\.live\/@fs_ana before you go live/);
    assert.strictEqual(byUser[bo].url, `https://openvibe.live/recap/${boStream}`, 'no public recording yet: the after-show report');
    assert.strictEqual(byUser[ana].type, 'STREAM_SUMMARY');
    assert.ok(!/viewer/i.test(byUser[bo].message), 'no signed-in viewer watched Bo: nothing said, and peak_viewers (not a person count) is never used');

    // Never twice; the test stream was marked too, so it never comes back either.
    assert.strictEqual((await followup.run({ now: () => NOW, push: (n) => sent.push(n), vodFor, clipFor, chattersFor })).sent, 0);
    assert.ok(await db.getState(followup.stateKey(cy)), 'a test stream is marked, so a later run does not reconsider it');

    // Once settled, the stream that had just ended is notified too.
    // A recording, clip or Chat that fails names nothing and still sends.
    const fail = async () => { throw new Error('down'); };
    const later = await followup.run({ now: () => NOW + 4 * 60000, push: (n) => sent.push(n), vodFor: fail, clipFor: fail, chattersFor: fail });
    assert.strictEqual(later.sent, 1);
    assert.strictEqual(sent[sent.length - 1].user_id, di);

    // Short first stream with no recording: the channel.
    const m = followup.messageFor({ username: 'zed', seconds: 90, vodUrl: null });
    assert.match(m.message, /^2 minutes live\. The recording appears on your channel/);
    assert.match(followup.messageFor({ username: 'zed', seconds: 90, vodUrl: null, watchers: 1 }).message, /^2 minutes live, watched by 1 signed-in viewer\. /);
    assert.deepStrictEqual([['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']].map(followup.names), ['@a', '@a and @b', '@a, @b and @c', '@a, @b, @c and others']);
    // An old stand-in answering the URL alone still links it (no picture).
    const legacy = [];
    const u = await mkUser('fs_fy');
    await mkStream(u, { endedAgoMin: 10, seconds: 120 });
    await followup.run({ now: () => NOW, push: (n) => legacy.push(n), vodFor: async () => 'https://openvibe.video/v/5', clipFor: async () => null, chattersFor: async () => [] });
    assert.strictEqual(legacy[0].url, 'https://openvibe.video/v/5');
    assert.strictEqual(legacy[0].rich_content.thumbnail, null);
    console.log('first-stream follow-up: once, settled, recording/report/channel links, chatters, clip, picture, no test streams');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
