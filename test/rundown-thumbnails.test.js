'use strict';
/**
 * The Rundown's stream cards carry a picture (server/rundown/read.js):
 *   a public VOD's thumbnail for an ended stream, the live frame for one on air,
 *   null for NSFW (the stream's own flag or the channel's force flag), and null
 *   when Media is down — the feed still answers 200.
 *
 *   node test/rundown-thumbnails.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
const db = require('../server/db/database');
const media = require('../server/media-client');
const lookups = require('../server/media-proxy/lookups');
const read = require('../server/rundown/read');

(async () => {
await db.initDb();

const mk = async (username) => {
    await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') });
    const id = Number((await db.get('SELECT id FROM users WHERE username = ?', [username])).id);
    await db.ensureChannel(id);
    return id;
};
const stream = async (uid, { live = false, nsfw = false, title = 'Tech news' } = {}) => {
    const id = Number((await db.createStream({ user_id: uid, title, category: 'Science & Technology', protocol: 'rtmp', is_nsfw: nsfw })).lastInsertRowid);
    await db.run(`UPDATE streams SET is_live = ?, started_at = datetime('now', '-90 minutes'), ended_at = ${live ? 'NULL' : "datetime('now', '-30 minutes')"}, duration_seconds = 3600 WHERE id = ?`, [live ? 1 : 0, id]);
    return id;
};
const take = (streamId, uid, saidAt) => db.run(
    `INSERT INTO rundown_segments (stream_id, user_id, start_sec, end_sec, title, what, score, said_at) VALUES (?, ?, 0, 10, 'A take', 'they talked about it', 5, ?)`,
    [streamId, uid, saidAt]);

const alice = await mk('alice'), bob = await mk('bob'), carol = await mk('carol'), dave = await mk('dave');
await db.run('UPDATE channels SET force_nsfw = 1 WHERE user_id = ?', [carol]);

const publicEnded = await stream(alice, { title: 'An ended public stream' });
const live = await stream(bob, { live: true, title: 'Live now' });
const nsfwEnded = await stream(dave, { nsfw: true, title: 'An ended NSFW stream' });
const forcedEnded = await stream(carol, { title: 'An ended force-NSFW stream' });
const plainEnded = await stream(alice, { title: 'An ended stream without a VOD' });
const nsfwLive = await stream(dave, { live: true, nsfw: true, title: 'NSFW live now' });
await db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', [`/api/thumbnails/stream-${live}-123.jpg`, live]);
await db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', [`/api/thumbnails/stream-${nsfwLive}-456.jpg`, nsfwLive]);
for (const [i, sid] of [publicEnded, live, nsfwEnded, forcedEnded, plainEnded, nsfwLive].entries()) await take(sid, [alice, bob, dave, carol, alice, dave][i], `2026-11-01 12:0${i}:00`);

// ── OpenVibe.Media stand-in: a public, finished VOD for every stream but plainEnded ──
const VODS = new Map();
for (const sid of [publicEnded, nsfwEnded, forcedEnded]) {
    VODS.set(sid, { id: 7000 + sid, stream_id: sid, visibility: 'public', is_recording: 0, clips_only: 0, thumbnail_url: `/t/vod-${sid}.jpg`, duration_seconds: 3600 });
}
let fail = false;
const asked = [];
media.listVods = async (q = {}) => {
    asked.push(Number(q.stream_id));
    if (fail) throw new media.MediaApiError('Media is down', 0);
    const v = VODS.get(Number(q.stream_id));
    return { vods: v ? [{ ...v }] : [], total: v ? 1 : 0 };
};

// ── The feed: a public VOD's picture, the live frame, and null where it must be ──
lookups._resetCaches();
asked.length = 0;
const feed = await read.streamsFeed({});
const byId = new Map(feed.streams.map((s) => [s.stream_id, s]));
assert.strictEqual(byId.get(publicEnded).thumbnail_url, media.publicUrl(`/t/vod-${publicEnded}.jpg`), 'a public VOD gives the card its picture');
assert.strictEqual(byId.get(live).thumbnail_url, `https://openvibe.live/api/thumbnails/stream-${live}-123.jpg`, 'a live stream shows its live frame, absolute');
assert.strictEqual(byId.get(nsfwEnded).thumbnail_url, null, 'streams.is_nsfw: no picture');
assert.strictEqual(byId.get(forcedEnded).thumbnail_url, null, 'the channel force flag: no picture');
assert.strictEqual(byId.get(plainEnded).thumbnail_url, null, 'no public VOD: no picture');
assert.strictEqual(byId.get(nsfwLive).thumbnail_url, null, 'a live NSFW stream: no picture');
assert.deepStrictEqual([...asked].sort((a, b) => a - b), [publicEnded, plainEnded].sort((a, b) => a - b), 'only the ended, non-NSFW streams ask Media');
console.log('✅ feed: public VOD, live frame, NSFW and no-VOD null');

// ── on air: the live frame, and null for an NSFW stream ──
const air = await read.onAir();
const airById = new Map(air.map((s) => [s.stream_id, s]));
assert.strictEqual(airById.get(live).thumbnail_url, `https://openvibe.live/api/thumbnails/stream-${live}-123.jpg`, 'on air: the live frame');
assert.strictEqual(airById.get(nsfwLive).thumbnail_url, null, 'on air: NSFW has no picture');
console.log('✅ on air: live frame, NSFW null');

// ── Media down: nulls, and the route still answers 200 ──
const app = express();
app.use(express.json());
app.use('/api/rundown', require('../server/rundown/routes'));
const server = http.createServer(app);
await new Promise((res) => server.listen(0, '127.0.0.1', res));
try {
    fail = true;
    lookups._resetCaches();
    asked.length = 0;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rundown/streams`);
    assert.strictEqual(res.status, 200, 'a Media failure never fails the feed');
    const body = await res.json();
    const down = new Map(body.streams.map((s) => [s.stream_id, s]));
    assert.strictEqual(down.get(publicEnded).thumbnail_url, null, 'Media down: the ended stream has no picture');
    assert.strictEqual(down.get(plainEnded).thumbnail_url, null);
    assert.strictEqual(down.get(live).thumbnail_url, `https://openvibe.live/api/thumbnails/stream-${live}-123.jpg`, 'Media down: live cards keep their own frame');
} finally {
    fail = false;
    lookups._resetCaches();
    server.close();
}
console.log('✅ Media down: null pictures, 200');
})().catch((err) => { console.error(err); process.exit(1); });
