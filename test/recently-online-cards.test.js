'use strict';
// GET /api/streams/recently-online cards (server/streaming/routes.js): a replay row's picture is its
// recording's durable thumbnail — streams.thumbnail_url is the stream's last live capture
// (/api/thumbnails/stream-*.jpg), deleted when the stream ends, so every replay row named a 404
// (owner, 2026-11-10). With no recording the row carries nulls instead of an address that fails;
// a live row keeps its capture. Every card carries the same five numbers, present or null, and its
// line in the one channel shape (server/ai/channel-line.js).
//   node --import ./test/helpers/pg-preload.mjs test/recently-online-cards.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
console.warn = () => {};
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const db = require('../server/db/database');
const { CHANNEL_LINE_RE } = require('../server/ai/channel-line');
const KEYS = ['streams_this_week', 'hours_this_week', 'usual_time', 'days_in_a_row', 'last_stream_seconds'];

(async () => {
    await db.initDb();
    const mk = async (username) => { await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') }); const id = (await db.get('SELECT id FROM users WHERE username = ?', [username])).id; await db.ensureChannel(id); return id; };
    const pic = await mk('picasso'), nov = await mk('novod'), liv = await mk('liveone'), probe = await mk('ovprobe_recently');
    const slot = async (uid, slug) => Number((await db.run('INSERT INTO managed_streams (user_id, slug, title, protocol, stream_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ov_now(), ov_now()) RETURNING id', [uid, slug, `${slug} title`, 'webrtc', `${slug}-key-${uid}`])).lastInsertRowid);
    const picSlot = await slot(pic, 'main'), livSlot = await slot(liv, 'main'), probeSlot = await slot(probe, 'main');
    // A test account (OpenVibe.Network users.is_test) with a stream must never be a public card.
    await db.run('UPDATE users SET is_test = 1 WHERE id = ?', [probe]);
    const stream = async (uid, ms, { live = false, startedAgo, endedAgo = null, thumb = null }) => await db.run(
        `INSERT INTO streams (user_id, managed_stream_id, title, protocol, is_live, viewer_count, started_at, ended_at, thumbnail_url, created_at)
         VALUES (?, ?, ?, 'webrtc', ?, 0, to_char(now() - make_interval(mins => ?), 'YYYY-MM-DD HH24:MI:SS'), ${live ? 'NULL' : "to_char(now() - make_interval(mins => ?), 'YYYY-MM-DD HH24:MI:SS')"}, ?, ov_now())`,
        live ? [uid, ms, 'LIVE NOW', 1, startedAgo, thumb] : [uid, ms, 'old', 0, startedAgo, endedAgo, thumb]);
    // Ended streams whose stored picture is the deleted live capture.
    await stream(pic, picSlot, { startedAgo: 3000, endedAgo: 2900, thumb: '/api/thumbnails/stream-9101-1.jpg' });
    await stream(pic, picSlot, { startedAgo: 600, endedAgo: 500, thumb: '/api/thumbnails/stream-9102-2.jpg' });
    // An ended stream with no slot and no recording anywhere.
    await stream(nov, null, { startedAgo: 700, endedAgo: 650, thumb: '/api/thumbnails/stream-9103-3.jpg' });
    // A live stream: its capture still exists.
    await stream(liv, livSlot, { live: true, startedAgo: 10, thumb: '/api/thumbnails/stream-9104-live.jpg' });
    await stream(probe, probeSlot, { startedAgo: 400, endedAgo: 350, thumb: '/api/thumbnails/stream-9105-probe.jpg' });

    // A stored card line in the old shape (name first, colon, two sentences).
    await db.run("INSERT INTO streamer_overviews (user_id, overview, overview_short, model, sources, generated_at) VALUES (?, ?, ?, 'x', '{}', ov_now())",
        [pic, 'picasso streams late-night Rust raids with the whole crew: zergs, door-camping and betrayals. The chat runs the raid targets.', 'picasso streams late-night Rust raids with the whole crew: zergs, door-camping and betrayals.']);

    // The stored old-shape line is refreshed by the job that rewrites stored overviews (no AI call).
    assert.ok(await db.shapeStoredStreamerOverviewShorts(50) >= 1);
    assert.match((await db.getStreamerOverview(pic)).overview_short, CHANNEL_LINE_RE, 'stored line reshaped in place');

    // Media: the slot's recording has a durable picture and is audio-only; the loose stream has no VOD.
    const media = require('../server/media-client');
    media.request = async (method, p) => {
        assert.strictEqual(p, '/vods/latest-thumbs');
        return { thumbs: { [picSlot]: { vod_id: 9, thumbnail_url: '/t/vod-9-new.jpg', audio_only: true } } };
    };
    require('../server/media-proxy/lookups').publicVodsForStreams = async () => new Map();

    const app = express();
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/streams/recently-online?limit=10`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        const by = (u) => body.streamers.find((s) => s.username === u);
        const p = by('picasso'), n = by('novod'), l = by('liveone');
        assert.ok(p && n && l, JSON.stringify(body.streamers.map((s) => s.username)));
        assert.strictEqual(by('ovprobe_recently'), undefined, 'a test account is never on Recently Online');
        assert.ok(!JSON.stringify(body).includes('ovprobe_recently'), 'the test account is nowhere in the public read');
        assert.strictEqual(body.streamers.length, 3, 'the probe is counted out too');

        // The replay rows picture the recording, not the deleted capture.
        assert.strictEqual(p.recent_facts.streams.length, 2);
        for (const h of p.recent_facts.streams) {
            assert.ok(String(h.thumbnail_url).endsWith('/t/vod-9-new.jpg'), h.thumbnail_url);
            assert.strictEqual(h.vod_id, 9);
            assert.strictEqual(h.audio_only, true, 'audio-only says so with a field');
        }
        // No recording: nulls, never a dead address.
        assert.strictEqual(n.recent_facts.streams.length, 1);
        assert.deepStrictEqual(
            [n.recent_facts.streams[0].thumbnail_url, n.recent_facts.streams[0].vod_id, n.recent_facts.streams[0].audio_only],
            [null, null, null]);
        // Live: the capture stays.
        const liveRow = l.recent_facts.streams.find((h) => h.is_live);
        assert.ok(liveRow, 'the live row is listed');
        assert.strictEqual(liveRow.thumbnail_url, '/api/thumbnails/stream-9104-live.jpg');
        assert.strictEqual(liveRow.audio_only, null, 'a live row never borrows an old recording\u2019s flag');

        // The same five numbers on every card, present or null.
        for (const s of body.streamers) {
            for (const k of KEYS) assert.ok(s.recent_facts[k] !== undefined, `${s.username}.${k}`);
            assert.ok(Array.isArray(s.recent_facts.streams) && s.recent_facts.streams.length <= 2);
        }
        assert.strictEqual(typeof p.recent_facts.streams_this_week, 'number');
        assert.strictEqual(n.recent_facts.usual_time, null, 'one stream: no usual time');
        assert.strictEqual(n.recent_facts.days_in_a_row, null, 'one stream: no streak');

        // The stored old-shape line is shaped on read.
        assert.match(p.ai_overview_short, CHANNEL_LINE_RE, p.ai_overview_short);
        assert.ok(!p.ai_overview_short.toLowerCase().startsWith('picasso'), p.ai_overview_short);
        assert.match(n.ai_overview_short, CHANNEL_LINE_RE, 'no stored overview: the fallback shape');

        console.log('recently-online cards: all checks passed');
    } finally { server.close(); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
