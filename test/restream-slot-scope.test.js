/**
 * Restream control is slot-only: going live on a slot auto-starts and resumes that slot's
 * destinations and nothing else; a legacy stream with no slot uses only unbound destinations.
 *
 * The production case: user 1 has slots 1, 60 and 85 with auto-start destinations on slot 1.
 * The old _getDestinationsForStream merged every destination the account owned into a slotted
 * stream, so going live on slot 60 or 85 started slot 1's Twitch and YouTube relays too.
 * The display paths (destination list, broadcaster viewer counts) follow the same rule.
 *
 *   node test/restream-slot-scope.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-restream-slot-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

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

raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (1, 'alex', 'alex', 'a@x', 'x', 'streamer')`).run();
raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (2, 'other', 'other', 'o@x', 'x', 'streamer')`).run();
db.ensureChannel(1);
db.ensureChannel(2);
const chan = db.getChannelByUserId(1);

const slot = (slug, userId = 1) => Number(db.createManagedStream({ user_id: userId, channel_id: chan.id, slug, title: slug, stream_key: `key-${slug}` }).lastInsertRowid);
const slotA = slot('main');       // "slot 1": the auto-start destinations live here
const slotB = slot('second');     // "slot 60"
const slotC = slot('third');      // "slot 85": no destinations at all
const otherSlot = slot('theirs', 2);

const dest = (fields) => db.createRestreamDestination(fields.user_id || 1, {
    server_url: 'rtmp://ingest.example/live', stream_key: `sk-${fields.name}`, enabled: 1, ...fields,
}).id;
const aTwitch = dest({ name: 'a-twitch', platform: 'twitch', managed_stream_id: slotA, auto_start: 1 });
const aYoutube = dest({ name: 'a-youtube', platform: 'youtube', managed_stream_id: slotA, auto_start: 1 });
const bKick = dest({ name: 'b-kick', platform: 'kick', managed_stream_id: slotB, auto_start: 1 });
const bManual = dest({ name: 'b-manual', platform: 'custom', managed_stream_id: slotB, auto_start: 0 });
const unbound = dest({ name: 'legacy', platform: 'custom', auto_start: 1 });
const unboundManual = dest({ name: 'legacy-manual', platform: 'custom', auto_start: 0 });
dest({ name: 'theirs', platform: 'twitch', managed_stream_id: otherSlot, auto_start: 1, user_id: 2 });

const manager = require('../server/streaming/restream-manager');
let started = [];
manager.startRestream = async (streamId, d) => { started.push([streamId, d.id]); return { status: 'starting' }; };

const live = (managedStreamId, userId = 1) => Number(db.createStream({ user_id: userId, channel_id: chan.id, managed_stream_id: managedStreamId, title: 't', protocol: 'rtmp' }).lastInsertRowid);
const ids = (list) => list.map(([, destId]) => destId).sort((a, b) => a - b);

let server;
(async () => {
    // ── Control: auto-start ──────────────────────────────────────────────────────────
    const onB = live(slotB);
    started = [];
    await manager.autoStartForStream(onB, 1, { protocol: 'rtmp' });
    assert.deepStrictEqual(ids(started), [bKick], 'going live on slot B auto-starts only slot B auto-start destinations (not slot A, not unbound)');

    const onC = live(slotC);
    started = [];
    await manager.autoStartForStream(onC, 1, { protocol: 'rtmp' });
    assert.deepStrictEqual(started, [], 'a slot with no destinations starts nothing, even though slot A has auto-start ones');

    const onA = live(slotA);
    started = [];
    await manager.autoStartForStream(onA, 1, { protocol: 'rtmp' });
    assert.deepStrictEqual(ids(started), [aTwitch, aYoutube].sort((a, b) => a - b), 'slot A starts its own two');

    const legacy = live(null);
    started = [];
    await manager.autoStartForStream(legacy, 1, { protocol: 'rtmp' });
    assert.deepStrictEqual(ids(started), [unbound], 'a legacy stream with no slot starts only unbound auto-start destinations');

    // ── Control: resume (every enabled destination, auto-start or not) ──────────────
    started = [];
    await manager.resumeForStream(onB, 1, { protocol: 'rtmp' });
    assert.deepStrictEqual(ids(started), [bKick, bManual].sort((a, b) => a - b), 'resume on slot B covers only slot B');
    started = [];
    await manager.resumeForStream(onC, 1, { protocol: 'rtmp' });
    assert.deepStrictEqual(started, [], 'resume on an empty slot resumes nothing');
    started = [];
    await manager.resumeForStream(legacy, 1, { protocol: 'rtmp' });
    assert.deepStrictEqual(ids(started), [unbound, unboundManual].sort((a, b) => a - b), 'resume on a slot-less stream covers only unbound destinations');

    // The owner of the stream decides, not the caller's userId argument.
    started = [];
    await manager.autoStartForStream(onB, 2, { protocol: 'rtmp' });
    assert.deepStrictEqual(ids(started), [bKick], 'a wrong userId cannot pull in another account\'s destinations');

    // ── Display: external viewer counts ──────────────────────────────────────────────
    manager.setViewerCount(aTwitch, 40, true);
    manager.setViewerCount(bKick, 7, true);
    manager.setViewerCount(unbound, 3, true);
    assert.strictEqual(manager.getExternalViewerCountsForUser(1, slotB).total, 7, 'slot B counts only its own platform viewers');
    assert.strictEqual(manager.getExternalViewerCountsForUser(1, slotA).total, 40);
    assert.strictEqual(manager.getExternalViewerCountsForUser(1, null).total, 3, 'no slot counts only unbound destinations');

    // ── Display: routes ─────────────────────────────────────────────────────────────
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/restream', require('../server/streaming/restream-routes'));
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
    const listed = (r) => r.json.destinations.map((d) => d.id).sort((a, b) => a - b);

    let r = await call('GET', `/api/restream/destinations?managed_stream_id=${slotB}`, 1);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(listed(r), [bKick, bManual].sort((a, b) => a - b), 'slot listing is that slot only');
    r = await call('GET', '/api/restream/destinations', 1);
    assert.deepStrictEqual(listed(r), [unbound, unboundManual].sort((a, b) => a - b), 'no slot lists only unbound destinations, not the whole account');
    r = await call('GET', '/api/restream/destinations?all=1', 1);
    assert.strictEqual(r.json.destinations.length, 6, '?all=1 is the explicit whole-account listing');
    assert.ok(r.json.destinations.every((d) => d.user_id === 1), 'and still only the caller\'s own');
    r = await call('GET', `/api/restream/destinations?managed_stream_id=${otherSlot}`, 1);
    assert.strictEqual(r.status, 403, 'another account\'s slot is refused');

    // Viewer counts: explicit slot, or the slots live right now (A, B, C and slot-less).
    r = await call('GET', `/api/restream/viewer-counts?managed_stream_id=${slotB}`, 1);
    assert.strictEqual(r.json.total, 7);
    r = await call('GET', '/api/restream/viewer-counts', 1);
    assert.strictEqual(r.json.total, 50, 'the default counts each live stream\'s own slot once');
    db.endStream(onA);
    r = await call('GET', '/api/restream/viewer-counts', 1);
    assert.strictEqual(r.json.total, 10, 'slot A is not live any more, so its Twitch viewers are not counted');
    r = await call('GET', `/api/restream/viewer-counts?managed_stream_id=${otherSlot}`, 1);
    assert.strictEqual(r.status, 403);

    // Manual start of an unbound destination refuses a slotted stream.
    r = await call('POST', `/api/restream/destinations/${unbound}/start`, 1, { streamId: onB });
    assert.strictEqual(r.status, 400, 'an unbound destination cannot be started on a stream that has a slot');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('restream-slot-scope: ok');
    process.exit(0);
})().catch((err) => {
    console.error = quiet;
    quiet(err);
    try { server && server.close(); } catch { /* */ }
    process.exit(1);
});
