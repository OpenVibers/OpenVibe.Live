/**
 * OpenVibe.Live — Payments
 *
 * Real-money purchase of Vibes + channel subscriptions across PayPal,
 * Stripe, CCBill and crypto (NOWPayments). All provider credentials live in
 * site_settings (configured in openvibe.network/admin → Payments). The master switch
 * `payments_enabled` gates everything (default OFF) so nothing is live until an
 * admin turns it on.
 *
 * Design:
 *  - Every purchase creates a `payment_orders` row (pending) BEFORE redirecting.
 *  - Providers redirect the buyer to a hosted checkout; on success the provider
 *    calls our webhook, which we verify, then credit bucks / activate the sub
 *    idempotently (an order is only credited once).
 *  - We never see raw card data — Stripe/CCBill host the card form.
 */
const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');

function baseUrl() { return config.baseUrl.replace(/\/+$/, ''); }
function s(key) { return (db.getSetting(key) || '').toString().trim(); }
function b(key) { const v = db.getSetting(key); return v === true || v === 'true' || v === 1 || v === '1'; }
function n(key, dflt) { const v = parseFloat(db.getSetting(key)); return Number.isFinite(v) ? v : dflt; }

function isEnabled() { return b('payments_enabled'); }

/** USD (dollars) → whole Vibes at the VALUE rate (100 bucks = $1). Used for
 *  converting real income (sub share, external tips) into bucks — NOT for purchase
 *  pricing (buying adds a margin; see vibes.js priceUsdForBucks). */
function bucksForUsd(usd) {
    const rate = n('bucks_per_usd', 100);
    return Math.max(0, Math.round(usd * rate));
}

/** Public provider availability + pricing for the client. */
function publicConfig() {
    const hb = require('./vibes');
    return {
        enabled: isEnabled(),
        // Bit-style: 100 bucks = $1 cashout. Buy packages carry a per-buck premium.
        cashoutBucksPerUsd: hb.CASHOUT_BUCKS_PER_USD,
        packages: hb.BUCKS_PACKAGES,
        minPurchaseBucks: n('bucks_min_purchase_bucks', 100),
        subPriceUsd: n('sub_price_usd', 4.99),
        providers: {
            paypal: isEnabled() && b('paypal_enabled') && !!s('paypal_client_id'),
            stripe: isEnabled() && b('stripe_enabled') && !!s('stripe_secret_key'),
            ccbill: isEnabled() && b('ccbill_enabled') && !!s('ccbill_flexform_id'),
            crypto: isEnabled() && b('crypto_enabled') && !!s('crypto_api_key'),
        },
        stripePublishableKey: s('stripe_publishable_key'),
    };
}

// ── HTTP helpers ─────────────────────────────────────────────
async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : {}; } catch { /* */ }
    if (!res.ok) {
        const msg = (json && (json.message || json.error?.message || json.error || json.error_description)) || text || res.statusText;
        throw new Error(`${method} ${url} -> ${res.status}: ${msg}`);
    }
    return json || {};
}

