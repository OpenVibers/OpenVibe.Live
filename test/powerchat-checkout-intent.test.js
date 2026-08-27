// Checkout-intent minting: success (re-homed URL, expiresAt), 404 → canonical fallback
// with capability caching, 403 → per-call fallback, item_name 400 → retry without it,
// no host token → canonical. DB and OAuth are stubbed; nothing touches the network.
const assert = require('assert');
const path = require('path');

function stub(modPath, exportsObj) {
    const full = require.resolve(modPath);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// ── Stubs ──────────────────────────────────────────────────────
const orders = new Map([[41, { id: 41, kind: 'bucks', amount_cents: 500, bucks: 500, user_id: 7, status: 'pending' }],
                        [42, { id: 42, kind: 'subscription', amount_cents: 500, user_id: 7, streamer_id: 1, status: 'pending' }]]);
const conns = { alex: { user_id: 1, powerchat_username: 'alex', access_token: 'a', refresh_token: 'r', scope: 'profile:read checkout:attribute' },
                noscope: { user_id: 2, powerchat_username: 'noscope', access_token: 'a', refresh_token: 'r', scope: 'profile:read' } };
stub(path.join(__dirname, '../server/db/database'), {
    getSetting: (k) => (k === 'powerchat_site_tip_username' ? 'alex' : null),
    getPowerchatConnectionByUsername: (u) => conns[String(u).toLowerCase()] || null,
    getPowerchatConnection: (id) => Object.values(conns).find((c) => c.user_id === id) || null,
    getUserById: (id) => (id === 1 ? { id: 1, username: 'goosely', display_name: 'goosely' } : null),
    getPaymentOrderById: (id) => orders.get(id) || null,
    updatePaymentOrder: (id, f) => { Object.assign(orders.get(id), f); },
});
const api = { calls: [], script: [] };
stub(path.join(__dirname, '../server/integrations/powerchat-oauth'), {
    getConfig: () => ({ enabled: true, clientId: 'pca_test', baseUrl: 'https://tunnel.example', apiBase: 'https://tunnel.example/api/dev/v1' }),
    redirectUri: () => 'https://openvibe.live/api/powerchat/oauth/callback',
    apiRequest: async (userId, req) => {
        api.calls.push({ userId, ...req });
        const next = api.script.shift();
        if (!next) throw new Error('unscripted apiRequest');
        if (next.throw) throw Object.assign(new Error(next.message || 'fail'), { status: next.throw });
        return next.body;
    },
});

const checkout = require('../server/integrations/powerchat-checkout');
const mint = (opts) => checkout.mintCheckoutLink('alex', 'pcsub:42', { purpose: 'subscription', amountCents: 500, itemName: 'goosely — 1 month subscription', ...opts });

(async () => {
    // ── success: intent URL, re-homed onto our base host, expiresAt surfaced ──
    api.script.push({ body: { data: { url: 'https://powerchat.internal/alex/tip?app_intent=TOK1', expiresAt: '2026-08-27T11:00:00.000Z' } } });
    let r = await mint();
    assert.strictEqual(r.minted, true);
    assert.strictEqual(r.url, 'https://tunnel.example/alex/tip?app_intent=TOK1', 'host swapped to the base we can reach, token intact');
    assert.strictEqual(r.expiresAt, '2026-08-27T11:00:00.000Z');
    let q = api.calls.at(-1);
    assert.strictEqual(q.path, '/tip-checkout-link');
    assert.strictEqual(q.username, 'alex');
    assert.strictEqual(q.userId, 1, 'minted with the host account token');
    assert.deepStrictEqual(q.query, { ref: 'pcsub:42', redirect_uri: 'https://openvibe.live/api/powerchat/oauth/callback', purpose: 'subscription', amount_cents: '500', item_name: 'goosely — 1 month subscription' });
    assert.deepStrictEqual(checkout.checkoutIntentSupport(), { state: 'supported' });
    assert.ok(!/app_amount_cents|app_ref/.test(r.url), 'terms never ride in the URL');

    // ── envelope tolerance: bare { url } (older deployment) ──
    api.script.push({ body: { url: 'https://tunnel.example/alex/tip?app_intent=TOK2' } });
    r = await mint();
    assert.strictEqual(r.minted, true); assert.match(r.url, /app_intent=TOK2/); assert.strictEqual(r.expiresAt, null);

    // ── item_name rejected (400) → retried once without it, still minted ──
    api.calls.length = 0;
    api.script.push({ throw: 400, message: 'unknown query parameter item_name' }, { body: { data: { url: 'https://tunnel.example/alex/tip?app_intent=TOK3' } } });
    r = await mint();
    assert.strictEqual(r.minted, true); assert.match(r.url, /TOK3/);
    assert.strictEqual(api.calls.length, 2);
    assert.ok('item_name' in api.calls[0].query && !('item_name' in api.calls[1].query), 'second try drops item_name only');

    // ── 403 (scope shrunk / redirect not registered) → canonical fallback, no caching ──
    api.calls.length = 0;
    api.script.push({ throw: 403, message: 'redirect_uri is not registered for this app' }, { throw: 403, message: 'again' });
    r = await mint();
    assert.strictEqual(r.minted, false);
    assert.match(r.reason, /403/);
    const u = new URL(r.url);
    assert.strictEqual(u.origin + u.pathname, 'https://tunnel.example/alex/tip');
    assert.strictEqual(u.searchParams.get('app_client_id'), 'pca_test');
    assert.strictEqual(u.searchParams.get('app_ref'), 'pcsub:42');
    assert.strictEqual(u.searchParams.get('app_amount_cents'), '500', 'fallback still pins via the canonical param');
    assert.strictEqual(u.searchParams.get('app_purpose'), 'subscription');
    assert.strictEqual(u.searchParams.get('app_redirect_uri'), 'https://openvibe.live/api/powerchat/oauth/callback');
    assert.strictEqual(api.calls.length, 1, '403 with a label is not retried (only 400 is)');
    assert.strictEqual(checkout.checkoutIntentSupport().state, 'supported', 'a 403 is per-grant, not a deployment gate');
    api.script.length = 0;

    // ── 404 (endpoint not deployed) → canonical fallback AND no re-probe for a while ──
    api.calls.length = 0;
    api.script.push({ throw: 404, message: 'Not found' });
    r = await mint();
    assert.strictEqual(r.minted, false);
    assert.match(new URL(r.url).searchParams.get('app_amount_cents'), /^500$/);
    assert.strictEqual(checkout.checkoutIntentSupport().state, 'unsupported');
    r = await mint();                                     // second order: no API call at all
    assert.strictEqual(r.minted, false);
    assert.match(r.reason, /unsupported/);
    assert.strictEqual(api.calls.length, 1, '404 is cached — one probe, not one per order');
    checkout._test.resetIntentSupport();

    // ── no usable host token → canonical link without any API call ──
    api.calls.length = 0;
    r = await checkout.mintCheckoutLink('noscope', 'pcorder:41', { purpose: 'vibes', amountCents: 500 });
    assert.strictEqual(r.minted, false);
    assert.strictEqual(api.calls.length, 0);
    assert.match(r.url, /^https:\/\/tunnel\.example\/noscope\/tip\?/);
    r = await checkout.mintCheckoutLink('stranger', 'pcorder:41', { purpose: 'vibes', amountCents: 500 });
    assert.strictEqual(r.minted, false);

    // ── amount below PowerChat's floor (50¢) is left free rather than rejected ──
    api.script.push({ body: { data: { url: 'https://tunnel.example/alex/tip?app_intent=TOK4' } } });
    r = await mint({ amountCents: 10 });
    assert.ok(!('amount_cents' in api.calls.at(-1).query));

    // ── builders: subscription persists route + renew flag and returns expiry ──
    api.script.push({ body: { data: { url: 'https://tunnel.example/alex/tip?app_intent=TOK5', expiresAt: '2026-08-27T12:00:00.000Z' } } });
    const sub = await checkout.buildSubscribeLink(orders.get(42), 1, { autoRenew: 1, route: 'direct' });
    assert.strictEqual(sub.mode, 'direct'); assert.strictEqual(sub.minted, true); assert.strictEqual(sub.expiresAt, '2026-08-27T12:00:00.000Z');
    assert.strictEqual(orders.get(42).provider_ref, 'direct:renew');
    assert.strictEqual(api.calls.at(-1).query.ref, 'pcsub:42');
    assert.strictEqual(api.calls.at(-1).query.item_name, 'goosely — 1 month subscription (auto-renew)');
    api.script.push({ body: { data: { url: 'https://tunnel.example/alex/tip?app_intent=TOK6' } } });
    const buy = await checkout.buildPurchaseLink(orders.get(41));
    assert.strictEqual(buy.mode, 'site'); assert.strictEqual(buy.minted, true);
    assert.strictEqual(api.calls.at(-1).query.item_name, '500 Vibes');
    assert.strictEqual(api.calls.at(-1).query.purpose, 'vibes');

    console.log('✅ powerchat checkout-intent tests passed');
})().catch((e) => { console.error('❌', e); process.exit(1); });
