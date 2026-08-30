'use strict';

// Arena v2 — beefs + the board + the listener + chat commands, end-to-end on a temp DB with no AI
// configured (template headlines, fallback angles, heuristic judges — no LLM calls).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-arena2-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.ARENA_IMAGE_PATH = path.join(tmp, 'arena');

const db = require('../server/db/database');
db.initDb();
const arena = require('../server/arena/arena-service');
const board = require('../server/arena/board');
const beef = require('../server/arena/beef');
const listener = require('../server/arena/listener');
const chat = require('../server/arena/arena-chat');

const mk = (username) => Number(db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username[0].toUpperCase() + username.slice(1), stream_key: username.padEnd(32, '0') }).lastInsertRowid);
const u1 = mk('nova'), u2 = mk('grizzly_bear'), u3 = mk('pixelqueen'), viewer = mk('viewer');
for (const uid of [u1, u2, u3, viewer]) db.ensureChannel(uid);
const stream = (uid, peak, hours, daysAgo) => {
    const id = Number(db.createStream({ user_id: uid, title: `${uid} stream`, category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 0, started_at = datetime('now', ?), ended_at = datetime('now', ?), duration_seconds = ?, peak_viewers = ? WHERE id = ?`, [`-${daysAgo} days`, `-${daysAgo} days`, Math.round(hours * 3600), peak, id]);
    db.run(`INSERT INTO stream_analytics (stream_id, avg_viewers, peak_viewers, unique_chatters, total_messages, total_watch_minutes, new_followers, clips_created, coins_earned) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`, [id, peak / 2, peak, peak, peak * 20, peak * 60, Math.round(hours)]);
    return id;
};
stream(u1, 120, 6, 2); stream(u2, 60, 5, 1); stream(u3, 20, 2, 3);
const roster = arena.loadRoster(true);
assert.deepStrictEqual(roster.order, [u1, u2, u3], 'roster by power');
board.ensureTables(); beef.ensureTables();

(async () => {
    // ── Board: topics from chat, fallback angles, one active topic per streamer ──
    const t1 = board.createTopic({ text: 'Streamers who read donations in a baby voice', createdBy: 'chat', creatorUserId: viewer, creatorName: 'Viewer' });
    assert.strictEqual(t1.kind, 'topic');
    assert.throws(() => board.createTopic({ text: 'streamers who read donations in a baby voice', createdBy: 'chat' }), /already on the board/);
    assert.throws(() => board.createTopic({ text: 'ok', createdBy: 'chat' }), /short|characters|topic/i);
    const angles = await board.ensureAngles(t1);
    assert.strictEqual(angles.length, 3, 'fallback angles without AI');
    await assert.rejects(board.joinTopic(t1.id, viewer), /roster/, 'viewers cannot talk on a topic');
    const j = await board.joinTopic(t1.id, u1);
    assert.strictEqual(j.topic.id, t1.id);
    assert.strictEqual(board.activeTopicFor(u1).id, t1.id);
    const t2 = board.createTopic({ text: 'Whose chat is the dumbest chat on the site', createdBy: 'streamer', creatorUserId: u2, creatorName: 'Grizzly' });
    await board.joinTopic(t2.id, u1);
    assert.strictEqual(board.activeTopicFor(u1).id, t2.id, 'joining another topic switches the active one');
    await board.joinTopic(t1.id, u1);

    // Judged chunks: progress → angle cleared (+25) → all angles → conquered (+60).
    const fresh = () => db.get('SELECT * FROM arena_topics WHERE id = ?', [t1.id]);
    let r = board.applyTopicJudgement(u1, fresh(), { angle_idx: 0, quality: 6, progress_gain: 60, best_line: 'Your baby voice sounds like a fax machine', about: 'baby voice' }, { vod_id: null, sec: 10 });
    assert.deepStrictEqual([r.applied, r.progress, r.cleared_angle], [true, 60, false]);
    assert.strictEqual(board.applyTopicJudgement(u1, fresh(), { angle_idx: -1, quality: 0, progress_gain: 0 }).applied, false, 'off-topic chunk does nothing');
    assert.strictEqual(board.applyTopicJudgement(u1, fresh(), { angle_idx: 0, quality: 9, progress_gain: 50, flagged: true }).applied, false, 'flagged chunk (threat/minor/dox) is ignored');
    r = board.applyTopicJudgement(u1, fresh(), { angle_idx: 0, quality: 8, progress_gain: 50, best_line: 'Read my dono in your real voice, coward', about: 'dono voice' }, { vod_id: null, sec: 40 });
    assert.ok(r.cleared_angle && r.progress === 100 && !r.conquered);
    assert.ok(r.xp >= board.XP_ANGLE_CLEARED, `angle clear pays: ${r.xp}`);
    for (const idx of [1, 2]) r = board.applyTopicJudgement(u1, fresh(), { angle_idx: idx, quality: 7, progress_gain: 60, best_line: `line ${idx}`, about: 'x' }, {});
    for (const idx of [1, 2]) r = board.applyTopicJudgement(u1, fresh(), { angle_idx: idx, quality: 7, progress_gain: 60, best_line: `line ${idx}b`, about: 'x' }, {});
    assert.strictEqual(r.conquered, true, 'all angles cleared → topic conquered');
    assert.strictEqual(board.activeTopicFor(u1), null, 'conquering ends the active topic');
    const lv = board.levelView(u1);
    assert.ok(lv.xp >= board.XP_ANGLE_CLEARED * 3 + board.XP_TOPIC_CONQUERED, `xp accrued: ${lv.xp}`);
    assert.strictEqual(lv.level, board.levelFor(lv.xp));
    assert.ok(lv.level >= 3, `Trash Level climbed: ${lv.level}`);
    assert.strictEqual(lv.angles_cleared, 3); assert.strictEqual(lv.topics_conquered, 1);
    assert.strictEqual(lv.best_line.text, 'Read my dono in your real voice, coward', 'best line is the highest-quality one');
    const detail = board.topicDetail(t1.id);
    assert.strictEqual(detail.conquered, 1); assert.strictEqual(detail.members[0].cleared, 3);
    assert.ok(detail.best_lines.length >= 1 && detail.progress[u1].every(p => p.cleared));
    console.log('✅ board topics: angles, progress, clears, conquest, Trash Level');

    // Hype + heat.
    assert.throws(() => board.hypeTopic(t2.id, u2, `user:${u2}`), /yourself/);
    await board.joinTopic(t2.id, u2);
    assert.deepStrictEqual(board.hypeTopic(t2.id, u2, 'anon:abc'), { added: true, hypers: 1 });
    assert.deepStrictEqual(board.hypeTopic(t2.id, u2, 'anon:abc'), { added: false, hypers: 1 }, 'one hype per person');
    assert.ok(board.computeHeat(t2.id) >= 5, 'talking + hype makes heat');
    const view = board.boardView();
    assert.strictEqual(view.open[0].id, t1.id, 'hottest topic first (7 judged hits in the last hour beat 1 talker + 1 hype)');
    assert.ok(view.open[0].heat > view.open[1].heat && view.open[0].hot, `heat sorted: ${view.open.map(t => t.heat)}`);
    assert.ok(view.open.find(t => t.id === t2.id).talking_now.some(f => f.user.id === u2));
    console.log('✅ hype + heat ordering');

    // Debate: sides from chat + talk, resolves at expiry, clout for right picks.
    const d = board.createTopic({ text: 'Face cam or no face cam', createdBy: 'ai', kind: 'debate', sideA: 'Face cam', sideB: 'No cam', headline: 'THE CAM WAR' });
    assert.strictEqual(JSON.parse(d.angles_json).length, 3, 'debate carries its sides as angles');
    assert.deepStrictEqual(board.pickSide(d.id, 'anon:v1', 'a', null), { a: 1, b: 0, share_a: 100 });
    board.pickSide(d.id, 'anon:v2', 'b'); board.pickSide(d.id, 'anon:v1', 'b');
    assert.deepStrictEqual(board.sideTally(d.id), { a: 0, b: 2, share_a: 0 }, 'changing sides never double-counts');
    await board.joinTopic(d.id, u3);
    board.applyTopicJudgement(u3, db.get('SELECT * FROM arena_topics WHERE id = ?', [d.id]), { angle_idx: 0, quality: 9, progress_gain: 30, best_line: 'cams are for cowards', about: 'x' }, {});
    db.run(`UPDATE arena_topics SET expires_at = datetime('now', '-1 minute') WHERE id = ?`, [d.id]);
    const res = board.resolveExpired();
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].winner, 'a', 'talk (9×2=18) beats chat (2 for b)');
    assert.strictEqual(res[0].mvp_user_id, u3);
    assert.strictEqual(board.topicDetail(d.id).status, 'resolved');
    // second debate so the voter has ≥ 2 picks and shows on the clout board
    const d2 = board.createTopic({ text: 'Keyboard sounds on stream', createdBy: 'ai', kind: 'debate', sideA: 'ASMR', sideB: 'Mute it' });
    board.pickSide(d2.id, 'anon:v1', 'a'); board.pickSide(d2.id, 'anon:v2', 'a');
    db.run(`UPDATE arena_topics SET expires_at = datetime('now', '-1 minute') WHERE id = ?`, [d2.id]);
    board.resolveExpired();
    const clout = board.cloutLeaderboard();
    assert.ok(clout.length >= 1 && clout[0].picks === 2, `clout board: ${JSON.stringify(clout)}`);
    console.log('✅ debates: sides, resolution, clout');

    // Phrase challenge: no model needed.
    const ph = board.createTopic({ text: 'Say "certified yapper" on stream', createdBy: 'ai', kind: 'phrase', phrase: 'certified yapper' });
    assert.deepStrictEqual(board.checkPhrases(u2, 'we are just a certified yapper household', { vod_id: null, sec: 1 }).map(h => h.xp), [15]);
    assert.deepStrictEqual(board.checkPhrases(u2, 'CERTIFIED YAPPER again', {}).map(h => h.xp), [5], 'repeats pay less');
    assert.deepStrictEqual(board.checkPhrases(u2, 'nothing here', {}), []);
    assert.strictEqual(board.topicDetail(ph.id).hits, 2);
    console.log('✅ phrase challenges');

    // ── Beefs: a name on mic opens it, the target goes on the clock, silence forfeits ──
    const h1 = beef.recordHit(u1, u2, { quality: 7, best_line: 'Grizzly streams to 12 people and 9 are his alts', about: 'his viewers are alts', announcer: 'Nova swings first!' });
    assert.strictEqual(h1.opened, true); assert.strictEqual(h1.side, 'a');
    assert.strictEqual(h1.beef.on_clock, 'b', 'the target is on the clock');
    let v = beef.get(h1.beef.id);
    assert.ok(v.clock_seconds_left > 23 * 3600 && v.clock_seconds_left <= 24 * 3600, `offline clock is 24 h: ${v.clock_seconds_left}`);
    assert.ok(v.headline && v.headline.includes('Nova'), `template headline: ${v.headline}`);
    assert.strictEqual(v.share_a, 100);
    assert.strictEqual(beef.recordHit(u1, u1, { quality: 5 }), null, 'no beef with yourself');
    const h2 = beef.recordHit(u2, u1, { quality: 9, best_line: 'Nova needed a bit to get views, I just exist', about: 'clout chasing' });
    assert.strictEqual(h2.opened, false); assert.strictEqual(h2.beef.id, h1.beef.id, 'same pair → same beef');
    assert.strictEqual(h2.first_response, true);
    assert.strictEqual(h2.beef.on_clock, 'a', 'answering flips the clock');
    v = beef.get(h1.beef.id);
    assert.strictEqual(v.feed.length, 2);
    assert.strictEqual(v.feed[1].kind, 'respond');
    assert.ok(v.share_a < 50, 'quality 9 beats quality 7');
    assert.throws(() => beef.hype(v.id, 'a', `user:${u1}`), /yourself/);
    assert.deepStrictEqual(beef.hype(v.id, 'a', 'anon:x'), { added: true, hypers: 1, crowd: 1 });
    assert.deepStrictEqual(beef.hype(v.id, 'a', 'anon:x').added, false);
    assert.deepStrictEqual(beef.pickSide(v.id, 'anon:x', 'b'), { a: 0, b: 1, share_a: 0 });
    assert.throws(() => beef.hype(999, 'a', 'anon:x'), /No open beef/);
    beef.tick();
    assert.strictEqual(beef.get(v.id).status, 'open', 'clock still running → stays open');
    db.run(`UPDATE arena_beefs SET clock_until = datetime('now', '-1 minute') WHERE id = ?`, [v.id]);
    beef.tick();
    v = beef.get(v.id);
    assert.strictEqual(v.status, 'resolved'); assert.strictEqual(v.resolution, 'forfeit');
    assert.strictEqual(v.winner_user_id, u2, 'the side on the clock (a) went silent → b wins');
    assert.ok(v.result_headline, 'result headline set');
    assert.deepStrictEqual(beef.recordFor(u2), { wins: 1, losses: 0, draws: 0 });
    assert.deepStrictEqual(beef.recordFor(u1), { wins: 0, losses: 1, draws: 0 });
    assert.strictEqual(beef.streakFor(u2), 1);
    assert.ok(board.levelView(u2).xp >= beef.XP_BEEF_WIN, 'winner gets beef XP');
    assert.ok(arena.listFighters().find(f => f.user.id === u2).ratings.talk_bonus > 0, 'recent win → mouth bonus on POWER');
    console.log('✅ beef: open on a name-drop, clock flips on answer, forfeit on silence');

    // Rematch + hard end on points + upset + rivalry receipts.
    const h3 = beef.recordHit(u1, u2, { quality: 8, best_line: 'Round two, and this time bring your real viewers', about: 'rematch' });
    assert.strictEqual(h3.opened, true);
    let v2 = beef.get(h3.beef.id);
    assert.strictEqual(v2.rematch, true, 'second beef between the pair is a rematch');
    assert.strictEqual(v2.history.fights, 1);
    beef.recordHit(u2, u1, { quality: 3, best_line: 'ok', about: 'weak' });
    db.run(`UPDATE arena_beefs SET ends_at = datetime('now', '-1 minute') WHERE id = ?`, [v2.id]);
    beef.tick();
    v2 = beef.get(v2.id);
    assert.strictEqual(v2.resolution, 'score'); assert.strictEqual(v2.winner_user_id, u1, 'higher total on the hard end wins');
    assert.strictEqual(v2.upset, false, 'the #1 beating #2 is no upset');
    const riv = beef.rivalry(u1, u2);
    assert.deepStrictEqual([riv.fights, riv.wins_1, riv.wins_2], [2, 1, 1]);
    assert.ok(riv.receipts.length >= 1 && riv.receipts[0].quality >= 6, 'receipts are the quotable lines from earlier beefs');
    assert.strictEqual(beef.rivalriesFor(u1)[0].opponent.user.id, u2);
    // Upset: #3 beats #1 on a forfeit.
    const h4 = beef.recordHit(u3, u1, { quality: 6, best_line: 'Nova is a lobby simulator with a face cam', about: 'x' });
    db.run(`UPDATE arena_beefs SET clock_until = datetime('now', '-1 minute') WHERE id = ?`, [h4.beef.id]);
    beef.tick();
    const up = beef.get(h4.beef.id);
    assert.strictEqual(up.winner_user_id, u3);
    assert.strictEqual(up.upset, false, 'rank gap of 2 is not an upset (needs ≥ 4)');
    const L = beef.list();
    assert.strictEqual(L.open.length, 0); assert.strictEqual(L.resolved.length, 3);
    console.log('✅ rematches, hard end on points, rivalry receipts');

    // Bounty doubles beef XP for whoever collects.
    const bty = board.createTopic({ text: 'Bounty: Pixelqueen', createdBy: 'chat', creatorUserId: viewer, kind: 'bounty', targetUserId: u3 });
    assert.strictEqual(board.openBountyOn(u3).id, bty.id);
    assert.throws(() => board.createTopic({ text: 'Bounty again', createdBy: 'chat', kind: 'bounty', targetUserId: u3 }), /already a bounty/);
    const before = board.levelView(u2).xp;
    const hb = beef.recordHit(u2, u3, { quality: 8, best_line: 'Pixelqueen plays on a calculator', about: 'setup' });
    assert.strictEqual(hb.bounty, true);
    const gained = board.levelView(u2).xp - before;
    assert.ok(gained >= 8 * 2 + beef.XP_BEEF_OPEN, `bounty doubles the hit XP (+open bonus): ${gained}`);
    assert.strictEqual(board.topicDetail(bty.id).hits, 1);
    console.log('✅ bounties');

    // ── Listener: aliases + heuristics + a real tick over a live transcribed stream ──
    const fresh2 = arena.loadRoster(true);
    assert.deepStrictEqual(listener._mentionsIn('honestly grizzly bear is washed', u1, fresh2), [u2], 'underscored username spoken with a space');
    assert.deepStrictEqual(listener._mentionsIn('shoutout @pixelqueen for the raid', u1, fresh2), [u3]);
    assert.deepStrictEqual(listener._mentionsIn('nova is the best, nova nova', u1, fresh2), [], 'a speaker never mentions themselves');
    assert.deepStrictEqual(listener._mentionsIn('the supernova exploded', u2, fresh2), [], 'no match inside other words');
    const hb1 = listener._heuristicBeef('Grizzly is trash and washed, he could never beat me!', ['grizzly']);
    assert.strictEqual(hb1.aimed_at_target, true); assert.ok(hb1.quality >= 6);
    assert.strictEqual(listener._heuristicBeef('thanks grizzly for the raid, love you', ['grizzly']).aimed_at_target, false);
    const ht = listener._heuristicTopic('the roast angle: worst at this is grizzly because reasons', [{ text: 'Brag: why you win' }, { text: 'Roast: who is worst at this and why' }, { text: 'Bit: unhinged take' }]);
    assert.strictEqual(ht.angle_idx, 1);

    // Nova goes live with transcription; says pixelqueen's name while talking shit → beef opens without anyone clicking.
    const liveId = Number(db.createStream({ user_id: u1, title: 'live', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 1, started_at = datetime('now', '-600 seconds') WHERE id = ?`, [liveId]);
    db.addTimelineEvents([
        { stream_id: liveId, user_id: u1, vod_id: null, kind: 'speech', start_sec: 586, end_sec: 590, text: 'Chat, pixelqueen is trash, she is washed and could never beat me in anything, she is scared of the smoke.', label: null, confidence: 0.9 },
        { stream_id: liveId, user_id: u1, vod_id: null, kind: 'speech', start_sec: 591, end_sec: 596, text: 'Nobody watches that stream, it is mid, it is garbage, I would cook her in a second, bet!', label: null, confidence: 0.9 },
    ]);
    assert.strictEqual(arena.liveFighters()[0].user.id, u1);
    const ev = await listener.tick();
    assert.ok(ev.some(e => e.kind === 'beef_hit' && e.targetId === u3 && e.opened), `listener opened the beef: ${JSON.stringify(ev)}`);
    assert.strictEqual(listener.consoleState(u1).listening, true);
    assert.ok(listener.consoleState(u1).last_beef_judgement.aimed_at_target);
    const opened = beef.openBeefsFor(u1);
    assert.strictEqual(opened.length, 1); assert.strictEqual(opened[0].b_user_id, u3);
    assert.strictEqual(opened[0].on_clock, 'b');
    assert.strictEqual(arena.liveFighters()[0].open_beefs, 1);
    console.log('✅ listener: name-drop on a live stream opens the beef');

    // ── Chat commands ──
    const sent = [], room = [];
    const fakeChat = { sendTo: (ws, m) => sent.push(m.message), broadcastToStream: (sid, m) => room.push(m.message) };
    const run = async (client, line) => { const parts = line.split(' '); const handled = chat.handle(fakeChat, {}, client, parts[0], parts); await new Promise(r => setTimeout(r, 30)); return handled; };
    const vc = { user: { id: viewer, username: 'viewer', display_name: 'Viewer' }, streamId: liveId, ip: '1.1.1.1' };
    assert.strictEqual(await run(vc, '!nope'), false);
    assert.strictEqual(await run(vc, '!topic Streamers who blame lag for everything'), true);
    assert.ok(sent.pop().includes('/arena/topic/'), 'topic posted with a link');
    assert.ok(room.pop().includes('put a topic on the Arena board'));
    assert.ok(db.get(`SELECT id FROM arena_topics WHERE text LIKE 'Streamers who blame lag%' AND created_by = 'chat'`));
    await new Promise(r => setTimeout(r, 4100)); // per-person command rate limit
    await run(vc, '!hype');
    assert.ok(sent.pop().includes('Hyped Nova in their beef'), 'hype goes to the streamer\'s open beef');
    assert.strictEqual(beef.get(opened[0].id).a.crowd, 1);
    await new Promise(r => setTimeout(r, 4100));
    await run(vc, '!side pixelqueen');
    assert.ok(sent.pop().includes("You're with"));
    assert.deepStrictEqual(beef.sidesTally(opened[0].id), { a: 0, b: 1, share_a: 0 });
    await new Promise(r => setTimeout(r, 4100));
    await run({ anonId: 'zz', streamId: liveId }, '!beef');
    assert.ok(sent.pop().includes('on the clock'), 'beef summary shows the clock');
    await run({ anonId: 'zz2', streamId: liveId }, '!board');
    assert.ok(sent.pop().includes('Hottest'), 'board summary');
    await run({ anonId: 'zz3', streamId: liveId }, '!topic no sign in');
    assert.ok(sent.pop().includes('Sign in'));
    console.log('✅ chat: !topic !hype !side !beef !board');

    // ── Public API smoke ──
    const express = require('express');
    const app = express(); app.use(express.json()); app.use('/api/arena', require('../server/arena/routes'));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const get = async (p) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/arena${p}`); return { status: res.status, body: await res.json() }; };
    const bd = await get('/board');
    assert.strictEqual(bd.status, 200); assert.ok(Array.isArray(bd.body.open) && bd.body.levels.length >= 1 && bd.body.clout.length >= 1);
    const bf = await get('/beefs'); assert.strictEqual(bf.body.open.length, 2, 'nova→pixelqueen (listener) + grizzly→pixelqueen (bounty)'); assert.strictEqual(bf.body.resolved.length, 3);
    const one = await get(`/beefs/${opened[0].id}`); assert.strictEqual(one.body.a.user.username, 'nova'); assert.ok(one.body.rules.response_live_min === 15);
    const con = await get('/console/nova'); assert.strictEqual(con.body.listener.listening, true); assert.strictEqual(con.body.open_beefs.length, 1); assert.ok(con.body.hot_mic.length === 2);
    const lv2 = await get('/live'); assert.strictEqual(lv2.body.live[0].open_beefs, 1);
    const tp = await get(`/board/topics/${t1.id}`); assert.strictEqual(tp.body.conquered, 1);
    assert.strictEqual((await get('/beefs/999')).status, 404);
    assert.strictEqual((await get('/console/nobody')).status, 404);
    srv.close();
    console.log('✅ public API');

    console.log('\n✅ All Arena beef/board tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