// ══════════════════════════════════════════ STRIPE ══════════
const STRIPE_API = 'https://api.stripe.com/v1';
function stripeHeaders() {
    return { Authorization: `Bearer ${s('stripe_secret_key')}`, 'Content-Type': 'application/x-www-form-urlencoded' };
}
/** Create a Stripe Checkout Session. kind: 'bucks' (one-time) | 'subscription'. */
async function stripeCheckout({ order, name, amountCents, kind, successUrl, cancelUrl }) {
    const p = new URLSearchParams();
    p.set('success_url', successUrl);
    p.set('cancel_url', cancelUrl);
    p.set('client_reference_id', String(order.id));
    p.set('metadata[order_id]', String(order.id));
    p.set('line_items[0][quantity]', '1');
    p.set('line_items[0][price_data][currency]', 'usd');
    p.set('line_items[0][price_data][unit_amount]', String(amountCents));
    p.set('line_items[0][price_data][product_data][name]', name);
    if (kind === 'subscription') {
        p.set('mode', 'subscription');
        p.set('line_items[0][price_data][recurring][interval]', 'month');
        p.set('subscription_data[metadata][order_id]', String(order.id));
    } else {
        p.set('mode', 'payment');
    }
    const session = await httpJson(`${STRIPE_API}/checkout/sessions`, { method: 'POST', headers: stripeHeaders(), body: p.toString() });
    db.updatePaymentOrder(order.id, { provider_ref: session.id });
    return { url: session.url, ref: session.id };
}
/** Verify a Stripe webhook signature (t=..,v1=..) against the raw body. */
function stripeVerify(rawBody, sigHeader) {
    const secret = s('stripe_webhook_secret');
    if (!secret || !sigHeader) return null;
    const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
    if (!parts.t || !parts.v1) return null;
    const signed = `${parts.t}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
    const a = Buffer.from(expected), c = Buffer.from(parts.v1);
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
    try { return JSON.parse(rawBody); } catch { return null; }
}

// ══════════════════════════════════════════ PAYPAL ══════════
function paypalBase() { return s('paypal_mode') === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
async function paypalToken() {
    const auth = Buffer.from(`${s('paypal_client_id')}:${s('paypal_client_secret')}`).toString('base64');
    const j = await httpJson(`${paypalBase()}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
    });
    return j.access_token;
}
async function paypalCreateOrder({ order, amountUsd, description }) {
    const token = await paypalToken();
    const j = await httpJson(`${paypalBase()}/v2/checkout/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{
                custom_id: String(order.id),
                description: description.slice(0, 127),
                amount: { currency_code: 'USD', value: amountUsd.toFixed(2) },
            }],
            application_context: {
                brand_name: 'OpenVibe.Live', user_action: 'PAY_NOW',
                return_url: `${baseUrl()}/api/payments/paypal/return?order=${order.id}`,
                cancel_url: `${baseUrl()}/?purchase=cancel`,
            },
        }),
    });
    db.updatePaymentOrder(order.id, { provider_ref: j.id });
    const approve = (j.links || []).find(l => l.rel === 'approve');
    return { url: approve ? approve.href : null, ref: j.id };
}
async function paypalCaptureOrder(paypalOrderId) {
    const token = await paypalToken();
    return httpJson(`${paypalBase()}/v2/checkout/orders/${paypalOrderId}/capture`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
}
/** Verify a PayPal webhook via the verify-webhook-signature API. */
async function paypalVerify(headers, rawBody) {
    const webhookId = s('paypal_webhook_id');
    if (!webhookId) return false;
    const token = await paypalToken();
    const j = await httpJson(`${paypalBase()}/v1/notifications/verify-webhook-signature`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            auth_algo: headers['paypal-auth-algo'],
            cert_url: headers['paypal-cert-url'],
            transmission_id: headers['paypal-transmission-id'],
            transmission_sig: headers['paypal-transmission-sig'],
            transmission_time: headers['paypal-transmission-time'],
            webhook_id: webhookId,
            webhook_event: JSON.parse(rawBody),
        }),
    });
    return j.verification_status === 'SUCCESS';
}

// ══════════════════════════════════════════ CCBILL ══════════
/** Build a CCBill FlexForms hosted-payment URL for a one-time charge. */
function ccbillUrl({ order, amountUsd }) {
    const formId = s('ccbill_flexform_id');
    const salt = s('ccbill_salt');
    const price = amountUsd.toFixed(2);
    const currency = '840'; // USD
    // FlexForms digest: md5(price + period + currencyCode + salt) for a single charge
    const period = '2'; // days is unused for single charge but required; FlexForms uses formDigest
    const digest = crypto.createHash('md5').update(`${price}${period}${currency}${salt}`).digest('hex');
    const qs = new URLSearchParams({
        clientAccnum: s('ccbill_client_account'),
        clientSubacc: s('ccbill_subaccount'),
        initialPrice: price,
        initialPeriod: period,
        currencyCode: currency,
        formDigest: digest,
        'X-order': String(order.id), // custom passthrough (X- prefix survives to the webhook)
    });
    return `https://api.ccbill.com/wap-frontflex/flexforms/${formId}?${qs.toString()}`;
}
/** CCBill webhook auth: we require a shared secret in the query (?secret=...). */
function ccbillVerify(query) {
    const secret = s('ccbill_webhook_secret');
    if (!secret) return false;
    return String(query.secret || '') === secret;
}

// ══════════════════════════════════════════ CRYPTO (NOWPayments) ══
async function cryptoCreateInvoice({ order, amountUsd, description }) {
    const j = await httpJson('https://api.nowpayments.io/v1/invoice', {
        method: 'POST',
        headers: { 'x-api-key': s('crypto_api_key'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            price_amount: amountUsd, price_currency: 'usd',
            order_id: String(order.id), order_description: description,
            ipn_callback_url: `${baseUrl()}/api/payments/webhook/crypto`,
            success_url: `${baseUrl()}/?purchase=success`, cancel_url: `${baseUrl()}/?purchase=cancel`,
        }),
    });
    db.updatePaymentOrder(order.id, { provider_ref: String(j.id || j.invoice_id || '') });
    return { url: j.invoice_url, ref: String(j.id || j.invoice_id || '') };
}
/** Verify a NOWPayments IPN via HMAC-SHA512 of the sorted JSON body. */
function cryptoVerify(rawBody, sigHeader) {
    const secret = s('crypto_ipn_secret');
    if (!secret || !sigHeader) return null;
    let obj; try { obj = JSON.parse(rawBody); } catch { return null; }
    const sorted = JSON.stringify(sortObject(obj));
    const expected = crypto.createHmac('sha512', secret).update(sorted).digest('hex');
    const a = Buffer.from(expected), c = Buffer.from(String(sigHeader));
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
    return obj;
}
function sortObject(o) {
    if (Array.isArray(o)) return o.map(sortObject);
    if (o && typeof o === 'object') {
        return Object.keys(o).sort().reduce((acc, k) => { acc[k] = sortObject(o[k]); return acc; }, {});
    }
    return o;
}

// ── Fulfillment (idempotent) ─────────────────────────────────

/** Credit a paid bucks order exactly once. Returns true if newly credited. */
function fulfillBucksOrder(order) {
    if (!order || order.status === 'credited') return false;
    const bucks = order.bucks || bucksForUsd(order.amount_cents / 100);
    db.addVibes(order.user_id, bucks);
    try {
        db.createTransaction({
            from_user_id: null, to_user_id: order.user_id, amount: bucks, // ledger is in bucks
            type: 'purchase', status: 'completed',
            message: `Purchased ${bucks.toLocaleString()} Vibes via ${order.provider}`,
        });
    } catch { /* ledger is best-effort */ }
    db.updatePaymentOrder(order.id, { status: 'credited', bucks });
    return true;
}

/** Activate/extend a subscription from a paid order (idempotent-ish). */
function fulfillSubscriptionOrder(order, { providerRef = null, periodEnd = null } = {}) {
    if (!order || !order.streamer_id) return null;
    const end = periodEnd || new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();
    // Note BEFORE the upsert whether this subscriber already had a sub row — that makes
    // a renewal a resub for the PowerChat alert below.
    let isResub = false;
    try { isResub = !!db.getActiveSubscription(order.user_id, order.streamer_id); } catch { /* */ }
    const sub = db.upsertSubscription({
        subscriber_id: order.user_id, streamer_id: order.streamer_id, tier: 1,
        provider: order.provider, provider_ref: providerRef || order.provider_ref,
        price_cents: order.amount_cents, currency: order.currency || 'usd',
        status: 'active', current_period_end: end,
    });
    if (order.status !== 'credited') {
        // Pay the streamer their share as Vibes — this is income they received, so
        // it lands in their cashout balance (the only cashout-able balance).
        const sharePct = n('sub_streamer_share_pct', 70);
        const streamerBucks = bucksForUsd((order.amount_cents / 100) * (sharePct / 100));
        if (streamerBucks > 0) db.addVibesCashout(order.streamer_id, streamerBucks);
        db.updatePaymentOrder(order.id, { status: 'credited' });
        // Fire the sub on the streamer's PowerChat overlay (subscriptions:write) —
        // alerts + sub-goal/subathon credit. Keyed by the order id so a replayed
        // fulfillment can't double-alert. Only on first credit, never on re-runs.
        try {
            const subscriber = db.getUserById(order.user_id);
            require('../integrations/powerchat-platform').forwardSubscription(order.streamer_id, {
                subscriberName: subscriber?.display_name || subscriber?.username || 'Someone',
                externalId: `sub-order:${order.id}`,
                tier: '1',
                isResub,
            });
        } catch { /* non-critical */ }
    }
    return sub;
}

module.exports = {
    isEnabled, publicConfig, bucksForUsd,
    // stripe
    stripeCheckout, stripeVerify,
    // paypal
    paypalCreateOrder, paypalCaptureOrder, paypalVerify,
    // ccbill
    ccbillUrl, ccbillVerify,
    // crypto
    cryptoCreateInvoice, cryptoVerify,
    // fulfillment
    fulfillBucksOrder, fulfillSubscriptionOrder,
    // settings accessors (for routes)
    _get: s, _bool: b, _num: n,
};
