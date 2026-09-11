'use strict';

// Arena v3 (Battle Cam) — pure mic. The roster is whoever has been heard, ratings come from the
// transcripts + the mic ledger, beefs open from name-drops AND from the mic judge's "aimed_at",
// free-standing shit talk lands in the feed and pays Trash Level XP, and chat can only hype.
// Runs end-to-end on a temp DB with no AI configured (heuristic judges, template headlines).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-arena3-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.ARENA_IMAGE_PATH = path.join(tmp, 'arena');

const db = require('../server/db/database');
db.initDb();
const arena = require('../server/arena/arena-service');
const mic = require('../server/arena/mic');
const beef = require('../server/arena/beef');
const listener = require('../server/arena/listener');
const chat = require('../server/arena/arena-chat');

const mk = (username) => Number(db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username[0].toUpperCase() + username.slice(1), stream_key: username.padEnd(32, '0') }).lastInsertRowid);
const u1 = mk('nova'), u2 = mk('grizzly_bear'), u3 = mk('pixelqueen'), quiet = mk('quietguy'), viewer = mk('viewer');
for (const uid of [u1, u2, u3, quiet, viewer]) db.ensureChannel(uid);
// Streams: everyone streamed, but the roster only cares who was HEARD.
const stream = (uid, hours, daysAgo, peak = 500) => {
    const id = Number(db.createStream({ user_id: uid, title: `${uid} stream`, category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 0, started_at = datetime('now', ?), ended_at = datetime('now', ?), duration_seconds = ?, peak_viewers = ? WHERE id = ?`, [`-${daysAgo} days`, `-${daysAgo} days`, Math.round(hours * 3600), peak, id]);
    return id;
};
const s1 = stream(u1, 2, 2), s2 = stream(u2, 2, 1), s3 = stream(u3, 1, 3);
stream(quiet, 40, 1, 9000);   // huge audience, never says a word → NOT on the roster
const speak = (streamId, uid, n, mk) => db.addTimelineEvents(Array.from({ length: n }, (_, i) => ({ stream_id: streamId, user_id: uid, vod_id: null, kind: 'speech', start_sec: i * 30, end_sec: i * 30 + 8, text: mk(i), label: null, confidence: 0.9 })));
speak(s1, u1, 60, i => `Chat listen, this is line ${i}, we are cooking today, nobody can touch this, bet!`);
speak(s2, u2, 30, i => `Okay so line ${i}, let me check the map and farm this boss.`);
speak(s3, u3, 10, i => `Line ${i} hello everyone welcome in.`);

const roster = arena.loadRoster(true);
assert.deepStrictEqual([...roster.order].sort(), [u1, u2, u3].sort(), 'roster = everyone with speech; the silent 9000-viewer streamer is not a fighter');
assert.ok(!roster.byId[quiet], 'audience size buys nothing');
assert.deepStrictEqual(arena.STAT_KEYS, ['heat', 'aim', 'kills', 'mouth', 'clapback', 'stamina', 'pace']);
assert.ok(Math.abs(Object.values(arena.STAT_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9, 'stat weights sum to 1');
const f1 = roster.byId[u1];
assert.ok(f1.raw.mic && f1.raw.mic.window_days === 30 && f1.raw.mic.moments === 0, 'mic stats present, nothing judged yet');
assert.ok(!('peak_viewers' in f1.raw) && !('followers' in f1.raw) && !('messages_per_hour' in f1.raw), 'no audience numbers anywhere in the raw stats');
assert.strictEqual(f1.ratings.stamina, 99, 'the most speech = top STAMINA');
assert.strictEqual(roster.byId[u3].ratings.stamina, 40);
assert.strictEqual(f1.ratings.heat, roster.byId[u3].ratings.heat, 'nobody judged yet → HEAT ties');
console.log('✅ roster + ratings are pure mic');

(async () => {
    // ── Mic ledger: moments pay XP, best line sticks, feed lists newest first ──
    const m1 = mic.addMoment({ userId: u1, streamId: s1, vodId: 501, sec: 40, kind: 'trash', aimedAt: 'chat', text: 'Chat you are all clowns, every one of you, bet', about: 'chat is clowns', quality: 7 });
    assert.ok(m1 && m1.id, 'moment stored');
    assert.strictEqual(mic.addMoment({ userId: u1, kind: 'trash', text: 'kys buddy', quality: 9 }), null, 'threats never land in the feed');
    const lv = mic.levelView(u1);
    assert.strictEqual(lv.xp, Math.round(7 * mic.XP_MOMENT), `trash moment pays quality × ${mic.XP_MOMENT} XP: ${lv.xp}`);
    assert.strictEqual(lv.mic_moments, 1); assert.strictEqual(lv.best_line.text, 'Chat you are all clowns, every one of you, bet');
    mic.addMoment({ userId: u1, streamId: s1, kind: 'trash', aimedAt: 'the mods', text: 'the mods are asleep again, useless', about: 'mods', quality: 5 });
    const feed = mic.feed({ limit: 10 });
    assert.strictEqual(feed.length, 2); assert.strictEqual(feed[0].aimed_at, 'the mods'); assert.strictEqual(feed[1].vod_id, 501);
    assert.strictEqual(feed[0].fighter_name, 'Nova');
    const ms = mic.micStats(u1);
    assert.strictEqual(ms.moments, 2); assert.strictEqual(ms.avg_quality, 6); assert.strictEqual(ms.bangers, 1);
    assert.strictEqual(arena.loadRoster(true).byId[u1].ratings.heat, 99, 'judged moments lift HEAT');
    console.log('✅ mic ledger: moments, XP, best line, feed, stats');

    // ── Beefs: a hit logs into the feed too; clocks flip; forfeit; KILLS ──
    const h1 = beef.recordHit(u1, u2, { quality: 7, best_line: 'Grizzly streams to 12 people and 9 are his alts', about: 'alts', announcer: 'Nova swings first!', stream_id: s1, vod_id: 501, sec: 90 });
    assert.strictEqual(h1.opened, true); assert.strictEqual(h1.beef.on_clock, 'b');
    assert.ok(!('bounty' in h1), 'bounties are gone');
    const fm = mic.feed({ limit: 1 })[0];
    assert.strictEqual(fm.kind, 'beef_hit'); assert.strictEqual(fm.target.user.id, u2); assert.strictEqual(fm.beef_id, h1.beef.id); assert.strictEqual(fm.sec, 90);
    assert.strictEqual(mic.levelView(u1).beef_hits, 1);
    const h2 = beef.recordHit(u2, u1, { quality: 9, best_line: 'Nova needed a bit to get views, I just exist', about: 'clout' });
    assert.strictEqual(h2.first_response, true); assert.strictEqual(h2.beef.on_clock, 'a');
    assert.deepStrictEqual(beef.hype(h1.beef.id, 'a', 'anon:x'), { added: true, hypers: 1, crowd: 1 });
    assert.throws(() => beef.hype(h1.beef.id, 'a', `user:${u1}`), /yourself/);
    db.run(`UPDATE arena_beefs SET clock_until = datetime('now', '-1 minute') WHERE id = ?`, [h1.beef.id]);
    beef.tick();
    const v = beef.get(h1.beef.id);
    assert.strictEqual(v.resolution, 'forfeit'); assert.strictEqual(v.winner_user_id, u2, 'nova went silent on the clock → grizzly wins');
    assert.ok(!('bounty' in v), 'no bounty field on the view');
    assert.deepStrictEqual(beef.recordFor(u2), { wins: 1, losses: 0, draws: 0 });
    const r2 = arena.loadRoster(true);
    assert.strictEqual(r2.byId[u2].ratings.kills, 99, 'a win is a KILL');
    assert.strictEqual(r2.byId[u2].raw.mic.answered, 1, 'answering on the clock counts for CLAPBACK');
    assert.ok(r2.byId[u2].ratings.talk_bonus > 0, 'recent win → mouth bonus');
    console.log('✅ beefs feed the ledger; forfeit; KILLS + CLAPBACK from the mic ledger');

    // ── Heuristic judges (AI off) ──
    const hm = listener._heuristicMic('Chat, listen, all of you are clowns, absolute bums, nobody in this chat could beat me at anything, bet!');
    assert.strictEqual(hm.is_trash_talk, true); assert.ok(hm.quality >= 5, `quality ${hm.quality}`); assert.strictEqual(hm.aimed_at, 'chat');
    assert.strictEqual(listener._heuristicMic('okay so we need to farm this boss and then go to the shop, let me check the map').is_trash_talk, false);
    assert.strictEqual(listener._heuristicBeef('thanks grizzly for the raid, love you', ['grizzly']).aimed_at_target, false);
    console.log('✅ heuristic judges');

    // ── Listener over a live stream: free talk → feed; a name-drop → beef; a callout by nickname → beef ──
    const liveId = Number(db.createStream({ user_id: u3, title: 'live', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 1, started_at = datetime('now', '-600 seconds') WHERE id = ?`, [liveId]);
    const xpBefore = mic.levelView(u3).xp;
    db.addTimelineEvents([
        { stream_id: liveId, user_id: u3, vod_id: null, kind: 'speech', start_sec: 586, end_sec: 590, text: 'Chat, every single one of you is a clown, you bums could never do what I do, nobody in here has a job, bet!', label: null, confidence: 0.9 },
        { stream_id: liveId, user_id: u3, vod_id: null, kind: 'speech', start_sec: 591, end_sec: 596, text: 'Sit down, all of you, absolute losers, I am better than this whole chat combined and everyone knows it!', label: null, confidence: 0.9 },
    ]);
    let ev = await listener.tick();
    assert.ok(ev.some(e => e.kind === 'mic_hit' && e.speakerId === u3), `free shit talk lands in the feed: ${JSON.stringify(ev)}`);
    assert.ok(mic.levelView(u3).xp > xpBefore, 'and pays XP');
    assert.strictEqual(mic.feed({ limit: 1 })[0].user.id, u3);
    const cs = listener.consoleState(u3);
    assert.ok(cs.listening && cs.last_mic_judgement && cs.last_mic_judgement.is_trash_talk && cs.focus === null, 'console shows the mic judgement, no lock');
    assert.strictEqual(arena.liveFighters()[0].user.id, u3);
    assert.ok(arena.liveFighters()[0].last_moment && arena.liveFighters()[0].last_moment.aimed_at === 'chat', 'live cam carries the last judged line');
    // Name-drop → focus lock → beef.
    db.run(`UPDATE streams SET started_at = datetime('now', '-700 seconds') WHERE id = ?`, [liveId]);
    db.addTimelineEvents([
        { stream_id: liveId, user_id: u3, vod_id: null, kind: 'speech', start_sec: 686, end_sec: 690, text: 'And grizzly bear? Grizzly bear is trash, washed, a fraud, he could never beat me, he is scared of the smoke, bet!', label: null, confidence: 0.9 },
        { stream_id: liveId, user_id: u3, vod_id: null, kind: 'speech', start_sec: 691, end_sec: 696, text: 'Nobody watches that stream, it is mid, it is garbage, I would cook him in a second!', label: null, confidence: 0.9 },
    ]);
    listener._state.get(liveId).lastJudgeAt = 0;
    ev = await listener.tick();
    assert.ok(ev.some(e => e.kind === 'beef_hit' && e.targetId === u2 && e.opened), `name-drop opened the beef: ${JSON.stringify(ev)}`);
    assert.ok(listener.consoleState(u3).focus && listener.consoleState(u3).focus.target_id === u2, 'locked on grizzly');
    assert.strictEqual(beef.openBeefsFor(u3).length, 1);
    assert.strictEqual(arena.liveFighters()[0].ears.focus.target_id, u2, 'live cam shows the lock');
    // Drop the lock (two off-target chunks), then a callout WITHOUT the name in the speech but with the judge's aimed_at.
    for (let k = 0; k < 2; k++) {
        db.run(`UPDATE streams SET started_at = datetime('now', ?) WHERE id = ?`, [`-${800 + k * 100} seconds`, liveId]);
        db.addTimelineEvents([{ stream_id: liveId, user_id: u3, vod_id: null, kind: 'speech', start_sec: 786 + k * 100, end_sec: 792 + k * 100, text: 'Okay chat back to the game, we need to farm this boss and then do the quest line for the sword upgrade, let me check the map real quick.', label: null, confidence: 0.9 }]);
        listener._state.get(liveId).lastJudgeAt = 0;
        await listener.tick();
    }
    assert.strictEqual(listener.consoleState(u3).focus, null, 'moved on → lock dropped');
    console.log('✅ listener: free talk → feed + XP; name-drop → lock → beef; lets go when they move on');

    // ── Persona fallback + fighter card are mic-shaped ──
    const card = await arena.getFighter('nova');
    assert.ok(card.mic && card.mic.moments >= 2 && card.level.level >= 1 && Array.isArray(card.beefs));
    assert.ok(!('active_topic' in card), 'no topics');
    assert.ok(['Rushdown', 'Sniper', 'Assassin', 'Caster', 'Counter', 'Tank', 'Zoner'].includes(card.persona.class), `fallback class from the mic stats: ${card.persona.class}`);
    assert.deepStrictEqual(Object.keys(card.persona.stat_quips).sort(), [...arena.STAT_KEYS].sort());
    const detail = arena.getStatDetail(u1, 'heat');
    assert.strictEqual(detail.unit, 'avg judge score'); assert.ok(detail.series.length >= 1);
    assert.strictEqual(arena.getStatDetail(u1, 'hype'), null, 'audience stats do not exist');
    const lb = mic.levelsLeaderboard(5);
    assert.ok(lb.length >= 2 && lb[0].xp >= lb[1].xp);
    console.log('✅ fighter card, stat detail, ladder');

    // ── Chat: hype only ──
    const sent = [], room = [];
    const fakeChat = { sendTo: (ws, m) => sent.push(m.message), broadcastToStream: (sid, m) => room.push(m.message) };
    const run = async (client, line) => { const parts = line.split(' '); const handled = chat.handle(fakeChat, {}, client, parts[0], parts); await new Promise(r => setTimeout(r, 30)); return handled; };
    assert.strictEqual(await run({ user: { id: viewer, username: 'viewer' }, streamId: liveId, ip: '1.1.1.1' }, '!topic anything'), false, '!topic no longer exists');
    assert.strictEqual(await run({ anonId: 'b1', streamId: liveId }, '!bounty nova'), false, '!bounty no longer exists');
    assert.strictEqual(await run({ anonId: 'b2', streamId: liveId }, '!board'), false, '!board no longer exists');
    await run({ user: { id: viewer, username: 'viewer', display_name: 'Viewer' }, streamId: liveId, ip: '1.1.1.1' }, '!hype');
    assert.ok(sent.pop().includes('Hyped'), 'hype goes to the streamer\'s open beef');
    await run({ anonId: 'zz', streamId: liveId }, '!beef');
    assert.ok(sent.pop().includes('on the clock'));
    console.log('✅ chat: !hype / !beef only');

    // ── Backfill: past speech on ended streams gets judged into the feed (heuristic judges, no AI) ──
    const backfill = require('../server/arena/backfill');
    const old = Number(db.createStream({ user_id: u2, title: 'yesterday', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 0, started_at = datetime('now', '-1 day'), ended_at = datetime('now', '-23 hours'), duration_seconds = 3600 WHERE id = ?`, [old]);
    db.addTimelineEvents([
        { stream_id: old, user_id: u2, vod_id: 777, kind: 'speech', start_sec: 100, end_sec: 106, text: 'Chat, all of you are clowns, absolute bums, nobody in this chat could beat me at anything, sit down losers, bet!', label: null, confidence: 0.9 },
        { stream_id: old, user_id: u2, vod_id: 777, kind: 'speech', start_sec: 107, end_sec: 112, text: 'Pathetic, every single one of you is washed and delusional, I am better than this entire chat!', label: null, confidence: 0.9 },
        { stream_id: old, user_id: u2, vod_id: 777, kind: 'speech', start_sec: 400, end_sec: 406, text: 'Okay so we go to the shop, buy the potions, then head to the cave and farm the boss for the sword, let me check the map for the route.', label: null, confidence: 0.9 },
        { stream_id: old, user_id: u2, vod_id: 777, kind: 'speech', start_sec: 407, end_sec: 412, text: 'Yeah the cave is north of the village past the bridge, should take about ten minutes if we do not get lost again.', label: null, confidence: 0.9 },
    ]);
    const feedBefore = mic.feed({ limit: 100 }).length;
    const bfr = await backfill.run({ force: true });
    assert.ok(bfr.moments >= 1, `backfill judged old speech into the feed: ${JSON.stringify(bfr)}`);
    assert.ok(bfr.skipped >= 1, 'gameplay chunk never cost a judge call');
    const fromOld = mic.feed({ limit: 100 }).filter(m => m.stream_id === old);
    assert.ok(fromOld.length >= 1 && fromOld[0].vod_id === 777 && fromOld[0].aimed_at === 'chat', `moment carries VOD + target: ${JSON.stringify(fromOld[0])}`);
    assert.ok(fromOld[0].at && Date.now() - Date.parse(fromOld[0].at.replace(' ', 'T') + 'Z') > 20 * 3600 * 1000, 'moment is dated when it was SAID, not when it was judged');
    assert.ok(mic.feed({ limit: 100 }).length >= feedBefore + fromOld.length, 'other fighters\' spicy past lines were judged too');
    const again = await backfill.run({ force: true });
    assert.strictEqual(again.judged, 0, 'cursor: nothing re-judged on the second run');
    assert.deepStrictEqual(await backfill.run({ force: true }), await backfill.run({ force: true }));
    console.log('✅ backfill: past speech judged once, VOD-linked, dated when said');

    // ── Public API smoke ──
    const express = require('express');
    const app = express(); app.use(express.json()); app.use('/api/arena', require('../server/arena/routes'));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const get = async (p) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/arena${p}`); const txt = await res.text(); let body = null; try { body = JSON.parse(txt); } catch { body = null; } return { status: res.status, body }; };
    const fd = await get('/feed?limit=5'); assert.strictEqual(fd.status, 200); assert.ok(fd.body.feed.length >= 3 && fd.body.feed[0].text);
    assert.strictEqual((await get('/backfill')).status, 404, 'backfill is POST + admin only');
    const fi = await get('/fighters'); assert.deepStrictEqual(fi.body.stats, arena.STAT_KEYS); assert.ok(fi.body.fighters.every(f => f.mic && typeof f.mic.avg_quality === 'number'));
    const bf = await get('/beefs'); assert.strictEqual(bf.body.open.length, 1); assert.strictEqual(bf.body.resolved.length, 1);
    const con = await get('/console/pixelqueen'); assert.strictEqual(con.body.listener.listening, true); assert.ok(con.body.recent_moments.length >= 1 && con.body.mic);
    const lv2 = await get('/live'); assert.strictEqual(lv2.body.live[0].open_beefs, 1);
    const st = await get('/status'); assert.strictEqual(st.body.mode, 'battle-cam'); assert.ok(!('topics_open' in st.body));
    assert.strictEqual((await get('/board')).status, 404, 'the board is gone');
    assert.strictEqual((await get('/yappers')).status, 404, 'yappers are gone');
    assert.strictEqual((await get('/fighters/quietguy')).body.not_on_roster, true);
    srv.close();
    console.log('✅ public API');

    console.log('\n✅ All Arena (Battle Cam) tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
