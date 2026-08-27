// /paid-messages reconciliation: finds paid-but-uncredited checkouts by appExternalRef,
// credits through the same idempotent fulfillment the webhook uses, pages on
// nextCursor (both envelope shapes), skips echoes / test rows / hosts without the
// scope, and makes no API call when nothing is pending.
const assert = require('assert');
const path = require('path');
function stub(modPath, exportsObj) { const full = require.resolve(modPath); require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj }; }

const settings = { powerchat_site_tip_username: 'alex', powerchat_allow_test_fulfillment: 'false' };
const orders = new Map();
const seed = () => {
    orders.clear();
    orders.set(41, { id: 41, user_id: 7, provider: 'powerchat', kind: 'bucks', amount_cents: 500, bucks: 500, status: 'pending', created_at: '2026-08-27 09:00:00' });
    orders.set(42, { id: 42, user_id: 8, provider: 'powerchat', kind: 'subscription', amount_cents: 500, streamer_id: 1, provider_ref: 'direct:renew', status: 'pending', created_at: '2026-08-27 09:05:00' });
    orders.set(43, { id: 43, user_id: 9, provider: 'powerchat', kind: 'subscription', amount_cents: 500, streamer_id: 3, provider_ref: 'direct', status: 'pending', created_at: '2026-08-27 09:06:00' });
};
const conns = {
    1: { user_id: 1, powerchat_username: 'alex', access_token: 'a', refresh_token: 'r', scope: 'checkout:attribute paid_messages:read' },
    3: { user_id: 3, powerchat_username: 'other', access_token: 'a', refresh_token: 'r', scope: 'checkout:attribute' }, // no paid_messages:read
};
const notes = [];
stub(path.join(__dirname, '../server/db/database'), {
    getSetting: (k) => settings[k] ?? null,
    getPendingPowerchatOrders: () => [...orders.values()].filter((o) => o.status === 'pending'),
    getPowerchatConnection: (id) => conns[id] || null,
    getPowerchatConnectionByUsername: (u) => Object.values(conns).find((c) => c.powerchat_username === String(u).toLowerCase()) || null,
    getPaymentOrderById: (id) => orders.get(id) || null,
    updatePaymentOrder: (id, f) => Object.assign(orders.get(id), f),
    getUserById: (id) => ({ id, username: 'u' + id, display_name: 'U' + id }),
});
stub(path.join(__dirname, '../server/config'), { baseUrl: 'https://openvibe.live' });
stub(path.join(__dirname, '../server/monetization/payments'), {
    bucksForUsd: (usd) => Math.round(usd * 100),
    fulfillBucksOrder: (o) => { orders.get(o.id).status = 'credited'; },
    fulfillSubscriptionOrder: (o, opts) => { orders.get(o.id).status = 'credited'; orders.get(o.id)._opts = opts; },
});
stub(path.join(__dirname, '../server/utils/notify'), { pushNotification: (n) => notes.push(n) });
const api = { calls: [], pages: [] };
stub(path.join(__dirname, '../server/integrations/powerchat-oauth'), {
    getConfig: () => ({ enabled: true, clientId: 'pca', baseUrl: 'https://pc.example', apiBase: 'https://pc.example/api/dev/v1' }),
    redirectUri: () => 'https://openvibe.live/cb',
    apiRequest: async (userId, req) => { api.calls.push({ userId, ...req }); const p = api.pages.shift(); if (!p) throw new Error('unscripted'); if (p.throw) throw Object.assign(new Error('x'), { status: p.throw }); return p; },
});
const reconcile = require('../server/integrations/powerchat-reconcile');

