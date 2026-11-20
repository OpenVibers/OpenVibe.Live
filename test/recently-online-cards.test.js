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
         VALUES (?, ?, ?, 'webrtc', ?, 0, to_char(now() - make_interval(mins => ?), 'YYYY-MM-DD HH24:MI:SS'), ${live ? 'NULL' : "to_char(now() - make_interval(mins => ?), 'YYYY-MM-DD HH24:MI:SS')"}, ?, ov_now()) RETURNING id`,
        live ? [uid, ms, 'LIVE NOW', 1, startedAgo, thumb] : [uid, ms, 'old', 0, startedAgo, endedAgo, thumb]);
    // Ended streams whose stored picture is the deleted live capture, on one slot.
    const picOld = Number((await stream(pic, picSlot, { startedAgo: 3000, endedAgo: 2900, thumb: '/api/thumbnails/stream-9101-1.jpg' })).lastInsertRowid);
    const picNew = Number((await stream(pic, picSlot, { startedAgo: 600, endedAgo: 500, thumb: '/api/thumbnails/stream-9102-2.jpg' })).lastInsertRowid);
    // An ended stream with no slot and no recording anywhere.
    const novId = Number((await stream(nov, null, { startedAgo: 700, endedAgo: 650, thumb: '/api/thumbnails/stream-9103-3.jpg' })).lastInsertRowid);
    // 11-20 (RePlayer009, VOD 6632): recorded, then the streamer deleted the replay (the delete route notes it).
    const del = await mk('deleter');
    const delId = Number((await stream(del, null, { startedAgo: 800, endedAgo: 780 })).lastInsertRowid);
    await db.run("UPDATE streams SET replay_removed_at = ov_now(), replay_removed_by = 'streamer' WHERE id = ?", [delId]);
    // A live stream: its capture still exists.
    await stream(liv, livSlot, { live: true, startedAgo: 10, thumb: '/api/thumbnails/stream-9104-live.jpg' });
    await stream(probe, probeSlot, { startedAgo: 400, endedAgo: 350, thumb: '/api/thumbnails/stream-9105-probe.jpg' });

    // A stored card line in the old shape (name first, colon, two sentences).
    await db.run("INSERT INTO streamer_overviews (user_id, overview, overview_short, model, sources, generated_at) VALUES (?, ?, ?, 'x', '{}', ov_now())",
        [pic, 'picasso streams late-night Rust raids with the whole crew: zergs, door-camping and betrayals. The chat runs the raid targets.', 'picasso streams late-night Rust raids with the whole crew: zergs, door-camping and betrayals.']);

    // The stored old-shape line is refreshed by the job that rewrites stored overviews (no AI call).
    assert.ok(await db.shapeStoredStreamerOverviewShorts(50) >= 1);
    assert.match((await db.getStreamerOverview(pic)).overview_short, CHANNEL_LINE_RE, 'stored line reshaped in place');

    // Media: the slot's newest recording (VOD 9) is the newer stream's. The older stream was recorded in two parts
    // (a reconnect), the first with no picture yet; the loose stream has none, and Media says so.
    const media = require('../server/media-client');
    media.request = async (method, p) => {
        assert.strictEqual(p, '/vods/latest-thumbs');
        return { thumbs: { [picSlot]: { vod_id: 9, thumbnail_url: '/t/vod-9-new.jpg', audio_only: true } } };
    };
    const lookups = require('../server/media-proxy/lookups');
    let asked = null;
    lookups.publicPartsForStreams = async (ids) => {
        asked = ids.slice().sort((a, b) => a - b);
        return new Map([
            [picOld, [{ id: 7, duration_seconds: 40, thumbnail_url: null, audio_only: false }, { id: 8, duration_seconds: 20.4, thumbnail_url: '/t/vod-8.jpg', audio_only: false }]],
            [picNew, [{ id: 9, duration_seconds: 32, thumbnail_url: '/t/vod-9-new.jpg', audio_only: true }]],
            [novId, []],
            [delId, []],
        ]);
    };
    lookups.publicVodsForStreams = async () => new Map();

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
        assert.strictEqual(body.streamers.length, 4, 'the probe is counted out too');

        // Media is asked about the ended rows only, by their own stream ids.
        assert.deepStrictEqual(asked, [picOld, picNew, novId, delId].sort((a, b) => a - b));
        // A replay its streamer deleted says so; a stream never recorded says nothing of the kind.
        const d = by('deleter').recent_facts.streams[0];
        assert.deepStrictEqual([d.recorded, d.replay_removed], [false, 'streamer'], 'deleted by the streamer, not "Not recorded"');
        assert.strictEqual(n.recent_facts.streams[0].replay_removed, undefined);
        // Each replay row is its own stream's recording, never the slot's newest (Maticus, 2026-11-17).
        assert.strictEqual(p.recent_facts.streams.length, 2);
        const [newer, older] = p.recent_facts.streams;
        assert.deepStrictEqual([newer.id, older.id], [picNew, picOld]);
        assert.ok(String(newer.thumbnail_url).endsWith('/t/vod-9-new.jpg'), newer.thumbnail_url);
        assert.deepStrictEqual([newer.vod_id, newer.recorded, newer.recorded_seconds, newer.audio_only], [9, true, 32, true], 'audio-only says so with a field');
        // Two parts: the row opens the first and counts both; the picture is the first part that has one.
        assert.deepStrictEqual([older.vod_id, older.recorded, older.recorded_seconds, older.audio_only], [7, true, 60, false]);
        assert.ok(String(older.thumbnail_url).endsWith('/t/vod-8.jpg'), older.thumbnail_url);
        // No recording: Media's "none" is said; nulls, never a dead address.
        assert.strictEqual(n.recent_facts.streams.length, 1);
        assert.deepStrictEqual(
            [n.recent_facts.streams[0].thumbnail_url, n.recent_facts.streams[0].vod_id, n.recent_facts.streams[0].audio_only, n.recent_facts.streams[0].recorded],
            [null, null, null, false]);
        // Live: the capture stays.
        const liveRow = l.recent_facts.streams.find((h) => h.is_live);
        assert.ok(liveRow, 'the live row is listed');
        assert.strictEqual(liveRow.thumbnail_url, '/api/thumbnails/stream-9104-live.jpg');
        assert.strictEqual(liveRow.audio_only, null, 'a live row never borrows an old recording\u2019s flag');
        assert.deepStrictEqual([liveRow.vod_id, liveRow.recorded], [null, null], 'a live row claims no recording');

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
