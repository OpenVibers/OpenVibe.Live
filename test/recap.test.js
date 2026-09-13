'use strict';
// After-show report (server/recap/recap.js) on a temp DB with AI off → template write-up.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-recap-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const db = require('../server/db/database'); db.initDb();
const recap = require('../server/recap/recap');
try { require('../server/arena/mic').ensureTables(); } catch { /* mic table optional */ }

const mk = (username) => Number(db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username[0].toUpperCase() + username.slice(1), stream_key: username.padEnd(32, '0') }).lastInsertRowid);
const host = mk('hostess'), fan = mk('fan1'), fan2 = mk('fan2');
const ts = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString().replace('T', ' ').slice(0, 19);
db.run("INSERT INTO streams (user_id, title, category, protocol, is_live, started_at, ended_at, duration_seconds, peak_viewers) VALUES (?,?,?,?,0,?,?,?,?)", [host, 'Late night tinkering', 'irl', 'webrtc', ts(70), ts(10), 3600, 9]);
const sid = db.get('SELECT id FROM streams ORDER BY id DESC LIMIT 1').id;
for (let i = 0; i < 12; i++) db.run('INSERT INTO viewer_snapshots (stream_id, viewer_count, chat_messages_5m, recorded_at) VALUES (?,?,?,?)', [sid, 2 + Math.round(7 * Math.sin(i / 11 * Math.PI)), i === 6 ? 14 : 3, ts(70 - i * 5)]);
for (let i = 0; i < 9; i++) db.run("INSERT INTO chat_messages (stream_id, user_id, username, message, timestamp) VALUES (?,?,?,?,?)", [sid, fan, 'fan1', `msg ${i}`, ts(60 - i)]);
for (let i = 0; i < 4; i++) db.run("INSERT INTO chat_messages (stream_id, user_id, username, message, timestamp) VALUES (?,?,?,?,?)", [sid, fan2, 'fan2', `yo ${i}`, ts(50 - i)]);
db.run("INSERT INTO chat_messages (stream_id, user_id, username, message, timestamp) VALUES (?,?,?,?,?)", [sid, host, 'hostess', 'hi chat', ts(55)]);
db.run("INSERT INTO follows (follower_id, streamer_id, created_at) VALUES (?,?,?)", [fan2, host, ts(30)]);
db.run("INSERT INTO arena_mic_moments (user_id, stream_id, kind, text, about, quality, announcer, sec, said_at) VALUES (?,?,?,?,?,?,?,?,?)", [host, sid, 'trash', 'my soldering iron has more rizz than your whole setup', 'setup', 8, '', 1200, ts(40)]);
db.run("INSERT INTO transactions (from_user_id, to_user_id, stream_id, amount, type, status) VALUES (?,?,?,?,?,?)", [fan, host, sid, 5, 'donation', 'completed']);
// Too-short stream: no report from the job.
db.run("INSERT INTO streams (user_id, title, category, protocol, is_live, started_at, ended_at, duration_seconds, peak_viewers) VALUES (?,?,?,?,0,?,?,?,?)", [host, 'oops', 'irl', 'webrtc', ts(9), ts(5), 240, 1]);

(async () => {
    const pend = recap.pending().map(r => r.id);
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
    assert.strictEqual(r.love.tips, 1); assert.strictEqual(r.love.tips_total, 5);
    assert.strictEqual(r.mic.length, 1);
    assert.strictEqual(r.viewers.curve.length, 12);
    assert.ok(r.chat.busiest_n === 14, 'busiest 5-min window from snapshots');
    assert.ok(['S', 'A', 'B', 'C'].includes(r.write.grade));
    assert.ok(/hostess/i.test(r.write.headline) || /Hostess/.test(r.write.summary));
    // Stored + listed + no longer pending.
    assert.ok(recap.getRecap(sid).write.headline === r.write.headline);
    assert.strictEqual(recap.listRecaps(host).length, 1);
    assert.deepStrictEqual(recap.pending(), []);
    // Live streams never get one.
    db.run('UPDATE streams SET is_live = 1, ended_at = NULL WHERE id = ?', [sid]);
    assert.strictEqual(await recap.gather(sid), null);
    console.log('recap: OK');
})().catch(e => { console.error(e); process.exit(1); });
