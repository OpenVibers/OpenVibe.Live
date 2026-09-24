'use strict';

// Staff may moderate someone else's stream or slot (edit, end, delete) but never the site owner's, and
// never act as its streamer: stream keys, the ingest endpoint and heartbeats stay with the streamer.

const assert = require('assert');
const os = require('os');
const path = require('path');
const http = require('http');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `ov-staff-scope-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
console.log = () => {}; console.warn = () => {}; console.error = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();
const auth = require('../server/auth/auth');
const signIn = (req) => { const id = Number(req.headers['x-test-user'] || 0); const u = id ? db.getUserById(id) : null; if (u) req.user = u; return u; };
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

const addUser = (id, name, role, isOwner = 0) => raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner, stream_key)
    VALUES (?, ?, ?, ?, 'x', ?, ?, ?)`).run(id, name, name, `${name}@x`, role, isOwner, `key-${name}`);
addUser(1, 'siteowner', 'admin', 1);
addUser(2, 'anadmin', 'admin');
addUser(3, 'streamer', 'streamer');
const slotOf = (uid, slug) => Number(db.createManagedStream({ user_id: uid, slug, title: slug, protocol: 'webrtc', stream_key: `sk-${slug}` }).lastInsertRowid);
const slotStreamer = slotOf(3, 's3');
const slotOwner = slotOf(1, 's1');
const liveOf = (uid, ms) => Number(db.createStream({ user_id: uid, managed_stream_id: ms, title: 't', protocol: 'webrtc' }).lastInsertRowid);
const streamStreamer = liveOf(3, slotStreamer);
const streamOwner = liveOf(1, slotOwner);

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/streams', require('../server/streaming/routes'));
const server = http.createServer(app);

function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'x-test-user': String(user), 'content-type': 'application/json' } }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
}

server.listen(0, '127.0.0.1', async () => {
    try {
        // Moderation of another streamer's slot: allowed for an admin.
        assert.notStrictEqual(await call('PUT', `/api/streams/managed/${slotStreamer}`, 2, { title: 'moderated' }), 403, 'an admin may edit another streamer\'s slot');
        // ...but never the site owner's.
        assert.strictEqual(await call('PUT', `/api/streams/managed/${slotOwner}`, 2, { title: 'x' }), 403, 'an admin may not edit the owner\'s slot');
        assert.strictEqual(await call('PUT', `/api/streams/${streamOwner}`, 2, { title: 'x' }), 403, 'an admin may not edit the owner\'s live stream');
        assert.strictEqual(await call('DELETE', `/api/streams/${streamOwner}`, 2), 403, 'an admin may not end the owner\'s stream');
        // Acting as the streamer: never, not even for admins.
        assert.strictEqual(await call('POST', `/api/streams/managed/${slotStreamer}/regenerate-key`, 2), 403, 'an admin may not regenerate someone else\'s stream key');
        assert.strictEqual(await call('GET', `/api/streams/${streamStreamer}/endpoint`, 2), 403, 'an admin may not read someone else\'s ingest endpoint');
        assert.strictEqual(await call('POST', `/api/streams/${streamStreamer}/heartbeat`, 2), 403, 'an admin may not heartbeat someone else\'s stream');
        // The streamer keeps everything on their own stream.
        assert.notStrictEqual(await call('GET', `/api/streams/${streamStreamer}/endpoint`, 3), 403);
        assert.notStrictEqual(await call('POST', `/api/streams/managed/${slotStreamer}/regenerate-key`, 3), 403);
        // Even the site owner does not act as another streamer.
        assert.strictEqual(await call('POST', `/api/streams/managed/${slotStreamer}/regenerate-key`, 1), 403);
        console.info('staff stream scope: all checks passed');
    } finally { server.close(); try { fs.rmSync(tmp, { force: true }); } catch { /* */ } }
});
