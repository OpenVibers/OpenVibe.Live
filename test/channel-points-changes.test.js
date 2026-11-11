'use strict';

// Live's channel-points read for Network's gain/loss API (ask 273):
// GET /internal/channel-points/changes is a Network service token with live.channel_points.read only,
// loopback only; it reads Live's own channel_points_log for the person behind the Network account.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-cp-changes-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
console.log = () => {};
console.warn = () => {};
console.error = () => {};
const out = (...a) => process.stdout.write(`${a.join(' ')}\n`);

const now = () => Math.floor(Date.now() / 1000);
let jti = 0;
const token = (cap, { aud = 'openvibe.live', sub = 'svc:network', env } = {}) => serviceAuth.signServiceToken({
    iss: 'https://openvibe.network', sub, actor_type: 'service', aud: [aud], cap, iat: now(), exp: now() + 300, jti: `tok_test_${String(++jti).padStart(4, '0')}`, ...(env ? { env } : {}),
}, keys.privateKey);

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    // A viewer and a streamer, the viewer linked to their Network account.
    const fan = Number((await db.createUser({ username: 'cpfan', password_hash: 'x', display_name: 'Cp Fan', stream_key: 'cpfansecretkey1' })).lastInsertRowid);
    const streamer = Number((await db.createUser({ username: 'cpstar', password_hash: 'x', display_name: 'Cp Star', stream_key: 'cpstarsecretkey1' })).lastInsertRowid);
    const other = Number((await db.createUser({ username: 'cpother', password_hash: 'x', display_name: 'Cp Other', stream_key: 'cpothersecretkey1' })).lastInsertRowid);
    await db.getDb().prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)").run(fan, 'net-fan-1', 'usr_01JAB2C3D4E5F6G7H8J9K0FAN1');
    await db.getDb().prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (?, 'network', ?)").run(other, 'net-other-1');
    const events = require('../server/events/stream-events');
    const original = { init: events.init, enqueue: events.enqueue, kick: events.kick };
    const sent = [];
    let kicks = 0;
    events.init = () => ({});
    events.enqueue = async (env) => { sent.push(env); return env; };
    events.kick = () => { kicks++; };
    await db.applyChannelPoints({ userId: fan, streamerId: streamer, delta: 100, key: 'test:cp:watch:1', reason: 'watch' });
    await db.applyChannelPoints({ userId: fan, streamerId: streamer, delta: -30, key: 'test:cp:redeem:1', reason: 'redeem reward 7' });
    await db.applyChannelPoints({ userId: other, streamerId: streamer, delta: 50, key: 'test:cp:watch:2', reason: 'watch' });
    await db.applyChannelPoints({ userId: fan, streamerId: streamer, delta: 100, key: 'test:cp:watch:1', reason: 'watch' });
    assert.deepStrictEqual(sent.map((e) => e.payload.delta), [100, -30], 'only applied moves for a linked person announce');
    assert(sent.every((e) => e.event_type === 'live.balance.changed' && e.visibility === 'subject' && e.subject.id === 'usr_01JAB2C3D4E5F6G7H8J9K0FAN1'));
    assert.strictEqual(kicks, 2);
    Object.assign(events, original);

    const app = express();
    app.use(express.json());
    app.use('/internal', require('../server/internal/routes'));
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const get = (p, headers = {}) => fetch(origin + p, { headers });
    const Bearer = (t) => ({ authorization: `Bearer ${t}` });
    const q = (o) => `/internal/channel-points/changes?${new URLSearchParams(o)}`;

    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); out('  ✓', name); }
        catch (e) { failures++; out('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
    };
    const good = Bearer(token(['live.channel_points.read']));

    await check('a gain and a loss, oldest first, with the balance', async () => {
        const r = await get(q({ network_user_id: 'net-fan-1', streamer_id: String(streamer) }), good);
        assert.strictEqual(r.status, 200);
        const b = await r.json();
        assert.strictEqual(b.balance, 70);
        assert.strictEqual(b.moves.length, 2);
        assert.strictEqual(b.moves[0].delta, 100);
        assert.strictEqual(b.moves[0].reason, 'watch');
        assert.strictEqual(b.moves[1].delta, -30);
        assert.strictEqual(b.cursor, b.moves[1].id);
        assert.strictEqual(b.next_since, null);
    });

    await check('the Network subject resolves the same account', async () => {
        const rr = await get(q({ network_user_id: 'usr_01JAB2C3D4E5F6G7H8J9K0FAN1', streamer_id: String(streamer) }), good);
        const b = await rr.json();
        assert.strictEqual(rr.status, 200, JSON.stringify(b));
        assert.strictEqual(b.moves.length, 2);
        assert.strictEqual(b.balance, 70);
    });

    await check('a cursor pages forward', async () => {
        const first = await (await get(q({ network_user_id: 'net-fan-1', streamer_id: String(streamer), limit: '1' }), good)).json();
        assert.strictEqual(first.moves.length, 1);
        assert.strictEqual(first.next_since, first.moves[0].id);
        const rest = await (await get(q({ network_user_id: 'net-fan-1', streamer_id: String(streamer), since_id: String(first.next_since) }), good)).json();
        assert.strictEqual(rest.moves.length, 1);
        assert.strictEqual(rest.moves[0].delta, -30);
    });

    await check("another person's points are unreachable: no user parameter beyond the linked account", async () => {
        const b = await (await get(q({ network_user_id: 'net-other-1', streamer_id: String(streamer) }), good)).json();
        assert.strictEqual(b.moves.length, 1);
        assert.strictEqual(b.moves[0].delta, 50, 'only their own row');
        assert.strictEqual((await get(q({ network_user_id: 'nobody' }), good)).status, 404);
        assert.strictEqual((await get(q({}), good)).status, 400);
        assert.strictEqual((await get(q({ network_user_id: 'net-fan-1', streamer_id: 'x' }), good)).status, 400);
    });

    await check('only the capability opens it', async () => {
        const p = q({ network_user_id: 'net-fan-1' });
        assert.strictEqual((await get(p)).status, 401);
        assert.strictEqual((await get(p, Bearer(token(['live.avatar.write'])))).status, 403);
        assert.strictEqual((await get(p, Bearer(token(['live.channel_points.read'], { aud: 'openvibe.network' })))).status, 401);
        assert.strictEqual((await get(p, { ...good, 'x-forwarded-for': '203.0.113.9' })).status, 403);
    });

    server.close();
    if (failures) { out(`${failures} failed`); process.exit(1); }
    out('channel-points changes: all passed');
    process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
