'use strict';
// GET /api/streams/recently-online says who is live right now (server/streaming/routes.js): a streamer live on a slot
// gets `live` (started_at, viewer count summed over their live slots, title), that slot is marked is_live with its frame
// and listed first; an offline streamer gets neither. The home card reads them (public/js/app-home.js
// renderRecentlyOnline): LIVE instead of "last online 22h ago".
//   node --import ./test/helpers/pg-preload.mjs test/recently-online-live.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
console.warn = () => {};
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const db = require('../server/db/database');
(async () => {
    await db.initDb();
    const mk = async (username) => { await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') }); const id = (await db.get('SELECT id FROM users WHERE username = ?', [username])).id; await db.ensureChannel(id); return id; };
    const izor = await mk('izor'), quiet1 = await mk('quietone');
    const slot = async (uid, slug) => Number((await db.run('INSERT INTO managed_streams (user_id, slug, title, protocol, stream_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ov_now(), ov_now()) RETURNING id', [uid, slug, `${slug} title`, 'webrtc', `${slug}-key-${uid}`])).lastInsertRowid);
    const ranked = await slot(izor, 'ranked'), chill = await slot(izor, 'chill'), q = await slot(quiet1, 'main');
    const stream = async (uid, ms, { live = false, startedAgo, endedAgo = null, viewers = 0 }) => await db.run(
        `INSERT INTO streams (user_id, managed_stream_id, title, protocol, is_live, viewer_count, started_at, ended_at, thumbnail_url, created_at)
         VALUES (?, ?, ?, 'webrtc', ?, ?, to_char(now() - make_interval(mins => ?), 'YYYY-MM-DD HH24:MI:SS'), ${live ? 'NULL' : "to_char(now() - make_interval(mins => ?), 'YYYY-MM-DD HH24:MI:SS')"}, ?, ov_now())`,
        live ? [uid, ms, 'DUO RANKED', 1, viewers, startedAgo, 'https://openvibe.media/live/frame.jpg'] : [uid, ms, 'old', 0, 0, startedAgo, endedAgo, null]);
    await stream(izor, chill, { startedAgo: 3000, endedAgo: 2900 });
    await stream(izor, ranked, { startedAgo: 2000, endedAgo: 1900 });
    await stream(izor, ranked, { live: true, startedAgo: 120, viewers: 7 });
    await stream(quiet1, q, { startedAgo: 600, endedAgo: 500 });

    const app = express();
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/streams/recently-online?limit=10`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        const iz = body.streamers.find((s) => s.username === 'izor');
        const qu = body.streamers.find((s) => s.username === 'quietone');
        assert.ok(iz && qu, JSON.stringify(body.streamers.map((s) => s.username)));
        assert.deepStrictEqual([iz.live && iz.live.viewer_count, iz.live && iz.live.title], [7, 'DUO RANKED']);
        assert.deepStrictEqual(iz.managed_streams.map((m) => [m.slug, !!m.is_live]), [['ranked', true], ['chill', false]], 'the live slot first');
        assert.strictEqual(iz.managed_streams[0].live_thumbnail, 'https://openvibe.media/live/frame.jpg');
        assert.ok(!qu.live && !qu.managed_streams.some((m) => m.is_live), 'an offline streamer is not live');
        console.log('recently-online live: all checks passed');
    } finally { server.close(); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
