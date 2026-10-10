'use strict';
// Live's Network keys (server/auth/auth.js, openvibe-sdk/auth createNetworkKeys). With no key file, Live verifies
// against Network's JWKS instead of refusing every sign-in: a person's session token verifies, a key rotation is
// followed after one refetch, and the service guard reads the same keys. Typed tokens (a FedCM assertion, a realtime
// ticket, an export token) and service principal tokens are never a session, whoever signed them.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const LEGACY = '/opt/openvibe/openvibe-tools/data/keys/public.pem';
if (fs.existsSync(LEGACY)) { console.log(`network-keys: skipped (a key file at ${LEGACY} wins over the JWKS here)`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-keys-'));
const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const K1 = pair(), K2 = pair(), ROGUE = pair();
const jwkOf = (k, kid) => ({ ...k.publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid });
let published = [jwkOf(K1, 'k1')];
let fetches = 0;
const network = http.createServer((req, res) => {
    if (req.url !== '/api/.well-known/jwks') { res.statusCode = 404; return res.end(); }
    fetches++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: published }));
});

const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    process.env.NODE_ENV = 'test';
    process.env.DATA_DIR = tmp;                                    // no data/keys/openvibe-tools-public.pem
    process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'absent.pem');
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;
    const express = require('express');
    const { serviceAuth } = require('openvibe-contracts');
    const db = require('../server/db/database');
    const auth = require('../server/auth/auth');
    const { guard } = require('../server/net/service-guard');
    await db.initDb();

    const now = () => Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const sign = (k, kid, claims) => {
        const input = `${enc({ alg: 'RS256', typ: 'JWT', kid })}.${enc(claims)}`;
        return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), k.privateKey).toString('base64url')}`;
    };
    const session = (extra = {}) => ({ sub: 7, id: 7, subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR', username: 'x', role: 'user', iss: auth.getNetworkIssuer(), iat: now(), exp: now() + 600, ...extra });

    const app = express();
    app.get('/internal/probe', guard('live.chat_context.read'), (req, res) => res.json({ sub: req.principal.sub }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const probe = (token) => fetch(`http://127.0.0.1:${server.address().port}/internal/probe`, { headers: { authorization: `Bearer ${token}` } });

    try {
        assert.strictEqual(auth.networkKeysLoaded(), false, 'nothing fetched at module load');
        const claims = await auth.verifyToken(sign(K1, 'k1', session()));
        assert.ok(claims && claims.subject_id === 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR', 'a session token verifies against the JWKS');
        assert.strictEqual(auth.networkKeysLoaded(), true, 'the readiness check sees the keys');

        const before = fetches;
        published = [jwkOf(K2, 'k2'), jwkOf(K1, 'k1')];
        assert.ok(await auth.verifyToken(sign(K2, 'k2', session())), 'a rotated key verifies');
        assert.strictEqual(fetches, before + 1, 'after one refetch');
        assert.strictEqual(await auth.verifyToken(sign(ROGUE, 'k1', session())), null, 'a key Network never published');

        for (const [what, extra] of [['a FedCM assertion', { typ: 'fedcm' }], ['a realtime ticket', { typ: 'realtime', purpose: 'realtime' }],
            ['an export token', { purpose: 'export' }], ['a service principal', { sub: 'svc:chat', actor_type: 'service' }]]) {
            const r = await auth.verifyTokenWithReason(sign(K2, 'k2', session(extra)));
            assert.deepStrictEqual([r.ok, r.reason], [false, 'token.not_user'], what);
        }
        const expired = await auth.verifyTokenWithReason(sign(K2, 'k2', session({ exp: now() - 120 })));
        assert.strictEqual(expired.reason, 'token.expired');

        const svc = (cap) => serviceAuth.signServiceToken({ iss: auth.getNetworkIssuer(), sub: 'svc:chat', actor_type: 'service', aud: ['openvibe.live'], cap, ns: [], iat: now(), exp: now() + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` },
            K2.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        let r = await probe(svc(['live.chat_context.read']));
        assert.strictEqual(r.status, 200, 'the service guard reads the same keys');
        assert.strictEqual((await r.json()).sub, 'svc:chat');
        r = await probe(svc([]));
        assert.strictEqual(r.status, 403);
        r = await probe(sign(K2, 'k2', session()));
        assert.strictEqual(r.status, 401, 'a session token is not a service token');
    } finally {
        server.close();
        network.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    quiet('network-keys: all checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
