'use strict';

// OpenVibe.Tips → Live (roadmap Wave 9): POST /internal/tips/deliveries announces a settled tip in the
// creator's chat — service token with live.tips_delivery.write, idempotent per delivery id, the
// creator found by Network subject, no Live balance touched.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tips-delivery-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
fs.mkdirSync(path.join(tmp, 'sounds'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.SOUNDS_PATH = path.join(tmp, 'sounds');
console.log = () => {};
console.warn = () => {};

const ISS = 'https://openvibe.network';
const SUBJECT = 'usr_01J0000000000000000000000Z';
const now = () => Math.floor(Date.now() / 1000);
let jti = 0;
const token = (cap, aud = 'openvibe.live') => serviceAuth.signServiceToken({ iss: ISS, sub: 'svc:tips', actor_type: 'service', aud: [aud], cap, iat: now(), exp: now() + 300, jti: `tok_tips_${++jti}` }, keys.privateKey);

(async () => {
    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    d.prepare("INSERT INTO users (id, username, display_name, password_hash, openvibe_bucks_balance, openvibe_bucks_cashout_balance) VALUES (501, 'alex', 'Alex', 'x', 0, 0)").run();
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (501, 'network', '77', ?)").run(SUBJECT);

    const chatServer = require('../server/chat/chat-server');
    const broadcasts = [];
    chatServer.broadcastToChannelRoom = (uid, sid, ev) => broadcasts.push({ uid, sid, ev });
    chatServer.broadcastGlobal = () => {};
    const tts = [];
    chatServer.synthesizeAndBroadcastTTS = async (...a) => { tts.push(a); };

    const app = express();
    app.use('/internal/tips', require('../server/tips/delivery-routes'));
    const server = await new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body, { cap = ['live.tips_delivery.write'], key = 'tint_1:chat_line', headers = {} } = {}) => fetch(`${base}/internal/tips/deliveries`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(cap)}`, 'Idempotency-Key': key, ...headers }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

    const job = {
        delivery_id: 'tint_1:chat_line', effect: 'chat_line', test: false, creator: { type: 'user', id: SUBJECT },
        supporter: { name: 'Viewer' }, interaction: { id: 'tint_1', kind: 'tip', amount: 250, currency: 'vibes-bits', message: 'gg' },
        text: 'Viewer tipped 250 Vibes: gg',
    };

    assert.strictEqual((await post(job, { cap: ['live.chat_effects.write'] })).status, 403, 'needs live.tips_delivery.write');
    assert.strictEqual((await post(job, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403, 'loopback only');

    const a = await post(job);
    assert.strictEqual(a.status, 200);
    assert.ok(a.json.ref.chat_message_id > 0);
    assert.strictEqual(broadcasts.length, 1);
    assert.strictEqual(broadcasts[0].uid, 501);
    assert.strictEqual(broadcasts[0].ev.type, 'donation');
    assert.strictEqual(broadcasts[0].ev.amount, 250);
    const saved = d.prepare("SELECT * FROM chat_messages WHERE message_type = 'donation'").get();
    assert.strictEqual(saved.message, 'Viewer tipped 250 Vibes: gg');
    assert.strictEqual(JSON.parse(saved.metadata).source, 'tips');

    // A retry of the same delivery changes nothing.
    const b = await post(job);
    assert.deepStrictEqual(b.json, a.json);
    assert.strictEqual(broadcasts.length, 1);
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE message_type = 'donation'").get().n, 1);

    // TTS on the (offline) channel room.
    const t = await post({ ...job, effect: 'tts', tts: { text: 'read me', voice: 'gary' } }, { key: 'tint_1:tts' });
    assert.strictEqual(t.status, 200);
    assert.strictEqual(tts[0][2], 'read me');
    assert.strictEqual(tts[0][6], 501);

    // Unknown creator: permanent refusal.
    const u = await post({ ...job, creator: { type: 'user', id: 'usr_01J0000000000000000000000Y' } }, { key: 'tint_2:chat_line' });
    assert.strictEqual(u.status, 404);

    // No Live balance moved.
    const user = d.prepare('SELECT openvibe_bucks_balance, openvibe_bucks_cashout_balance FROM users WHERE id = 501').get();
    assert.deepStrictEqual(user, { openvibe_bucks_balance: 0, openvibe_bucks_cashout_balance: 0 });
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM transactions").get().n, 0);

    server.close();
    process.stdout.write('tips-delivery: all passed\n');
    process.exit(0);
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
