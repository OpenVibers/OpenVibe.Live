'use strict';
// After-show report (server/recap/recap.js) with AI off → template write-up.
const assert = require('assert');
const db = require('../server/db/database');
const recap = require('../server/recap/recap');
const ts = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString().replace('T', ' ').slice(0, 19);

(async () => {
    await db.initDb();
    const mk = async (username) => Number((await db.run('INSERT INTO users (username, email, password_hash, display_name, stream_key) VALUES (?, NULL, ?, ?, ?) RETURNING id',
        [username, 'x', username[0].toUpperCase() + username.slice(1), username.padEnd(32, '0')])).lastInsertRowid);
    const host = await mk('hostess'), fan = await mk('fan1'), fan2 = await mk('fan2');
    const sid = (await db.run("INSERT INTO streams (user_id, title, category, protocol, is_live, started_at, ended_at, duration_seconds, peak_viewers) VALUES (?,?,?,?,0,?,?,?,?) RETURNING id", [host, 'Late night tinkering', 'irl', 'webrtc', ts(70), ts(10), 3600, 9])).lastInsertRowid;
    for (let i = 0; i < 12; i++) await db.run('INSERT INTO viewer_snapshots (stream_id, viewer_count, chat_messages_5m, recorded_at) VALUES (?,?,?,?)', [sid, 2 + Math.round(7 * Math.sin(i / 11 * Math.PI)), i === 6 ? 14 : 3, ts(70 - i * 5)]);
    // Chat owns chat history now. Stub its stats and top chatter answers.
    const chatReads = require('../server/chat/chat-reads');
    chatReads.streamStats = async () => ({ messages: 14, chatters: 3, sounds: 0 });
    chatReads.topChatters = async () => [{ username: 'fan1', display_name: 'Fan1', count: 9 }, { username: 'fan2', display_name: 'Fan2', count: 4 }];
    await db.run('INSERT INTO follows (follower_id, streamer_id, created_at) VALUES (?,?,?)', [fan2, host, ts(30)]);
    // The Rundown's takes on the stream: the best quoted one leads; a hidden one is never shown.
    const topic = (await db.run("INSERT INTO rundown_topics (slug, title, kind, first_seen_at, last_seen_at) VALUES ('soldering-irons', 'Soldering irons', 'tech', ?, ?) RETURNING id", [ts(40), ts(40)])).lastInsertRowid;
    await db.run('INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, score, quotes_json, vod_id, said_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [sid, host, topic, 1190, 1260, 'The iron with rizz', 'hostess rated their soldering iron.', 4, JSON.stringify([{ text: 'my soldering iron has more rizz than your whole setup', sec: 1200, en: null }]), 77, ts(40)]);
    await db.run("INSERT INTO rundown_segments (stream_id, user_id, start_sec, end_sec, title, what, score, said_at, status) VALUES (?,?,?,?,?,?,?,?,'hidden')", [sid, host, 10, 20, 'Taken down', 'x', 5, ts(60)]);
    await require('../server/monetization/channel-tips').record({ toUserId: host, fromUserId: fan, streamId: sid, amount: 5, source: 'vibes', ref: 'live-txn:1' });
    await require('../server/monetization/channel-tips').record({ toUserId: host, username: 'pcfan', streamId: sid, amount: 3, source: 'powerchat', ref: 'powerchat:evt_1' });
    await db.run("INSERT INTO streams (user_id, title, category, protocol, is_live, started_at, ended_at, duration_seconds, peak_viewers) VALUES (?,?,?,?,0,?,?,?,?)", [host, 'oops', 'irl', 'webrtc', ts(9), ts(5), 240, 1]);
    const pend = (await recap.pending()).map(r => r.id);
    assert.deepStrictEqual(pend, [sid], 'only the long-enough, settled stream is pending');
    const r = await recap.buildRecap(sid);
    assert.ok(r && r.write && r.write.headline, 'has a write-up');
    assert.strictEqual(r.ai, false, 'AI off → template');
    assert.strictEqual(r.stream.peak_viewers, 9);
    assert.strictEqual(r.chat.messages, 14);
    assert.strictEqual(r.chat.chatters, 3);
    assert.strictEqual(r.chat.top[0].username, 'fan1', 'host excluded from top chatters, fan1 leads');
    assert.strictEqual(r.chat.top[0].n, 9);
    assert.strictEqual(r.love.follows, 1);
    assert.strictEqual(r.love.tips, 2); assert.strictEqual(r.love.tips_total, 8, 'on-site and PowerChat tips both count');
    assert.deepStrictEqual(r.love.top_tipper, { username: 'fan1', display_name: 'Fan1', total: 5 });
    assert.deepStrictEqual(r.takes, [{ title: 'The iron with rizz', text: 'my soldering iron has more rizz than your whole setup', en: null, sec: 1200, vod_id: 77, topic: 'Soldering irons', slug: 'soldering-irons' }], 'the Rundown\'s takes, never a hidden one');
    assert.deepStrictEqual(r.mic, [], 'the Arena\'s mic lines are gone (kept empty for the previous release\'s open tabs)');
    assert.ok(r.write.tags.includes('on the Rundown'));
    assert.strictEqual(r.viewers.curve.length, 12);
    assert.ok(r.chat.busiest_n === 14, 'busiest 5-min window from snapshots');
    assert.ok(['S', 'A', 'B', 'C'].includes(r.write.grade));
    assert.ok(/hostess/i.test(r.write.headline) || /Hostess/.test(r.write.summary));
    // Stored + listed + no longer pending.
    assert.ok((await recap.getRecap(sid)).write.headline === r.write.headline);
    assert.strictEqual((await recap.listRecaps(host)).length, 1);
    assert.deepStrictEqual(await recap.pending(), []);
    // Live streams never get one.
    await db.run('UPDATE streams SET is_live = 1, ended_at = NULL WHERE id = ?', [sid]);
    assert.strictEqual(await recap.gather(sid), null);
    console.log('recap: OK');
})().catch(e => { console.error(e); process.exit(1); });
