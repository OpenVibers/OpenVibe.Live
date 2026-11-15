'use strict';
// Flagged speech, the staff queue (plan §AD.11 item 3): global mods and admins read the windows the hard floor flagged
// (newest first, by status) and mark each one cleared or handled, or back to open; nobody else sees the queue.
// openvibe.network/admin reads it through /api/admin/streamer-mod → /api/mod.
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const auth = require('../server/auth/auth');
    const signIn = async (req) => {
        const id = Number(req.headers['x-test-user'] || 0);
        const u = id ? await db.getUserById(id) : null;
        if (u) { req.user = u; req.authSource = 'network'; }
        return u;
    };
    auth.requireAuth = (req, res, next) => { signIn(req).then((u) => (u ? next() : res.status(401).json({ error: 'Authentication required' }))).catch(next); };
    const addUser = async (id, username, role) => raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?)`).run(id, username, username, `${username}@x`, role);
    await addUser(71, 'modmia', 'global_mod');
    await addUser(72, 'streamsam', 'streamer');
    await addUser(73, 'viewervic', 'user');

    const flags = require('../server/admin/transcript-flags');
    await flags.record({ rule: 'minors', src: 'https://media.openvibe.live/vods/801/vod.mp4?sig=S', startSec: 600, ref: { kind: 'vod', id: '801', userId: 72 } });
    await flags.record({ rule: 'consent', src: 'https://media.openvibe.live/clips/9/c.mp4', startSec: 12.4, ref: { kind: 'clip', id: '9', userId: 72 } });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/mod', require('../server/admin/mod-routes'));
    const server = http.createServer(app).listen(0);
    const call = (method, p, user, body) => new Promise((resolve, reject) => {
        const req = http.request({ port: server.address().port, path: p, method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });

    try {
        assert.strictEqual((await call('GET', '/api/mod/transcript-flags')).status, 401, 'signed out');
        assert.strictEqual((await call('GET', '/api/mod/transcript-flags', 73)).status, 403, 'a viewer');
        assert.strictEqual((await call('GET', '/api/mod/transcript-flags', 72)).status, 403, 'the streamer whose recording it is');

        let r = await call('GET', '/api/mod/transcript-flags', 71);
        assert.strictEqual(r.status, 200);
        assert.match(r.headers['cache-control'], /no-store/);
        assert.strictEqual(r.json.open, 2);
        assert.deepStrictEqual(r.json.flags.map((f) => [f.kind, f.rule, f.start_sec, f.url, f.channel && f.channel.username]),
            [['clip', 'consent', 12, '/clip/9?t=12', 'streamsam'], ['vod', 'minors', 600, '/vod/801?t=600', 'streamsam']], 'newest first, each opened at its second');

        const clipFlag = r.json.flags[0].id;
        r = await call('POST', `/api/mod/transcript-flags/${clipFlag}`, 72, { status: 'cleared' });
        assert.strictEqual(r.status, 403, 'only staff mark them');
        r = await call('POST', `/api/mod/transcript-flags/${clipFlag}`, 71, { status: 'gone' });
        assert.strictEqual(r.status, 422);
        r = await call('POST', '/api/mod/transcript-flags/999999', 71, { status: 'cleared' });
        assert.strictEqual(r.status, 404);
        r = await call('POST', `/api/mod/transcript-flags/${clipFlag}`, 71, { status: 'cleared' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.json.flag.status, r.json.flag.reviewed_by, !!r.json.flag.reviewed_at], ['cleared', 'modmia', true]);

        r = await call('GET', '/api/mod/transcript-flags', 71);
        assert.deepStrictEqual([r.json.open, r.json.flags.length, r.json.flags[0].kind], [1, 1, 'vod'], 'the open queue drops it');
        r = await call('GET', '/api/mod/transcript-flags?status=cleared', 71);
        assert.deepStrictEqual(r.json.flags.map((f) => f.id), [clipFlag]);
        r = await call('GET', '/api/mod/transcript-flags?status=all', 71);
        assert.strictEqual(r.json.flags.length, 2);

        r = await call('POST', `/api/mod/transcript-flags/${clipFlag}`, 71, { status: 'open' });
        assert.deepStrictEqual([r.json.flag.status, r.json.flag.reviewed_by, r.json.flag.reviewed_at], ['open', null, null], 'back in the queue');

        // Kept when the streamer's account is deleted, like bans: a moderation record.
        assert.ok(require('../server/auth/account-data').RETAIN.has('transcript_flags'));
        console.log('transcript-flags-queue: staff read the flagged speech and mark it; nobody else sees it');
    } finally {
        server.close();
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
