'use strict';
// Follows on OpenVibe.Network (ADR-030 step 4; server/social/network-follows.js): with FOLLOWS_AUTHORITY=network a
// follow button writes Network first (network.follows.write) and Live's row only when Network took it; a side
// without a subject stays Live-only; network.follow.* events keep Live's table as a projection, in revision order.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-netfollows-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_INTERNAL_URL = 'http://network.test';
const log = console.log; console.log = () => {}; console.warn = () => {};
const db = require('../server/db/database');
db.initDb();
console.log = log;
const principal = require('../server/net/network-principal');
principal.serviceHeaders = async () => ({ Authorization: 'Bearer svc-token' });
const follows = require('../server/social/network-follows');
const events = require('../server/auth/network-events');

const sub = (tag) => `usr_${`01J${tag}`.padEnd(26, '0')}`;
const ANN = sub('AA'), BOB = sub('BB'), CAT = sub('CC'), GHOST = sub('DD');
const d = db.getDb();
for (const [id, name] of [[1, 'ann'], [2, 'bob'], [3, 'cat'], [4, 'nolink']]) d.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')").run(id, name);
const link = d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)");
link.run(1, '101', ANN); link.run(2, '102', BOB); link.run(3, '103', CAT);

(async () => {
    const calls = [];
    let answer = 200;
    const fetchImpl = async (url, o) => { calls.push({ url, method: o.method, body: o.body ? JSON.parse(o.body) : null, auth: o.headers.Authorization }); if (answer instanceof Error) throw answer; return { status: answer }; };

    // Authority live (unset): no Network call.
    delete process.env.FOLLOWS_AUTHORITY;
    assert.deepStrictEqual(await follows.writeThrough(1, 2, true, { fetchImpl }), { ok: true, network: false, reason: 'authority_live' });
    assert.strictEqual(calls.length, 0);

    process.env.FOLLOWS_AUTHORITY = 'network';
    let r = await follows.writeThrough(1, 2, true, { fetchImpl });
    assert.deepStrictEqual(r, { ok: true, network: true });
    assert.deepStrictEqual(calls.pop(), { url: `http://network.test/internal/follows/channel/${BOB}`, method: 'PUT', body: { follower: ANN }, auth: 'Bearer svc-token' });
    r = await follows.writeThrough(1, 2, false, { fetchImpl });
    assert.deepStrictEqual(calls.pop(), { url: `http://network.test/internal/follows/channel/${BOB}?follower=${ANN}`, method: 'DELETE', body: null, auth: 'Bearer svc-token' });
    answer = 503;
    assert.strictEqual((await follows.writeThrough(1, 2, true, { fetchImpl })).ok, false, 'Network refused: the button fails, nothing local');
    answer = new Error('ECONNREFUSED');
    assert.strictEqual((await follows.writeThrough(1, 2, true, { fetchImpl })).ok, false);
    answer = 200;
    const n = calls.length;
    assert.deepStrictEqual(await follows.writeThrough(4, 2, true, { fetchImpl }), { ok: true, network: false, reason: 'no_subject' }, 'no subject: Live-only');
    assert.strictEqual(calls.length, n);

    // The projection, through the Network events endpoint's apply().
    const ev = (type, follower, target, revision) => ({ event_id: `evt_01JAB2C3D4E5F6G7H8J9K0M${String(revision).padStart(3, '0')}`.slice(0, 30), event_type: type, source: 'network', payload: { follower, target_type: 'channel', target_id: target, revision } });
    assert.strictEqual(events.apply(ev('network.follow.created', CAT, BOB, 1)), 'followed');
    assert.ok(db.isFollowing(3, 2));
    assert.strictEqual(events.apply(ev('network.follow.created', CAT, BOB, 1)), 'stale', 'a redelivery');
    assert.strictEqual(events.apply(ev('network.follow.deleted', CAT, BOB, 3)), 'unfollowed');
    assert.ok(!db.isFollowing(3, 2));
    assert.strictEqual(events.apply(ev('network.follow.created', CAT, BOB, 2)), 'stale', 'an older follow after the unfollow changes nothing');
    assert.ok(!db.isFollowing(3, 2));
    assert.strictEqual(events.apply(ev('network.follow.created', GHOST, BOB, 1)), 'ignored:unmapped', 'no Live account');
    assert.strictEqual(events.apply({ ...ev('network.follow.created', CAT, BOB, 9), source: 'live' }), 'ignored:source');

    // Both follow routes ask Network before writing Live's row.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'server', 'streaming', 'routes.js'), 'utf8');
    for (const route of ["router.post('/:id/follow'", "router.post('/channel/:username/follow'"]) {
        const body = routes.slice(routes.indexOf(route), routes.indexOf(route) + 1200);
        assert.ok(body.indexOf('writeThrough(') > 0 && body.indexOf('writeThrough(') < body.indexOf('db.followUser('), `${route} writes Network first`);
        assert.match(body, /if \(!w\.ok\) return res\.status\(503\)/);
    }
    // Live subscribes to the follow events.
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'subscribe-media-events.js'), 'utf8'), /'network\.follow\.created', 'network\.follow\.deleted'/);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('network follows: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
