'use strict';
/**
 * GET /api/streams/following: the ids of channels live right now that the signed-in viewer follows (the home's
 * Following chip, Live market outcome 3). Private: never cached by a browser or the edge. Signed out: 401.
 *   node test/streams-following.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
console.warn = () => {};
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const db = require('../server/db/database');
// The route's own requireAuth reads a token; here a header names the signed-in user instead.
const auth = require('../server/auth/auth');
auth.requireAuth = (req, res, next) => {
    const id = Number(req.headers['x-test-user']);
    if (!id) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id };
    return next();
};

(async () => {
    await db.initDb();
    const mk = async (username) => {
        await db.createUser({ username, display_name: username, stream_key: username.padEnd(32, '0') });
        return Number((await db.get('SELECT id FROM users WHERE username = ?', [username])).id);
    };
    const ts = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
    const stream = async (userId, live) => db.run(
        `INSERT INTO streams (user_id, title, protocol, is_live, started_at, ended_at, created_at) VALUES (?, ?, 'webrtc', ?, ?, ?, ?)`,
        [userId, `${userId} stream`, live ? 1 : 0, ts(60000), live ? null : ts(30000), ts(60000)]);
    const follow = async (follower, streamer) => db.run('INSERT INTO follows (follower_id, streamer_id) VALUES (?, ?)', [follower, streamer]);

    const viewer = await mk('viewer'), bob = await mk('bob'), carol = await mk('carol'), dave = await mk('dave');
    await stream(bob, true);      // followed, live
    await stream(carol, true);    // live, not followed
    await stream(dave, false);    // followed, not live
    await follow(viewer, bob);
    await follow(viewer, dave);

    const app = express();
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const out = await fetch(`${base}/api/streams/following`);
        assert.strictEqual(out.status, 401, 'signed out: 401');

        const me = await fetch(`${base}/api/streams/following`, { headers: { 'x-test-user': String(viewer) } });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.headers.get('cache-control'), 'private, no-store', 'never cached');
        assert.deepStrictEqual((await me.json()).user_ids, [bob], 'only followed channels that are live now');

        const nobody = await fetch(`${base}/api/streams/following`, { headers: { 'x-test-user': String(carol) } });
        assert.deepStrictEqual((await nobody.json()).user_ids, [], 'following nobody live: an empty list');
        console.log('streams following: all checks passed');
    } finally {
        server.close();
        await db.closeDb?.();
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
