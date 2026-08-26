/**
 * powerchat-checkout.js — PowerChat as a real-money entry point into the site economy.
 *
 * Three attributed checkout flows, all confirmed by the donation.completed webhook
 * (appExternalRef carries our reference; only our app ever sees its own refs):
 *
 *   pcorder:<orderId>            Buy Vibes. Always hosted on the SITE account's tip
 *                                page (the site receives the money, so it can mint
 *                                spendable Vibes for the buyer).
 *   pcsub:<orderId>              Channel subscription paid by PowerChat tip. Hosted on
 *                                the STREAMER's own tip page when they have PowerChat
 *                                (they keep the money → no Vibes share credited), else
 *                                on the site account (site keeps the money → streamer
 *                                gets the normal cashout-able share).
 *   pcdon:<streamerId>:<donorId> Donation to a streamer WITHOUT PowerChat, routed
 *                                through the site account. The streamer is credited
 *                                the full amount as cashout-able Vibes (1¢ = 1 Vibe)
 *                                and the normal donation celebration fires. Streamers
 *                                WITH PowerChat never get pcdon refs — viewers tip
 *                                their page directly and the plain webhook flow runs.
 *
 * The SITE account is an ordinary streamer connection (dashboard OAuth card) pointed
 * at by the powerchat_site_user_id admin setting — the owner's own PowerChat.
 */
'use strict';

const db = require('../db/database');
const oauth = require('./powerchat-oauth');

