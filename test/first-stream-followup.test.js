'use strict';
// The first stream's follow-up (server/streaming/first-stream-followup.js): one notification after someone's first
// stream ends (settled for 5 minutes), never twice, never for a second stream or a test under 30 seconds; it links the
// public recording when Media has it, else the after-show report (8 minutes and up), else the channel.
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

    const sent = [];
    const vodFor = async (s) => (s.id === anaStream ? 'https://openvibe.video/v/77' : null);
    const out = await followup.run({ now: () => NOW, push: (n) => sent.push(n), vodFor });
    assert.strictEqual(out.sent, 2, JSON.stringify(sent));
    const byUser = Object.fromEntries(sent.map((n) => [n.user_id, n]));
    assert.deepStrictEqual(Object.keys(byUser).map(Number).sort(), [ana, bo].map(Number).sort());
    assert.strictEqual(byUser[ana].url, 'https://openvibe.video/v/77');
    assert.match(byUser[ana].message, /^6 minutes live\. The recording is on OpenVibe\.Video/);
    assert.match(byUser[ana].message, /share openvibe\.live\/@fs_ana before you go live/);
    assert.strictEqual(byUser[bo].url, `https://openvibe.live/recap/${boStream}`, 'no public recording yet: the after-show report');
    assert.strictEqual(byUser[ana].type, 'STREAM_SUMMARY');
    assert.ok(!/viewer/i.test(sent.map((n) => n.message).join(' ')), 'no viewer counts (peak_viewers is not a person count)');

    // Never twice; the test stream was marked too, so it never comes back either.
    assert.strictEqual((await followup.run({ now: () => NOW, push: (n) => sent.push(n), vodFor })).sent, 0);
    assert.ok(await db.getState(followup.stateKey(cy)), 'a test stream is marked, so a later run does not reconsider it');

    // Once settled, the stream that had just ended is notified too.
    const later = await followup.run({ now: () => NOW + 4 * 60000, push: (n) => sent.push(n), vodFor });
    assert.strictEqual(later.sent, 1);
    assert.strictEqual(sent[sent.length - 1].user_id, di);

    // Short first stream with no recording: the channel.
    const m = followup.messageFor({ username: 'zed', seconds: 90, vodUrl: null });
    assert.match(m.message, /^2 minutes live\. The recording appears on your channel/);
    console.log('first-stream follow-up: once, settled, recording/report/channel links, no test streams');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
