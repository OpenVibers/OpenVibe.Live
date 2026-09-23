'use strict';

// GET /internal/followers — OpenVibe.Network asks who follows the channel behind a stream when it
// consumes live.stream.started. Service token with live.follower.read, loopback only, paged.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-followers-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
console.log = () => {};
console.warn = () => {};

const ISS = 'https://openvibe.network';
const now = () => Math.floor(Date.now() / 1000);
let jti = 0;
const token = (cap) => serviceAuth.signServiceToken({ iss: ISS, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.live'], cap, iat: now(), exp: now() + 300, jti: `tok_net_${++jti}` }, keys.privateKey);

(async () => {
    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    for (const [id, name] of [[601, 'streamer'], [602, 'fan_a'], [603, 'fan_b'], [604, 'fan_c']]) {
        d.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, 'x')").run(id, name, name);
    }
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (601, 'network', '70', 'usr_01J0000000000000000000000S')").run();
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (602, 'network', '71', 'usr_01J0000000000000000000000A')").run();
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (603, 'network', '72')").run();
    for (const f of [602, 603, 604]) d.prepare('INSERT INTO follows (follower_id, streamer_id) VALUES (?, 601)').run(f);
    const streamId = d.prepare("INSERT INTO streams (user_id, title, is_live) VALUES (601, 'hello', 1)").run().lastInsertRowid;

    const app = express();
    app.use('/internal/followers', require('../server/streaming/followers-internal'));
    const server = await new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (q, { cap = ['live.follower.read'], headers = {} } = {}) => fetch(`${base}/internal/followers?${q}`, {
        headers: { Authorization: `Bearer ${token(cap)}`, ...headers },
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

    assert.strictEqual((await get(`stream_id=${streamId}`, { cap: ['live.chat_effects.write'] })).status, 403, 'needs live.follower.read');
    assert.strictEqual((await get(`stream_id=${streamId}`, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403, 'loopback only');
    assert.strictEqual((await fetch(`${base}/internal/followers?stream_id=${streamId}`)).status, 401, 'no token');
    assert.strictEqual((await get('stream_id=abc')).status, 400);
    assert.strictEqual((await get('stream_id=999999')).status, 404);

    const all = await get(`stream_id=${streamId}`);
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.json.channel.subject, 'usr_01J0000000000000000000000S');
    assert.deepStrictEqual(all.json.followers, [
        { subject: 'usr_01J0000000000000000000000A', network_user_id: 71 },
        { subject: null, network_user_id: 72 },
        { subject: null, network_user_id: null },
    ]);
    assert.strictEqual(all.json.next, null);

    // Paging: two per page, then the rest.
    const p1 = await get(`stream_id=${streamId}&limit=2`);
    assert.strictEqual(p1.json.followers.length, 2);
    assert.ok(p1.json.next);
    const p2 = await get(`stream_id=${streamId}&limit=2&after=${p1.json.next}`);
    assert.strictEqual(p2.json.followers.length, 1);
    assert.strictEqual(p2.json.next, null);

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.stdout.write('followers-internal: all passed\n');
    process.exit(0);
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
