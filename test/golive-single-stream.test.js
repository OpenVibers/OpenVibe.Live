'use strict';
// One go-live per stream slot: two requests at once, or a repeat within 15 s while the stream is live, get the same
// stream instead of a second one. On 2026-10-17 one go-live made streams 2620 and 2621 in the same second: viewers'
// chat and TTS went to one while the phone studio sat in the other, and the RobotStreamer relay, started on both,
// delivered every line twice.
//
//   node test/golive-single-stream.test.js
const assert = require('assert');
const http = require('http');
process.env.NODE_ENV = 'test';
console.log = () => {};
console.warn = () => {};

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    // Requests carry their user in x-test-user (the auth middleware is replaced before the routes load).
    const auth = require('../server/auth/auth');
    const signIn = async (req) => { const u = await db.getUserById(Number(req.headers['x-test-user'] || 0)); if (u) req.user = u; return u; };
    auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = async (req, res, next) => { await signIn(req); next(); };
    // No outside integrations from a test: RobotStreamer, chat relays, AI viewers, go-live notices.
    require('../server/integrations/robotstreamer-service').startForStream = async () => {};
    require('../server/integrations/chat-relay-service').startForStream = async () => {};
    require('../server/streaming/live-events').announceGoLive = () => {};

    await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE VALUES (1, 'gooze', 'gooze', 'g@x', 'x', 'streamer')`).run();
    const channel = await db.ensureChannel(1);
    const slot = await db.createManagedStream({ user_id: 1, channel_id: channel.id, title: 'Main', protocol: 'webrtc', stream_key: 'k'.repeat(32) });
    const slotId = Number(slot.lastInsertRowid || slot.id);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const goLive = () => fetch(`http://127.0.0.1:${server.address().port}/api/streams`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': '1' }, body: JSON.stringify({ managed_stream_id: slotId, title: 'YO' }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const liveRows = async () => (await raw.prepare('SELECT id FROM streams WHERE managed_stream_id = ? AND is_live = 1').all(slotId)).map((r) => Number(r.id));

    try {
        // Two at once (a double tap): one stream, both answers name it.
        const [a, b] = await Promise.all([goLive(), goLive()]);
        assert.deepStrictEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a, b]));
        assert.strictEqual(a.body.stream.id, b.body.stream.id);
        assert.deepStrictEqual(await liveRows(), [Number(a.body.stream.id)], 'one live stream for the slot');
        assert.deepStrictEqual((a.status === 200 ? a : b).body.endpoint, { roomId: `stream-${a.body.stream.id}` }, 'the repeat gets the same room');

        // Asked again moments later while it is live: the same stream.
        const again = await goLive();
        assert.deepStrictEqual([again.status, again.body.stream.id, again.body.reused], [200, a.body.stream.id, true]);

        // Once that stream has ended, going live starts a new one.
        await raw.prepare('UPDATE streams SET is_live = 0, ended_at = ov_now() WHERE id = ?').run(a.body.stream.id);
        const next = await goLive();
        assert.strictEqual(next.status, 201);
        assert.notStrictEqual(next.body.stream.id, a.body.stream.id);
        // And a live stream older than 15 s is not taken for a repeat (a restart after a crash gets its own).
        await raw.prepare("UPDATE streams SET started_at = to_char(now() at time zone 'utc' - interval '60 seconds', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?").run(next.body.stream.id);
        assert.strictEqual((await goLive()).status, 201);
    } finally {
        server.close();
    }
    process.stdout.write('golive-single-stream: all checks passed\n');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
