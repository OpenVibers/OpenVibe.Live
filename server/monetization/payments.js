/**
 * OpenVibe.Live — payment settings for the client: which ways to pay are shown, and the prices.
 *
 * OpenVibe.Billing runs every checkout, webhook, subscription and renewal since the cutover of 2026-10-17
 * (billing-actions.js); the provider adapters live there. The master switch `payments_enabled` (site_settings,
 * openvibe.network/admin → Payments) still decides whether Live offers card/PayPal/crypto at all; PowerChat has its
 * own enablement.
 */
const db = require('../db/database');
const money = require('./money-authority');

async function s(key) { return (await db.getSetting(key) || '').toString().trim(); }
async function b(key) { const v = await db.getSetting(key); return v === true || v === 'true' || v === 1 || v === '1'; }
async function n(key, dflt) { const v = parseFloat(await db.getSetting(key)); return Number.isFinite(v) ? v : dflt; }

async function isEnabled() { return await b('payments_enabled'); }

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
            paypal: await isEnabled() && await b('paypal_enabled') && !!await s('paypal_client_id'),
            stripe: await isEnabled() && await b('stripe_enabled') && !!await s('stripe_secret_key'),
            ccbill: await isEnabled() && await b('ccbill_enabled') && !!await s('ccbill_flexform_id'),
            crypto: await isEnabled() && await b('crypto_enabled') && !!await s('crypto_api_key'),
            // PowerChat tips as a money entry point. Deliberately INDEPENDENT of the
            // payments master switch — it has its own enablement (powerchat_enabled +
            // the site tips account), so Vibes can be bought via PowerChat even while
            // the card/PayPal rails are off. Lazy require: circular with this module.
            powerchat: powerchatAvailable,
        },
        stripePublishableKey: await s('stripe_publishable_key'),
        // Who holds the money (OpenVibe.Billing) and whether money actions are paused.
        authority: money.authority(),
        moneyFrozen: await money.isFrozen(),
    };
}

module.exports = {
    isEnabled, publicConfig,
    // settings accessors (for routes)
    _get: s, _bool: b, _num: n,
};
