'use strict';
/**
 * BILLING_AUTHORITY=billing (roadmap Wave 8, ADR-012): every Live money action goes to
 * OpenVibe.Billing with Live's service token (audience openvibe.billing), the one capability that
 * route needs, a deterministic Idempotency-Key and canonical subjects — and Live's own money
 * columns and tables (users.openvibe_bucks_*, transactions, payment_orders, subscriptions) are
 * never written. A person with no subject cannot move money; Billing being down or slow fails
 * clearly; the provider and PowerChat webhooks on Live answer 410 with Billing's URL.
 *
 * Network and Billing are local stand-ins (test/billing-stub.js); sign-in is stubbed with an
 * x-test-user header like authorization.test.js. Everything after that is the production code.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork, startBilling } = require('./billing-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-billing-authority-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
process.env.BILLING_AUTHORITY = 'billing';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
process.env.OV_BILLING_TIMEOUT_MS = '1500';
process.env.OV_BILLING_PUBLIC_URL = 'https://billing.openvibe.network';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const SID = {
    ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1',
    bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2',
    dan: 'usr_01JAB2C3D4E5F6G7H8J9K0MND4',
};

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 9).join('\n      ')); }
}

(async () => {
    const network = await startNetwork();
    const billing = await startBilling({ network });
    process.env.OV_NETWORK_INTERNAL_URL = network.url;
    process.env.OV_BILLING_INTERNAL_URL = billing.url;
    network.legacy['5'] = SID.dan;          // dan: only Network's identity map knows him

    const db = require('../server/db/database');
    db.initDb();
    const raw = db.getDb();
    const addUser = (id, username, role, extra = {}) => raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner, openvibe_bucks_balance, openvibe_bucks_cashout_balance)
         VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?)`).run(id, username, username, `${username}@x`, role, extra.is_owner ? 1 : 0, extra.bucks || 0, extra.cashout || 0);
    addUser(1, 'owner', 'admin', { is_owner: 1 });
    addUser(2, 'ann', 'user', { bucks: 1000 });            // legacy columns carry values: they must never move
    addUser(3, 'bob', 'streamer', { cashout: 2000 });
    addUser(4, 'cat', 'user', { bucks: 5000 });            // no subject anywhere
    addUser(5, 'dan', 'user');
    addUser(6, 'eve', 'streamer');                          // streamer with no subject
    addUser(7, 'admin2', 'admin');                          // an admin who is not the owner
    const link = (uid, sid) => raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)").run(uid, String(100 + uid), sid);
    link(2, SID.ann); link(3, SID.bob);
    db.ensureChannel(3);
    const streamB = Number(db.createStream({ user_id: 3, channel_id: db.getChannelByUserId(3).id, title: 'B', protocol: 'webrtc' }).lastInsertRowid);
    db.setSetting('powerchat_enabled', 'true');
    db.setSetting('powerchat_client_id', 'pca_test');
    db.setSetting('powerchat_site_tip_username', 'sitepc');

    const ledger = () => ({
        users: raw.prepare('SELECT id, openvibe_bucks_balance AS b, openvibe_bucks_cashout_balance AS c FROM users ORDER BY id').all(),
        transactions: raw.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
        payment_orders: raw.prepare('SELECT COUNT(*) AS n FROM payment_orders').get().n,
        subscriptions: raw.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), \'\') AS u FROM subscriptions').get(),
    });
    const before = ledger();

    const auth = require('../server/auth/auth');
    const signIn = (req) => { const id = Number(req.headers['x-test-user'] || 0); const u = id ? db.getUserById(id) : null; if (u) req.user = u; return u; };
    auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

    const express = require('express');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use((req, res, next) => { signIn(req); next(); });
    app.use('/api/funds', require('../server/monetization/routes'));
    app.use('/api/payments', require('../server/monetization/payments-routes'));
    app.use('/api/admin', require('../server/admin/routes'));
    app.use('/api/powerchat', require('../server/integrations/powerchat-routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = async (method, p, user, body, headers = {}) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
            method, redirect: 'manual',
            headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, json, text, headers: res.headers };
    };
    const lastCall = () => billing.calls[billing.calls.length - 1];
    const callsSince = (n) => billing.calls.slice(n);
    const billingActions = require('../server/monetization/billing-actions');

    billing.fund(SID.ann, 3000);

    await check('the switch is read in one place and says billing', async () => {
        const money = require('../server/monetization/money-authority');
        assert.strictEqual(money.authority(), 'billing');
        const cfg = await call('GET', '/api/payments/config');
        assert.strictEqual(cfg.json.authority, 'billing');
    });

    await check('donation → POST /transfers with billing.transfer.create, a live:donation key and subjects (never Live ids)', async () => {
        const n = billing.calls.length;
        const r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, stream_id: streamB, amount: 150, message: 'gg' });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual({ success: r.json.success, amount: r.json.amount, balance: r.json.balance }, { success: true, amount: 150, balance: 2850 });
        const c = callsSince(n);
        assert.strictEqual(c.length, 1, 'one Billing call');
        assert.strictEqual(c[0].method, 'POST'); assert.strictEqual(c[0].path, '/transfers');
        assert.strictEqual(c[0].cap, 'billing.transfer.create');
        assert.strictEqual(c[0].principal, 'svc:live');
        assert.match(c[0].key, /^live:donation:[0-9a-f-]{36}$/);
        assert.deepStrictEqual(c[0].body.from, { type: 'user', id: SID.ann });
        assert.deepStrictEqual(c[0].body.to, { type: 'user', id: SID.bob });
        assert.deepStrictEqual(c[0].body.target, { service: 'live', type: 'stream', id: String(streamB) });
        assert.strictEqual(c[0].body.amount, 150); assert.strictEqual(c[0].body.kind, 'donation');
        assert.ok(!JSON.stringify(c[0].body).includes('"user_id"'), 'no Live user id reaches Billing');
        assert.ok(c[0].traceparent, 'trace context propagated');
        assert.strictEqual(billing.payable[SID.bob], 150);
        const row = raw.prepare("SELECT * FROM billing_actions WHERE idempotency_key = ?").get(c[0].key);
        assert.strictEqual(row.status, 'done'); assert.match(row.billing_ref, /^txn_/);
        // The chat celebration (display) is still Live's.
        const msg = raw.prepare("SELECT * FROM chat_messages WHERE message_type = 'donation' ORDER BY id DESC LIMIT 1").get();
        assert.ok(msg && /donated 150 Vibes/.test(msg.message));
    });

    await check('a browser retry with the same Idempotency-Key is one donation', async () => {
        const n = billing.calls.length;
        const a = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 10 }, { 'Idempotency-Key': 'click-7f3a9c21' });
        const b = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 10 }, { 'Idempotency-Key': 'click-7f3a9c21' });
        assert.strictEqual(a.status, 200, a.text); assert.strictEqual(b.status, 200, b.text);
        assert.strictEqual(callsSince(n).length, 1, 'second answered from the journal');
        assert.strictEqual(callsSince(n)[0].key, 'live:donation:u2:cclick-7f3a9c21');
        assert.strictEqual(billing.payable[SID.bob], 160);
        const c = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 11 }, { 'Idempotency-Key': 'click-7f3a9c21' });
        assert.strictEqual(c.status, 409, 'same key, different donation: refused');
    });

    await check('Billing refusals map to Live\'s error shapes', async () => {
        const r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 999999 });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.json.error, 'Insufficient Vibes');
        const self = await call('POST', '/api/funds/donate', 2, { streamer_id: 2, amount: 5 });
        assert.strictEqual(self.status, 400); assert.strictEqual(self.json.error, 'You cannot donate to yourself');
    });

    await check('no subject, no money: the integer id is never used instead', async () => {
        const n = billing.calls.length;
        let r = await call('POST', '/api/funds/donate', 4, { streamer_id: 3, amount: 5 });
        assert.strictEqual(r.status, 409, r.text); assert.strictEqual(r.json.code, 'no_subject');
        r = await call('POST', '/api/funds/donate', 2, { streamer_id: 6, amount: 5 });
        assert.strictEqual(r.status, 409, r.text); assert.match(r.json.error, /streamer/);
        r = await call('GET', '/api/funds/balance', 4);
        assert.strictEqual(r.status, 409);
        assert.strictEqual(callsSince(n).length, 0, 'Billing never asked');
        // dan has no token-noted subject but Network's identity map knows him: canonical, allowed.
        r = await call('GET', '/api/funds/balance', 5);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(lastCall().path, `/balances/${SID.dan}`);
    });

    await check('balance and history read Billing (balance.read), in Live\'s shapes', async () => {
        const r = await call('GET', '/api/funds/balance', 3);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(lastCall().cap, 'billing.balance.read');
        assert.deepStrictEqual({ b: r.json.balance, c: r.json.cashout_balance, cu: r.json.cashout_usd_value }, { b: 0, c: 160, cu: '1.60' });
        const h = await call('GET', '/api/funds/history', 2);
        assert.strictEqual(h.status, 200, h.text);
        const d = h.json.transactions.find((t) => t.type === 'donation');
        assert.strictEqual(d.from_user_id, 2); assert.strictEqual(d.to_username, 'bob');
    });

    await check('cashout request → POST /cashouts (cashout.request); approving/denying is not Live\'s any more', async () => {
        billing.payable[SID.bob] = 1000;
        const r = await call('POST', '/api/funds/cashout', 3, { amount: 600, paypal_email: 'bob@example.com' });
        assert.strictEqual(r.status, 200, r.text);
        const c = lastCall();
        assert.strictEqual(c.path, '/cashouts'); assert.strictEqual(c.cap, 'billing.cashout.request');
        assert.match(c.key, /^live:cashout:/);
        assert.deepStrictEqual(c.body.payout_method, { type: 'paypal', address: 'bob@example.com' });
        assert.deepStrictEqual(c.body.subject, { type: 'user', id: SID.bob });
        assert.strictEqual(r.json.status, 'escrow'); assert.strictEqual(r.json.amount, 600); assert.strictEqual(r.json.usd_value, '6.00'); assert.match(r.json.transaction_id, /^co_/);
        const small = await call('POST', '/api/funds/cashout', 3, { amount: 100, paypal_email: 'bob@example.com' });
        assert.strictEqual(small.status, 400); assert.match(small.json.error, /minimum cashout is 500 Vibes/i);
        const n = billing.calls.length;
        assert.strictEqual((await call('POST', '/api/funds/cashout/1/approve', 1)).status, 409);
        assert.strictEqual((await call('POST', '/api/funds/cashout/1/deny', 1)).status, 409);
        assert.strictEqual((await call('GET', '/api/funds/cashouts/pending', 1)).status, 409);
        assert.strictEqual(callsSince(n).length, 0);
    });

    await check('recycle → POST /recycle (cashout.request)', async () => {
        const r = await call('POST', '/api/funds/recycle', 3, { amount: 100 });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(lastCall().path, '/recycle'); assert.strictEqual(lastCall().cap, 'billing.cashout.request');
        assert.match(lastCall().key, /^live:recycle:/);
        assert.deepStrictEqual({ b: r.json.balance, c: r.json.cashout_balance }, { b: 100, c: 300 });
    });

    await check('subscribe with Vibes → entitlement check, then POST /subscriptions (subscription.manage)', async () => {
        const n = billing.calls.length;
        const r = await call('POST', '/api/payments/subscribe', 2, { streamer: 'bob', provider: 'bucks' });
        assert.strictEqual(r.status, 200, r.text);
        const c = callsSince(n);
        assert.deepStrictEqual(c.map((x) => [x.method, x.path.replace(/\?.*/, ''), x.cap]), [
            ['GET', `/entitlements/${SID.ann}`, 'billing.entitlement.check'],
            ['POST', '/subscriptions', 'billing.subscription.manage'],
        ]);
        assert.strictEqual(c[1].body.source, 'credit'); assert.deepStrictEqual(c[1].body.streamer, { type: 'user', id: SID.bob });
        assert.match(c[1].key, /^live:subscribe:/);
        assert.ok(r.json.subscription.current_period_end);
        const again = await call('POST', '/api/payments/subscribe', 2, { streamer: 'bob', provider: 'bucks' });
        assert.strictEqual(again.status, 409); assert.strictEqual(again.json.error, 'Already subscribed');
        const poor = await call('POST', '/api/payments/subscribe', 5, { streamer: 'bob', provider: 'bucks' });
        assert.strictEqual(poor.status, 402); assert.match(poor.json.error, /Not enough Vibes \(need 499\)/);
    });

    await check('channel state, my subscriptions and cancel go through Billing', async () => {
        const ch = await call('GET', '/api/payments/channel/bob', 2);
        assert.strictEqual(ch.status, 200, ch.text);
        assert.strictEqual(ch.json.subscribed, true); assert.strictEqual(ch.json.subscriberCount, 1);
        const mine = await call('GET', '/api/payments/subscriptions/mine', 2);
        assert.strictEqual(mine.json.subscriptions[0].streamer_username, 'bob');
        const sub = billing.subs[0];
        // Someone else cannot cancel ann's subscription by id.
        const n = billing.calls.length;
        const other = await call('POST', `/api/payments/subscriptions/${sub.id}/cancel`, 5, {});
        assert.strictEqual(other.status, 404);
        assert.ok(!callsSince(n).some((x) => x.method === 'POST'), 'nothing cancelled');
        const r = await call('POST', `/api/payments/subscriptions/${sub.id}/cancel`, 2, {});
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(lastCall().path, `/subscriptions/${sub.id}/cancel`);
        assert.strictEqual(lastCall().cap, 'billing.subscription.manage');
        assert.strictEqual(lastCall().key, `live:sub_cancel:${sub.id}:${sub.current_period_end}`);
        assert.strictEqual(sub.cancel_at_period_end, true);
    });

    await check('subscriber perks follow Billing\'s entitlement (cached, refreshed)', async () => {
        billingActions._reset();
        assert.strictEqual(db.isActiveSubscriber(2, 3), false, 'unknown until checked');
        assert.strictEqual(await billingActions.refreshEntitlement(2, 3), true);
        assert.strictEqual(db.isActiveSubscriber(2, 3), true);
        assert.strictEqual(lastCall().cap, 'billing.entitlement.check');
        assert.strictEqual(db.isActiveSubscriber(4, 3), false);
    });

    await check('Buy Vibes via PowerChat → POST /intents (intent.create); the link carries Billing\'s checkout ref', async () => {
        const n = billing.calls.length;
        const r = await call('POST', '/api/payments/bucks/checkout', 2, { provider: 'powerchat', bucks: 500 });
        assert.strictEqual(r.status, 200, r.text);
        const c = callsSince(n);
        assert.strictEqual(c.length, 1); assert.strictEqual(c[0].path, '/intents'); assert.strictEqual(c[0].cap, 'billing.intent.create');
        assert.deepStrictEqual({ kind: c[0].body.kind, bits: c[0].body.bits, provider: c[0].body.provider, subject: c[0].body.subject }, { kind: 'purchase', bits: 500, provider: 'powerchat', subject: { type: 'user', id: SID.ann } });
        const intent = billing.intents[billing.intents.length - 1];
        const u = new URL(r.json.url);
        assert.strictEqual(u.searchParams.get('app_ref'), `pcorder:${intent.id}`, 'PowerChat echoes Billing\'s ref to Billing');
        assert.strictEqual(u.searchParams.get('app_amount_cents'), String(intent.amount_cents), 'pinned to the price Billing computed');
        assert.strictEqual(r.json.amountUsd, intent.amount_cents / 100);
    });

    await check('subscribe via the site PowerChat → subscription intent with route site', async () => {
        const r = await call('POST', '/api/payments/subscribe', 5, { streamer: 'bob', provider: 'powerchat_site' });
        assert.strictEqual(r.status, 200, r.text);
        const c = lastCall();
        assert.strictEqual(c.path, '/intents'); assert.strictEqual(c.body.kind, 'subscription'); assert.strictEqual(c.body.route, 'site');
        assert.deepStrictEqual(c.body.subject, { type: 'user', id: SID.dan });
        const intent = billing.intents[billing.intents.length - 1];
        assert.strictEqual(new URL(r.json.url).searchParams.get('app_ref'), `pcsub:${intent.id}`);
        assert.strictEqual(r.json.feeUsd, 0.5);
    });

    await check('card rails stay behind Live\'s payments_enabled switch; when on, Stripe checkout is a Billing intent', async () => {
        const n = billing.calls.length;
        let r = await call('POST', '/api/payments/bucks/checkout', 2, { provider: 'stripe', bucks: 500 });
        assert.strictEqual(r.status, 403); assert.strictEqual(callsSince(n).length, 0);
        db.setSetting('payments_enabled', 'true');
        r = await call('POST', '/api/payments/bucks/checkout', 2, { provider: 'stripe', bucks: 500 });
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.json.url, /^https:\/\/checkout\.test\/pi_/);
        r = await call('POST', '/api/payments/bucks/checkout', 2, { provider: 'crypto', bucks: 500 });
        assert.strictEqual(lastCall().body.provider, 'nowpayments');
        db.setSetting('payments_enabled', 'false');
    });

    await check('a Vibes media request is a paid interaction; its refund reverses that exact transfer', async () => {
        const mediaQueue = require('../server/media/media-queue');
        const charge = await mediaQueue.charge({ currency: 'vibes', cost: 40, userId: 2, streamerId: 3, streamId: streamB, label: 'Media request: song' });
        const c = lastCall();
        assert.strictEqual(c.path, '/transfers'); assert.strictEqual(c.body.kind, 'paid_interaction'); assert.match(c.key, /^live:media_charge:/);
        const reqId = Number(db.createMediaRequest({ streamer_id: 3, stream_id: streamB, user_id: 2, username: 'ann', input: 'x', canonical_url: 'https://x.test/a', embed_url: null, provider: 'youtube', title: 'song', thumbnail_url: null, duration_seconds: 60, cost: 40, queue_position: 1, currency: 'vibes' }).lastInsertRowid);
        billingActions.linkMediaCharge(charge.actionId, reqId);
        const refunded = await mediaQueue.refund(reqId);
        assert.strictEqual(refunded, 40);
        const r = lastCall();
        assert.strictEqual(r.path, `/transfers/${charge.transactionId}/refund`); assert.strictEqual(r.cap, 'billing.transfer.create');
        assert.strictEqual(r.key, `live:media_refund:${reqId}`);
        assert.strictEqual(db.getMediaRequestById(reqId).refunded, 1);
        assert.strictEqual(await mediaQueue.refund(reqId), 0, 'a second refund is a no-op');
        await assert.rejects(mediaQueue.charge({ currency: 'vibes', cost: 999999, userId: 2, streamerId: 3, streamId: streamB, label: 'x' }), /Not enough Vibes — this costs 999999/);
    });

    await check('webhooks moved: PowerChat and card webhooks on Live answer 410 with Billing\'s URL', async () => {
        const pc = await call('POST', '/api/powerchat/webhook', null, { type: 'donation.completed', data: { appExternalRef: 'pcorder:1', amountUsdCents: 500 } });
        assert.strictEqual(pc.status, 410);
        assert.strictEqual(pc.json.webhook_url, 'https://billing.openvibe.network/webhooks/powerchat');
        for (const [p, name] of [['stripe', 'stripe'], ['paypal', 'paypal'], ['ccbill', 'ccbill'], ['crypto', 'nowpayments']]) {
            const r = await call('POST', `/api/payments/webhook/${p}`, null, {});
            assert.strictEqual(r.status, 410, p); assert.strictEqual(r.json.webhook_url, `https://billing.openvibe.network/webhooks/${name}`);
        }
        const rec = await require('../server/integrations/powerchat-reconcile').reconcileOnce();
        assert.strictEqual(rec.skipped, 'billing_authority');
    });

    await check('a missing Network grant fails clearly (misconfigured), nothing moves', async () => {
        const saved = network.grants['openvibe.billing'];
        network.grants['openvibe.billing'] = saved.filter((g) => g !== 'billing.transfer.create');
        require('../server/net/network-principal').invalidate('openvibe.billing');
        const r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 5 });
        assert.strictEqual(r.status, 503, r.text); assert.strictEqual(r.json.code, 'billing_misconfigured');
        network.grants['openvibe.billing'] = saved;
        require('../server/net/network-principal').invalidate('openvibe.billing');
    });

    await check('Billing slow: the outcome is "unknown", journaled, and an owner can resolve it with the same key', async () => {
        billing.state.delayMs = 2500;
        const r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 7 });
        billing.state.delayMs = 0;
        assert.strictEqual(r.status, 504, r.text); assert.strictEqual(r.json.code, 'billing_outcome_unknown');
        const row = raw.prepare("SELECT * FROM billing_actions WHERE action = 'donation' ORDER BY id DESC LIMIT 1").get();
        assert.strictEqual(row.status, 'unknown');
        await new Promise((res) => setTimeout(res, 1200));        // the slow request lands on the stub
        const payableBefore = billing.payable[SID.bob];
        const st = await call('GET', '/api/admin/money', 1);
        assert.ok(st.json.billing.actions.attention.some((a) => a.id === row.id));
        assert.strictEqual((await call('POST', `/api/admin/money/actions/${row.id}/resolve`, 7)).status, 403, 'owner only');
        const res = await call('POST', `/api/admin/money/actions/${row.id}/resolve`, 1);
        assert.strictEqual(res.status, 200, res.text); assert.strictEqual(res.json.status, 'done');
        assert.strictEqual(lastCall().key, row.idempotency_key); assert.strictEqual(lastCall().replayed, true, 'Billing replayed; no second effect');
        assert.strictEqual(billing.payable[SID.bob], payableBefore);
    });

    await check('Billing down: money actions fail clearly and balances read "unavailable" (no fallback)', async () => {
        await billing.close();
        let r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, amount: 5 });
        assert.strictEqual(r.status, 503, r.text); assert.strictEqual(r.json.code, 'billing_unavailable'); assert.match(r.json.error, /nothing was charged/);
        r = await call('GET', '/api/funds/balance', 2);
        assert.strictEqual(r.status, 503); assert.strictEqual(r.json.unavailable, true);
        assert.ok(!('balance' in r.json), 'never the legacy column');
        r = await call('POST', '/api/funds/cashout', 3, { amount: 600, paypal_email: 'bob@example.com' });
        assert.strictEqual(r.status, 503);
        r = await call('GET', '/api/payments/channel/bob', 2);
        assert.strictEqual(r.status, 200); assert.strictEqual(r.json.unavailable, true);
        const st = await call('GET', '/api/admin/money', 7);
        assert.strictEqual(st.json.authority, "billing"); assert.strictEqual(st.json.billing.reachable, false, JSON.stringify(st.json));
    });

    await check('the tripwire: Live\'s money columns cannot be written under billing', async () => {
        assert.throws(() => db.addVibes(2, 5), /read-only/);
        assert.throws(() => db.addVibesCashout(3, 5), /read-only/);
        assert.throws(() => db.createPaymentOrder({ user_id: 2, provider: 'powerchat' }), /read-only/);
        assert.throws(() => db.upsertSubscription({ subscriber_id: 2, streamer_id: 3 }), /read-only/);
        assert.throws(() => db.createTransaction({ to_user_id: 2, amount: 1, type: 'purchase' }), /read-only/);
    });

    await check('legacy balances are not shown as live (admin stats, admin user list)', async () => {
        const s = await call('GET', '/api/admin/stats', 1);
        assert.strictEqual(s.json.openvibeBucks.totalCirculating, null);
        const u = await call('GET', '/api/admin/users', 1);
        assert.ok(u.json.users.every((x) => x.openvibe_bucks_balance === null));
    });

    await check('after everything: Live\'s money columns and tables are exactly as before', async () => {
        assert.deepStrictEqual(ledger(), before);
    });

    server.close();
    await network.close();
    quiet(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { quiet(e); process.exit(1); });
