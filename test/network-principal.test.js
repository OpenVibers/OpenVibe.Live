'use strict';

// Live as a service principal (roadmap Wave 1): coins and notification pushes go to Network with a
// client-credentials token; every other internal call keeps the X-Internal-Key; a token that can't be
// had or is refused falls back to the key without losing the call. Against a stub Network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-principal-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.INTERNAL_API_KEY = 'legacy-key';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const mode = { token: 'ok', coins: 'ok' };
const seen = [];
let tokenCalls = 0;

const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const send = (status, body, type = 'application/json') => { res.statusCode = status; res.setHeader('Content-Type', type); res.end(JSON.stringify(body)); };
        if (req.url === '/oauth/token') {
            tokenCalls++;
            const f = new URLSearchParams(raw);
            assert.strictEqual(f.get('grant_type'), 'client_credentials');
            assert.strictEqual(f.get('client_secret'), 'live-secret');
            if (mode.token !== 'ok') return send(400, { error: 'invalid_scope' });
            const now = Math.floor(Date.now() / 1000);
            return send(200, { access_token: serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: ['openvibe.network'], cap: ['network.coins.credit'], iat: now, exp: now + 300, jti: `tok_${tokenCalls}abcdefg` }, keys.privateKey), expires_in: 300 });
        }
        const auth = req.headers.authorization ? 'token' : req.headers['x-internal-key'] === 'legacy-key' ? 'key' : 'none';
        seen.push({ url: req.url, auth });
        if (auth === 'token' && mode.coins === 'refuse') return send(401, { code: 'token.bad_signature' }, 'application/problem+json');
        if (req.url.startsWith('/internal/coins/')) return send(200, { balance: 10 });
        return send(200, { ok: true });
    });
});

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;

    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    const uid = d.prepare("INSERT INTO users (username, password_hash, stream_key) VALUES ('p', 'x', 'k1')").run().lastInsertRowid;
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (?, 'network', '41')").run(uid);
    const wallet = require('../server/monetization/wallet-client');
    const principal = require('../server/net/network-principal');
    const notify = require('../server/utils/notify');

    // 1. Coins go with a service token; the token is cached across calls.
    assert.deepStrictEqual(await wallet.credit(uid, 5, 'test', 'idem-1'), { balance: 10 });
    await wallet.credit(uid, 5, 'test', 'idem-2');
    assert.deepStrictEqual(seen.map((s) => s.auth), ['token', 'token']);
    assert.strictEqual(tokenCalls, 1, 'one token for both calls');

    // 2. link-account takes a service token too since Network guards it (identity.subject.resolve, 2026-09-24).
    seen.length = 0;
    await (async () => { notify.reportLinkedAccount({ id: uid, username: 'p' }); await new Promise((x) => setTimeout(x, 150)); })();
    assert.deepStrictEqual(seen.map((s) => `${s.url}:${s.auth}`), ['/internal/link-account:token']);
    assert.ok(!principal.TOKEN_PATHS.has('/internal/notifications/mark-read'), 'routes Network does not guard by capability keep the key');

    // 3. A refused token is retried once with the key, and the key is used until the pause ends.
    seen.length = 0; mode.coins = 'refuse';
    assert.deepStrictEqual(await wallet.credit(uid, 5, 'test', 'idem-3'), { balance: 10 }, 'the call still succeeds');
    assert.deepStrictEqual(seen.map((s) => s.auth), ['token', 'key']);
    await wallet.credit(uid, 5, 'test', 'idem-4');
    assert.strictEqual(seen[2].auth, 'key', 'paused: no token attempt');

    // 4. Network that can't issue a token (not upgraded, no grant): quietly use the key.
    principal._reset(); mode.coins = 'ok'; mode.token = 'fail'; seen.length = 0;
    await wallet.debit(uid, 1, 'test', 'idem-5');
    assert.deepStrictEqual(seen.map((s) => s.auth), ['key']);
    assert.ok(principal.stats.tokenFailures >= 1);

    network.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('network principal: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
