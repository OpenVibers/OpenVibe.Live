'use strict';
// Follows on OpenVibe.Network (ADR-030, plan T2; server/social/network-follows.js): a follow button follows or
// unfollows on Network (network.follows.write) and shows Network's answer; only a follow Network says the click
// started earns the coins and the PowerChat alert; a side without a subject cannot follow; Network down or a
// malformed answer changes nothing; channel and stream responses show Network's count and the viewer's follow
// while the projection lags; network.follow.* events alone write Live's table, in revision order, so a late older
// event cannot undo a click. Nothing else on Live writes follows, and GET /internal/followers is gone.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-netfollows-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
process.env.OV_NETWORK_INTERNAL_URL = 'http://network.test';
const log = console.log; console.log = () => {}; console.warn = () => {};
const db = require('../server/db/database');
db.initDb();
const principal = require('../server/net/network-principal');
principal.serviceHeaders = async () => ({ Authorization: 'Bearer svc-token' });
let invalidated = 0;
principal.invalidate = () => { invalidated++; };
const follows = require('../server/social/network-follows');
const events = require('../server/auth/network-events');
const auth = require('../server/auth/auth');
auth.requireAuth = (req, res, next) => { const u = db.getUserById(Number(req.headers['x-test-user'] || 0)); if (!u) return res.status(401).json({ error: 'Authentication required' }); req.user = u; next(); };
auth.optionalAuth = (req, res, next) => { const u = db.getUserById(Number(req.headers['x-test-user'] || 0)); if (u) req.user = u; next(); };
const coins = require('../server/monetization/opencoins');
const powerchat = require('../server/integrations/powerchat-platform');
const side = [];
coins.awardFollow = (a, b) => side.push(['coins', a, b]);
powerchat.forwardFollow = (s) => side.push(['powerchat', s]);
const notify = require('../server/utils/notify');
notify.pushNotification = (n) => side.push(['notify', n.type]);

const sub = (tag) => `usr_${`01J${tag}`.padEnd(26, '0')}`;
const ANN = sub('AA'), BOB = sub('BB'), CAT = sub('CC'), GHOST = sub('DD');
const d = db.getDb();
for (const [id, name] of [[1, 'ann'], [2, 'bob'], [3, 'cat'], [4, 'nolink']]) d.prepare("INSERT INTO users (id, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (?, ?, 'x')").run(id, name);
const link = d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)");
link.run(1, '101', ANN); link.run(2, '102', BOB); link.run(3, '103', CAT);
const streamId = Number(db.createStream({ user_id: 2, title: 't', protocol: 'webrtc' }).lastInsertRowid);

// Network: /internal/follows answers network.follow-status-result@1 from its own graph (201 for a pair's first
// follow; a follow that starts again starts its `since` again), and /api/v1/follows answers the public count.
const graph = new Map();   // `${follower}>${target}` → { active, revision, since }
const calls = [];
let fail = null;
const countOf = (target) => [...graph].filter(([k, v]) => v.active && k.endsWith(`>${target}`)).length + 40;
globalThis.fetch = async (url, o = {}) => {
    const method = o.method || 'GET';
    calls.push({ url, method, body: o.body ? JSON.parse(o.body) : null, auth: o.headers && o.headers.Authorization });
    if (fail instanceof Error) throw fail;
    if (fail) return { status: fail.status, json: async () => fail.body || {} };
    const u = new URL(url);
    const target = u.pathname.split('/').pop();
    if (method === 'GET') return { status: 200, json: async () => ({ target_type: 'channel', target_id: target, followers: countOf(target) }) };
    const follower = method === 'PUT' ? JSON.parse(o.body).follower : u.searchParams.get('follower');
    const key = `${follower}>${target}`;
    const prev = graph.get(key);
    let status = 200;
    if (method === 'PUT' && !(prev && prev.active)) {
        const revision = prev ? prev.revision + 1 : 1;
        graph.set(key, { active: true, revision, since: new Date().toISOString() });
        if (revision === 1) status = 201;
    } else if (method === 'DELETE' && prev && prev.active) graph.set(key, { ...prev, active: false, revision: prev.revision + 1 });
    const now = graph.get(key);
    const body = { target_type: 'channel', target_id: target, followers: countOf(target), following: !!(now && now.active) };
    if (now && now.active) body.since = now.since;
    return { status, json: async () => body };
};

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/streams', require('../server/streaming/routes'));
const server = http.createServer(app);
const call = (method, p, user) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: user ? { 'x-test-user': String(user) } : {} }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject); req.end();
});
const post = (p, user) => call('POST', p, user);
const get = (p, user) => call('GET', p, user);
const ev = (type, follower, target, revision) => ({ event_id: `evt_01JAB2C3D4E5F6G7H8J9K0M${String(revision).padStart(3, '0')}`.slice(0, 30), event_type: type, source: 'network', payload: { follower, target_type: 'channel', target_id: target, revision } });

