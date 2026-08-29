'use strict';

// Trash Talk: topics are per-slot and deterministic without AI, entries are judged
// (heuristic without AI, slurs void), the crowd score comes from unique hypes, the
// POWER bonus decays, and chat commands reply through the ChatServer API.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-talk-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.ARENA_IMAGE_PATH = path.join(tmp, 'arena');
const db = require('../server/db/database');
db.initDb();
const arena = require('../server/arena/arena-service');
const talk = require('../server/arena/trash-talk');
const chat = require('../server/arena/arena-chat');

// ── pure bits ──
assert.strictEqual(talk.currentSlot(Date.UTC(2026, 7, 29, 13, 5)), '2026-08-29/2', '13:05 UTC is slot 2 of 6-hour slots');
assert.strictEqual(talk.currentSlot(Date.UTC(2026, 7, 29, 23, 59)), '2026-08-29/3');
assert.strictEqual(talk._crowdScore(0), 0);
assert.strictEqual(talk._crowdScore(3), 1);
assert.strictEqual(talk._crowdScore(90), 10, 'crowd caps at 10');
assert.strictEqual(talk._stampFor(45), 'COOKED');
assert.strictEqual(talk._stampFor(31), 'SOLID');
assert.strictEqual(talk._stampFor(5), 'FLOP');
assert.strictEqual(talk._totalFor({ spice: 8, wit: 7, on_topic: 9, delivery: 6 }, 9), 33, 'total = 4 judge scores + crowd');
assert.strictEqual(talk._totalFor({ spice: 8, wit: 7, on_topic: 9, delivery: 6, flagged: true }, 30), 0, 'flagged entries score 0');
const h = talk._heuristicJudge('Chat, your chat is smarter than this whole arena, bet!', 'Explain why your chat is the smartest chat on this site.');
assert.ok(h.spice >= 3 && h.on_topic >= 4 && !h.flagged, JSON.stringify(h));
console.log('✅ slots, crowd score, stamps, totals, heuristic judge');

