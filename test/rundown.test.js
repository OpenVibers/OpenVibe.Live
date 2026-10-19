'use strict';
/**
 * The Rundown (server/rundown/, docs/rundown.md) on a temp DB with a stubbed OpenVibe.AI:
 *   filters      game lines, verbatim quotes, invented accusations, topic identity
 *   the desk     a stretch without game lines goes to the AI; segments keep only verified quotes, drop invented
 *                accusations, name streamers by whole name; topics join by name; an ended stream becomes an episode
 *                (announced once); a topic with takes from two streamers gets its page; a live stream waits for enough
 *                talk; an opted-out streamer is never read
 *   reads        the front page, topics, a topic, an episode, a streamer, reactions, opt-out and staff hiding
 *   the API      GET /api/rundown and /t/:slug, POST /react as a signed-out reader; old /arena links
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const db = require('../server/db/database');

(async () => {
await db.initDb();
const filters = require('../server/rundown/filters');
const desk = require('../server/rundown/desk');
const read = require('../server/rundown/read');

// ── Filters ──
assert.ok(filters.gameLine('You have slain an enemy.'), 'the League announcer');
assert.ok(filters.gameLine('Victory!') && filters.gameLine('An enemy has been slain') && filters.gameLine('Welcome to Summoner\'s Rift'));
assert.ok(!filters.gameLine('I got first blood on that guy and chat lost it'), 'a sentence about the game is the streamer');
assert.ok(filters.gameLine("I've been slain.") && filters.gameLine('The first blood!'), 'the announcer as speech-to-text hears it');
const src = 'This is why having the internet inside of a refrigerator is a bad idea.\nThe hackers got in with the date as the password.';
assert.strictEqual(filters.verifiedQuote('“having the internet inside of a refrigerator is a bad idea”', src), 'having the internet inside of a refrigerator is a bad idea');
assert.strictEqual(filters.verifiedQuote('internet fridges are a terrible idea', src), null, 'a paraphrase is not a quote');
assert.strictEqual(filters.verifiedQuote('bad idea', src), null, 'too short to be a line');
assert.strictEqual(filters.verifiedQuote('You have slain an enemy', 'You have slain an enemy'), null, 'a game line is never a quote');
assert.ok(filters.addsAccusation('goosely threatened the fridge company', src), 'an accusation the transcript never made');
assert.ok(!filters.addsAccusation('hackers got into French fridges', src), 'the transcript said hackers');
assert.ok(!filters.addsAccusation('French fridges got hacked', src), 'hacked: the same root as the transcript\'s hackers');
assert.strictEqual(filters.slugify('Supermarket fridges hacked in France!'), 'supermarket-fridges-hacked-in-france');
for (const t of ['back around eight mountain time', 'famous because of the school newspaper', 'I went to school today', 'call 555 123 4567', 'mail me at a@b.co', 'we live at 1420 Maple Street']) assert.ok(filters.privateDetail(t), `private: ${t}`);
for (const t of ['First blood was mine', 'This is my favourite ride', 'Supermarket fridges hacked in France']) assert.ok(!filters.privateDetail(t), `not private: ${t}`);
assert.ok(filters.sameTopic('League ranked matchmaking', 'Ranked matchmaking in League'));
assert.ok(!filters.sameTopic('League ranked matchmaking', 'Moving apartments'));
['chat', 'Games', 'life', 'Just chatting', 'the stream', 'x'].forEach((t) => assert.ok(filters.vagueTopic(t), `vague: ${t}`));
assert.ok(!filters.vagueTopic('League ranked matchmaking') && !filters.vagueTopic('Halloween'));
['Frustration and chaos in the match', 'Talking with chat and teammates', 'Commands, builds and mid-game criticism', 'Mid-game rage'].forEach((t) => assert.ok(filters.vagueTopic(t), `a mood or the play: ${t}`));
['Briar in League', 'Theme park rides', 'Boxing fight night', 'Minecraft base building', 'League autofill'].forEach((t) => assert.ok(!filters.vagueTopic(t), `a subject: ${t}`));
console.log('✅ filters: game lines, verbatim quotes, accusations, topics');

// ── People and streams ──
const mk = async (username, display) => { await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: display || username, stream_key: username.padEnd(32, '0') }); const id = (await db.get('SELECT id FROM users WHERE username = ?', [username])).id; await db.ensureChannel(id); return id; };
const goose = await mk('goosely', 'goosely'), izor = await mk('iZoR_One'), jax = await mk('Jax_eats_tacks'), shy = await mk('shyone');
const stream = async (uid, { live = false, startedAgoMin = 180, endedAgoMin = 60, title = 'Tech news' } = {}) => {
    const id = Number((await db.createStream({ user_id: uid, title, category: 'Science & Technology', protocol: 'rtmp' })).lastInsertRowid);
    await db.run(`UPDATE streams SET is_live = ?, started_at = datetime('now', ?), ended_at = ${live ? 'NULL' : "datetime('now', ?)"}, duration_seconds = ?, peak_viewers = 6 WHERE id = ?`,
        live ? [1, `-${startedAgoMin} minutes`, (startedAgoMin) * 60, id] : [0, `-${startedAgoMin} minutes`, `-${endedAgoMin} minutes`, (startedAgoMin - endedAgoMin) * 60, id]);
    return id;
};
const speak = async (streamId, uid, lines, from = 0) => db.addTimelineEvents(lines.map((text, i) => ({ stream_id: streamId, user_id: uid, vod_id: 900 + streamId, kind: 'speech', start_sec: from + i * 10, end_sec: from + i * 10 + 8, text, label: null, confidence: 0.9 })));
const filler = (n, say) => Array.from({ length: n }, (_, i) => `${say} number ${i}, and that is all I have to say about it right now chat.`);

await stream(jax, { startedAgoMin: 3000, endedAgoMin: 2900, title: 'Tacos' });   // a streamer (no transcript), so their name can be said
const s1 = await stream(goose);
await speak(s1, goose, [
    'Okay chat, the news today is about supermarket fridges in France getting hacked.',
    'You have slain an enemy.',
    'This is why having the internet inside of a refrigerator is a bad idea.',
    'The hackers got in because the password was literally the date.',
    'Jax_eats_tacks would never put his fridge on the internet, right?',
    ...filler(20, 'Fridge thought'),
]);
const sShy = await stream(shy);
await speak(sShy, shy, filler(30, 'Shy line'));
await db.run('INSERT INTO arena_opt_outs (user_id) VALUES (?) ON CONFLICT DO NOTHING', [shy]);

// ── A stubbed OpenVibe.AI, budget and chat ──
const llm = require('../server/ai/llm');
llm.isEnabled = async () => true;
llm.withinBudget = async () => true;
const calls = [];
const answers = {
    'live.rundown.segment': (input) => ({ segments: input.streamer === 'goosely' ? [
        { start: 0, end: 40, topic: 'Supermarket fridges hacked in France', kind: 'tech', title: 'French fridges get hacked', what: 'goosely read about supermarket fridges in France getting hacked.', take: 'Putting the internet in a fridge is a bad idea.',
            quip: 'Somewhere a fridge is reading this.', score: 4, quotes: [{ t: 20, text: 'having the internet inside of a refrigerator is a bad idea', en: null }, { t: 20, text: 'fridges deserve rights', en: null }, { t: 10, text: 'You have slain an enemy', en: null }] },
        { start: 40, end: 60, topic: 'Fridge security', kind: 'tech', title: 'goosely threatens fridge makers', what: 'An invented threat.', take: null, quip: 'x', score: 3, quotes: [] },
        { start: 60, end: 240, topic: 'League ranked matchmaking', kind: 'games', title: 'Ranked is pain', what: 'goosely talked about ranked.', take: null, quip: 'goosely attacked the ladder.', score: 3, quotes: [] },
        { start: 240, end: 250, topic: 'Coffee', kind: 'life', title: 'Filler bit', what: 'goosely got a coffee.', take: null, quip: 'x', score: 2, quotes: [] },
    ] : [
        { start: 0, end: 100, topic: 'Supermarket fridges hacked in France', kind: 'tech', title: 'iZoR_One weighs in on the fridge hack', what: 'iZoR_One also talked about the hacked fridges.', take: 'Fridges should stay dumb.', quip: 'A rare unity.', score: 3, quotes: [] },
    ] }),
    'live.rundown.episode': (input) => ({ title: 'The Fridge Files', logline: 'A night of cold takes.', recap: 'goosely opened with French fridges.\n\nThen ranked.', chapters: [{ index: 0, title: 'Fridges' }, { index: 1, title: 'Ranked' }, { index: 9, title: 'Nope' }] }),
    'live.rundown.topic': () => ({ headline: 'Two streamers agree fridges should stay offline', summary: 'goosely and iZoR_One both think internet fridges are a bad idea.' }),
};
require('../server/ai/ai-service').structured = async (workflow, input) => { calls.push({ workflow, input }); return answers[workflow] ? answers[workflow](input) : null; };
const announced = [];
require('../server/chat/chat-delivery').message = async (line) => { announced.push(line); return true; };

// ── The desk: segments ──
desk._test.reset();
await desk.tick();
const segCalls = calls.filter((c) => c.workflow === 'live.rundown.segment');
assert.strictEqual(segCalls.length, 1, 'one stretch read; the opted-out streamer never');
assert.ok(!segCalls[0].input.lines.some((l) => /slain an enemy/.test(l.text)), 'the game line never reaches the AI');
assert.strictEqual(segCalls[0].input.streamer, 'goosely');
assert.strictEqual((await db.get('SELECT done FROM rundown_progress WHERE stream_id = ?', [sShy])).done, 1, 'an opted-out streamer is marked done, unread');
const segs = await db.all('SELECT * FROM rundown_segments WHERE stream_id = ? ORDER BY start_sec', [s1]);
assert.strictEqual(segs.length, 2, 'the invented threat dropped its segment');
assert.deepStrictEqual(JSON.parse(segs[0].quotes_json).map((q) => q.text), ['having the internet inside of a refrigerator is a bad idea'], 'only the verbatim, non-game quote stays');
assert.deepStrictEqual(segs[0].mentions.map(Number), [Number(jax)], 'Jax_eats_tacks was named by whole name');
assert.strictEqual(segs[1].quip, null, 'a quip with an accusation the transcript never made is dropped');
assert.strictEqual(Number(segs[0].vod_id), 900 + s1);
const fridge = await db.get("SELECT * FROM rundown_topics WHERE slug = 'supermarket-fridges-hacked-in-france'");
assert.ok(fridge && fridge.takes === 1 && fridge.streamers === 1 && fridge.kind === 'tech');
console.log('✅ desk: game lines out, verified quotes, invented accusations dropped, whole-name mentions, topics');

// ── The desk: the episode, announced once ──
await desk.tick();
const ep = await db.get('SELECT * FROM rundown_episodes WHERE stream_id = ?', [s1]);
assert.ok(ep, 'the ended stream became an episode');
assert.strictEqual(ep.title, 'The Fridge Files');
assert.strictEqual(ep.recap, 'goosely opened with French fridges.\n\nThen ranked.');
assert.deepStrictEqual(JSON.parse(ep.chapters_json).map((c) => [c.title, Number(c.segment_id)]), [['Fridges', Number(segs[0].id)], ['Ranked', Number(segs[1].id)]], 'chapters name real segments');
assert.strictEqual(announced.length, 1);
assert.match(announced[0].message, /^📰 goosely: “The Fridge Files” → .*\/rundown\/e\/\d+$/);
assert.strictEqual((await db.get('SELECT done FROM rundown_progress WHERE stream_id = ?', [s1])).done, 1);
const before = calls.length;
await desk.tick();
assert.strictEqual(calls.length, before, 'nothing left to read or write');
console.log('✅ desk: an ended stream is an episode with real chapters, announced once');

// ── A live stream waits for enough talk; a second streamer on the same topic gets the topic its page ──
const s2 = await stream(izor, { live: true, startedAgoMin: 30, title: 'Ranked' });
await speak(s2, izor, ['Short hello chat.']);
await desk.tick();
assert.strictEqual(calls.filter((c) => c.input && c.input.streamer === 'iZoR_One').length, 0, 'a live stream with a few words waits');
await speak(s2, izor, filler(70, 'Those hacked fridges should stay dumb'), 100);
await desk.tick();
assert.strictEqual(calls.filter((c) => c.workflow === 'live.rundown.segment' && c.input.streamer === 'iZoR_One').length, 1, 'enough talk: read');
const fridge2 = await db.get('SELECT * FROM rundown_topics WHERE id = ?', [fridge.id]);
assert.deepStrictEqual([fridge2.takes, fridge2.streamers], [2, 2], 'the same topic name joined the topic');
assert.strictEqual(fridge2.summary, 'goosely and iZoR_One both think internet fridges are a bad idea.', 'two takes: the topic page is written');
assert.ok(!await db.get('SELECT 1 FROM rundown_episodes WHERE stream_id = ?', [s2]), 'no episode while live');
console.log('✅ desk: live streams wait for talk; topics gather streamers and get their page');

// ── Reads ──
const home = await read.home({ viewer: 'anon:t' });
assert.ok(home.latest.some((x) => x.type === 'episode' && x.title === 'The Fridge Files'), 'the episode is in the latest');
assert.ok(home.latest.some((x) => x.type === 'segment' && x.title === 'French fridges get hacked'), 'a score-4 take is in the latest');
assert.ok(!await db.get("SELECT 1 FROM rundown_segments WHERE title = 'Filler bit'"), 'a score-2 segment is filler: not kept');
assert.ok(!home.latest.some((x) => x.title === 'Ranked is pain'), 'a score-3 take without a name is not on the front page');
assert.strictEqual(home.trending[0].slug, 'supermarket-fridges-hacked-in-france');
assert.strictEqual(home.trending[0].streamers, 2);
assert.deepStrictEqual(Object.keys(home.latest[0].user).sort(), ['avatar_url', 'display_name', 'id', 'profile_color', 'username'], 'a person is five fields, never a users row');
assert.ok(home.lead && home.lead.score >= 4, 'the lead is a take scored 4 or 5');
const fridgeNight = home.streams.find((x) => x.stream_id === s1);
assert.ok(fridgeNight && fridgeNight.episode && fridgeNight.episode.title === 'The Fridge Files', 'stream by stream: a stream carries its episode');
assert.ok(home.streams.every((x) => x.takes.length >= 1 && x.takes.length <= 3 && !x.takes.some((k) => k.id === home.lead.id)), 'at most 3 takes a stream, never the lead again');
assert.ok(home.streams.every((x) => x.takes.every((k, i) => i === 0 || x.takes[i - 1].sec <= k.sec)), 'a stream\'s takes in the order they were said');
assert.ok(home.streams.some((x) => x.live && x.user.username === 'iZoR_One' && !x.episode), 'a live stream shows what it has so far');
assert.deepStrictEqual(Object.keys(fridgeNight.user).sort(), ['avatar_url', 'display_name', 'id', 'profile_color', 'username']);
const older = await read.streamsFeed({ before: home.streams[0].last_at });
assert.ok(!older.streams.some((x) => x.stream_id === home.streams[0].stream_id), 'the next page starts after the first stream');
assert.ok(home.on_air.some((x) => x.user.username === 'iZoR_One' && x.talking_about), 'on air, with what they are talking about');
assert.ok(home.voices.some((v) => v.user.username === 'goosely' && v.top_topics.length));
const t = await read.topic('supermarket-fridges-hacked-in-france');
assert.strictEqual(t.takes.length, 2);
assert.ok(t.related.some((r) => r.slug === 'league-ranked-matchmaking'), 'came up alongside');
const e = await read.episode(s1);
assert.strictEqual(e.episode.title, 'The Fridge Files');
assert.strictEqual(e.segments.length, 2);
const g = await read.streamer('GOOSELY');
assert.strictEqual(g.episodes.length, 1);
assert.ok(g.lines.length >= 1 && g.crossovers.length === 1, 'their best line and the crossover naming Jax');
const j = await read.streamer('jax_eats_tacks');
assert.strictEqual(j.crossovers.length, 1, 'Jax sees being brought up');
let r = await read.react('segment', segs[0].id, 'anon:a', 'fire');
assert.deepStrictEqual([r.reactions.fire, r.mine], [1, 'fire']);
r = await read.react('segment', segs[0].id, 'anon:a', 'fire');
assert.deepStrictEqual([r.reactions.fire, r.mine], [undefined, null], 'the same reaction again takes it back');
await assert.rejects(read.react('segment', segs[0].id, 'anon:a', 'clown'), /Unknown reaction/);
console.log('✅ reads: front page, topic, episode, streamer, reactions');

// ── Opt-out and staff ──
await read.hide('segment', segs[1].id);
await read.setOptOut(goose, true);
assert.strictEqual((await read.streamer('goosely')).opted_out, true);
assert.ok(!(await read.home({})).latest.some((x) => x.user && x.user.username === 'goosely'), 'out: nothing about them on the front page');
const outHome = await read.home({});
assert.ok(!outHome.streams.some((x) => x.user.username === 'goosely') && !(outHome.lead && outHome.lead.user.username === 'goosely'), 'out: not in stream by stream or the lead');
await read.setOptOut(goose, false);
assert.strictEqual((await db.get('SELECT status FROM rundown_segments WHERE id = ?', [segs[0].id])).status, 'live', 'back: their take is back');
assert.strictEqual((await db.get('SELECT status FROM rundown_segments WHERE id = ?', [segs[1].id])).status, 'hidden', 'what staff took down stays down');
console.log('✅ opt-out and staff hiding');

// ── The API and old links ──
const routes = require('../server/rundown/routes');
assert.strictEqual(routes.arenaRedirect('/arena'), '/rundown');
assert.strictEqual(routes.arenaRedirect('/arena/goosely'), '/rundown/goosely');
assert.strictEqual(routes.arenaRedirect('/arena/drama/12'), '/rundown');
assert.strictEqual(routes.arenaRedirect('/arena/beef'), '/rundown');
assert.strictEqual(routes.arenaRedirect('/arena/live/goosely'), '/rundown');
const app = express();
app.use(express.json());
app.use('/api/rundown', routes);
const server = http.createServer(app);
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}/api/rundown`;
try {
    const front = await (await fetch(`${base}/`)).json();
    assert.ok(Array.isArray(front.latest) && front.trending.length >= 1 && front.counts.episodes === 1);
    assert.ok(Array.isArray(front.streams) && front.streams.length >= 1, 'stream by stream');
    const page2 = await (await fetch(`${base}/streams?before=${encodeURIComponent(front.streams[0].last_at)}`)).json();
    assert.ok(Array.isArray(page2.streams) && 'next' in page2);
    const topic = await fetch(`${base}/t/supermarket-fridges-hacked-in-france`);
    assert.strictEqual(topic.status, 200);
    assert.strictEqual((await fetch(`${base}/t/no-such-topic`)).status, 404);
    const react = await fetch(`${base}/react`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'episode', id: s1, reaction: 'lol' }) });
    assert.deepStrictEqual((await react.json()).reactions, { lol: 1 });
    assert.strictEqual((await fetch(`${base}/react`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'episode', id: 999999, reaction: 'lol' }) })).status, 404);
    assert.strictEqual((await fetch(`${base}/opt-out`)).status, 401, 'opting out needs an account');
} finally { server.close(); }
console.log('✅ API: front page, topic, reactions as a signed-out reader; old /arena links');

// ── Lines heard on 3+ streams (voice lines, hallucinations on silence) never reach the AI ──
{
    const echo = await mk('echoes');
    const ghost = 'Thanks for watching, and I\'ll see you in the next video.';
    for (let i = 0; i < 3; i++) { const old = await stream(echo, { startedAgoMin: 30 * 1440 + i, endedAgoMin: 30 * 1440 - 60 }); await speak(old, echo, [ghost]); }
    const fresh = await mk('freshone');
    const sf = await stream(fresh, { startedAgoMin: 200, endedAgoMin: 100, title: 'Fresh' });
    await speak(sf, fresh, [ghost, ...filler(25, 'My own words')]);
    desk._test.reset();
    await desk.tick();
    const c = calls.filter((x) => x.workflow === 'live.rundown.segment' && x.input.streamer === 'freshone');
    assert.strictEqual(c.length, 1);
    assert.ok(!c[0].input.lines.some((l) => /next video/.test(l.text)) && c[0].input.lines.some((l) => /My own words/.test(l.text)), 'the repeated line is out, their own words are in');
    console.log('✅ lines heard on three streams never reach the AI');
}

// ── A streamer's own languages; lines the AI says are not the streamer ──
{
    const gr = await mk('greekgamer');
    const old = await stream(gr, { startedAgoMin: 20 * 1440, endedAgoMin: 20 * 1440 - 60 });
    await speak(old, gr, [...Array.from({ length: 60 }, (_, i) => `Λοιπόν παιδιά πάμε ${i} τώρα`), ...Array.from({ length: 30 }, (_, i) => `bro push mid lane what are you doing ${i}`)]);
    const sg = await stream(gr, { startedAgoMin: 300, endedAgoMin: 200, title: 'Ranked' });
    await speak(sg, gr, [
        'Hoje eu acordei e essa bichinha estava assim no meu bode.',
        'Kneel before me or bleed out.',
        'No one can find the queen!',
        'bro this team is so bad I want to cry right now',
        ...Array.from({ length: 30 }, (_, i) => `Λοιπόν παιδιά πάμε για καφέ ${i} και μετά παίζουμε`),
    ]);
    const prev = answers['live.rundown.segment'];
    answers['live.rundown.segment'] = (input) => input.streamer !== 'greekgamer' ? prev(input) : {
        others: input.lines.filter((l) => /queen|Kneel/.test(l.text)).map((l) => l.t),
        segments: [
            { start: 10, end: 20, topic: 'Queen roleplay', kind: 'games', title: 'greekgamer plays a queen', what: 'greekgamer did a queen bit.', take: null, quip: 'Long live.', score: 4, quotes: [{ t: 20, text: 'No one can find the queen!', en: null }] },
            { start: 30, end: 400, topic: 'Bad teammates', kind: 'games', title: 'greekgamer and the team', what: 'greekgamer complained about the team.', take: 'The team is bad.', quip: 'Classic.', score: 4, quotes: [{ t: 20, text: 'No one can find the queen!', en: null }, { t: 30, text: 'this team is so bad I want to cry', en: null }] },
        ],
    };
    desk._test.reset();
    await desk.tick();
    const c = calls.filter((x) => x.workflow === 'live.rundown.segment' && x.input.streamer === 'greekgamer');
    assert.strictEqual(c.length, 1);
    assert.ok(!c[0].input.lines.some((l) => /Hoje eu acordei/.test(l.text)), 'a Portuguese clip on a Greek and English stream never reaches the AI');
    assert.ok(c[0].input.lines.some((l) => /Λοιπόν/.test(l.text)) && c[0].input.lines.some((l) => /team is so bad/.test(l.text)), 'their Greek and English stay');
    const kept = await db.all('SELECT title, quotes_json FROM rundown_segments WHERE stream_id = ? ORDER BY start_sec', [sg]);
    assert.deepStrictEqual(kept.map((k) => k.title), ['greekgamer and the team'], 'a segment built on the game\'s lines is dropped');
    assert.deepStrictEqual(JSON.parse(kept[0].quotes_json).map((q) => q.text), ['this team is so bad I want to cry'], 'a quote from a line that is not theirs is dropped');
    answers['live.rundown.segment'] = prev;
    console.log('✅ own languages and the AI\'s speaker labels');
}

// ── Details that place a person are never kept ──
{
    const teen = await mk('teenstreamer');
    const st = await stream(teen, { startedAgoMin: 200, endedAgoMin: 120, title: 'Theme park' });
    await speak(st, teen, ['I might live again later around eight mountain time okay chat', 'this ride is honestly the best ride in the whole park chat', ...filler(25, 'Ride talk')]);
    const prev = answers['live.rundown.segment'];
    answers['live.rundown.segment'] = (input) => input.streamer !== 'teenstreamer' ? prev(input) : { others: [], segments: [
        { start: 0, end: 5, topic: 'Streaming later tonight', kind: 'chat', title: 'Back at eight mountain time', what: 'teenstreamer will stream again around eight mountain time.', take: null, quip: 'x', score: 3, quotes: [] },
        { start: 5, end: 300, topic: 'chat', kind: 'life', title: 'The best ride in the park', what: 'teenstreamer loved a ride.', take: 'This ride is the best.', quip: 'See you after school.', score: 3,
            quotes: [{ t: 0, text: 'I might live again later around eight mountain time', en: null }, { t: 10, text: 'this ride is honestly the best ride in the whole park', en: null }] },
    ] };
    desk._test.reset();
    await desk.tick();
    const kept = await db.all('SELECT title, quip, quotes_json FROM rundown_segments WHERE stream_id = ?', [st]);
    assert.ok(!await db.get("SELECT 1 FROM rundown_topics WHERE slug = 'chat'"), 'a vague topic is never made');
    assert.deepStrictEqual(kept.map((k) => k.title), ['The best ride in the park'], 'a segment naming a time zone is dropped');
    assert.strictEqual(kept[0].quip, null, 'a quip about school is dropped');
    assert.deepStrictEqual(JSON.parse(kept[0].quotes_json).map((q) => q.text), ['this ride is honestly the best ride in the whole park'], 'a quote with a time zone is dropped');
    answers['live.rundown.segment'] = prev;
    console.log('✅ no time zones, schools, addresses or contact details');
}

// ── Limits: a stretch is at most MAX_LINES lines; a stretch the AI keeps refusing is skipped after three tries ──
{
    const greek = await mk('greekline');
    const sg = await stream(greek, { startedAgoMin: 400, endedAgoMin: 300, title: 'Short lines' });
    await speak(sg, greek, Array.from({ length: 500 }, (_, i) => `Έλα ${i} τώρα`));
    const refuse = answers['live.rundown.segment'];
    answers['live.rundown.segment'] = () => null;
    const seen = () => calls.filter((c) => c.workflow === 'live.rundown.segment' && c.input.streamer === 'greekline');
    await desk.tick();
    assert.ok(seen().length === 1 && seen()[0].input.lines.length <= desk.MAX_LINES, `at most ${desk.MAX_LINES} lines: ${seen()[0] && seen()[0].input.lines.length}`);
    assert.ok(!await db.get('SELECT 1 FROM rundown_progress WHERE stream_id = ?', [sg]), 'a refused stretch is tried again');
    await desk.tick();
    await desk.tick();
    assert.strictEqual(seen().length, 3);
    const p = await db.get('SELECT read_to_sec FROM rundown_progress WHERE stream_id = ?', [sg]);
    assert.ok(p && p.read_to_sec > 0, 'refused three times: the stretch is skipped');
    answers['live.rundown.segment'] = refuse;
    console.log('✅ limits: lines per stretch, refused stretches skipped after three tries');
}

// ── Play-by-play: a stream keeps its best 2 takes on a topic (and 2 with no topic) ──
{
    const gamer = await mk('leaguenight');
    const sl = await stream(gamer, { startedAgoMin: 500, endedAgoMin: 420, title: 'Ranked' });
    await speak(sl, gamer, filler(60, 'Autofill again'));
    const prev = answers['live.rundown.segment'];
    const seg = (start, topic, title, score) => ({ start, end: start + 5, topic, kind: 'games', title, what: `leaguenight on ${title}.`, take: null, quip: null, score, quotes: [] });
    answers['live.rundown.segment'] = (input) => input.streamer !== 'leaguenight' ? prev(input) : { others: [], segments: [
        seg(0, 'League autofill', 'Autofill A', 3), seg(10, 'League autofill', 'Autofill B', 4), seg(20, 'League autofill', 'Autofill C', 3), seg(30, 'League autofill', 'Autofill D', 5),
    ] };
    desk._test.reset();
    await desk.tick();
    const titles = async (cond) => (await db.all(`SELECT title FROM rundown_segments WHERE stream_id = ? AND ${cond} ORDER BY title`, [sl])).map((r) => r.title);
    assert.deepStrictEqual(await titles('topic_id IS NOT NULL'), ['Autofill B', 'Autofill D'], 'the best two takes on a topic stay');
    assert.strictEqual(Number((await db.get("SELECT takes FROM rundown_topics WHERE slug = 'league-autofill'")).takes), 2, 'the topic counts what stayed');
    await db.run('DELETE FROM rundown_progress WHERE stream_id = ?', [sl]);
    answers['live.rundown.segment'] = (input) => input.streamer !== 'leaguenight' ? prev(input) : { others: [], segments: [
        seg(40, 'Frustration and chaos in the match', 'Rage A', 3), seg(50, 'Mid-game rage', 'Rage B', 3), seg(60, 'Talking with chat and teammates', 'Rage C', 4),
    ] };
    desk._test.reset();
    await desk.tick();
    assert.deepStrictEqual(await titles('topic_id IS NULL'), ['Rage B', 'Rage C'], 'a mood is no topic, and 2 such takes a stream at most');
    assert.ok(!await db.get("SELECT 1 FROM rundown_topics WHERE slug LIKE 'frustration%' OR slug LIKE 'talking-with%'"));
    answers['live.rundown.segment'] = prev;
    console.log('✅ play-by-play: 2 takes a stream on a topic, moods are no topic');
}

console.log('rundown: ok');
process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
