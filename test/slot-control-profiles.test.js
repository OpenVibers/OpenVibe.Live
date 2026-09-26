/**
 * Legacy parity (roadmap D20): per-stream control profiles. Each stream slot (managed stream) keeps
 * its own control profile: whichever way a slot goes live, its stream gets that slot's buttons (the
 * channel default only when the slot has none), and editing one profile changes only the streams
 * bound to it.
 *
 * The fix it came with: an RTMP publish attached to ANY live RTMP stream of the user that was waiting
 * for an encoder. With two slots on RTMP, the second slot's encoder took over the first slot's stream,
 * rebound it to the second slot's profile, fed it from two encoders, and ended it when that encoder
 * disconnected, while the second slot never got a stream. A slot key now only picks up its own slot's
 * waiting stream (the account key: one no other encoder feeds).
 *
 * The real RTMP publish handlers (server/streaming/rtmp-server.js) run against a fake node-media-server
 * on a temp database; the control routes run in-process.
 *
 *   node test/slot-control-profiles.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-slot-controls-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
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
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

// ── a channel with four slots and three profiles ──
for (const [id, name] of [[3, 'alice'], [7, 'mallory']]) {
    raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, stream_key, created_at)
        VALUES (?, ?, ?, ?, 'x', 'streamer', ?, '2025-01-01 00:00:00')`).run(id, name, name, `${name}@x`, `personal${name}key01`);
}
const ch = db.ensureChannel(3);
db.ensureChannel(7);
const profile = (userId, name, buttons) => {
    const id = Number(db.createControlConfig({ user_id: userId, name }).lastInsertRowid);
    buttons.forEach((label, i) => db.createConfigButton({ config_id: id, label, command: label.toLowerCase(), sort_order: i }));
    return id;
};
const ROBOT = profile(3, 'Robot arm', ['Left', 'Right']);
const CAMERA = profile(3, 'Camera', ['Pan', 'Zoom']);
const DEFAULT = profile(3, 'Channel default', ['Wave']);
const MALLORY = profile(7, 'Not yours', ['Steal']);
db.updateChannel(3, { active_control_config_id: DEFAULT });
const slot = (slug, protocol, cfg) => Number(db.createManagedStream({
    user_id: 3, channel_id: ch.id, slug, title: slug, protocol, streaming_method: protocol === 'rtmp' ? 'rtmp' : 'whip',
    stream_key: `${slug}key`.padEnd(40, '0'), control_config_id: cfg,
}).lastInsertRowid);
const ARM = slot('arm', 'rtmp', ROBOT);
const CAM = slot('cam', 'rtmp', CAMERA);
const PLAIN = slot('plain', 'rtmp', null);
const keyOf = (msid) => db.getManagedStreamById(msid).stream_key;
const buttons = (streamId) => db.getStreamControls(streamId).map((c) => c.label);

// ── the RTMP server, with node-media-server and its side effects stubbed ──
const handlers = {};
class FakeNms {
    on(event, fn) { handlers[event] = fn; }
    run() {}
    stop() {}
    getSession() { return { reject() {} }; }
}
require.cache[require.resolve('node-media-server')] = { id: 'nms', filename: 'nms', loaded: true, exports: FakeNms };
require.cache[require.resolve('../server/streaming/broadcast-server')] = { id: 'bs', filename: 'bs', loaded: true, exports: { endStream() {} } };
const recorder = require('../server/streaming/recorder');
recorder.startRecording = () => {};
recorder.stopRecording = () => {};
require('../server/streaming/golive-notify').notifyFollowersGoLive = () => {};
require('../server/streaming/live-events').announceGoLive = () => {};
const rtmp = require('../server/streaming/rtmp-server');
rtmp.start();
let session = 0;
const publish = (key) => { const id = `s${++session}`; handlers.prePublish(id, `/live/${key}`, {}); return rtmp.activeStreams.get(key); };
const unpublish = (key) => handlers.donePublish(rtmp.activeStreams.get(key)?.sessionId, `/live/${key}`, {});

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/controls', require('../server/controls/routes'));
const server = http.createServer(app).listen(0);
function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'content-type': 'application/json' };
        if (data) headers['content-length'] = Buffer.byteLength(data);
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json }); });
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
    let armStream, camStream;

    await check('Go Live on a slot, then its encoder: the waiting stream is used and keeps the slot\'s profile', async () => {
        // What the Go Live page does for the "arm" slot (POST /api/streams with managed_stream_id).
        armStream = Number(db.createStream({ user_id: 3, channel_id: ch.id, managed_stream_id: ARM, control_config_id: ROBOT, title: 'arm', protocol: 'rtmp' }).lastInsertRowid);
        db.applyConfigToStream(ROBOT, armStream);
        const info = publish(keyOf(ARM));
        assert.strictEqual(info.streamId, armStream);
        assert.deepStrictEqual(buttons(armStream), ['Left', 'Right']);
    });

    await check('a second slot\'s encoder gets its own stream and profile, and leaves the first slot\'s alone', async () => {
        const info = publish(keyOf(CAM));
        camStream = info.streamId;
        assert.notStrictEqual(camStream, armStream, 'not the arm slot\'s stream');
        const row = db.getStreamById(camStream);
        assert.deepStrictEqual([row.managed_stream_id, row.control_config_id, !!row.is_live], [CAM, CAMERA, true]);
        assert.deepStrictEqual(buttons(camStream), ['Pan', 'Zoom']);
        assert.deepStrictEqual(buttons(armStream), ['Left', 'Right'], 'the arm slot keeps its buttons');
        assert.strictEqual(db.getStreamById(armStream).control_config_id, ROBOT);
        assert.strictEqual(rtmp.activeStreams.get(keyOf(ARM)).streamId, armStream);
    });

    await check('a slot without a profile gets the channel default', async () => {
        const info = publish(keyOf(PLAIN));
        assert.ok(![armStream, camStream].includes(info.streamId));
        assert.deepStrictEqual(buttons(info.streamId), ['Wave']);
        unpublish(keyOf(PLAIN));
    });

    await check('one encoder leaving ends only its own slot\'s stream', async () => {
        unpublish(keyOf(CAM));
        assert.strictEqual(db.getStreamById(camStream).is_live, 0);
        assert.strictEqual(db.getStreamById(armStream).is_live, 1, 'the arm slot is still live');
        assert.ok(rtmp.isReceiving(keyOf(ARM)) && !rtmp.isReceiving(keyOf(CAM)));
    });

    await check('each stream serves its own controls to viewers', async () => {
        assert.deepStrictEqual((await call('GET', `/api/controls/${armStream}`)).json.controls.map((c) => c.label), ['Left', 'Right']);
        assert.deepStrictEqual((await call('GET', `/api/controls/${camStream}`)).json.controls.map((c) => c.label), ['Pan', 'Zoom']);
    });

    await check('editing a profile changes the live streams bound to it, and only those', async () => {
        camStream = publish(keyOf(CAM)).streamId;
        const r = await call('POST', `/api/controls/configs/${ROBOT}/buttons`, 3, { label: 'Grab', command: 'grab' });
        assert.strictEqual(r.status, 201);
        assert.deepStrictEqual(buttons(armStream), ['Left', 'Right', 'Grab']);
        assert.deepStrictEqual(buttons(camStream), ['Pan', 'Zoom']);
    });

    await check('a stream can be rebound to another of the owner\'s profiles, never to someone else\'s', async () => {
        const mine = await call('PUT', `/api/controls/${camStream}/config`, 3, { control_config_id: DEFAULT });
        assert.strictEqual(mine.status, 200);
        assert.deepStrictEqual(buttons(camStream), ['Wave']);
        const theirs = await call('PUT', `/api/controls/${camStream}/config`, 3, { control_config_id: MALLORY });
        assert.strictEqual(theirs.status, 403);
        const stranger = await call('PUT', `/api/controls/${armStream}/config`, 7, { control_config_id: MALLORY });
        assert.strictEqual(stranger.status, 403);
        assert.deepStrictEqual(buttons(armStream), ['Left', 'Right', 'Grab']);
    });

    await check('every other way a slot goes live applies the slot\'s profile first, then the channel default', async () => {
        const whip = read('server/streaming/whip-handler.js');
        assert.match(whip, /const configId = managedStream\.control_config_id \|\| \(channel && channel\.active_control_config_id\);\s*if \(configId\) \{\s*try \{ db\.applyConfigToStream\(configId, streamId\); \}/, 'WHIP');
        const routes = read('server/streaming/routes.js');
        assert.match(routes, /const effectiveConfigId = \(requestedControlConfigId != null\)\s*\? requestedControlConfigId\s*: \(managedStream\.control_config_id \|\| null\);/, 'Go Live page: a session choice, else the slot\'s');
        assert.match(routes, /\} else if \(channel\.active_control_config_id\) \{\s*\/\/ No slot-level config at all: fall back to channel default/);
        assert.match(routes, /control_config_id: ownControlConfigId\(req, req\.body\.control_config_id\) \|\| null,/, 'a new slot takes only the owner\'s profile');
        assert.match(routes, /const cfgId = ownControlConfigId\(req, req\.body\.control_config_id\);\s*if \(cfgId === undefined\) return res\.status\(403\)/, 'and so does a slot edit');
        const mirror = read('server/openre/mirror.js');
        assert.match(mirror, /const configId = slot\.control_config_id \|\| \(channel && channel\.active_control_config_id\);/, 'OpenRe mirror');
    });

    server.close();
    if (failures) { quiet(`\n${failures} check(s) failed`); process.exit(1); }
    quiet('\nAll per-slot control profile checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