(async () => {
    // ── nothing pending → nothing read ──
    let sum = await reconcile.reconcileOnce();
    assert.strictEqual(sum.orders, 0); assert.strictEqual(api.calls.length, 0);

    // ── envelope parsing (corrected + legacy shapes) ──
    assert.deepStrictEqual(reconcile._test.page({ data: { rows: [{ a: 1 }], nextCursor: 'c1' } }), { rows: [{ a: 1 }], nextCursor: 'c1' });
    assert.deepStrictEqual(reconcile._test.page({ data: { rows: [] }, nextCursor: 'c2' }), { rows: [], nextCursor: 'c2' }, 'older deployments left nextCursor outside data');
    assert.deepStrictEqual(reconcile._test.page({ data: [{ b: 2 }] }), { rows: [{ b: 2 }], nextCursor: null });
    assert.deepStrictEqual(reconcile._test.page(null), { rows: [], nextCursor: null });

    // ── the main sweep: 3 pending orders, two hosts ──
    seed();
    api.calls.length = 0;
    // Host alex: page 1 (legacy cursor placement) → page 2 (corrected).
    api.pages.push({ data: { rows: [
        { eventId: 'e-other', occurredAt: '2026-08-27T09:30:00Z', source: 'powerchat', amountCents: 300, amountUsdCents: 300, appExternalRef: null },
        { eventId: 'e-echo', occurredAt: '2026-08-27T09:20:00Z', source: 'developer_app', amountCents: 500, amountUsdCents: 500, appExternalRef: 'pcorder:41' },
        { eventId: 'e-test', occurredAt: '2026-08-27T09:19:00Z', source: 'powerchat', isTest: true, amountCents: 500, amountUsdCents: 500, appExternalRef: 'pcorder:41' },
        // Real feed rows have NO isTest field; manual_test is PowerChat's no-provider test tip → must be treated as test.
        { eventId: 'e-manual', occurredAt: '2026-08-27T09:18:00Z', source: 'manual_test', amountCents: 500, amountUsdCents: 500, appExternalRef: 'pcorder:41' },
        { eventId: 'e-41', occurredAt: '2026-08-27T09:10:00Z', source: 'powerchat', donorName: 'Pat', amountCents: 500, currency: 'USD', amountUsdCents: 500, appExternalRef: 'pcorder:41' },
    ] }, nextCursor: 'cur-2' });
    api.pages.push({ data: { rows: [
        { eventId: 'e-42', occurredAt: '2026-08-27T09:08:00Z', source: 'powerchat', donorName: 'Sam', amountCents: 500, amountUsdCents: 500, appExternalRef: 'pcsub:42' },
    ], nextCursor: 'cur-3' } });
    sum = await reconcile.reconcileOnce();
    assert.strictEqual(sum.orders, 3);
    assert.strictEqual(sum.hosts, 1, 'alex hosts both 41 (site) and 42 (direct, streamer 1 = alex)');
    assert.strictEqual(sum.skippedHosts, 1, "'other' has no paid_messages:read → skipped, no call");
    assert.strictEqual(sum.pages, 2, 'stopped after page 2: no orders left for that host despite a cursor');
    assert.strictEqual(sum.skippedTest, 2, 'explicit isTest AND source=manual_test are both skipped');
    assert.deepStrictEqual(sum.credited.map((c) => c.ref).sort(), ['pcorder:41', 'pcsub:42']);
    assert.deepStrictEqual(sum.underpaid, []);
    assert.strictEqual(orders.get(41).status, 'credited');
    assert.strictEqual(orders.get(42).status, 'credited');
    assert.strictEqual(orders.get(42)._opts.autoRenew, 1, 'renew flag read off provider_ref as the webhook path does');
    assert.strictEqual(orders.get(42)._opts.creditShare, false, 'direct: streamer already holds the cash');
    assert.strictEqual(orders.get(43).status, 'pending');
    const reads = api.calls.filter((c) => c.path === '/paid-messages');
    assert.strictEqual(reads.length, 2);
    assert.strictEqual(reads[0].userId, 1); assert.strictEqual(reads[0].username, 'alex');
    assert.deepStrictEqual(reads[0].query, { limit: 100 });
    assert.deepStrictEqual(reads[1].query, { limit: 100, cursor: 'cur-2' }, 'legacy top-level nextCursor was honoured');
    assert.strictEqual(notes.length, 2, 'buyers are notified exactly like a webhook credit');

    // ── idempotent: run again → credited orders are no longer pending → only 43 remains, host skipped ──
    api.calls.length = 0;
    sum = await reconcile.reconcileOnce();
    assert.strictEqual(sum.orders, 1); assert.strictEqual(api.calls.length, 0); assert.strictEqual(sum.credited.length, 0);

    // ── underpaid sub (direct route): not credited, reported, order stays pending ──
    // (a Vibes pack credits whatever was actually paid, so only subs have this guard)
    seed(); orders.delete(41); orders.delete(43);
    api.calls.length = 0; api.pages.length = 0;
    api.pages.push({ data: { rows: [{ eventId: 'e-low', occurredAt: '2026-08-27T09:10:00Z', source: 'powerchat', amountCents: 100, amountUsdCents: 100, appExternalRef: 'pcsub:42' }], nextCursor: null } });
    sum = await reconcile.reconcileOnce();
    assert.strictEqual(sum.credited.length, 0);
    assert.deepStrictEqual(sum.underpaid.map((u) => u.ref), ['pcsub:42']);
    assert.strictEqual(orders.get(42).status, 'pending');

    // ── a paging stop: rows older than the oldest pending order (minus grace) end the walk ──
    seed(); orders.delete(42); orders.delete(43);
    api.calls.length = 0; api.pages.length = 0;
    api.pages.push({ data: { rows: [{ eventId: 'e-ancient', occurredAt: '2026-08-20T00:00:00Z', source: 'powerchat', amountCents: 1, amountUsdCents: 1, appExternalRef: null }], nextCursor: 'more' } });
    sum = await reconcile.reconcileOnce();
    assert.strictEqual(sum.pages, 1, 'did not follow the cursor into rows that predate every pending order');

    // ── read failure is contained: summary.errors, nothing credited, no throw ──
    seed(); orders.delete(42); orders.delete(43);
    api.pages.length = 0; api.pages.push({ throw: 429 });
    sum = await reconcile.reconcileOnce();
    assert.strictEqual(sum.errors, 1); assert.strictEqual(orders.get(41).status, 'pending');

    console.log('✅ powerchat reconcile tests passed');
})().catch((e) => { console.error('❌', e); process.exit(1); });
