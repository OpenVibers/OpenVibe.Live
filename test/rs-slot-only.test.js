/**
 * RobotStreamer is configured per stream slot only.
 *
 *  - A stream uses its slot's robotstreamer_integrations row and nothing else. An account-level
 *    row (no managed_stream_id, 5 of 8 in production before scripts/rs-integrations-to-slots.js)
 *    is logged and skipped, never used and never a crash: the old fallback sent every slot
 *    without its own row to the same robot.
 *  - validate / login / save / remove need a slot (400 without one); GET without a slot answers
 *    only the passthrough capability, never the account-level row; no account-level row is
 *    written any more.
 *  (scripts/rs-integrations-to-slots.js, tested in rs-integrations-to-slots.test.js, moves the
 *  account-level rows onto slots before this ships.)
 *
 *   node test/rs-slot-only.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-rs-slot-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const quiet = console.log;
const warnings = [];
console.log = () => {};
console.warn = (...a) => { warnings.push(a.join(' ')); };

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));

const addUser = (id, name) => raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'streamer')`).run(id, name, name, `${name}@x`);
const slot = (userId, slug) => Number(db.createManagedStream({ user_id: userId, slug, title: slug, stream_key: `key-${userId}-${slug}` }).lastInsertRowid);
const rsRow = (userId, slotId, fields = {}) => Number(raw.prepare(
    `INSERT INTO robotstreamer_integrations (user_id, managed_stream_id, enabled, token, robot_id, stream_name, chat_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, slotId, fields.enabled ?? 1, fields.token ?? 'tok', fields.robot_id ?? null, fields.stream_name ?? null, 'wss://chat.example').lastInsertRowid);
const accountRow = (userId) => raw.prepare('SELECT * FROM robotstreamer_integrations WHERE user_id = ? AND managed_stream_id IS NULL').get(userId);

// User 1 has three slots (like production's user 1: slots 1/60/85), an enabled account-level row
// and robot 777 configured on slot "second" only.
addUser(1, 'alex');
const a1 = slot(1, 'main'), a2 = slot(1, 'second'), a3 = slot(1, 'third');
const r1 = rsRow(1, null, { robot_id: '777', stream_name: 'Robot' });
const r1slot = rsRow(1, a2, { robot_id: '777' });
// User 2 owns slot b1 (for the ownership check).
addUser(2, 'solo');
const b1 = slot(2, 'only');

let server;
(async () => {
    // ── Runtime: slot-only, account rows skipped (not crashing) ──────────────────────
    const rs = require('../server/integrations/robotstreamer-service');
    assert.strictEqual(db.getRobotStreamerIntegrationForStream(1, a2).id, r1slot, 'a slot uses its own row');
    assert.strictEqual(db.getRobotStreamerIntegrationForStream(1, a1), null, 'a slot without a row does NOT fall back to the account-level row');
    assert.strictEqual(db.getRobotStreamerIntegrationForStream(1, null), null, 'a slot-less stream gets no RobotStreamer');
    assert.strictEqual(warnings.filter((w) => /account-level RobotStreamer row/.test(w)).length, 1, 'the unmigrated row is logged once per user');
    assert.ok(warnings.some((w) => w.includes(`(${r1})`) && w.includes('rs-integrations-to-slots')), 'the log names the row and the script');
    assert.strictEqual(rs.getIntegrationForStream({ id: 1, user_id: 1, managed_stream_id: a3 }), null);
    assert.strictEqual(await rs.startForStream({ id: 99, user_id: 1, managed_stream_id: a1, protocol: 'webrtc' }), null, 'going live on a slot without a row starts nothing');
    assert.strictEqual(await rs.refreshIntegration(1, null), null, 'no account-level refresh');
    assert.throws(() => db.upsertRobotStreamerIntegration(1, { enabled: 1 }, null), /stream slot/, 'no account-level row is written');
    await assert.rejects(rs.upsertIntegration(1, { enabled: 1 }, null), /stream slot/);

    // ── Routes ───────────────────────────────────────────────────────────────────────
    rs.validateConfiguration = async ({ token, robotInput }) => {
        if (!token) throw new Error('RobotStreamer token is required');
        return { fields: { token, robot_id: String(robotInput), stream_name: `Robot ${robotInput}`, last_validated_at: new Date().toISOString() }, availableRobots: [{ robot_id: String(robotInput), viewers: 3 }] };
    };
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/robotstreamer', require('../server/integrations/routes'));
    server = http.createServer(app).listen(0);
    const call = (method, p, user, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ port: server.address().port, path: p, method, headers: { 'content-type': 'application/json', 'x-test-user': String(user) } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });

    let r = await call('GET', '/api/robotstreamer/integration', 1);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.exists, false, 'GET without a slot does not return the account-level row');
    assert.strictEqual(r.json.integration.robot_id, '', 'the account-level robot is not shown as if it applied');
    assert.ok('passthrough' in r.json.integration, 'GET without a slot still says whether the server relays the video');
    r = await call('GET', `/api/robotstreamer/integration?managed_stream_id=${a2}`, 1);
    assert.strictEqual(r.json.exists, true);
    assert.strictEqual(r.json.integration.robot_id, '777');

    for (const [method, p, body] of [
        ['POST', '/api/robotstreamer/integration/validate', { robot_input: '777' }],
        ['POST', '/api/robotstreamer/integration/login', { user_name: 'u', password: 'p' }],
        ['PUT', '/api/robotstreamer/integration', { enabled: true, token: 't', robot_input: '1' }],
        ['DELETE', '/api/robotstreamer/integration', null],
    ]) {
        r = await call(method, p, 1, body);
        assert.strictEqual(r.status, 400, `${method} ${p} without a slot is refused`);
        assert.match(r.json.error, /stream slot/);
    }
    // The old validate-without-slot path read the account token; with a slot it uses only the slot's.
    r = await call('POST', '/api/robotstreamer/integration/validate', 1, { robot_input: '888', managed_stream_id: a1 });
    assert.strictEqual(r.status, 400, 'slot a1 has no token of its own, and the account token is not borrowed');
    r = await call('POST', '/api/robotstreamer/integration/validate', 1, { robot_input: '777', managed_stream_id: a2 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.integration.managed_stream_id, a2);
    r = await call('PUT', '/api/robotstreamer/integration', 1, { enabled: true, token: 'fresh', robot_input: '888', managed_stream_id: a1 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.getRobotStreamerIntegrationBySlot(1, a1).robot_id, '888', 'saving with a slot writes that slot\'s row');
    assert.strictEqual(accountRow(1).robot_id, '777', 'and leaves the account-level row alone');
    r = await call('PUT', '/api/robotstreamer/integration', 1, { enabled: true, robot_input: '1', managed_stream_id: b1 });
    assert.strictEqual(r.status, 403, 'another user\'s slot is refused');
    server.close();

    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('rs-slot-only: ok');
    process.exit(0);
})().catch((err) => {
    quiet(err);
    try { server && server.close(); } catch { /* */ }
    process.exit(1);
});
