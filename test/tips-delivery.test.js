'use strict';

// OpenVibe.Tips → Live (roadmap Wave 9): POST /internal/tips/deliveries announces a settled tip in the
// creator's chat — service token with live.tips_delivery.write, idempotent per delivery id (kept in
// SQLite, so a restart between deliveries does not repeat one), the creator found by Network
// subject, no Live balance touched.

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
    d.prepare("INSERT INTO users (id, username, display_name, password_hash, openvibe_bucks_balance, openvibe_bucks_cashout_balance) OVERRIDING SYSTEM VALUE VALUES (501, 'alex', 'Alex', 'x', 0, 0)").run();
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (501, 'network', '77', ?)").run(SUBJECT);

    // Chat persists and shows the line (Live keeps no chat table): stub the ingress call and record
    // what Live sends, and keep stubbing TTS synthesis (Chat speaks tts lines; the delivery seam is
    // Live's only path).
    const delivery = require('../server/chat/chat-delivery');
    const sent = [];
    let nextId = 700;
    delivery.message = async (body) => { sent.push(body); return nextId++; };
    const tts = [];
    delivery.synthesizeAndBroadcastTTS = async (...a) => { tts.push(a); };

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
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual([sent[0].channel_user_id, sent[0].message_type, sent[0].mirror], [501, 'donation', true]);
    assert.strictEqual(sent[0].message, 'Viewer tipped 250 Vibes: gg');
    assert.strictEqual(sent[0].metadata.source, 'tips');
    assert.strictEqual(sent[0].metadata.amount, 250);

    // A retry of the same delivery changes nothing.
    const b = await post(job);
    assert.deepStrictEqual(b.json, a.json);
    assert.strictEqual(sent.length, 1, 'the retry posts nothing to Chat');

    // A Live restart between deliveries: the answered key is in SQLite, not in the old process.
    delete require.cache[require.resolve('../server/tips/delivery-routes')];
    const app2 = express();
    app2.use('/internal/tips', require('../server/tips/delivery-routes'));
    const server2 = await new Promise((r) => { const s = http.createServer(app2); s.listen(0, '127.0.0.1', () => r(s)); });
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const post2 = (body, key) => fetch(`${base2}/internal/tips/deliveries`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(['live.tips_delivery.write'])}`, 'Idempotency-Key': key }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const afterRestart = await post2(job, 'tint_1:chat_line');
    assert.strictEqual(afterRestart.status, 200);
    assert.deepStrictEqual(afterRestart.json, a.json, 'after a restart the same key answers the first result');
    assert.strictEqual(sent.length, 1, 'and delivers nothing again');

    // A retry while the first attempt is still running is told to come back; a claim left by a
    // crash (older than two minutes) is taken over.
    d.prepare("INSERT INTO tips_deliveries (idempotency_key, effect, state, claimed_at) VALUES ('tint_9:chat_line', 'chat_line', 'pending', ?)").run(Date.now());
    assert.strictEqual((await post2({ ...job, interaction: { ...job.interaction, id: 'tint_9' } }, 'tint_9:chat_line')).status, 409);
    assert.strictEqual(sent.length, 1);
    d.prepare("UPDATE tips_deliveries SET claimed_at = ? WHERE idempotency_key = 'tint_9:chat_line'").run(Date.now() - 5 * 60 * 1000);
    assert.strictEqual((await post2({ ...job, interaction: { ...job.interaction, id: 'tint_9' } }, 'tint_9:chat_line')).status, 200);
    assert.strictEqual(sent.length, 2);

    // A refused delivery gives its key back, so Tips' retry runs it.
    const gone = { ...job, creator: { type: 'user', id: 'usr_01J0000000000000000000000X' } };
    assert.strictEqual((await post2(gone, 'tint_8:chat_line')).status, 404);
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM tips_deliveries WHERE idempotency_key = 'tint_8:chat_line'").get().n, 0);

    // Pruning: answers older than 7 days go, recent ones stay.
    d.prepare("INSERT INTO tips_deliveries (idempotency_key, effect, state, response_json, claimed_at, created_at) VALUES ('tint_old:chat_line', 'chat_line', 'done', '{}', 0, datetime('now', '-8 days'))").run();
    const routes2 = require('../server/tips/delivery-routes');
    assert.strictEqual(routes2.prune({ force: true }), 1);
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM tips_deliveries WHERE idempotency_key = 'tint_old:chat_line'").get().n, 0);
    assert.strictEqual(d.prepare("SELECT state FROM tips_deliveries WHERE idempotency_key = 'tint_1:chat_line'").get().state, 'done');
    server2.close();

    // TTS on the (offline) channel room.
    const t = await post({ ...job, effect: 'tts', tts: { text: 'read me', voice: 'gary' } }, { key: 'tint_1:tts' });
    assert.strictEqual(t.status, 200);
    assert.strictEqual(tts[0][2], 'read me');
    assert.strictEqual(tts[0][6], 501);

    // A hidden amount (Tips privacy.hide_amount sends null) stays hidden: no "0 Vibes" anywhere.
    const h = await post({ ...job, text: undefined, interaction: { ...job.interaction, id: 'tint_h', amount: null, message: 'hi' } }, { key: 'tint_h:chat_line' });
    assert.strictEqual(h.status, 200);
    assert.strictEqual(sent[sent.length - 1].message, 'Viewer sent a tip: hi');
    assert.strictEqual(sent[sent.length - 1].metadata.amount, null);

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
