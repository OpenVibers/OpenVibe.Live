'use strict';

// POST /api/cosmetics/internal-unlock grants paid cosmetics, so only the configured INTERNAL_API_KEY
// opens it. The legacy X-Internal-Secret is in git history: from loopback, without proxy headers,
// it used to be enough on its own.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-cosmetics-internal-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.INTERNAL_API_KEY = 'k'.repeat(40);
console.log = () => {};
console.warn = () => {};
console.error = () => {};

(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/cosmetics', require('../server/monetization/cosmetics-routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/cosmetics/internal-unlock`;
    const post = (headers) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({}) });
    try {
        assert.strictEqual((await post({ 'x-internal-secret': 'openvibe-internal-2026' })).status, 403, 'the legacy secret from loopback no longer opens it');
        assert.strictEqual((await post({})).status, 403);
        assert.strictEqual((await post({ 'x-internal-key': 'wrong' })).status, 403);
        assert.strictEqual((await post({ 'x-internal-key': 'k'.repeat(40) })).status, 400, 'the internal key gets past the gate (then needs userId/itemId)');
        process.stdout.write('cosmetics internal-unlock: all checks passed\n');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