// ── Site account resolution ──────────────────────────────────
function siteAccountUserId() {
    const v = parseInt(String(db.getSetting('powerchat_site_user_id') || ''), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
}
// A usable checkout host = connected via app OAuth AND granted checkout:attribute
// (attribution refs only echo back for grants that carry the scope).
function _checkoutConn(userId) {
    if (!userId) return null;
    try {
        if (!oauth.getConfig().enabled) return null;
        const conn = db.getPowerchatConnection(userId);
        if (!conn || !conn.access_token || !conn.refresh_token || !conn.powerchat_username) return null;
        if (conn.scope && !String(conn.scope).split(/\s+/).includes('checkout:attribute')) return null;
        return conn;
    } catch { return null; }
}
function getSiteAccount() {
    const userId = siteAccountUserId();
    const conn = _checkoutConn(userId);
    return conn ? { userId, username: conn.powerchat_username } : null;
}
function isAvailable() { return !!getSiteAccount(); }

// Canonical attribution link (documented stable URL shape — no API round-trip needed).
function tipLinkFor(pcUsername, ref) {
    const c = oauth.getConfig();
    const params = new URLSearchParams({ app_client_id: c.clientId });
    if (ref) params.set('app_ref', ref);
    return `${c.baseUrl}/${encodeURIComponent(pcUsername)}/tip?${params.toString()}`;
}

// ── Link builders ────────────────────────────────────────────
// Buy Vibes: always the site account (the site must receive the money it mints against).
function buildPurchaseLink(order) {
    const site = getSiteAccount();
    if (!site) return null;
    return { url: tipLinkFor(site.username, `pcorder:${order.id}`), mode: 'site' };
}

// Subscription: streamer-direct when possible, site fallback otherwise.
// The chosen mode (and the subscriber's auto-renew wish) is persisted on the order's
// provider_ref ("direct" | "site", ":renew" suffix) — webhook fulfillment reads it to
// decide the streamer share and the sub's auto_renew flag.
function buildSubscribeLink(order, streamerUserId, { autoRenew = 0 } = {}) {
    const suffix = autoRenew ? ':renew' : '';
    const direct = _checkoutConn(streamerUserId);
    if (direct) {
        db.updatePaymentOrder(order.id, { provider_ref: `direct${suffix}` });
        return { url: tipLinkFor(direct.powerchat_username, `pcsub:${order.id}`), mode: 'direct' };
    }
    const site = getSiteAccount();
    if (!site) return null;
    db.updatePaymentOrder(order.id, { provider_ref: `site${suffix}` });
    return { url: tipLinkFor(site.username, `pcsub:${order.id}`), mode: 'site' };
}

// Donation: streamer's own page when they have PowerChat (plain link — the normal
// donation.completed flow handles it, optionally with a goal: ref added by the caller),
// else the site account with a routing ref.
function buildDonateLink(streamerUserId, donorUserId) {
    const direct = _checkoutConn(streamerUserId);
    if (direct) return { url: tipLinkFor(direct.powerchat_username, ''), mode: 'direct' };
    const site = getSiteAccount();
    if (!site) return null;
    return { url: tipLinkFor(site.username, `pcdon:${streamerUserId}:${donorUserId || 0}`), mode: 'site' };
}

// ── Webhook fulfillment ──────────────────────────────────────
// Called by the webhook processor for donation.completed events whose appExternalRef
// matches one of our prefixes. Returns true when the event was CONSUMED (the normal
// donation pipeline for the receiving account must then be skipped), false to fall
// through to plain donation handling.
function handleAttributedDonation(receivingUserId, data) {
    const ref = String(data.appExternalRef || '');
    const usdCents = Math.max(0, Math.round(Number(data.amountUsdCents || 0)));
    try {
        // Buy Vibes ---------------------------------------------------------
        let m = ref.match(/^pcorder:(\d+)$/);
        if (m) {
            const order = db.getPaymentOrderById(Number(m[1]));
            if (!order || order.kind !== 'bucks') return true; // ours but unusable — never double-handle
            if (order.status === 'credited') return true;      // at-least-once redelivery
            if (usdCents < 1) return true;
            // The tip page can't enforce an amount — credit what was ACTUALLY paid.
            const pay = require('../monetization/payments');
            const bucks = pay.bucksForUsd(usdCents / 100);
            db.updatePaymentOrder(order.id, { amount_cents: usdCents, bucks, status: 'paid' });
            pay.fulfillBucksOrder(db.getPaymentOrderById(order.id));
            _notify(order.user_id, 'Vibes credited 🎉', `Your PowerChat tip of ${_usd(usdCents)} was confirmed — ${bucks.toLocaleString()} Vibes added to your balance.`);
            console.log(`[PowerChat] purchase order ${order.id}: ${_usd(usdCents)} → ${bucks} Vibes for user ${order.user_id}`);
            return true;
        }
        // Subscription ------------------------------------------------------
        m = ref.match(/^pcsub:(\d+)$/);
        if (m) {
            const order = db.getPaymentOrderById(Number(m[1]));
            if (!order || order.kind !== 'subscription' || !order.streamer_id) return true;
            if (order.status === 'credited') return true;
            // Underpaid (tip page can't enforce amounts): treat the tip as a plain
            // donation to the order's streamer rather than silently activating a
            // discounted sub. Direct mode = the receiving account IS the streamer, so
            // falling through does the right thing; site mode routes explicitly.
            const mode = String(order.provider_ref || 'site').split(':')[0];
            const autoRenew = /:renew$/.test(String(order.provider_ref || '')) ? 1 : 0;
            if (usdCents + 1 < (order.amount_cents || 0)) {
                console.warn(`[PowerChat] sub order ${order.id} underpaid (${_usd(usdCents)} < ${_usd(order.amount_cents)}) — treating as a donation`);
                if (mode === 'site') { _creditSiteRoutedDonation(order.streamer_id, order.user_id, data); return true; }
                return false;
            }
            const pay = require('../monetization/payments');
            db.updatePaymentOrder(order.id, { status: 'paid' });
            // Streamer-direct: they already hold the cash — no cashout-Vibes share.
            pay.fulfillSubscriptionOrder(db.getPaymentOrderById(order.id), { creditShare: mode !== 'direct', autoRenew });
            _notify(order.user_id, 'Subscribed! ⭐', 'Your PowerChat tip was confirmed — your channel subscription is active.');
            console.log(`[PowerChat] sub order ${order.id} activated via PowerChat (${order.provider_ref}) for user ${order.user_id}`);
            return true;
        }
        // Site-routed donation ----------------------------------------------
        m = ref.match(/^pcdon:(\d+):(\d+)$/);
        if (m) {
            _creditSiteRoutedDonation(Number(m[1]), Number(m[2]) || null, data);
            return true;
        }
    } catch (e) {
        console.warn('[PowerChat] attributed-donation fulfillment failed:', e.message);
        return true; // never fall through to crediting the receiving account on our refs
    }
    return false; // not one of our checkout refs (e.g. goal:12) — normal handling
}

// A tip that landed on the SITE account on behalf of a PowerChat-less streamer:
// full amount becomes the streamer's cashout-able Vibes (the site holds the cash),
// plus the normal on-site donation celebration/goal credit.
function _creditSiteRoutedDonation(streamerUserId, donorUserId, data) {
    const usdCents = Math.max(0, Math.round(Number(data.amountUsdCents || 0)));
    if (!streamerUserId || usdCents < 1) return;
    if (!db.getUserById(streamerUserId)) { console.warn(`[PowerChat] pcdon for unknown streamer ${streamerUserId}`); return; }
    db.addVibesCashout(streamerUserId, usdCents); // 1¢ = 1 Vibe, same rate as on-site donations
    try {
        db.createTransaction({
            from_user_id: donorUserId || null, to_user_id: streamerUserId, amount: usdCents,
            type: 'donation', status: 'completed',
            message: `PowerChat tip via site account (${_usd(usdCents)})`,
        });
    } catch { /* ledger best-effort */ }
    // Same celebration pipeline a direct-connected streamer gets from their own webhook.
    try { require('./powerchat-webhook').creditDonationPipeline(streamerUserId, data); } catch (e) { console.warn('[PowerChat] pcdon pipeline:', e.message); }
    console.log(`[PowerChat] site-routed donation: ${_usd(usdCents)} → ${usdCents} cashout Vibes for streamer ${streamerUserId}`);
}

function _usd(cents) { return `$${(Math.round(cents) / 100).toFixed(2)}`; }
function _notify(userId, title, message) {
    try {
        const { pushNotification } = require('../utils/notify');
        pushNotification({ user_id: userId, type: 'PAYMENT', title, message, url: '/' });
    } catch { /* optional */ }
}

module.exports = {
    isAvailable, getSiteAccount, tipLinkFor,
    buildPurchaseLink, buildSubscribeLink, buildDonateLink,
    handleAttributedDonation,
};
