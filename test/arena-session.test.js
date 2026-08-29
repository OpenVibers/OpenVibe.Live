'use strict';

// Live trash-talk sessions: start needs a live stream with transcription, the ticker
// judges new transcript chunks against the current topic, progress clears topics and
// generates the next one, XP levels up, hype adds XP/progress, and the session ends when
// the stream ends. No AI configured → heuristic chunk judge, templated topics.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-session-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.ARENA_IMAGE_PATH = path.join(tmp, 'arena');
const db = require('../server/db/database');
db.initDb();
const arena = require('../server/arena/arena-service');
const sessions = require('../server/arena/talk-session');

const mk = (u, key) => Number(db.createUser({ username: u, email: `${u}@x`, password_hash: 'x', display_name: u.toUpperCase(), stream_key: key }).lastInsertRowid);
const u1 = mk('alpha', 'a'.repeat(32));
db.ensureChannel(u1);
const old = Number(db.createStream({ user_id: u1, title: 'old', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
db.run(`UPDATE streams SET is_live = 0, started_at = datetime('now', '-2 days'), ended_at = datetime('now', '-2 days'), duration_seconds = 3600, peak_viewers = 20 WHERE id = ?`, [old]);

assert.strictEqual(sessions._levelFor(0), 1);
assert.strictEqual(sessions._levelFor(39), 1);
assert.strictEqual(sessions._levelFor(40), 2);
assert.strictEqual(sessions._levelFor(125), 4);
const hc = sessions._heuristicChunk("Chat, your chat couldn't read a menu. I'm the smartest streamer on this whole site, bet!", { topic: 'Explain why your chat is the smartest chat on this site.', hint: '', tone: 'brag' });
assert.strictEqual(hc.is_trash_talk, true);
assert.ok(hc.progress_gain > 10 && hc.best_line.length > 5, JSON.stringify(hc));
const quiet = sessions._heuristicChunk('okay let me open the inventory and craft the pickaxe then we go mining', { topic: 'Explain why your chat is the smartest chat on this site.', hint: '', tone: 'brag' });
assert.ok(quiet.progress_gain <= 15, 'gameplay chatter barely moves the topic');
console.log('✅ levels + heuristic chunk judge');

(async () => {
    await assert.rejects(() => sessions.startSession(u1), /Go live/, 'needs a live stream');
    const live = Number(db.createStream({ user_id: u1, title: 'live', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 1, started_at = datetime('now', '-10 minutes') WHERE id = ?`, [live]);
    await assert.rejects(() => sessions.startSession(u1), /transcription/, 'needs transcript rows');
    db.addTimelineEvents([{ stream_id: live, user_id: u1, vod_id: 77, kind: 'speech', start_sec: 500, end_sec: 505, text: 'welcome in chat, we are live', label: null, confidence: 0.9 }]);

    const s = await sessions.startSession(u1);
    assert.strictEqual(s.status, 'live');
    const again = await sessions.startSession(u1);
    assert.strictEqual(again.id, s.id, 'one live session per user');
    let v = sessions.viewFor('alpha');
    assert.ok(v.session.active_topic && v.session.active_topic.topic, 'a first topic is set');
    assert.strictEqual(v.session.level, 1);
    assert.strictEqual(v.session.active_topic.progress, 0);
    console.log('✅ session start + first topic');

    // Feed trash talk in the transcript AFTER the session offset and tick.
    const off = 600 + 5; // session started ~600s into the stream
    const trash = [
        "Chat, your chat couldn't read a menu. I'm the smartest streamer on this whole site, bet!",
        'Nobody on this ladder is scared of nothing except me, champ. Come see who is better.',
        "You call that a stream? Best believe my chat is smarter, faster, and prettier than yours!",
    ];
    db.addTimelineEvents(trash.map((t, i) => ({ stream_id: live, user_id: u1, vod_id: 77, kind: 'speech', start_sec: off + i * 10, end_sec: off + i * 10 + 8, text: t, label: null, confidence: 0.9 })));
    await sessions.tick();
    v = sessions.viewFor('alpha');
    const t1 = v.session.active_topic;
    assert.ok(t1.chunks >= 1, 'a chunk was judged');
    assert.ok(t1.progress > 0 && t1.progress <= 100, `progress ${t1.progress}`);
    assert.ok(v.session.xp > 0, 'xp earned');
    assert.ok(v.session.recent_lines.length >= 3, 'live lines visible');
    assert.ok(v.session.talked_about.length >= 1, 'talked-about tags');
    assert.ok(t1.best_line && t1.best_vod_id === 77 && typeof t1.best_line_sec === 'number', 'best line links to the VOD');
    console.log('✅ tick judges new speech against the topic');

    // Hype from two viewers, self-hype blocked.
    const h1 = sessions.hypeSession(u1, 'user:50');
    assert.strictEqual(h1.added, true);
    assert.strictEqual(sessions.hypeSession(u1, 'user:50').added, false);
    sessions.hypeSession(u1, 'anon:abc');
    assert.throws(() => sessions.hypeSession(u1, `user:${u1}`), /yourself/);
    v = sessions.viewFor('alpha');
    assert.strictEqual(v.session.active_topic.hypers, 2);
    console.log('✅ hype adds XP + progress');

    // Keep talking (bypass the 30 s judge interval by rewinding last_judge_at) until the topic clears.
    let cleared = 0;
    for (let round = 0; round < 8 && !cleared; round++) {
        db.run(`UPDATE arena_talk_sessions SET last_judge_at = datetime('now', '-2 minutes') WHERE id = ?`, [s.id]);
        db.addTimelineEvents(trash.map((t, i) => ({ stream_id: live, user_id: u1, vod_id: 77, kind: 'speech', start_sec: off + 100 + round * 40 + i * 10, end_sec: off + 100 + round * 40 + i * 10 + 8, text: t + ` (${round})`, label: null, confidence: 0.9 })));
        await sessions.tick();
        cleared = sessions.viewFor('alpha').session.topics_cleared;
    }
    v = sessions.viewFor('alpha');
    assert.strictEqual(v.session.topics_cleared, 1, 'talking enough clears the topic');
    assert.strictEqual(v.session.cleared_topics.length, 1);
    assert.strictEqual(v.session.cleared_topics[0].status, 'cleared');
    assert.ok(v.session.active_topic && v.session.active_topic.idx === 1, 'a new topic replaces it');
    assert.notStrictEqual(v.session.active_topic.topic, v.session.cleared_topics[0].topic, 'the new topic differs');
    const entry = db.get(`SELECT * FROM arena_talk WHERE user_id = ? AND source = 'session'`, [u1]);
    assert.ok(entry && entry.total > 0, 'a cleared topic becomes a Trash Talk entry');
    assert.ok(arena.loadRoster(true).byId[u1].ratings.talk_bonus >= 1, 'and feeds the POWER bonus');
    console.log('✅ topic clears → next topic + entry + bonus');

    const skipped = await sessions.skipTopic(u1);
    assert.strictEqual(skipped.idx, 2);
    assert.strictEqual(sessions.viewFor('alpha').session.cleared_topics.filter(t => t.status === 'skipped').length, 1);
    assert.ok(sessions.liveSessionSummaries().length === 1 && sessions.liveSessionSummaries()[0].user.username === 'alpha');
    console.log('✅ skip + live list');

    db.run('UPDATE streams SET is_live = 0 WHERE id = ?', [live]);
    await sessions.tick();
    v = sessions.viewFor('alpha');
    assert.strictEqual(v.session.status, 'ended');
    assert.strictEqual(v.session.end_reason, 'stream_ended');
    assert.strictEqual(sessions.liveSessionFor(u1), null);
    assert.throws(() => sessions.stopSession(u1), /No live session/);
    console.log('✅ session ends with the stream');

    console.log('\n✅ All session tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
