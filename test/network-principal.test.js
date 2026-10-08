'use strict';

// Live as a service principal (ADR-003): every internal call to Network goes with a client-credentials
// token; the X-Internal-Key is never sent (plan T2). A refused token is retried once with a fresh one; no
// token at all fails the call like an unreachable Network. Against a stub Network.

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

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
    await db.initDb();
    const d = db.getDb();
    const uid = (await d.prepare("INSERT INTO users (username, password_hash, stream_key) VALUES ('p', 'x', 'k1') RETURNING id").run()).lastInsertRowid;
    await d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (?, 'network', '41')").run(uid);
    const wallet = require('../server/monetization/wallet-client');
    const principal = require('../server/net/network-principal');
    const notify = require('../server/utils/notify');

    // 1. Coins go with a service token; the token is cached across calls.
    assert.deepStrictEqual(await wallet.credit(uid, 5, 'test', 'idem-1'), { balance: 10 });
    await wallet.credit(uid, 5, 'test', 'idem-2');
    assert.deepStrictEqual(seen.map((s) => s.auth), ['token', 'token']);
    assert.strictEqual(tokenCalls, 1, 'one token for both calls');

    // 2. Every other internal call goes with the token too: link-account, the avatar report and mark-read (the last
    //    two were key-only until Network guarded them, plan T2).
    seen.length = 0;
    notify.reportLinkedAccount({ id: uid, username: 'p' });
    notify.reportAvatarChange({ id: uid, avatar_url: 'https://openvibe.media/f/a.png' });
    notify.markNotificationsRead(uid, 'follow');
    await new Promise((x) => setTimeout(x, 200));
    assert.deepStrictEqual(seen.map((s) => `${s.url}:${s.auth}`).sort(), ['/internal/link-account:token', '/internal/notifications/mark-read:token', '/internal/user-avatar:token']);

    // 3. A refused token is retried once with a fresh token (never the key); refused again, the call fails.
    seen.length = 0; mode.coins = 'refuse';
    const before = tokenCalls;
    await assert.rejects(wallet.credit(uid, 5, 'test', 'idem-3'), (e) => e.status === 401, 'refused twice: the call fails');
    assert.deepStrictEqual(seen.map((s) => s.auth), ['token', 'token']);
    assert.strictEqual(tokenCalls, before + 1, 'the retry minted a fresh token');

    // 4. No token at all (Network cannot issue one): the call fails like an unreachable Network; nothing is sent.
    principal._reset(); mode.coins = 'ok'; mode.token = 'fail'; seen.length = 0;
    await assert.rejects(wallet.debit(uid, 1, 'test', 'idem-5'), (e) => e.status === 0);
    assert.deepStrictEqual(seen, []);
    assert.ok(principal.stats.tokenFailures >= 1);
    assert.ok(!seen.some((s) => s.auth === 'key'), 'the key is never sent');

    network.close();
    console.log('network principal: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
