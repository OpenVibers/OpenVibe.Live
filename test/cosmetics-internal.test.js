'use strict';

// Live's internal (server-to-server) routes after the X-Internal-Key retirement (plan T2):
//  - each route checks the one capability it performs on a Network service token (server/net/service-guard.js);
//  - the retired key opens nothing, alone or next to a bad token;
//  - nothing that came through nginx or Cloudflare gets in;
//  - POST /api/cosmetics/internal-unlock (the openvibe-quest bridge) is gone: the quest game runs nowhere;
//  - no server file reads INTERNAL_API_KEY any more.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-internal-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
const KEY = 'k'.repeat(40);   // what an old caller would send: it must open nothing
process.env.INTERNAL_API_KEY = KEY;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const now = () => Math.floor(Date.now() / 1000);
let jti = 0;
const token = (cap, { aud = 'openvibe.live', sub = 'svc:network', env } = {}) => serviceAuth.signServiceToken({
    iss: 'https://openvibe.network', sub, actor_type: 'service', aud: [aud], cap, iat: now(), exp: now() + 300, jti: `tok_test_${String(++jti).padStart(4, '0')}`, ...(env ? { env } : {}),
}, keys.privateKey);

(async () => {
    await require('../server/db/database').initDb();
    const app = express();
    app.use(express.json());
    app.use('/api/cosmetics', require('../server/monetization/cosmetics-routes'));
    app.use('/internal', require('../server/internal/routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = (p, headers, body = {}) => fetch(origin + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const bearer = (t) => ({ authorization: `Bearer ${t}` });
    try {
        // ── the quest bridge is gone ─────────────────────────────────────────────────
        for (const h of [{ 'x-internal-key': KEY }, { 'x-internal-secret': 'openvibe-internal-2026' }]) {
            assert.strictEqual((await post('/api/cosmetics/internal-unlock', h, { userId: 1, itemId: 'fx_fire' })).status, 404, 'internal-unlock no longer exists');
        }
        // activate/deactivate answer 410 for one release (old tabs, ADR-016), behind the same auth.
        for (const p of ['/api/cosmetics/activate', '/api/cosmetics/deactivate']) assert.strictEqual((await post(p, {}, { itemId: 'fx_fire' })).status, 401, `${p} still needs a session`);

        // ── /internal/user-avatar: live.avatar.write ─────────────────────────────────
        const avatar = (headers) => post('/internal/user-avatar', headers, { username: 'nobody-here' });
        assert.strictEqual((await avatar(bearer(token(['live.avatar.write'])))).status, 404, 'the capability reaches the handler (no such user)');
        assert.strictEqual((await avatar(bearer(token(['live.url_registry.refresh'])))).status, 403, 'another capability is not enough');
        assert.strictEqual((await avatar(bearer(token(['live.avatar.write'], { aud: 'openvibe.network' })))).status, 401, 'a token for another audience');
        assert.strictEqual((await avatar(bearer(token(['live.avatar.write'], { env: 'sandbox' })))).status, 401, 'a sandbox token');
        assert.strictEqual((await avatar({ ...bearer('not.a.token'), 'x-internal-key': KEY })).status, 401, 'a bad token is not rescued by the key');
        assert.strictEqual((await avatar({ ...bearer(token(['live.avatar.write'])), 'x-forwarded-for': '203.0.113.9' })).status, 403, 'a token through the public edge is refused');
        assert.strictEqual((await avatar({})).status, 401);
        // The retired key opens nothing.
        assert.strictEqual((await avatar({ 'x-internal-key': KEY })).status, 401, 'the key alone is refused');
        for (const h of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) {
            assert.strictEqual((await avatar({ ...bearer(token(['live.avatar.write'])), [h]: '203.0.113.9' })).status, 403, `a token through the public edge (${h}) is refused`);
        }

        // ── the other internal routes: each has its own capability ───────────────────
        assert.strictEqual((await post('/internal/url-registry/refresh', bearer(token(['live.avatar.write'])))).status, 403);
        assert.notStrictEqual((await post('/internal/url-registry/refresh', bearer(token(['live.url_registry.refresh'])))).status, 403, 'live.url_registry.refresh opens the refresh');

        // No server file reads or sends the retired key.
        const offenders = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.js')) {
                    const src = fs.readFileSync(p, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');   // code, not comments
                    if (/INTERNAL_API_KEY|OV_INTERNAL_KEY|internalApiKey|x-internal-key/i.test(src)) offenders.push(path.relative(path.join(__dirname, '..'), p));
                }
            }
        };
        walk(path.join(__dirname, '..', 'server'));
        assert.deepStrictEqual(offenders, [], 'no server file reads or sends X-Internal-Key');
        process.stdout.write('live internal routes: all checks passed\n');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
