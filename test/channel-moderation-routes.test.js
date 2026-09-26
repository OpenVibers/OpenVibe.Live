/**
 * The dashboard's channel moderation routes (server/admin/channel-mod-routes.js), for the chat
 * parity gaps of roadmap WS-I task 6:
 *   - the dashboard's slow mode is saved in slow_mode_seconds (it sent slowmode_seconds, which no
 *     writer knows, so it was never saved) and sub-only mode is a saved setting like the others;
 *   - deleting one message reaches every surface that shows it: the streamer's whole channel room
 *     (every live slot, the offline room, a channel popout) and the global feed.
 *
 * The real router on a temp database; only sign-in is stubbed (x-test-user) and the chat server's
 * broadcasts are recorded.
 *
 *   node test/channel-moderation-routes.test.js
 */
'use strict';
const assert = require('assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `ov-chanmod-${process.pid}.db`);
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

const auth = require('../server/auth/auth');
auth.requireAuth = (req, res, next) => {
    const u = db.getUserById(Number(req.headers['x-test-user'] || 0));
    if (!u) return res.status(401).json({ error: 'Authentication required' });
    req.user = u; req.authSource = 'network';
    next();
};

// What the routes push to browsers.
const chatServer = require('../server/chat/chat-server');
const sent = [];
for (const fn of ['broadcastToStream', 'broadcastToChannelRoom', 'forwardToGlobal', 'forwardToGlobalByChannel', 'broadcastGlobal']) {
    chatServer[fn] = (...args) => { sent.push([fn, ...args.slice(0, -1), args[args.length - 1].type]); };
}

const addUser = (id, username, role) => raw.prepare("INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'x', ?)").run(id, username, username, `${username}@x`, role);
addUser(1, 'streamer', 'streamer');
addUser(2, 'moddy', 'user');
addUser(3, 'viewer', 'user');
db.ensureChannel(1);
const channel = db.getChannelByUserId(1);
raw.prepare('INSERT INTO channel_moderators (channel_id, user_id, added_by) VALUES (?, ?, ?)').run(channel.id, 2, 1);
const streamId = Number(db.createStream({ user_id: 1, channel_id: channel.id, title: 'Live', protocol: 'webrtc' }).lastInsertRowid);
const liveLine = Number(db.saveChatMessage({ stream_id: streamId, channel_user_id: 1, user_id: 3, username: 'viewer', message: 'while live' }).lastInsertRowid);
const offlineLine = Number(db.saveChatMessage({ stream_id: null, channel_user_id: 1, user_id: 3, username: 'viewer', message: 'while offline' }).lastInsertRowid);

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/channels', require('../server/admin/channel-mod-routes'));
const server = http.createServer(app).listen(0);

function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ port: server.address().port, path: p, method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack || e.message); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));
    const settings = () => db.getChannelModerationSettings(channel.id);

    await check('the dashboard saves slow mode in slow_mode_seconds (the old slowmode_seconds too)', async () => {
        let r = await call('PUT', `/api/channels/${channel.id}/moderation`, 1, { slow_mode_seconds: 7 });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(settings().slow_mode_seconds, 7);
        assert.strictEqual(r.json.settings.slow_mode_seconds, 7);
        r = await call('PUT', `/api/channels/${channel.id}/moderation`, 1, { slowmode_seconds: 4 });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(settings().slow_mode_seconds, 4, 'a cached dashboard that still sends slowmode_seconds');
    });

    await check('sub-only mode is a saved channel setting: the owner and a channel mod may set it, a viewer may not', async () => {
        assert.strictEqual(settings().sub_only, 0, 'off by default');
        assert.strictEqual((await call('PUT', `/api/channels/${channel.id}/moderation`, 3, { sub_only: true })).status, 403);
        assert.strictEqual(settings().sub_only, 0);
        let r = await call('PUT', `/api/channels/${channel.id}/moderation`, 2, { sub_only: true });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([settings().sub_only, settings().slow_mode_seconds], [1, 4], 'set; the rest kept');
        r = await call('PUT', `/api/channels/${channel.id}/moderation`, 1, { sub_only: false, followers_only: true });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([settings().sub_only, settings().followers_only], [0, 1]);
        const other = db.ensureChannel(3) || db.getChannelByUserId(3);
        r = await call('PUT', `/api/channels/${other.id}/moderation`, 3, { sub_only: 1 });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(db.getChannelModerationSettings(other.id).sub_only, 1, 'a channel with no settings row yet');
    });

    await check('deleting a line reaches the whole channel room and the global feed', async () => {
        sent.length = 0;
        let r = await call('POST', `/api/channels/${channel.id}/moderation/messages/${liveLine}/delete`, 2);
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(sent, [
            ['broadcastToChannelRoom', 1, streamId, 'delete-messages'],
            ['forwardToGlobal', streamId, 'delete-messages'],
        ]);
        sent.length = 0;
        r = await call('POST', `/api/channels/${channel.id}/moderation/messages/${offlineLine}/delete`, 2);
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(sent, [
            ['broadcastToChannelRoom', 1, null, 'delete-messages'],
            ['forwardToGlobalByChannel', 1, 'delete-messages'],
        ], 'an offline line: the channel room (popout, channel page) and the global feed');
        assert.strictEqual(db.getChatMessageById(offlineLine).is_deleted, 1);
    });

    server.close();
    try { db.getDb().close(); } catch { /* */ }
    for (const f of ['', '-wal', '-shm']) { try { require('fs').rmSync(process.env.DB_PATH + f, { force: true }); } catch { /* */ } }
    quiet(failures ? `channel moderation routes: ${failures} failed` : 'channel moderation routes: all checks passed');
    process.exit(failures ? 1 : 0);
})();
