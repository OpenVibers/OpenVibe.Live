'use strict';
// A streamer's AI-viewer daily budget is a cap in OpenVibe.AI (roadmap WS-O task 2, server/ai/viewer-quota.js),
// against a stub Network (token endpoint) and a stub AI: the site's AI with a budget sets the cap for live:user:<id>
// on live.viewers.* in dollars a day; their own key or no budget removes it; a missing cap is 'none'; AI down is
// reported, never thrown.
//   node test/viewer-quota.test.js
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

process.env.NODE_ENV = 'test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const calls = [];
const caps = new Set();
const network = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const f = new URLSearchParams(raw); const now = Math.floor(Date.now() / 1000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: [f.get('audience')], cap: ['ai.quota.attribution.manage'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey), token_type: 'Bearer', expires_in: 300 }));
    });
});
const ai = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        const attr = decodeURIComponent(req.url.split('/').pop());
        calls.push({ method: req.method, attr, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'PUT') { caps.add(attr); return res.end(JSON.stringify({ attribution: attr, window: body.window, max_cost_usd: body.max_cost_usd })); }
        if (req.method === 'DELETE') { const had = caps.delete(attr); res.statusCode = had ? 204 : 404; return res.end(); }
        res.statusCode = 404; res.end('{}');
    });
});

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;
    process.env.OV_AI_INTERNAL_URL = `http://127.0.0.1:${ai.address().port}`;
    const db = require('../server/db/database');
    await db.initDb();
    const quota = require('../server/ai/viewer-quota');
    await db.getDb().prepare("INSERT INTO users (id, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (50, 'dana', '$sso$')").run();
    try {
        await db.upsertChannelAiConfig(50, { use_shared_key: 1, daily_budget_cents: 35 });
        assert.strictEqual(await quota.sync(50), 'set');
        assert.deepStrictEqual(calls[0], { method: 'PUT', attr: 'live:user:50', body: { window: 'day', max_cost_usd: 0.35, workflow_prefix: 'live.viewers.' } });
        await db.upsertChannelAiConfig(50, { use_shared_key: 0 });
        assert.strictEqual(await quota.sync(50), 'removed', 'their own key: the site cap goes');
        assert.strictEqual(await quota.sync(50), 'none', 'nothing left to remove');
        await db.upsertChannelAiConfig(50, { use_shared_key: 1, daily_budget_cents: 0 });
        assert.strictEqual(await quota.sync(50), 'none', 'no budget: no cap');
        assert.strictEqual(await quota.sync('x'), 'none');
        ai.close();
        await new Promise((r) => setTimeout(r, 50));
        await db.upsertChannelAiConfig(50, { daily_budget_cents: 20 });
        assert.strictEqual(await quota.sync(50), 'quota.unavailable', 'AI down is reported, never thrown');
    } finally {
        network.close(); ai.close();
    }
    console.log('viewer quota: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