// ── roster ──
const mk = (u, key) => Number(db.createUser({ username: u, email: `${u}@x`, password_hash: 'x', display_name: u.toUpperCase(), stream_key: key }).lastInsertRowid);
const u1 = mk('alpha', 'a'.repeat(32)), u2 = mk('bravo', 'b'.repeat(32)), viewer = mk('fan', 'c'.repeat(32));
for (const uid of [u1, u2, viewer]) db.ensureChannel(uid);
const stream = (uid, peak, hours, daysAgo) => {
    const id = Number(db.createStream({ user_id: uid, title: 't', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 0, started_at = datetime('now', ?), ended_at = datetime('now', ?), duration_seconds = ?, peak_viewers = ? WHERE id = ?`, [`-${daysAgo} days`, `-${daysAgo} days`, Math.round(hours * 3600), peak, id]);
    return id;
};
stream(u1, 50, 4, 1); stream(u2, 40, 4, 2);

(async () => {
    const t1 = await talk.getTopic({ generate: false });
    const t2 = await talk.getTopic({ generate: false });
    assert.strictEqual(t1.id, t2.id, 'one topic per slot');
    assert.ok(t1.topic.length > 10 && t1.ends_at, 'templated topic without AI');
    console.log('✅ topic per slot');

    const b0 = await talk.board({ userId: viewer, generate: false });
    assert.strictEqual(b0.on_roster, false, 'a viewer is not on the roster');
    assert.strictEqual(b0.can_enter, false);
    await assert.rejects(() => talk.submit(viewer, { mode: 'text', text: 'I am the best and everyone knows it, chat.' }), /roster/);
    await assert.rejects(() => talk.submit(u1, { mode: 'text', text: 'short' }), /more than that/);
    await assert.rejects(() => talk.submit(u1, { mode: 'mic', text: '' }), /live-mic session/);
    console.log('✅ entry gating');

    const e1 = await talk.submit(u1, { mode: 'text', text: 'My chat solves my bugs before I finish typing them. Your chat is still loading, champ!' });
    assert.strictEqual(e1.source, 'text');
    assert.ok(e1.total > 0 && e1.scores && e1.stamp, JSON.stringify(e1));
    assert.strictEqual(e1.flagged, false);
    await assert.rejects(() => talk.submit(u1, { mode: 'text', text: 'Trying to enter the same topic twice should fail.' }), /already entered/);
    const bad = await talk.submit(u2, { mode: 'text', text: 'Your chat is full of retards and you know it, loser.' });
    assert.strictEqual(bad.flagged, true, 'slur → void');
    assert.strictEqual(bad.total, 0);
    console.log('✅ judged entries; slurs void');

    const before = talk.hype(e1.id, 'user:999');
    assert.strictEqual(before.added, true);
    assert.strictEqual(talk.hype(e1.id, 'user:999').added, false, 'one hype per person');
    for (let i = 0; i < 5; i++) talk.hype(e1.id, `anon:${i}`);
    const after = talk.hype(e1.id, 'user:1000');
    assert.strictEqual(after.crowd_uniques, 7);
    assert.ok(Math.abs(after.crowd - 2.3) < 0.01, `crowd 7/3 → ${after.crowd}`);
    assert.strictEqual(after.total, e1.total + after.crowd);
    assert.throws(() => talk.hype(e1.id, `user:${u1}`), /yourself/);
    assert.throws(() => talk.hype(bad.id, 'user:5'), /void/);
    console.log('✅ crowd hype');

    const board = await talk.board({ userId: u1, generate: false });
    assert.strictEqual(board.entries.length, 2);
    assert.strictEqual(board.entries[0].user.username, 'alpha', 'ranked by total');
    assert.strictEqual(board.entries[1].text, null, 'a flagged entry hides its text from others');
    assert.strictEqual(board.my_entry.id, e1.id);
    assert.strictEqual(board.can_enter, false, 'already entered');
    assert.ok(board.hall_of_trash.length === 1 && board.hall_of_trash[0].topic, 'hall lists non-flagged entries with their topic');
    const ownBad = await talk.board({ userId: u2, generate: false });
    assert.ok(ownBad.my_entry.text && ownBad.my_entry.note, 'the author still sees their voided text + note');
    console.log('✅ board');

    const bonuses = talk.talkBonuses();
    assert.ok(bonuses[u1] >= 1 && bonuses[u1] <= talk.TALK_BONUS_MAX, `bonus ${bonuses[u1]}`);
    assert.strictEqual(bonuses[u2], undefined, 'flagged entry gives no bonus');
    const roster = arena.loadRoster(true);
    assert.strictEqual(roster.byId[u1].ratings.talk_bonus, bonuses[u1]);
    assert.strictEqual(roster.byId[u1].ratings.power, roster.byId[u1].ratings.base_power + bonuses[u1], 'bonus is added to POWER');
    assert.strictEqual(roster.byId[u2].ratings.talk_bonus, 0);
    const card = await arena.getFighter('alpha', { generate: false });
    assert.strictEqual(card.trash_talk.length, 1);
    console.log('✅ POWER bonus');

    // ── chat commands (fake ChatServer) ──
    const sent = [], broadcast = [];
    const fakeChat = { sendTo: (ws, m) => sent.push(m.message), broadcastToStream: (sid, m) => broadcast.push(m.message) };
    const live = Number(db.createStream({ user_id: u1, title: 'live', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run('UPDATE streams SET is_live = 1 WHERE id = ?', [live]);
    const client = (user, anonId = null) => ({ user, anonId, streamId: live, ip: '1.2.3.4' });
    assert.strictEqual(chat.handle(fakeChat, {}, client(null, 'anonA'), '!sr', ['!sr']), false, 'unrelated commands fall through');
    assert.strictEqual(chat.handle(fakeChat, {}, client(null, 'anonA'), '!hype', ['!hype']), true);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(/Hyped!|already hyped/.test(sent[sent.length - 1]), sent[sent.length - 1]);
    chat.handle(fakeChat, {}, client(null, 'anonB'), '!talk', ['!talk']);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(/Trash Talk topic/.test(sent[sent.length - 1]));
    chat.handle(fakeChat, {}, client(db.getUserById(viewer)), '!arena', ['!arena']);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(/PWR/.test(sent[sent.length - 1]), sent[sent.length - 1]);
    chat.handle(fakeChat, {}, client(null, 'anonC'), '!vote', ['!vote', 'a']);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(/Sign in/.test(sent[sent.length - 1]));
    chat.handle(fakeChat, {}, client(null, 'anonD'), '!fight', ['!fight', 'bravo']);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(/called out/.test(broadcast[broadcast.length - 1]), 'fight is announced to the room');
    chat.handle(fakeChat, {}, client(null, 'anonD'), '!talk', ['!talk']);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(/Easy/.test(sent[sent.length - 1]), 'rate limited per person');
    console.log('✅ chat commands');

    console.log('\n✅ All Trash Talk tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
