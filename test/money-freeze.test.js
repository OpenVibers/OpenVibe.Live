'use strict';
/**
 * money_writes_frozen: refuses every money action a person or an operator starts on Live (checkout, donation, cashout
 * request, recycle, subscribe, cancel, Vibes media request and refund) before OpenVibe.Billing is ever called, while
 * reads keep working. Only the owner can set it; every admin can see it at /api/admin/money.
 */
const assert = require('assert');
const http = require('http');
const { startNetwork, startBilling } = require('./billing-stub');

process.env.NODE_ENV = 'test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const SID_ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1';
const SID_BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2';

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
    const network = await startNetwork();
    const billing = await startBilling({ network });
    process.env.OV_NETWORK_INTERNAL_URL = network.url;
    process.env.OV_BILLING_INTERNAL_URL = billing.url;

    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const addUser = async (id, username, role, extra = {}) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, ?)`).run(id, username, username, `${username}@x`, role, extra.is_owner ? 1 : 0);
    await addUser(1, 'owner', 'admin', { is_owner: 1 });
    await addUser(2, 'ann', 'user');
    await addUser(3, 'bob', 'streamer', { cashout: 1000 });
    await addUser(4, 'admin2', 'admin');
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?), (3, 'network', '103', ?)").run(SID_ANN, SID_BOB);
    await db.setSetting('powerchat_enabled', 'true');
    await db.setSetting('powerchat_client_id', 'pca_test');
    await db.setSetting('powerchat_site_tip_username', 'sitepc');
    const auth = require('../server/auth/auth');
    const signIn = async (req) => { const id = Number(req.headers['x-test-user'] || 0); const u = id ? await db.getUserById(id) : null; if (u) req.user = u; return u; };
    auth.requireAuth = (req, res, next) => { signIn(req).then((u) => u ? next() : res.status(401).json({ error: 'Authentication required' })).catch(next); };
    auth.optionalAuth = (req, res, next) => { signIn(req).then(() => next()).catch(next); };
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { signIn(req).then(() => next()).catch(next); });
    app.use('/api/funds', require('../server/monetization/routes'));
    app.use('/api/payments', require('../server/monetization/payments-routes'));
    app.use('/api/admin', require('../server/admin/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = async (method, p, user, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, json, text };
    };
    const money = require('../server/monetization/money-authority');
    const mediaQueue = require('../server/media/media-queue');

    // Every write route a person or operator can start. Each must answer 503 money_writes_frozen.
    const writes = [
        ['POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 10 }],
        ['POST', '/api/funds/cashout', 3, { amount: 600, paypal_email: 'bob@example.com' }],
        ['POST', '/api/funds/recycle', 3, { amount: 10 }],
        ['POST', '/api/payments/bucks/checkout', 2, { provider: 'powerchat', bucks: 500 }],
        ['POST', '/api/payments/subscribe', 2, { streamer: 'bob', provider: 'bucks' }],
        ['POST', '/api/payments/subscriptions/1/cancel', 2, {}],
    ];
    async function expectAllRefused(label) {
        for (const [m, p, u, b] of writes) {
            const r = await call(m, p, u, b);
            assert.strictEqual(r.status, 503, `${label} ${p}: ${r.text}`);
            assert.strictEqual(r.json.code, 'money_writes_frozen', `${label} ${p}`);
        }
        await assert.rejects(mediaQueue.charge({ currency: 'vibes', cost: 10, userId: 2, streamerId: 3, streamId: null, label: 'x', requestId: 9001 }), /paused/);
    }

    await check('only the owner can freeze; every admin can see it', async () => {
        assert.strictEqual((await call('POST', '/api/admin/money/freeze', 4, { on: true })).status, 403);
        assert.strictEqual((await call('POST', '/api/admin/money/freeze', 2, { on: true })).status, 403);
        assert.strictEqual((await call('PUT', '/api/admin/settings/money_writes_frozen', 4, { value: 'true' })).status, 403, 'not through the generic settings either');
        assert.strictEqual(await money.isFrozen(), false);
        const r = await call('POST', '/api/admin/money/freeze', 1, { on: true, reason: 'maintenance' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.frozen, true);
        const seen = await call('GET', '/api/admin/money', 4);
        assert.deepStrictEqual([seen.json.authority, seen.json.frozen, seen.json.reason, seen.json.by], ['billing', true, 'maintenance', 'owner']);
        assert.strictEqual((await call('GET', '/api/admin/money', 2)).status, 403, 'not for non-admins');
        assert.strictEqual((await call('GET', '/api/payments/config')).json.moneyFrozen, true);
    });

    await check('frozen: every money write is refused before Billing is ever called', async () => {
        billing.fund(SID_ANN, 1000);
        const n = billing.calls.length;
        await expectAllRefused('frozen');
        assert.strictEqual(billing.calls.length, n, 'zero Billing calls while frozen');
    });

    await check('frozen: a Vibes media refund is deferred (not lost, not marked refunded)', async () => {
        const id = Number((await db.run("INSERT INTO media_requests (streamer_id, user_id, username, input, canonical_url, provider, title, duration_seconds, cost, queue_position, currency) VALUES (3, 2, 'ann', 'x', 'https://x.test/1', 'youtube', 't', 60, 10, 1, 'vibes') RETURNING id")).lastInsertRowid);
        assert.strictEqual(await mediaQueue.refund(id), 0);
        assert.strictEqual((await db.getMediaRequestById(id)).refunded, 0);
    });

    await check('frozen: reads are served (from Billing)', async () => {
        const b = await call('GET', '/api/funds/balance', 2);
        assert.strictEqual(b.status, 200, b.text);
        assert.strictEqual((await call('GET', '/api/funds/history', 2)).status, 200);
        assert.strictEqual((await call('GET', '/api/payments/channel/bob', 2)).status, 200);
    });

    await check('unfreeze: money moves again, through Billing', async () => {
        const r = await call('POST', '/api/admin/money/freeze', 1, { on: false });
        assert.strictEqual(r.json.frozen, false);
        const d = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 10 });
        assert.strictEqual(d.status, 200, d.text);
        assert.strictEqual(billing.calls[billing.calls.length - 1].path, '/transfers');
    });

    server.close();
    await billing.close();
    await network.close();
    quiet(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { quiet(e); process.exit(1); });
