/**
 * OpenVibe.Live — payment settings for the client: which ways to pay are shown, and the prices.
 *
 * OpenVibe.Billing runs every checkout, webhook, subscription and renewal since the cutover of 2026-10-17
 * (billing-actions.js); the provider adapters and their credentials live there. Live offers a way to pay when the
 * master switch `payments_enabled` and the provider's own switch (`stripe_enabled`, …; site_settings,
 * openvibe.network/admin → Payments) are on AND Billing reports the provider enabled (`GET /api/v1/rates`, which is
 * true only when Billing holds that provider's keys). Live keeps no provider keys. PowerChat has its own enablement.
 */
const db = require('../db/database');
const money = require('./money-authority');
const billing = require('./billing-client');

async function s(key) { return (await db.getSetting(key) || '').toString().trim(); }
async function b(key) { const v = await db.getSetting(key); return v === true || v === 'true' || v === 1 || v === '1'; }
async function n(key, dflt) { const v = parseFloat(await db.getSetting(key)); return Number.isFinite(v) ? v : dflt; }

async function isEnabled() { return await b('payments_enabled'); }

// Billing's provider availability, read at most once a minute. Unreachable Billing offers no card rail (a checkout
// would fail there anyway); the last answer is kept for up to 10 minutes so a short Billing restart hides nothing.
const PROVIDERS_FRESH_MS = 60_000;
const PROVIDERS_MAX_STALE_MS = 10 * 60_000;
// Live's provider names → Billing's adapters.
const BILLING_NAME = { paypal: 'paypal', stripe: 'stripe', ccbill: 'ccbill', crypto: 'nowpayments' };
let _providers = { at: 0, value: null, pending: null };
async function billingProviders() {
    const age = Date.now() - _providers.at;
    if (_providers.value && age < PROVIDERS_FRESH_MS) return _providers.value;
    _providers.pending ||= billing.api.rates()
        .then((r) => { _providers = { at: Date.now(), value: (r && r.providers) || {}, pending: null }; })
        .catch(() => { _providers.pending = null; });
    await _providers.pending;
    if (_providers.value && Date.now() - _providers.at < PROVIDERS_MAX_STALE_MS) return _providers.value;
    return {};
}

/** Card, PayPal and crypto rails Live offers: master switch, the provider's switch, and Billing holds its keys. */
async function offered() {
    const out = Object.fromEntries(Object.keys(BILLING_NAME).map((p) => [p, false]));
    if (!await isEnabled()) return out;
    const on = await billingProviders();
    for (const p of Object.keys(out)) out[p] = await b(`${p}_enabled`) && on[BILLING_NAME[p]] === true;
    return out;
}

/** Public provider availability + pricing for the client. */
async function publicConfig() {
    const hb = require('./vibes');
    const powerchatAvailable = await (async () => { try { return await require('../integrations/powerchat-checkout').isAvailable(); } catch { return false; } })();
    return {
        // "Something can be bought here": the card/PayPal master switch OR PowerChat.
        // (The old flag hid the subscribe modal entirely whenever the master switch was
        // off — even for streamers with PowerChat fully set up.)
        enabled: await isEnabled() || powerchatAvailable,
        paymentsMaster: await isEnabled(),
        subSiteRouteFeePct: await n('sub_site_route_fee_pct', 10),
        // Bit-style: 100 bucks = $1 cashout. Buy packages carry a per-buck premium.
        cashoutBucksPerUsd: hb.CASHOUT_BUCKS_PER_USD,
        packages: hb.BUCKS_PACKAGES,
        minPurchaseBucks: await n('bucks_min_purchase_bucks', 100),
        subPriceUsd: await n('sub_price_usd', 4.99),
        providers: {
            ...await offered(),
            // PowerChat tips as a money entry point. Deliberately INDEPENDENT of the
            // payments master switch — it has its own enablement (powerchat_enabled +
            // the site tips account), so Vibes can be bought via PowerChat even while
            // the card/PayPal rails are off. Lazy require: circular with this module.
            powerchat: powerchatAvailable,
        },
        // Who holds the money (OpenVibe.Billing) and whether money actions are paused.
        authority: money.authority(),
        moneyFrozen: await money.isFrozen(),
    };
}

module.exports = {
    isEnabled, publicConfig, offered,
    _resetProviders() { _providers = { at: 0, value: null, pending: null }; },
    // settings accessors (for routes)
    _get: s, _bool: b, _num: n,
};
