'use strict';

// POST /api/cosmetics/internal-unlock grants paid cosmetics, so only the configured INTERNAL_API_KEY
// opens it, and only from loopback. The legacy X-Internal-Secret is in the repository's history:
// from loopback, without proxy headers, it used to be enough on its own. The key is shared by
// Network, Live, Media and Tools, so a request that came through the public edge (nginx adds
// X-Forwarded-For / X-Real-IP, Cloudflare CF-Connecting-IP) is refused even with the right key.
// The same rule and a constant-time compare cover the other X-Internal-Key routes
// (server/net/internal-key.js): /internal/* and /internal/analytics-summary.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-cosmetics-internal-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const KEY = 'k'.repeat(40);
process.env.INTERNAL_API_KEY = KEY;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

(async () => {
    require('../server/db/database').initDb();
    const app = express();
    app.use(express.json());
    app.use('/api/cosmetics', require('../server/monetization/cosmetics-routes'));
    app.use('/internal', require('../server/internal/routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = (p, headers, body = {}) => fetch(origin + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const unlock = (headers) => post('/api/cosmetics/internal-unlock', headers);
    try {
        // ── internal-unlock ──────────────────────────────────────────────────────────
        assert.strictEqual((await unlock({ 'x-internal-secret': 'openvibe-internal-2026' })).status, 403, 'the legacy secret from loopback no longer opens it');
        assert.strictEqual((await unlock({})).status, 403);
        assert.strictEqual((await unlock({ 'x-internal-key': 'wrong' })).status, 403);
        assert.strictEqual((await unlock({ 'x-internal-key': 'j'.repeat(40) })).status, 403, 'a wrong key of the right length');
        assert.strictEqual((await unlock({ 'x-internal-key': KEY + 'x' })).status, 403, 'a longer key that starts right');
        assert.strictEqual((await unlock({ 'x-internal-key': KEY })).status, 400, 'the internal key from loopback gets past the gate (then needs userId/itemId)');
        for (const h of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) {
            assert.strictEqual((await unlock({ 'x-internal-key': KEY, [h]: '203.0.113.9' })).status, 403, `the right key through the public edge (${h}) is refused`);
        }

        // ── the other X-Internal-Key routes: same rule ──────────────────────────────
        const avatar = (headers) => post('/internal/user-avatar', headers, { username: 'nobody-here' });
        assert.strictEqual((await avatar({ 'x-internal-key': KEY })).status, 404, 'the right key from loopback reaches /internal/*');
        assert.strictEqual((await avatar({ 'x-internal-key': 'j'.repeat(40) })).status, 403);
        assert.strictEqual((await avatar({ 'x-internal-key': KEY, 'x-forwarded-for': '203.0.113.9' })).status, 403);
        assert.strictEqual((await avatar({ 'x-internal-key': KEY, 'cf-connecting-ip': '203.0.113.9' })).status, 403);

        const ik = require('../server/net/internal-key');
        assert.strictEqual(ik.internalKeyMatches(KEY), true);
        assert.strictEqual(ik.internalKeyMatches(''), false);
        assert.strictEqual(ik.internalKeyMatches(KEY.slice(0, 39)), false);

        // No internal-key compare with === / !== is left anywhere in the server.
        const offenders = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.js')) {
                    const src = fs.readFileSync(p, 'utf8');
                    if (/[!=]==\s*(config\.internalApiKey|INTERNAL_API_KEY)\b|\b(config\.internalApiKey|INTERNAL_API_KEY)\s*[!=]==/.test(src)) offenders.push(path.relative(path.join(__dirname, '..'), p));
                }
            }
        };
        walk(path.join(__dirname, '..', 'server'));
        assert.deepStrictEqual(offenders, [], 'internal keys are compared with internalKeyMatches (constant time)');
        process.stdout.write('cosmetics internal-unlock: all checks passed\n');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
