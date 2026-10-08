'use strict';
/**
 * BILLING_AUTHORITY unset (= live, the default): the Billing client changes nothing. The money
 * routes move Live's own columns exactly as before, OpenVibe.Billing is never called (a stand-in
 * is running and counts calls), the Live webhooks still receive, and the billing_actions journal
 * stays empty. The rest of the suite (authorization, powerchat-*, migrations …) covers the
 * existing money behaviour unchanged.
 */
const assert = require('assert');
const http = require('http');
const { startNetwork, startBilling } = require('./billing-stub');

process.env.NODE_ENV = 'test';
delete process.env.BILLING_AUTHORITY;
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

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
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner, openvibe_bucks_balance, openvibe_bucks_cashout_balance) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?)`).run(id, username, username, `${username}@x`, role, extra.is_owner ? 1 : 0, extra.bucks || 0, extra.cashout || 0);
    await addUser(1, 'owner', 'admin', { is_owner: 1 });
    await addUser(2, 'ann', 'user', { bucks: 1000 });
    await addUser(3, 'bob', 'streamer');
    // Subjects exist, so nothing but the switch keeps these actions on Live's columns.
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1'), (3, 'network', '103', 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2')").run();
    const cols = async (id) => { const u = await db.getUserById(id); return { b: u.openvibe_bucks_balance, c: u.openvibe_bucks_cashout_balance }; };

    const auth = require('../server/auth/auth');
    const signIn = async (req) => { const id = Number(req.headers['x-test-user'] || 0); const u = id ? await db.getUserById(id) : null; if (u) req.user = u; return u; };
    auth.requireAuth = (req, res, next) => { signIn(req).then((u) => u ? next() : res.status(401).json({ error: 'Authentication required' })).catch(next); };
    auth.optionalAuth = (req, res, next) => { signIn(req).then(() => next()).catch(next); };
    const express = require('express');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use((req, res, next) => { signIn(req).then(() => next()).catch(next); });
    app.use('/api/funds', require('../server/monetization/routes'));
    app.use('/api/payments', require('../server/monetization/payments-routes'));
    app.use('/api/admin', require('../server/admin/routes'));
    app.use('/api/powerchat', require('../server/integrations/powerchat-routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = async (method, p, user, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, json, text };
    };

    await check('the switch defaults to live', async () => {
        assert.strictEqual(require('../server/monetization/money-authority').authority(), 'live');
        assert.strictEqual((await call('GET', '/api/payments/config')).json.authority, 'live');
    });

    await check('donate moves Live\'s columns and writes the transactions row, as before', async () => {
        const r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 150, message: 'gg' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.balance, 850);
        assert.deepStrictEqual(await cols(2), { b: 850, c: 0 });
        assert.deepStrictEqual(await cols(3), { b: 0, c: 150 });
        const t = await raw.prepare("SELECT * FROM transactions WHERE type = 'donation'").get();
        assert.deepStrictEqual([t.from_user_id, t.to_user_id, t.amount, t.status], [2, 3, 150, 'completed']);
        const bad = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 99999 });
        assert.strictEqual(bad.status, 400); assert.strictEqual(bad.json.error, 'Insufficient Vibes');
    });

    await check('cashout request, owner approval and the balance read use Live\'s columns', async () => {
        await raw.prepare('UPDATE users SET openvibe_bucks_cashout_balance = 1000 WHERE id = 3').run();
        const r = await call('POST', '/api/funds/cashout', 3, { amount: 600, paypal_email: 'bob@example.com' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.status, 'escrow'); assert.strictEqual(r.json.usd_value, '6.00');
        assert.deepStrictEqual(await cols(3), { b: 0, c: 400 });
        const pending = await call('GET', '/api/funds/cashouts/pending', 1);
        assert.strictEqual(pending.json.cashouts.length, 1);
        assert.strictEqual((await call('POST', `/api/funds/cashout/${r.json.transaction_id}/approve`, 1)).status, 200);
        const bal = await call('GET', '/api/funds/balance', 3);
        assert.deepStrictEqual({ b: bal.json.balance, c: bal.json.cashout_balance }, { b: 0, c: 400 });
    });

    await check('recycle behaves exactly as before (including the pre-existing transactions CHECK defect)', async () => {
        const r = await call('POST', '/api/funds/recycle', 3, { amount: 100 });
        // Economic inventory defect 7: 'recycle' is not in the transactions type CHECK, so the ledger
        // insert throws after both balances moved. Unchanged under `live`; Billing fixes it.
        assert.strictEqual(r.status, 400, r.text);
        assert.deepStrictEqual(await cols(3), { b: 100, c: 300 });
    });

    await check('subscribe with Vibes, the channel state and cancel use Live\'s subscriptions table', async () => {
        const r = await call('POST', '/api/payments/subscribe', 2, { streamer: 'bob', provider: 'bucks' });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(await cols(2), { b: 351, c: 0 });
        assert.deepStrictEqual(await cols(3), { b: 100, c: 649 });
        const ch = await call('GET', '/api/payments/channel/bob', 2);
        assert.deepStrictEqual([ch.json.subscribed, ch.json.subscriberCount], [true, 1]);
        assert.strictEqual(await db.isActiveSubscriber(2, 3), true);
        const sub = await raw.prepare('SELECT * FROM subscriptions').get();
        assert.strictEqual((await call('POST', `/api/payments/subscriptions/${sub.id}/cancel`, 2, {})).status, 200);
        assert.strictEqual((await raw.prepare('SELECT status FROM subscriptions WHERE id = ?').get(sub.id)).status, 'canceled');
    });

    await check('the PowerChat receiver still runs on Live (verifies, never 410)', async () => {
        const r = await call('POST', '/api/powerchat/webhook', null, { type: 'donation.completed', data: {} });
        assert.strictEqual(r.status, 401, r.text);
    });

    await check('OpenVibe.Billing was never called and no Billing journal exists', async () => {
        assert.strictEqual(billing.calls.length, 0);
        assert.strictEqual((await raw.prepare('SELECT COUNT(*) AS n FROM billing_actions').get()).n, 0, 'the migrated journal stays empty in live mode');
    });

    server.close();
    await billing.close();
    await network.close();
    quiet(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { quiet(e); process.exit(1); });
