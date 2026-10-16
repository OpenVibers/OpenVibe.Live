'use strict';
// Arena v4, the drama desk (server/arena/drama.js): what streamers did becomes ARENA ALERT stories, once per event —
// a rage quit and a dramatic title, a viewer crash and a chat explosion from the minute snapshots, a meltdown heard on
// the sound timeline with what was said around it, a ghost-town stream, a comeback, a beef; viewers react once each;
// the Lolcow Index and the Clout Rankings read the stories and the week's activity; a streamer who opts out gets no
// stories and their old ones are hidden. Runs on a temp database with AI off (template headlines).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-arena-drama-'));
process.env.ARENA_IMAGE_PATH = path.join(tmp, 'arena');
console.warn = () => {};

const db = require('../server/db/database');
(async () => {
    await db.initDb();
    const drama = require('../server/arena/drama');
    const { fmt } = drama._test;
    const NOW = Date.now();
    const ago = (min) => fmt(NOW - min * 60000);

    const mk = async (username) => { await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') }); const id = (await db.get('SELECT id FROM users WHERE username = ?', [username])).id; await db.ensureChannel(id); return id; };
    const stream = async (uid, { startMin, endMin = null, peak = 0, title = 'just chatting' }) => {
        const id = Number((await db.createStream({ user_id: uid, title, category: 'irl', protocol: 'rtmp' })).lastInsertRowid);
        const live = endMin == null;
        await db.run('UPDATE streams SET is_live = ?, started_at = ?, ended_at = ?, duration_seconds = ?, peak_viewers = ?, title = ? WHERE id = ?',
            [live ? 1 : 0, ago(startMin), live ? null : ago(endMin), live ? null : (startMin - endMin) * 60, peak, title, id]);
        return id;
    };
    const rager = await mk('rager'), crasher = await mk('crasher'), screamer = await mk('screamer'), ghost = await mk('ghost'), returner = await mk('returner'), viewer = await mk('viewer');

    // rager: four long streams before, then six minutes and a title that says it all.
    for (let d = 4; d >= 1; d--) await stream(rager, { startMin: d * 1440 + 120, endMin: d * 1440, peak: 2 });
    await stream(rager, { startMin: 36, endMin: 30, peak: 2, title: "I'm done with this game" });
    // crasher: live 40 min; 8 viewers for 15 min then 2; chat at 2 then 30.
    const cs = await stream(crasher, { startMin: 40, peak: 8 });
    for (let m = 30; m >= 0; m--) await db.run('INSERT INTO viewer_snapshots (stream_id, viewer_count, chat_messages_5m, recorded_at) VALUES (?, ?, ?, ?)', [cs, m > 15 ? 8 : 2, m === 3 ? 30 : 2, ago(m)]);
    // screamer: live; three rage sounds inside two minutes, and a line said between them.
    const ss = await stream(screamer, { startMin: 20, peak: 1 });
    await db.addTimelineEvents([
        { stream_id: ss, user_id: screamer, vod_id: null, kind: 'sound', start_sec: 100, end_sec: 101, text: null, label: 'Yell', confidence: 0.8 },
        { stream_id: ss, user_id: screamer, vod_id: null, kind: 'sound', start_sec: 130, end_sec: 131, text: null, label: 'Screaming', confidence: 0.8 },
        { stream_id: ss, user_id: screamer, vod_id: null, kind: 'sound', start_sec: 160, end_sec: 161, text: null, label: 'Shout', confidence: 0.8 },
        { stream_id: ss, user_id: screamer, vod_id: null, kind: 'speech', start_sec: 140, end_sec: 145, text: 'I swear this game is rigged against me every single time', label: null, confidence: 0.9 },
    ]);
    // ghost: 90 minutes, nobody watching, nobody typing.
    await stream(ghost, { startMin: 150, endMin: 60, peak: 0 });
    // returner: away 20 days, live again.
    await stream(returner, { startMin: 20 * 1440 + 60, endMin: 20 * 1440, peak: 1 });
    await stream(returner, { startMin: 30, peak: 1, title: 'back' });

    // Chat announcements: captured instead of sent.
    const delivery = require('../server/chat/chat-delivery');
    const sent = [];
    delivery.message = async (line) => { sent.push(line); return sent.length; };
    const first = await drama.detect({ now: NOW });
    await new Promise((r) => setTimeout(r, 100));
    const kinds = (await db.all('SELECT kind, user_id FROM arena_drama ORDER BY id')).map((r) => `${r.kind}:${r.user_id}`);
    for (const k of [`rage_quit:${rager}`, `title_drama:${rager}`, `viewer_crash:${crasher}`, `chat_explosion:${crasher}`, `meltdown:${screamer}`, `ghost_town:${ghost}`, `the_return:${returner}`]) {
        assert.ok(kinds.includes(k), `${k} in ${kinds.join(', ')}`);
    }
    assert.ok(!kinds.some((k) => k.startsWith('viewer_spike:')), 'no spike from a crash');
    assert.strictEqual((await drama.detect({ now: NOW })).created, 0, 'one story per event, however often the desk runs');
    assert.ok(first.created >= 7);

    const rq = await db.get("SELECT * FROM arena_drama WHERE kind = 'rage_quit'");
    assert.strictEqual(rq.headline, '🚨 rager RAGE QUIT? Stream over after 6 minutes');
    assert.match(rq.blurb, /usually goes 120 minutes\. Today it lasted 6\. The title was "I'm done with this game"\./);
    const md = await db.get("SELECT * FROM arena_drama WHERE kind = 'meltdown'");
    assert.strictEqual(md.quote, 'I swear this game is rigged against me every single time');
    assert.deepStrictEqual(JSON.parse(md.facts_json), { count: 3, seconds: 60, sounds: { Yell: 1, Screaming: 1, Shout: 1 } });
    const crash = JSON.parse((await db.get("SELECT facts_json FROM arena_drama WHERE kind = 'viewer_crash'")).facts_json);
    assert.deepStrictEqual([crash.from, crash.to], [8, 2]);

    // Stories at alert 3+ reach chat once each: the live subject's stream room (mirrored), else global chat.
    assert.ok(sent.length >= 2 && sent.every((l) => l.message_type === 'system' && l.username === 'ARENA ALERT' && /^arena:\d+$/.test(l.key)));
    const rqLine = sent.find((l) => l.key === `arena:${rq.id}`);
    assert.ok(rqLine && rqLine.is_global && !rqLine.stream_id && /\/arena\/drama\/\d+$/.test(rqLine.message), 'an ended stream: global chat');
    const mdLine = sent.find((l) => l.key === `arena:${md.id}`);
    assert.deepStrictEqual([mdLine.stream_id, mdLine.mirror], [ss, true], 'a live subject: their stream room, mirrored');
    assert.ok(!sent.some((l) => l.message.includes('GHOST')), 'alert 1-2 stories stay off chat');

    // Reactions: one per viewer, changing it replaces it.
    await drama.react(rq.id, 'w', `user:${viewer}`);
    let r = await drama.react(rq.id, 'clown', `user:${viewer}`);
    assert.deepStrictEqual([r.w, r.clown], [0, 1]);
    await drama.react(rq.id, 'clown', 'ip:abc');
    const view = await drama.story(rq.id, `user:${viewer}`);
    assert.deepStrictEqual([view.reactions.clown, view.my_reaction, view.user.username], [2, 'clown', 'rager']);
    await assert.rejects(drama.react(rq.id, 'heart', 'ip:abc'), /reaction must be one of/);

    // The boards.
    const cows = await drama.lolcowIndex({ now: NOW });
    assert.strictEqual(cows[0].user.username, 'rager', 'the rage quitter tops the Lolcow Index');
    assert.strictEqual(cows[0].meter, 100);
    const clout = await drama.cloutRankings({ now: NOW });
    assert.ok(clout.length >= 5 && clout.every((c, i) => c.rank === i + 1));
    assert.ok(clout.find((c) => c.user.username === 'rager').tags.includes('COOKED'));
    assert.ok(await db.get('SELECT 1 FROM arena_clout_weeks WHERE week = ?', [drama._test.weekStart(NOW)]), "the week's snapshot is kept for next week's moves");

    // Feed and rap sheet.
    const feed = await drama.feed({ limit: 50 });
    assert.ok(feed.length >= 7 && feed.every((s) => s.headline && s.user));
    const sheet = await drama.rapSheet(rager);
    assert.deepStrictEqual([sheet.counts.rage_quit, sheet.counts.title_drama, sheet.opted_out], [1, 1, false]);

    // A beef reports itself.
    const beefId = await drama.beefStory('open', { id: 991, a_user_id: crasher, b_user_id: screamer }, { about: 'his aim', opening_line: 'you could not hit a barn' });
    const b = await drama.story(beefId);
    assert.deepStrictEqual([b.kind, b.user.username, b.other.username, b.headline], ['beef_open', 'crasher', 'screamer', '🥩 BEEF: crasher vs screamer']);

    // Opting out hides the old stories and stops new ones.
    await drama.setOptOut(rager, true);
    assert.ok(!(await drama.feed({ limit: 50 })).some((s) => s.user.id === rager));
    assert.strictEqual(await drama.createStory({ kind: 'marathon', userId: rager, dedupeKey: 'marathon:test', facts: { hours: 9, started: 'x' }, happenedAt: NOW }), null);
    await drama.setOptOut(rager, false);
    assert.ok(await drama.createStory({ kind: 'marathon', userId: rager, dedupeKey: 'marathon:test', facts: { hours: 9, started: 'x' }, happenedAt: NOW }));

    // The AI rewrite: taken when it names everyone exactly (case aside), dropped when it misspells a name.
    const arenaSvc = require('../server/arena/arena-service');
    const aiSvc = require('../server/ai/ai-service');
    arenaSvc.aiOn = async () => true;
    let answer = { headline: '🚨 GHOST STREAMS 90 MINUTES TO NOBODY', blurb: 'Peak 0. Chat 0. Brutal.', alert: 2 };
    aiSvc.structured = async (workflow, input) => { assert.strictEqual(workflow, 'live.arena.drama'); assert.strictEqual(input.streamer, 'ghost'); assert.match(input.what, /^Peak: 0 viewers\. Chat messages: 0\.$/); return answer; };
    const g1 = await drama.createStory({ kind: 'ghost_town', userId: ghost, dedupeKey: 'ai:1', facts: { minutes: 90, peak: 0, messages: 0 }, happenedAt: NOW });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(await db.get('SELECT headline, ai FROM arena_drama WHERE id = ?', [g1]), { headline: '🚨 GHOST STREAMS 90 MINUTES TO NOBODY', ai: 1 });
    answer = { headline: '🚨 GOSTY STREAMS TO NOBODY', blurb: 'x', alert: 2 };
    const g2 = await drama.createStory({ kind: 'ghost_town', userId: ghost, dedupeKey: 'ai:2', facts: { minutes: 90, peak: 0, messages: 0 }, happenedAt: NOW });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(await db.get('SELECT headline, ai FROM arena_drama WHERE id = ?', [g2]), { headline: '👻 ghost STREAMED 90 MINUTES TO AN EMPTY ROOM', ai: 0 }, 'a misspelled name keeps the template');

    // The meltdown quote: the heated line near the shouting beats a longer mundane one.
    const { pickQuote } = drama._test;
    assert.strictEqual(pickQuote([
        { text: 'so the charge on each capacitor of the panel decides what you see on the screen today', start_sec: 95 },
        { text: 'bro why does this keep happening to me', start_sec: 128 },
        { text: 'ok', start_sec: 130 },
    ], 100, 160), 'bro why does this keep happening to me');
    assert.strictEqual(pickQuote([{ text: 'ok', start_sec: 1 }], 0, 10), null, 'too short to quote');

    console.log('arena-drama: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
