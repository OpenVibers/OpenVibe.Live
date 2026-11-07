'use strict';
/**
 * The Rundown's bar: search and filters (design 2026-11-06, section 4; server/rundown/browse.js).
 *
 *   search     finds a quote, a take and a streamer by prefix; a phrase in quotes is a phrase
 *   filters    every one of them narrows the results, and the counts follow
 *   no results the page is told which filter to drop, and which topics are closest
 *   the words   come from the tsvector columns the search migration fills (0031_rundown_search.sql)
 *
 *   node test/rundown-search.test.js
 */
const assert = require('assert');
process.env.NODE_ENV = 'test';
const db = require('../server/db/database');

(async () => {
await db.initDb();
const browse = require('../server/rundown/browse');

const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString().slice(0, 19).replace('T', ' ');
const mk = async (username, display) => {
    await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: display || username, stream_key: username.padEnd(32, '0') });
    const id = Number((await db.get('SELECT id FROM users WHERE username = ?', [username])).id);
    await db.ensureChannel(id);
    return id;
};
const stream = async (uid, title) => {
    const id = Number((await db.createStream({ user_id: uid, title, category: 'Science & Technology', protocol: 'rtmp' })).lastInsertRowid);
    await db.run("UPDATE streams SET is_live = 0, started_at = datetime('now', '-180 minutes'), ended_at = datetime('now', '-60 minutes'), duration_seconds = 3600 WHERE id = ?", [id]);
    return id;
};
const topic = async (slug, title, kind = 'tech') => {
    await db.run("INSERT INTO rundown_topics (slug, title, kind, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", [slug, title, kind, ago(600), ago(10)]);
    return Number((await db.get('SELECT id FROM rundown_topics WHERE slug = ?', [slug])).id);
};
const take = async (o) => {
    await db.run(`INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, take, quip, score, quotes_json, mentions, vod_id, said_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.stream, o.user, o.topic, o.sec || 10, 20, o.title, o.what || 'what they said', o.take || null, o.quip || null, o.score || 4,
        JSON.stringify(o.quotes || []), o.mentions || [], o.vod || null, o.said]);
    return Number((await db.get('SELECT MAX(id) AS id FROM rundown_segments')).id);
};

const goose = await mk('goosely', 'goosely');
const baron = await mk('baron_k', 'Baron');
const izor = await mk('izor', 'iZoR_One');
const sA = await stream(goose, 'Fridge night');
const sB = await stream(baron, 'Matchmaking night');
const sC = await stream(izor, 'Quiet night');
const tFridge = await topic('french-fridges-hacked', 'French fridges hacked');
const tLeague = await topic('league-ranked-matchmaking', 'League ranked matchmaking', 'games');

const s1 = await take({ stream: sA, user: goose, topic: tFridge, title: 'The fridge of the future', what: 'they talked about fridges and hacking', take: 'fridges will be hacked by the state', quip: 'the desk had thoughts', score: 5,
    quotes: [{ text: 'the fridge of the future is now', en: null, sec: 12 }], vod: 555, said: ago(30) });
const s2 = await take({ stream: sA, user: izor, topic: tLeague, title: 'Ranked matchmaking is broken again', what: 'they talked about ranked', said: ago(60 * 24 * 3), said_at: ago(60 * 24 * 3) });
await db.run('UPDATE rundown_segments SET said_at = ? WHERE id = ?', [ago(60 * 24 * 3), s2]);
const s3 = await take({ stream: sB, user: baron, topic: tFridge, title: 'Someone else broke a fridge', what: 'a fridge story', mentions: [goose], said: ago(120) });
await db.run('INSERT INTO rundown_episodes (stream_id, user_id, title, logline, recap, minutes, aired_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [sA, goose, 'Fridge night, written up', 'all about fridges and the state', 'a recap', 60, ago(90)]);

// ── The words are in the index ──
const vec = await db.get('SELECT search_tsv IS NOT NULL AS ok FROM rundown_segments WHERE id = ?', [s1]);
assert.ok(vec.ok, 'the search migration filled the take\'s words');
const found = await db.get("SELECT id FROM rundown_segments WHERE id = ? AND search_tsv @@ websearch_to_tsquery('english', 'fridge')", [s1]);
assert.ok(found, 'a take is found by its topic\'s name');

// ── Search finds a quote, a take and a streamer by prefix ──
let r = await browse.browse({ q: 'fridge' });
assert.ok(r.takes.some((x) => x.id === s1), 'search finds a take by the quote it carries');
assert.ok(r.takes.some((x) => x.id === s3), 'and a take on the same topic by its name');
assert.ok(r.episodes.some((e) => e.title === 'Fridge night, written up'), 'and the episode by its logline');

r = await browse.browse({ q: 'fridge of the future' });
assert.ok(r.takes.some((x) => x.id === s1), 'the whole phrase is in the quote');

r = await browse.browse({ q: 'fridge of the future is now' });
assert.ok(r.takes.some((x) => x.id === s1), 'a phrase in quotes is a phrase: the whole line matches');

r = await browse.browse({ q: '"fridge future"' });
assert.ok(!r.takes.some((x) => x.id === s1), 'a phrase is a phrase: the words in another order do not match');

r = await browse.browse({ q: '"future fridge"' });
assert.ok(!r.takes.some((x) => x.id === s1), 'and not the other way round either');

r = await browse.browse({ q: 'now fridge of the future' });
assert.ok(r.takes.some((x) => x.id === s1), 'words without quotes are all of them, in any order');

r = await browse.browse({ q: 'ranked' });
assert.ok(r.takes.some((x) => x.id === s2), 'search finds a take by its title');
assert.ok(!r.takes.some((x) => x.id === s1), 'and only that one');

r = await browse.browse({ q: 'goos' });
assert.ok(r.streamers.some((p) => p.username === 'goosely'), 'a streamer is found by prefix');
assert.ok(r.takes.some((x) => x.id === s1), 'and their takes come with them');

r = await browse.browse({ q: 'baron_k' });
assert.ok(r.streamers.some((p) => p.username === 'baron_k'), 'the exact name works too');

// ── Every filter narrows ──
const ids = (d) => d.takes.map((x) => x.id).sort((a, b) => a - b);

r = await browse.browse({});
assert.deepStrictEqual(ids(r), [s1, s2, s3].sort((a, b) => a - b), 'no filter: everything');
assert.strictEqual(r.counts.takes, 3, 'the count line knows how many takes there are');
assert.strictEqual(r.counts.take_people, 3, 'and how many streamers said them');

r = await browse.browse({ streamer: 'goosely' });
assert.deepStrictEqual(ids(r), [s1], 'the streamer filter narrows to their takes');

r = await browse.browse({ topic: 'french-fridges-hacked' });
assert.deepStrictEqual(ids(r), [s1, s3].sort((a, b) => a - b), 'the topic filter narrows to its takes');

r = await browse.browse({ when: 'day' });
assert.deepStrictEqual(ids(r), [s1, s3].sort((a, b) => a - b), 'the when filter narrows to today');
r = await browse.browse({ when: 'week' });
assert.deepStrictEqual(ids(r), [s1, s2, s3].sort((a, b) => a - b), 'and to the week');

r = await browse.browse({ video: '1' });
assert.deepStrictEqual(ids(r), [s1], 'with video: only the takes that jump to a moment');

r = await browse.browse({ q: 'fridge', show: 'episodes' });
assert.ok(r.episodes.some((e) => e.title === 'Fridge night, written up'), 'the show chip: episodes');
assert.strictEqual(r.takes.length, 0, 'and no takes with it');
r = await browse.browse({ q: 'fridge', show: 'topics' });
assert.ok(r.topics.some((t) => t.slug === 'french-fridges-hacked'), 'the show chip: topics');
assert.strictEqual(r.takes.length, 0, 'and no takes with it');
assert.strictEqual(r.episodes.length, 0, 'and no episodes with it');

r = await browse.browse({ show: 'episodes' });
assert.strictEqual(r.episodes.length, 1, 'one episode');
assert.strictEqual(r.episodes[0].takes_total, 2, 'the episode counts its takes');
assert.ok(r.episodes[0].takes.length >= 1, 'and sends them, so the fold can open in place');

r = await browse.browse({ mentions: '1' }, { viewer: { key: 'user:1', userId: goose } });
assert.deepStrictEqual(ids(r), [s3], 'mentions me: the takes that name you');

// ── Nothing matches: the page is told which filter to drop, and which topics are closest ──
r = await browse.browse({ q: 'fridge', streamer: 'izor' });
assert.strictEqual(r.takes.length, 0, 'a streamer and a word that do not meet: nothing');
assert.ok(r.suggestion, 'the page is given a way out');
assert.strictEqual(r.suggestion.drop, 'streamer', 'the filter to drop is the one that costs the most');
assert.ok(r.suggestion.topics.some((t) => t.slug === 'french-fridges-hacked'), 'and the closest topics by name');

// ── The state is read from the query string, and nothing else reaches the database ──
assert.deepStrictEqual(browse.parse({ q: 'x', streamer: 'a,b', topic: 'T', when: 'week', show: 'takes', sort: 'reacted', video: '1' }),
    { q: 'x', streamer: ['a', 'b'], topic: 't', when: 'week', show: 'takes', sort: 'reacted', video: true, following: false, mentions: false, kind: '' });
assert.deepStrictEqual(browse.parse({ when: 'century', show: 'everything', sort: 'random' }).when, null, 'an unknown when is dropped');
assert.deepStrictEqual(browse.parse({ show: 'everything' }).show, null, 'an unknown show is dropped');
assert.deepStrictEqual(browse.parse({ sort: 'random' }).sort, 'newest', 'an unknown sort falls back to the newest');
assert.strictEqual(browse.parse({ q: "'; drop table users; --" }).q, "'; drop table users; --", 'the words are words, not SQL');
assert.ok(browse.isFiltered(browse.parse({ q: 'x' })), 'a search is a filter');
assert.ok(!browse.isFiltered(browse.parse({})), 'an empty bar is not a filter');

console.log('rundown search: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