server.listen(0, '127.0.0.1', async () => {
    try {
        // set(): Network first; its answer is what the button shows, and the projection waits for the event.
        let r = await follows.set(1, 2, true);
        assert.deepStrictEqual(r, { ok: true, following: true, count: 41, started: true });
        assert.deepStrictEqual(calls.pop(), { url: `http://network.test/internal/follows/channel/${BOB}`, method: 'PUT', body: { follower: ANN }, auth: 'Bearer svc-token' });
        assert.ok(!db.isFollowing(1, 2), 'a write answer never touches the projection');
        assert.ok(follows.isFollowing(1, 2), 'the button shows Network\'s answer before the event');
        assert.strictEqual((await follows.set(1, 2, true)).started, false, 'the same follow again starts nothing');
        r = await follows.set(1, 2, false);
        assert.deepStrictEqual(calls.pop(), { url: `http://network.test/internal/follows/channel/${BOB}?follower=${ANN}`, method: 'DELETE', body: null, auth: 'Bearer svc-token' });
        assert.deepStrictEqual(r, { ok: true, following: false, count: 40, started: false });
        assert.ok(!follows.isFollowing(1, 2));
        assert.strictEqual((await follows.set(1, 2, true)).started, true, 'a follow that starts again (200, a new since) is started');
        await follows.set(1, 2, false);

        // Network cannot answer, or answers a malformed document: 503, nothing changes on Live.
        fail = { status: 503 };
        r = await follows.set(1, 2, true);
        assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 503);
        fail = new Error('ECONNREFUSED');
        assert.strictEqual((await follows.set(1, 2, true)).status, 503);
        fail = { status: 401 };
        assert.strictEqual((await follows.set(1, 2, true)).status, 503);
        assert.strictEqual(invalidated, 1, 'a refused service token is dropped');
        fail = { status: 200, body: { nope: true } };
        assert.strictEqual((await follows.set(1, 2, true)).status, 503, 'an answer without `following` is no answer');
        for (const followers of [undefined, '41', -1, 4.5]) {
            fail = { status: 200, body: { target_type: 'channel', target_id: BOB, following: true, followers } };
            assert.strictEqual((await follows.set(1, 2, true)).status, 503, `an answer with followers ${followers} is no answer`);
        }
        fail = { status: 200, body: { target_type: 'channel', target_id: CAT, following: true, followers: 41 } };
        assert.strictEqual((await follows.set(1, 2, true)).status, 503, 'an answer about another channel is no answer');
        assert.ok(!follows.isFollowing(1, 2) && !db.isFollowing(1, 2), 'nothing remembered while Network did not take it');
        // Network refuses the request itself: its status and reason.
        fail = { status: 400, body: { code: 'follows.self', detail: 'you cannot follow yourself' } };
        assert.deepStrictEqual(await follows.set(2, 2, true), { ok: false, status: 400, error: 'you cannot follow yourself' });
        fail = null;
        // A side without a subject cannot follow; Network is not asked.
        const n = calls.length;
        assert.strictEqual((await follows.set(4, 2, true)).status, 409, 'follower without a subject');
        assert.strictEqual((await follows.set(1, 4, true)).status, 409, 'channel without a subject');
        assert.strictEqual(calls.length, n);
        assert.ok(!follows.isFollowing(4, 2) && !follows.isFollowing(1, 4));

        // The buttons: toggle on the state the viewer sees, answer Network's state and count.
        assert.strictEqual((await post(`/api/streams/${streamId}/follow`)).status, 401, 'signed in only');
        side.length = 0;
        r = await post(`/api/streams/${streamId}/follow`, 3);
        assert.deepStrictEqual(r, { status: 200, body: { following: true, count: 41 } });
        assert.deepStrictEqual(side, [['coins', 3, 2], ['powerchat', 2]], 'coins and the PowerChat alert; Network sends FOLLOW');
        r = await post('/api/streams/channel/bob/follow', 3);
        assert.deepStrictEqual(r, { status: 200, body: { following: false, count: 40 } }, 'the second click unfollows before any event');
        side.length = 0;
        // Network already has the follow (made elsewhere, its event delayed): the click is an idempotent PUT, and
        // nothing started, so no coins and no false PowerChat alert.
        graph.set(`${CAT}>${BOB}`, { active: true, revision: 3, since: '2026-01-01T00:00:00.000Z' });
        follows._reset();
        r = await post('/api/streams/channel/bob/follow', 3);
        assert.deepStrictEqual(r.body, { following: true, count: 41 });
        assert.deepStrictEqual(side, [], 'a follow Network already had starts nothing');
        fail = { status: 502 };
        r = await post('/api/streams/channel/bob/follow', 3);
        assert.strictEqual(r.status, 503);
        assert.ok(follows.isFollowing(3, 2), 'Network down: the follow stays as it was');
        fail = null;
        assert.strictEqual((await post('/api/streams/channel/bob/follow', 4)).status, 409);
        assert.strictEqual((await post('/api/streams/channel/nobody/follow', 3)).status, 404);
        assert.strictEqual((await post('/api/streams/999999/follow', 3)).status, 404);
        assert.ok(!side.some((s) => s[0] === 'notify'), 'Live sends no follow notification');

        // Channel and stream responses while the projection lags: Network's count, the viewer's follow as Network
        // answered it (the projection still has no row for cat → bob).
        assert.ok(!db.isFollowing(3, 2));
        follows._reset();
        await follows.set(3, 2, true);
        graph.set(`${ANN}>${BOB}`, { active: true, revision: 7, since: '2026-01-01T00:00:00.000Z' });   // a follow made elsewhere
        follows._reset();
        await follows.set(3, 2, true);
        calls.length = 0;
        r = await get('/api/streams/channel/bob', 3);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.channel.follower_count, 42, 'the count is Network\'s');
        assert.strictEqual(r.body.channel.is_following, true);
        r = await get(`/api/streams/${streamId}`, 3);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.stream.follower_count, 42);
        assert.strictEqual(r.body.stream.isFollowing, true);
        assert.strictEqual(calls.filter((c) => c.url.includes('/api/v1/follows/')).length, 0, 'the write answer\'s count is reused');
        follows._reset();
        calls.length = 0;
        r = await get('/api/streams/channel/bob', 1);
        assert.strictEqual(r.body.channel.follower_count, 42);
        assert.strictEqual(r.body.channel.is_following, false, 'no answer for ann: the projection');
        assert.deepStrictEqual(calls.filter((c) => c.url.includes('/api/v1/follows/')), [{ url: `http://network.test/api/v1/follows/channel/${BOB}`, method: 'GET', body: null, auth: undefined }], 'the public count, no credentials');
        r = await get('/api/streams/channel/bob');
        assert.strictEqual(r.body.channel.is_following, false, 'signed out');
        // Network cannot answer the count, or answers a malformed one: the projection's count for a while.
        follows._reset();
        fail = new Error('ECONNREFUSED');
        assert.strictEqual(await follows.followerCount(2), 0);
        fail = null;
        assert.strictEqual(await follows.followerCount(2), 0, 'the projection answers while Network was just down');
        follows._reset();
        fail = { status: 200, body: { target_type: 'channel', target_id: BOB, followers: 'many' } };
        assert.strictEqual(await follows.followerCount(2), 0);
        fail = null;
        follows._reset();
        assert.strictEqual(await follows.followerCount(2), 42);
        assert.strictEqual(await follows.followerCount(4), 0, 'a channel without a subject: the projection');

        // The projection, through the Network events endpoint's apply().
        d.prepare('DELETE FROM follows').run();
        follows._reset();
        assert.strictEqual(events.apply(ev('network.follow.created', CAT, BOB, 1)), 'followed');
        assert.ok(db.isFollowing(3, 2));
        assert.strictEqual(events.apply(ev('network.follow.created', CAT, BOB, 1)), 'stale', 'a redelivery');
        assert.strictEqual(events.apply(ev('network.follow.deleted', CAT, BOB, 3)), 'unfollowed');
        assert.ok(!db.isFollowing(3, 2));
        assert.strictEqual(events.apply(ev('network.follow.created', CAT, BOB, 2)), 'stale', 'an older follow after the unfollow changes nothing');
        assert.ok(!db.isFollowing(3, 2));
        assert.strictEqual(events.apply(ev('network.follow.created', GHOST, BOB, 1)), 'ignored:unmapped', 'no Live account');
        assert.strictEqual(events.apply({ ...ev('network.follow.created', CAT, BOB, 9), source: 'live' }), 'ignored:source');

        // A click, then its events delivered late and out of order: an older follow event arriving after the
        // unfollow click cannot show the follow again, and the unfollow's own event retires the remembered answer.
        graph.delete(`${ANN}>${CAT}`);
        assert.strictEqual((await follows.set(1, 3, true)).started, true);    // Network revision 1
        assert.strictEqual((await follows.set(1, 3, false)).following, false); // Network revision 2
        assert.strictEqual(events.apply(ev('network.follow.created', ANN, CAT, 1)), 'followed', 'the late follow event');
        assert.ok(db.isFollowing(1, 3), 'the projection is at revision 1');
        assert.strictEqual(follows.isFollowing(1, 3), false, 'the button still shows the unfollow');
        r = await get('/api/streams/channel/cat', 1);
        assert.strictEqual(r.body.channel.is_following, false);
        assert.strictEqual(events.apply(ev('network.follow.deleted', ANN, CAT, 2)), 'unfollowed');
        assert.ok(!db.isFollowing(1, 3) && !follows.isFollowing(1, 3));
        assert.strictEqual(events.apply(ev('network.follow.created', ANN, CAT, 1)), 'stale');
        assert.strictEqual(events.apply(ev('network.follow.created', ANN, CAT, 3)), 'followed', 'a later follow made elsewhere');
        assert.strictEqual(follows.isFollowing(1, 3), true, 'the agreeing event retired the answer: the projection shows it');
        // Live subscribes to the follow events.
        assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'subscribe-media-events.js'), 'utf8'), /'network\.follow\.created', 'network\.follow\.deleted'/);

        // Only the projection writes follows (and the account merge repoints it); no Live-only path is left.
        const root = path.join(__dirname, '..', 'server');
        const writers = [];
        const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js') && /\b(INSERT(\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM|UPDATE)\s+follows\b/i.test(fs.readFileSync(p, 'utf8'))) writers.push(path.relative(root, p));
        } };
        walk(root);
        assert.deepStrictEqual(writers.sort(), ['auth/subject-merge.js', 'social/network-follows.js'], 'follows writers');
        assert.strictEqual(typeof db.followUser, 'undefined');
        assert.strictEqual(typeof db.unfollowUser, 'undefined');
        assert.ok(!/FOLLOWS_AUTHORITY/.test(fs.readFileSync(path.join(root, 'social', 'network-follows.js'), 'utf8')), 'no switch back to Live-only follows');
        // GET /internal/followers is retired: Network reads its own graph (Network PR #6).
        assert.ok(!fs.existsSync(path.join(root, 'streaming', 'followers-internal.js')));
        assert.ok(!fs.readFileSync(path.join(root, 'index.js'), 'utf8').includes('/internal/followers'));
        console.log = log;
        console.log('network follows: all checks passed');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    process.exit(0);
});
process.on('unhandledRejection', (e) => { console.log = log; console.error(e); process.exit(1); });
