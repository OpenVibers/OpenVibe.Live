'use strict';
/**
 * money_writes_frozen — step 3 of the Live → Billing cutover runbook. In BOTH modes it refuses
 * every money action a person or an operator starts on Live (checkout, donation, cashout request,
 * approve/deny, recycle, subscribe, cancel, Vibes media request and refund, renewal sweep) while
 * reads keep working. Only the owner can set it; every admin can see it at /api/admin/money.
 * Provider confirmations of checkouts started before the freeze still settle in `live` mode (the
 * provider already took that money). A BILLING_AUTHORITY that is neither live nor billing refuses
 * every money write too.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork, startBilling } = require('./billing-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-money-freeze-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
delete process.env.BILLING_AUTHORITY;
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
    db.initDb();
    const raw = db.getDb();
    const addUser = (id, username, role, extra = {}) => raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner, openvibe_bucks_balance, openvibe_bucks_cashout_balance)
         VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?)`).run(id, username, username, `${username}@x`, role, extra.is_owner ? 1 : 0, extra.bucks || 0, extra.cashout || 0);
    addUser(1, 'owner', 'admin', { is_owner: 1 });
    addUser(2, 'ann', 'user', { bucks: 2000 });
    addUser(3, 'bob', 'streamer', { cashout: 1000 });
    addUser(4, 'admin2', 'admin');
    raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?), (3, 'network', '103', ?)").run(SID_ANN, SID_BOB);
    db.setSetting('powerchat_enabled', 'true');
    db.setSetting('powerchat_client_id', 'pca_test');
    db.setSetting('powerchat_site_tip_username', 'sitepc');
    const snapshot = () => ({
        users: raw.prepare('SELECT id, openvibe_bucks_balance AS b, openvibe_bucks_cashout_balance AS c FROM users ORDER BY id').all(),
        tx: raw.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
        orders: raw.prepare('SELECT COUNT(*) AS n FROM payment_orders').get().n,
        subs: raw.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), \'\') AS u, COALESCE(GROUP_CONCAT(status), \'\') AS s FROM subscriptions').get(),
    });

    const auth = require('../server/auth/auth');
    const signIn = (req) => { const id = Number(req.headers['x-test-user'] || 0); const u = id ? db.getUserById(id) : null; if (u) req.user = u; return u; };
    auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = (req, res, next) => { signIn(req); next(); };
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { signIn(req); next(); });
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
        ['POST', '/api/funds/cashout/1/approve', 1, {}],
        ['POST', '/api/funds/cashout/1/deny', 1, {}],
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
        assert.strictEqual(money.isFrozen(), false);
        const r = await call('POST', '/api/admin/money/freeze', 1, { on: true, reason: 'Billing cutover step 3' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.frozen, true);
        const seen = await call('GET', '/api/admin/money', 4);
        assert.deepStrictEqual([seen.json.authority, seen.json.frozen, seen.json.reason, seen.json.by], ['live', true, 'Billing cutover step 3', 'owner']);
        assert.strictEqual((await call('GET', '/api/admin/money', 2)).status, 403, 'not for non-admins');
        assert.strictEqual((await call('GET', '/api/payments/config')).json.moneyFrozen, true);
    });

    await check('live mode, frozen: every money write is refused and nothing moves', async () => {
        const before = snapshot();
        // A due auto-renewing subscription: the sweep must not renew or expire it while frozen.
        raw.prepare("INSERT INTO subscriptions (subscriber_id, streamer_id, tier, provider, price_cents, status, is_active, current_period_end, auto_renew) VALUES (2, 3, 1, 'bucks', 499, 'active', 1, datetime('now', '-1 hour'), 1)").run();
        const withSub = snapshot();
        await expectAllRefused('live');
        require('../server/monetization/payments').startRenewalSweeper();   // sweeps once immediately
        assert.deepStrictEqual(snapshot(), withSub, 'no column, ledger, order or subscription change');
        assert.notDeepStrictEqual(before, withSub);
    });

    await check('live mode, frozen: a Vibes media refund is deferred (not lost, not marked refunded)', async () => {
        const id = Number(db.createMediaRequest({ streamer_id: 3, stream_id: null, user_id: 2, username: 'ann', input: 'x', canonical_url: 'https://x.test/1', embed_url: null, provider: 'youtube', title: 't', thumbnail_url: null, duration_seconds: 60, cost: 10, queue_position: 1, currency: 'vibes' }).lastInsertRowid);
        assert.strictEqual(await mediaQueue.refund(id), 0);
        assert.strictEqual(db.getMediaRequestById(id).refunded, 0);
    });

    await check('live mode, frozen: reads work', async () => {
        const b = await call('GET', '/api/funds/balance', 2);
        assert.strictEqual(b.status, 200); assert.strictEqual(b.json.balance, 2000);
        assert.strictEqual((await call('GET', '/api/funds/history', 2)).status, 200);
        assert.strictEqual((await call('GET', '/api/payments/channel/bob', 2)).status, 200);
    });

    await check('live mode, frozen: a checkout started before the freeze still settles when the provider confirms it', async () => {
        money.setFrozen(false);
        const order = db.createPaymentOrder({ user_id: 2, provider: 'powerchat', kind: 'bucks', amount_cents: 500, bucks: 500 });
        money.setFrozen(true, { reason: 'x', by: 'test' });
        const consumed = require('../server/integrations/powerchat-checkout').handleAttributedDonation(null, { appExternalRef: `pcorder:${order.id}`, amountUsdCents: 500 });
        assert.strictEqual(consumed, true);
        assert.strictEqual(db.getPaymentOrderById(order.id).status, 'credited');
        assert.strictEqual(db.getUserById(2).openvibe_bucks_balance, 2500);
    });

    await check('unfreeze: money moves again', async () => {
        const r = await call('POST', '/api/admin/money/freeze', 1, { on: false });
        assert.strictEqual(r.json.frozen, false);
        const d = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 10 });
        assert.strictEqual(d.status, 200, d.text);
    });

    await check('billing mode, frozen: refused before Billing is ever called; unfrozen: Billing is called', async () => {
        process.env.BILLING_AUTHORITY = 'billing';
        billing.fund(SID_ANN, 1000);
        money.setFrozen(true, { reason: 'cutover', by: 'test' });
        const n = billing.calls.length;
        await expectAllRefused('billing');
        assert.strictEqual(billing.calls.length, n, 'zero Billing calls while frozen');
        assert.strictEqual((await call('GET', '/api/funds/balance', 2)).status, 200, 'reads still served (from Billing)');
        money.setFrozen(false);
        const d = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 10 });
        assert.strictEqual(d.status, 200, d.text);
        assert.strictEqual(billing.calls[billing.calls.length - 1].path, '/transfers');
    });

    await check('a BILLING_AUTHORITY typo refuses money writes instead of guessing', async () => {
        process.env.BILLING_AUTHORITY = 'bilIing';
        assert.strictEqual(money.authority(), 'invalid');
        const r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 10 });
        assert.strictEqual(r.status, 503); assert.strictEqual(r.json.code, 'billing_misconfigured');
        assert.throws(() => db.addVibes(2, 1), /not 'live' or 'billing'/);
        delete process.env.BILLING_AUTHORITY;
    });

    server.close();
    await billing.close();
    await network.close();
    quiet(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { quiet(e); process.exit(1); });
