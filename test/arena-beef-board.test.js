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
    // ── Board: subjects with keywords, moments from chat + mic, lore, Trash Level ──
    board._resetScan();
    const t1 = board.createTopic({ text: 'The baby voice', createdBy: 'community', creatorName: 'global chat', headline: 'baby voice gate', keywords: ['baby voice', 'dono voice'], threads: [{ name: 'the fax machine voice', keywords: ['fax machine'], hint: 'roast the voice' }, { name: 'who does it for $2', keywords: ['dono', 'donation'] }] });
    assert.deepStrictEqual(JSON.parse(t1.keywords_json), ['baby voice', 'dono voice', 'fax machine', 'dono', 'donation'], 'subject keywords = its own + every thread\'s');
    assert.deepStrictEqual(board.threadsOf(t1.id).map(x => x.name), ['the fax machine voice', 'who does it for $2']);
    assert.strictEqual(board.threadFor(t1.id, 'sounds like a FAX MACHINE'), board.threadsOf(t1.id)[0].id, 'lines file into the matching thread');
    assert.strictEqual(board.threadFor(t1.id, 'baby voice in general'), null, 'no thread match → subject-level moment');
    assert.throws(() => board.createTopic({ text: 'the BABY voice', createdBy: 'chat' }), /already on the board/);
    assert.throws(() => board.createTopic({ text: 'Dono donation drama', createdBy: 'chat' }), /already on the board/, 'two shared keywords = same subject');
    assert.throws(() => board.createTopic({ text: 'ok', createdBy: 'chat' }), /short/i);
    const auto = board.createTopic({ text: 'Pakistanis in the global chat again', createdBy: 'chat', creatorUserId: viewer, creatorName: 'Viewer', creatorIp: '9.9.9.9' });
    assert.deepStrictEqual(JSON.parse(auto.keywords_json), ['pakistanis', 'global'], 'keywords fall out of the subject text (stopwords dropped)');
    assert.deepStrictEqual(board.matchTopics('lol the pakistani guy is back').map(t => t.id), [auto.id], 'keyword match forgives plural/singular');
    assert.deepStrictEqual(board.matchTopics('I do the BABY VOICE for every dono').map(t => t.id), [t1.id], 'phrase keywords match case-insensitively');
    assert.deepStrictEqual(board.matchTopics('nothing to see here'), []);

    // One per person + per IP per 24 h.
    assert.throws(() => board.assertCanSubmit(viewer, '1.2.3.4'), /per person/);
    assert.throws(() => board.assertCanSubmit(u3, '9.9.9.9'), /connection/);
    board.assertCanSubmit(u3, '5.5.5.5');
    await assert.rejects(board.submitTopic({ text: 'Another one', userId: viewer, ip: '5.5.5.5', creatorName: 'Viewer' }), /per person/);
    const sub = await board.submitTopic({ text: 'Streamers who blame lag for everything', userId: u3, ip: '5.5.5.5', creatorName: 'Pixelqueen', onRoster: true });
    assert.strictEqual(sub.created_by, 'streamer'); assert.strictEqual(sub.submitted_text, 'Streamers who blame lag for everything');
    await assert.rejects(board.submitTopic({ text: 'cp links in bio', userId: u2, ip: '6.6.6.6', creatorName: 'x' }), /crosses the line/);

    // Chat lines that mention a subject become moments (scan picks up only new messages).
    const say = (uid, uname, msg, streamId = null) => db.run('INSERT INTO chat_messages (stream_id, user_id, username, message) VALUES (?, ?, ?, ?)', [streamId, uid, uname, msg]);
    say(viewer, 'viewer', 'this was before the scan started and must be ignored, baby voice');
    board.scanChat(); // primes the cursor
    say(viewer, 'viewer', 'nova does the baby voice for a $2 dono no shame');
    say(u2, 'grizzly_bear', 'BABY VOICE gang rise up');
    say(viewer, 'viewer', '!topic should be ignored baby voice');
    say(null, 'anon_guy', 'pakistanis run this chat lol');
    db.run('INSERT INTO chat_messages (stream_id, user_id, username, message, source_platform) VALUES (NULL, NULL, ?, ?, ?)', ['sleepyotter_ttv', 'baby voice is peak content honestly', 'ai']);
    db.setSetting('arena_bot_usernames', 'ChuckBot');
    db.run('INSERT INTO chat_messages (stream_id, user_id, username, message) VALUES (NULL, NULL, ?, ?)', ['ChuckBot', 'baby voice detected, deploying roast']);
    const scan = board.scanChat();
    assert.strictEqual(scan.moments, 3, `three moments from six new messages (commands + bots skipped): ${JSON.stringify(scan)}`);
    assert.ok(board.isBotChatter({ username: 'chuckbot' }) && board.isBotChatter({ source_platform: 'ai' }) && !board.isBotChatter({ username: 'viewer' }));
    let d1 = board.topicDetail(t1.id);
    assert.strictEqual(d1.mentions.chat, 2); assert.strictEqual(d1.chatters, 2);
    assert.strictEqual(d1.last_moment.username, 'grizzly_bear');
    db.run(`UPDATE chat_messages SET timestamp = datetime('now', '-3 hours') WHERE message LIKE 'nova does the baby voice%'`);
    const old = board.createTopic({ text: 'Nova dono voice', createdBy: 'chat', creatorName: 'x', keywords: ['nova does'] });
    board.backfillMoments([old], { windowMin: 600 });
    const om = board.topicDetail(old.id).moments[0];
    assert.ok(om && Date.now() - Date.parse(om.at.replace(' ', 'T') + 'Z') > 2.5 * 3600_000, `moment time is when it was said, not when it was filed: ${om && om.at} vs ${om && om.filed_at}`);
    db.run(`UPDATE arena_topics SET status = 'archived' WHERE id = ?`, [old.id]);
    assert.strictEqual(board.topicDetail(auto.id).mentions.chat, 1);
    assert.ok(!board.addMoment(t1.id, { kind: 'chat', source: 'chat', username: 'x', text: 'kys baby voice people' }), 'threat lines never become moments');

    // A streamer saying it on mic auto-joins them; the judge adds scored moments + XP.
    const mm = board.noteMicMention(t1.id, { userId: u1, username: 'nova', streamId: 77, vodId: 501, sec: 100, text: 'chat the baby voice thing is a bit' });
    assert.ok(mm && mm.kind === 'speech');
    assert.strictEqual(board.noteMicMention(t1.id, { userId: u1, username: 'nova', streamId: 77, vodId: 501, sec: 105, text: 'baby voice again' }), null, 'one raw mention per stream per cooldown');
    assert.strictEqual(board.activeTopicFor(u1).id, t1.id, 'saying it on mic puts you on the subject');
    assert.ok(board.levelView(u1).xp >= board.XP_JOIN, 'joining pays XP');
    const T = () => db.get('SELECT * FROM arena_topics WHERE id = ?', [t1.id]);
    assert.strictEqual(board.applyTopicJudgement(u1, T(), { on_topic: false, quality: 0 }).applied, false, 'off-subject chunk does nothing');
    assert.strictEqual(board.applyTopicJudgement(u1, T(), { on_topic: true, quality: 9, flagged: true }).applied, false, 'flagged chunk (threat/minor/dox) is ignored');
    let r = board.applyTopicJudgement(u1, T(), { on_topic: true, quality: 8, best_line: 'Read my dono in your real voice, coward', about: 'dono voice' }, { vod_id: 501, sec: 40, stream_id: 77 });
    assert.deepStrictEqual([r.applied, r.quality, r.xp], [true, 8, 6]);
    r = board.applyTopicJudgement(u1, T(), { on_topic: true, quality: 6, best_line: 'fax machine voice', about: 'x' }, {});
    const lv = board.levelView(u1);
    assert.strictEqual(lv.topic_moments, 2); assert.strictEqual(lv.topics_joined, 1);
    assert.strictEqual(lv.best_line.text, 'Read my dono in your real voice, coward', 'best line is the highest-quality one');
    d1 = board.topicDetail(t1.id);
    assert.strictEqual(d1.mentions.mic, 3); assert.strictEqual(d1.fighters[0].user.id, u1); assert.strictEqual(d1.fighters[0].moments, 3);
    assert.strictEqual(d1.threads.find(x => x.name === 'the fax machine voice').moments, 1, 'the fax-machine line landed in its thread');
    assert.ok(d1.moments.some(m => m.thread_id === d1.threads[0].id || m.thread_id === d1.threads[1]?.id));
    assert.strictEqual(board.upsertThreads(t1.id, [{ name: 'The Fax Machine Voice', keywords: ['fax'] }, { name: 'nova vs grizzly', keywords: ['grizzly'] }]), 1, 'same thread merges, new angle added');
    assert.strictEqual(board.threadsOf(t1.id).length, 3);
    assert.strictEqual(d1.best_moment.quality, 8); assert.strictEqual(d1.best_lines.length, 2);
    assert.ok(d1.moments.length === 5 && d1.moments[0].source === 'judge');
    await board.joinTopic(auto.id, u1);
    assert.strictEqual(board.activeTopicFor(u1).id, auto.id, 'joining another subject switches the active one');
    await assert.rejects(board.joinTopic(t1.id, viewer), /roster/, 'viewers cannot talk on a subject');
    console.log('✅ board: keywords, chat scan → moments, mic auto-join, judged moments, Trash Level');

    // Lore (template without AI), hype, heat and the featured order.
    const lore = await board.buildLore(t1.id, { force: true });
    assert.ok(/It started in chat when viewer said/.test(lore.lore) && /took it on stream/.test(lore.lore) && /Best line so far, nova/.test(lore.lore), lore.lore);
    assert.deepStrictEqual(await board.buildLore(t1.id), { skipped: true }, 'no rewrite without new moments');
    assert.throws(() => board.hypeTopic(t1.id, u1, `user:${u1}`), /yourself/);
    assert.deepStrictEqual(board.hypeTopic(t1.id, u1, 'anon:abc'), { added: true, hypers: 1 });
    assert.deepStrictEqual(board.hypeTopic(t1.id, u1, 'anon:abc'), { added: false, hypers: 1 }, 'one hype per person');
    const view = board.boardView();
    assert.strictEqual(view.open[0].id, t1.id, 'most talked-about subject first');
    assert.ok(view.open[0].heat > view.open[1].heat && view.open[0].hot, `heat sorted: ${view.open.map(t => t.heat)}`);
    assert.strictEqual(view.open[0].lore, lore.lore);
    assert.strictEqual(view.cooldown_hours, 24);
    const yap = board.yappersLeaderboard();
    assert.deepStrictEqual(yap.map(y => y.name).sort(), ['anon_guy', 'grizzly_bear', 'viewer'], 'everyone who typed about a subject is a yapper');
    assert.ok(yap.every(y => y.moments >= 1 && y.subjects >= 1 && y.level >= 1 && y.title), 'yapper profiles carry level + title');
    console.log('✅ lore, hype, heat ordering, yappers');

    // Discovery without AI: a word ≥ 3 people keep saying becomes a subject, seeded with what was said.
    for (const [who, uid] of [['a1', null], ['a2', null], ['a3', null], ['a1', null]]) say(uid, who, `the curry smell in goosely tent is unreal ${who}`);
    say(null, 'a2', 'curry again bro');
    const found = board.heuristicDiscover(board.discoverInput());
    assert.ok(found.some(f => f.keywords[0] === 'curry'), `burst detected: ${JSON.stringify(found)}`);
    const disc = await board.discoverTopics({ force: true });
    assert.ok(disc.made >= 1, `discovered: ${JSON.stringify(disc)}`);
    const curry = db.get(`SELECT * FROM arena_topics WHERE keywords_json LIKE '%curry%'`);
    assert.ok(curry && curry.created_by === 'community');
    assert.ok(board.topicDetail(curry.id).mentions.chat >= 4, 'backfilled with the lines that started it');
    console.log('✅ discovery from chat bursts + backfill');

    // Bounty: a subject with a target; expires into the archive with a result.
    const bty = board.createTopic({ text: 'Bounty: Pixelqueen', createdBy: 'chat', creatorUserId: viewer, creatorName: 'Viewer', kind: 'bounty', targetUserId: u3, headline: 'WANTED' });
    assert.strictEqual(board.openBountyOn(u3).id, bty.id);
    assert.throws(() => board.createTopic({ text: 'Bounty again', createdBy: 'chat', kind: 'bounty', targetUserId: u3 }), /already a bounty/);
    assert.ok(JSON.parse(bty.keywords_json).includes('pixelqueen'), 'bounty keywords include the target name');

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
    assert.ok(!beef.pickSide && !beef.sidesTally && !('sides' in v), 'no voting anywhere');
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

    // Bounty doubles beef XP for whoever collects, and the hit lands as a moment on the bounty.
    const before = board.levelView(u2).xp;
    const hb = beef.recordHit(u2, u3, { quality: 8, best_line: 'Pixelqueen plays on a calculator', about: 'setup' });
    assert.strictEqual(hb.bounty, true);
    const gained = board.levelView(u2).xp - before;
    assert.ok(gained >= 8 * 2 + beef.XP_BEEF_OPEN, `bounty doubles the hit XP (+open bonus): ${gained}`);
    assert.ok(board.topicDetail(bty.id).moments.some(m => m.text.includes('calculator')));
    db.run(`UPDATE arena_topics SET expires_at = datetime('now', '-1 minute') WHERE id = ?`, [bty.id]);
    const res = board.resolveExpired();
    assert.strictEqual(res.length, 1); assert.strictEqual(res[0].claimed_by, u2);
    assert.strictEqual(board.topicDetail(bty.id).status, 'resolved');
    console.log('✅ bounties');

    // ── Listener: aliases + heuristics + a real tick over a live transcribed stream ──
    const fresh2 = arena.loadRoster(true);
    assert.deepStrictEqual(listener._mentionsIn('honestly grizzly bear is washed', u1, fresh2), [u2], 'underscored username spoken with a space');
    assert.deepStrictEqual(listener._mentionsIn('shoutout @pixelqueen for the raid', u1, fresh2), [u3]);
    assert.deepStrictEqual(listener._mentionsIn('nova is the best, nova nova', u1, fresh2), [], 'a speaker never mentions themselves');
    assert.deepStrictEqual(listener._mentionsIn('the supernova exploded', u2, fresh2), [], 'no match inside other words');
    assert.deepStrictEqual(listener._mentionsIn('grizzlybear is a fraud', u1, fresh2), [u2], 'glued form of a split name');
    assert.deepStrictEqual(listener._mentionsIn('grizly bear ducked me', u1, fresh2), [u2], 'typo-level fuzzy match');
    assert.deepStrictEqual(listener._mentionsIn('pixel queen is scared', u1, fresh2), [u3], 'a one-word handle the transcriber split in two');
    assert.strictEqual(listener._mentionsDetailed('pixel queen is scared', u1, fresh2)[0].how, 'phonetic');
    // names.js on the handles that break naive matching
    const names = require('../server/arena/names');
    assert.deepStrictEqual(names.variants('JapaneseOldGuy'), ['japanese old guy', 'japaneseoldguy']);
    assert.deepStrictEqual(names.variants('lofi_dan99'), ['lofi dan 99', 'lofi dan', 'lofidan']);
    assert.ok(names.variants('x_Goosely_TV').includes('goosely tv') && names.variants('M4ticus').includes('maticus'));
    assert.deepStrictEqual(names.variants('Guy'), [], 'a common word alone can never be an alias');
    const E = [...names.aliasEntries(1, ['JapaneseOldGuy']), ...names.aliasEntries(2, ['Maticus']), ...names.aliasEntries(3, ['Goosely'])];
    const hit = (t) => names.findMentions(t, E).map(m => `${m.userId}:${m.how}`);
    assert.deepStrictEqual(hit('Japanese old guy is washed'), ['1:exact']);
    assert.deepStrictEqual(hit('japanese-old-guy again'), ['1:exact']);
    assert.deepStrictEqual(hit("JapaneseOldGuy's chat is dead"), ['1:exact']);
    assert.deepStrictEqual(hit('japanese old gai lol'), ['1:fuzzy']);
    assert.deepStrictEqual(hit('a japanese guy walked in'), [], 'a different phrase is not a fuzzy hit');
    assert.deepStrictEqual(hit('the old guy said nothing'), []);
    assert.deepStrictEqual(hit('Matticus is a fraud'), ['2:fuzzy']);
    assert.deepStrictEqual(hit('mattie cuss is scared'), ['2:phonetic']);
    assert.deepStrictEqual(hit('goose lee ducked'), ['3:phonetic']);
    assert.deepStrictEqual(hit('Goosley never answered'), ['3:phonetic']);
    assert.deepStrictEqual(hit('that goose flew'), [], 'a prefix alone is not the name');
    console.log('✅ name matching: camelCase/snake/digits/leet/suffixes, fuzzy + phonetic, guarded');
    const hb1 = listener._heuristicBeef('Grizzly is trash and washed, he could never beat me!', ['grizzly']);
    assert.strictEqual(hb1.aimed_at_target, true); assert.ok(hb1.quality >= 6);
    assert.strictEqual(listener._heuristicBeef('thanks grizzly for the raid, love you', ['grizzly']).aimed_at_target, false);
    const ht = listener._heuristicTopic('honestly the baby voice thing is the worst, nobody wants it', { keywords_json: JSON.stringify(['baby voice']) });
    assert.strictEqual(ht.on_topic, true); assert.ok(ht.quality >= 5);
    assert.strictEqual(listener._heuristicTopic('unrelated gameplay talk', { keywords_json: JSON.stringify(['baby voice']) }).on_topic, false);

    // Nova goes live with transcription; says pixelqueen's name while talking shit → beef opens without anyone clicking.
    const liveId = Number(db.createStream({ user_id: u1, title: 'live', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 1, started_at = datetime('now', '-600 seconds') WHERE id = ?`, [liveId]);
    db.addTimelineEvents([
        { stream_id: liveId, user_id: u1, vod_id: null, kind: 'speech', start_sec: 586, end_sec: 590, text: 'Chat, pixelqueen is trash, she is washed and could never beat me in anything, she is scared of the smoke.', label: null, confidence: 0.9 },
        { stream_id: liveId, user_id: u1, vod_id: null, kind: 'speech', start_sec: 591, end_sec: 596, text: 'Nobody watches that stream, it is mid, it is garbage, I would cook her in a second, bet! Also the curry thing is real.', label: null, confidence: 0.9 },
    ]);
    assert.strictEqual(arena.liveFighters()[0].user.id, u1);
    const ev = await listener.tick();
    assert.ok(ev.some(e => e.kind === 'beef_hit' && e.targetId === u3 && e.opened), `listener opened the beef: ${JSON.stringify(ev)}`);
    assert.strictEqual(listener.consoleState(u1).listening, true);
    assert.ok(listener.consoleState(u1).last_beef_judgement.aimed_at_target);
    assert.ok(ev.some(e => e.kind === 'topic_mention' && e.topicId === curry.id), 'saying a subject on mic adds a moment on it');
    assert.ok(board.topicDetail(curry.id).fighters.some(f => f.user.id === u1), 'and auto-joins the fighter');
    const opened = beef.openBeefsFor(u1);
    assert.strictEqual(opened.length, 1); assert.strictEqual(opened[0].b_user_id, u3);
    assert.strictEqual(opened[0].on_clock, 'b');
    assert.strictEqual(arena.liveFighters()[0].open_beefs, 1);
    const cs = listener.consoleState(u1);
    assert.ok(cs.focus && cs.focus.target_id === u3 && cs.focus.hits === 1 && cs.focus.lock_seconds_left > 60, `locked on the target after the hit: ${JSON.stringify(cs.focus)}`);
    console.log('✅ listener: name-drop on a live stream opens the beef and locks on');

    // Locked on: the next lines never say the name, but "she", "her chat" keep the rant going → another hit.
    const hitsBefore = beef.get(opened[0].id).a.hits;
    db.run(`UPDATE streams SET started_at = datetime('now', '-700 seconds') WHERE id = ?`, [liveId]);
    db.addTimelineEvents([
        { stream_id: liveId, user_id: u1, vod_id: null, kind: 'speech', start_sec: 686, end_sec: 692, text: 'And her chat? Her chat is twelve alts and a bot, she is cooked, she could never run it back with me.', label: null, confidence: 0.9 },
        { stream_id: liveId, user_id: u1, vod_id: null, kind: 'speech', start_sec: 693, end_sec: 698, text: 'She is trash at this and everyone knows it, bet, she is scared to even answer.', label: null, confidence: 0.9 },
    ]);
    listener._state.get(liveId).lastJudgeAt = 0;   // skip the 30 s judge spacing for the test
    const ev2 = await listener.tick();
    assert.ok(ev2.some(e => e.kind === 'beef_hit' && e.targetId === u3 && e.continued), `continuation counted without the name: ${JSON.stringify(ev2)}`);
    assert.strictEqual(beef.get(opened[0].id).a.hits, hitsBefore + 1);
    assert.ok(listener.consoleState(u1).focus.hits === 2 && listener.consoleState(u1).focus.context.includes('|'), 'lock extended with context');
    // Then they move on to gameplay: two off-target chunks drop the lock.
    for (let k = 0; k < 2; k++) {
        db.run(`UPDATE streams SET started_at = datetime('now', ?) WHERE id = ?`, [`-${800 + k * 100} seconds`, liveId]);
        db.addTimelineEvents([{ stream_id: liveId, user_id: u1, vod_id: null, kind: 'speech', start_sec: 786 + k * 100, end_sec: 792 + k * 100, text: 'Okay chat back to the game, we need to farm this boss and then do the quest line for the sword upgrade, let me check the map real quick.', label: null, confidence: 0.9 }]);
        listener._state.get(liveId).lastJudgeAt = 0;
        await listener.tick();
    }
    assert.strictEqual(listener.consoleState(u1).focus, null, 'moved on → lock dropped');
    console.log('✅ listener: stays locked on the target, counts continuations, lets go when they move on');

    // ── Chat commands ──
    const sent = [], room = [];
    const fakeChat = { sendTo: (ws, m) => sent.push(m.message), broadcastToStream: (sid, m) => room.push(m.message) };
    const run = async (client, line) => { const parts = line.split(' '); const handled = chat.handle(fakeChat, {}, client, parts[0], parts); await new Promise(r => setTimeout(r, 30)); return handled; };
    const vc = { user: { id: viewer, username: 'viewer', display_name: 'Viewer' }, streamId: liveId, ip: '1.1.1.1' };
    assert.strictEqual(await run(vc, '!nope'), false);
    assert.strictEqual(await run(vc, '!topic Streamers who blame lag for everything'), true);
    assert.ok(/per person/.test(sent.pop()), 'viewer already used their topic for the day');
    const vc2 = { user: { id: u2, username: 'grizzly_bear', display_name: 'Grizzly' }, streamId: liveId, ip: '7.7.7.7' };
    await run(vc2, '!topic Goosely tent smell');
    assert.ok(sent.pop().includes('/arena/topic/'), 'topic posted with a link');
    assert.ok(room.pop().includes('put a subject on the Arena board'));
    assert.ok(db.get(`SELECT id FROM arena_topics WHERE text LIKE 'Goosely tent smell%' AND created_by = 'streamer'`));
    await new Promise(r => setTimeout(r, 4100)); // per-person command rate limit
    await run(vc, '!hype');
    assert.ok(sent.pop().includes('Hyped Nova in their beef'), 'hype goes to the streamer\'s open beef');
    assert.strictEqual(beef.get(opened[0].id).a.crowd, 1);
    await new Promise(r => setTimeout(r, 4100));
    await run({ anonId: 'zz', streamId: liveId }, '!beef');
    assert.ok(sent.pop().includes('on the clock'), 'beef summary shows the clock');
    await run({ anonId: 'zz2', streamId: liveId }, '!board');
    assert.ok(sent.pop().includes('Hottest'), 'board summary');
    await run({ anonId: 'zz4', streamId: liveId }, '!side nova');
    assert.strictEqual(sent.length, 0, 'no voting commands exist');
    await run({ anonId: 'zz3', streamId: liveId }, '!topic no sign in');
    assert.ok(sent.pop().includes('Sign in'));
    console.log('✅ chat: !topic (24 h limit) !hype !beef !board');

    // ── Public API smoke ──
    const express = require('express');
    const app = express(); app.use(express.json()); app.use('/api/arena', require('../server/arena/routes'));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const get = async (p) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/arena${p}`); return { status: res.status, body: await res.json() }; };
    const bd = await get('/board');
    assert.strictEqual(bd.status, 200); assert.ok(Array.isArray(bd.body.open) && bd.body.levels.length >= 1 && bd.body.yappers.length >= 1 && bd.body.archive.length >= 1);
    const bf = await get('/beefs'); assert.strictEqual(bf.body.open.length, 2, 'nova→pixelqueen (listener) + grizzly→pixelqueen (bounty)'); assert.strictEqual(bf.body.resolved.length, 3);
    const one = await get(`/beefs/${opened[0].id}`); assert.strictEqual(one.body.a.user.username, 'nova'); assert.ok(one.body.rules.response_live_min === 15);
    const con = await get('/console/nova'); assert.strictEqual(con.body.listener.listening, true); assert.strictEqual(con.body.open_beefs.length, 1); assert.ok(con.body.hot_mic.length >= 2 && con.body.listener.focus === null);
    const lv2 = await get('/live'); assert.strictEqual(lv2.body.live[0].open_beefs, 1);
    const tp = await get(`/board/topics/${t1.id}`); assert.ok(tp.body.lore && tp.body.moments.length >= 5 && tp.body.keywords.includes('baby voice') && tp.body.threads.length === 3);
    assert.strictEqual((await get('/beefs/999')).status, 404);
    assert.strictEqual((await get('/console/nobody')).status, 404);
    srv.close();
    console.log('✅ public API');

    console.log('\n✅ All Arena beef/board tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
