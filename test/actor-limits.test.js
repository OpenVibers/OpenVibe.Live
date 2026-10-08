'use strict';
// Per-actor limits on Live's API writes (server/net/actor-limits.js; roadmap WS-R task 4): a signed-in person's
// writes are counted by their subject, past the limit 429 problem+json rate_limited with Retry-After before the route
// runs, while another person still passes; named routes have their own tighter numbers on top; reads, signed-out
// writes and device traffic (controls, recording chunks, heartbeats) are never counted; the window reopens.
//   node test/actor-limits.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-limits-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.NODE_ENV = 'test';
console.warn = () => {};
const ISS = 'https://openvibe.network';
const tokenFor = (id, subject) => jwt.sign({ sub: String(id), username: `u${id}`, subject_id: subject }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: 600 });

(async () => {
    await require('../server/db/database').initDb();
    let t = Date.UTC(2026, 8, 28, 3, 0, 0);
    const counted = [];
    const registry = { counter: () => ({ inc: (l) => counted.push(l) }) };
    const { createLiveActorLimits } = require('../server/net/actor-limits');
    const app = express();
    app.use('/api/', createLiveActorLimits({ env: { LIVE_LIMITS_MINUTE: '5', LIVE_LIMITS_HOUR: '100' }, registry, now: () => t }));
    let ran = 0;
    app.all('/api/*', (req, res) => { ran++; res.json({ ok: true }); });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, token) => {
        const r = await fetch(base + p, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
        return { status: r.status, retry: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) };
    };
    const ann = tokenFor(10, 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1');
    const bob = tokenFor(11, 'usr_01JAB2C3D4E5F6G7H8J9K0MNP2');
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await call('PUT', '/api/streams/channel', ann)).status, 200, `write ${i + 1}`);
        const before = ran;
        const refused = await call('PUT', '/api/streams/channel', ann);
        assert.deepStrictEqual([refused.status, refused.body.code, Number(refused.retry) > 0], [429, 'rate_limited', true]);
        assert.strictEqual(ran, before, 'refused before the route ran');
        assert.strictEqual((await call('PUT', '/api/streams/channel', bob)).status, 200, 'another person passes');
        for (let i = 0; i < 20; i++) assert.strictEqual((await call('GET', '/api/streams', ann)).status, 200, 'reads are not counted');
        for (let i = 0; i < 10; i++) assert.strictEqual((await call('POST', '/api/pastes')).status, 200, 'signed-out writes keep the address limit only');
        for (let i = 0; i < 10; i++) {
            assert.strictEqual((await call('POST', '/api/controls/1/move', ann)).status, 200, 'robot controls are never counted');
            assert.strictEqual((await call('POST', '/api/vods/stream/9/chunk', ann)).status, 200, 'recording chunks are never counted');
            assert.strictEqual((await call('POST', '/api/streams/9/heartbeat', ann)).status, 200, 'heartbeats are never counted');
        }
        // Channel-point heartbeats are ordinary writes, not money: a second person sends 5 (the test's general limit).
        const dave = tokenFor(13, 'usr_01JAB2C3D4E5F6G7H8J9K0MNP4');
        t += 60 * 1000;
        for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/api/coins/heartbeat', dave)).status, 200);
        const { ROUTES } = require('../server/net/actor-limits');
        const money = ROUTES.find((r) => r[0] === 'live.money');
        assert.ok(money[2].test('/funds/donate') && money[2].test('/payments/bucks/checkout') && !money[2].test('/coins/heartbeat') && !money[2].test('/payments/webhook/stripe'));
        // A named route has its own limit, and the general write budget applies too.
        t += 60 * 1000;
        const carol = tokenFor(12, 'usr_01JAB2C3D4E5F6G7H8J9K0MNP3');
        for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/api/streams/managed/4/regenerate-key', carol)).status, 200);
        const key = await call('POST', '/api/streams/managed/4/regenerate-key', carol);
        assert.strictEqual(key.status, 429);
        assert.ok(/live\.(stream\.key|api\.write)/.test(key.body.detail), key.body.detail);
        // The next minute opens the window again.
        t += 60 * 1000;
        assert.strictEqual((await call('PUT', '/api/streams/channel', ann)).status, 200);
        assert.ok(counted.some((l) => l.limit === 'live.api.write' && l.window === 'minute'), 'refusals are counted');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('actor limits: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
