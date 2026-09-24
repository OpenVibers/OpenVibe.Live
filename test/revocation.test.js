'use strict';
// Revocation propagation in Live (WS-B task 4, Contracts 0.39.0 network.user.token_valid_after):
// POST /internal/network-events (signature v2) records a person's cutoff, only ever forwards; auth.js
// then refuses their Network session tokens issued before it and accepts newer ones; other people,
// unsigned, forged and foreign events change nothing; the subscribe script knows the --network topic.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-revoke-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.LIVE_EVENTS_SECRET = 's'.repeat(40);
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const jwt = require('jsonwebtoken');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const db = require('../server/db/database');
db.initDb();
const auth = require('../server/auth/auth');
auth.reloadNetworkKey();
const networkEvents = require('../server/auth/network-events');
const { parseArgs, NETWORK_TOPICS, NETWORK_ENDPOINT } = require('../scripts/subscribe-media-events');

const ALICE = ids.newId('user'), BOB = ids.newId('user');
const now = () => Math.floor(Date.now() / 1000);
const token = (subject, iatOffset) => jwt.sign({ sub: 7, id: 7, subject_id: subject, username: 'x', role: 'user', iat: now() + iatOffset }, keys.privateKey, { algorithm: 'RS256', issuer: auth.getNetworkIssuer(), expiresIn: '1h' });
const envelope = (subject, validAfterMs, over = {}) => ({
    event_id: ids.newId('event'), event_type: 'network.user.token_valid_after', version: 1, source: 'network',
    actor: { type: 'user', id: subject }, timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'user', id: subject },
    payload: { subject: { type: 'user', id: subject }, valid_after: new Date(validAfterMs).toISOString(), reason: 'signed_out_everywhere' }, ...over,
});

(async () => {
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.post('/internal/network-events', networkEvents.handler);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/internal/network-events`;
    const deliver = (ev, secret = process.env.LIVE_EVENTS_SECRET) => {
        const body = JSON.stringify({ event: ev, seq: 1 });
        const headers = { 'content-type': 'application/json', ...(secret ? signDeliveryHeaders(body, secret) : {}) };
        return fetch(url, { method: 'POST', headers, body }).then((r) => r.status);
    };
    try {
        const oldA = token(ALICE, -60), oldB = token(BOB, -60);
        assert.ok(auth.verifyToken(oldA) && auth.verifyToken(oldB), 'valid before any cutoff');

        assert.strictEqual(await deliver(envelope(ALICE, Date.now() - 5000), null), 401, 'unsigned');
        assert.strictEqual(await deliver(envelope(ALICE, Date.now() - 5000), 'f'.repeat(40)), 401, 'wrong secret');
        assert.strictEqual(await deliver(envelope(ALICE, Date.now() - 5000, { source: 'live' })), 204);
        assert.ok(auth.verifyToken(oldA), 'a foreign source changes nothing');

        assert.strictEqual(await deliver(envelope(ALICE, Date.now() - 5000)), 204);
        assert.strictEqual(networkEvents.stats.revoked, 1);
        assert.strictEqual(auth.verifyToken(oldA), null, 'the old token is refused');
        assert.deepStrictEqual(auth.verifyTokenWithReason(oldA), { ok: false, reason: 'revoked' });
        assert.ok(auth.verifyToken(token(ALICE, 0)), 'a token issued after the cutoff works');
        assert.ok(auth.verifyToken(oldB), 'someone else is untouched');

        assert.strictEqual(await deliver(envelope(ALICE, Date.now() - 600000)), 204);
        assert.strictEqual(networkEvents.stats.unchanged, 1, 'an older cutoff never moves it back');
        assert.strictEqual(auth.verifyToken(oldA), null);
        assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM token_revocations').n, 1, 'kept in the database');

        const o = parseArgs(['--network', '--dry-run']);
        assert.deepStrictEqual([o.topics, o.endpoint, o.action], [NETWORK_TOPICS, NETWORK_ENDPOINT, 'list']);
        assert.ok(/app\.post\('\/internal\/network-events'/.test(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8')), 'mounted');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    quiet('revocation: all checks passed');
})().catch((e) => { console.error = quiet; quiet(e); process.exit(1); });
