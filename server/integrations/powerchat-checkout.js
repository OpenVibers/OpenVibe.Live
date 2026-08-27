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
// The site tips account is just a TYPED PowerChat username (admin setting) — a
// dedicated account made for receiving site money. Checkout links are canonical
// URLs built from the username + our client id; confirmation arrives via the
// signed webhook, so no tokens are needed on our side. The only external
// requirement: that PowerChat account must have the app connected on PowerChat
// (Connect card / OAuth consent) so webhooks fire and refs echo back for it.
function getSiteAccount() {
    try {
        const c = oauth.getConfig();
        if (!c.enabled || !c.clientId) return null;
        const username = String(db.getSetting('powerchat_site_tip_username') || '').trim();
        return username ? { username } : null;
    } catch { return null; }
}
function isAvailable() { return !!getSiteAccount(); }

// A streamer-direct checkout host = connected via app OAuth AND granted
// checkout:attribute (attribution refs only echo back for grants carrying the scope).
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

// Canonical attribution link (documented stable URL shape — no API round-trip needed).
//  ref         → app_ref: per-TRANSACTION correlation id (which order to mark paid)
//  purpose     → app_purpose: CATEGORY slug, stable across purchases of the same thing
//                ("vibes", "subscription", "goal:<id>"); echoed back as appPurpose
//  amountCents → app_amount_cents: pins the checkout to exactly this USD amount — the
//                tip page locks the picker and the server rejects mismatched submits.
//                Valid range 50–1000000; below the floor we leave the amount free.
//  returnTo    → app_redirect_uri: send the viewer back to our REGISTERED redirect URI
//                after checkout (UX + correlation only — the webhook stays the ONLY
//                authoritative confirmation).
function tipLinkFor(pcUsername, ref, { purpose = null, amountCents = null, returnTo = false } = {}) {
    const c = oauth.getConfig();
    const params = new URLSearchParams({ app_client_id: c.clientId });
    if (ref) params.set('app_ref', ref);
    if (purpose) params.set('app_purpose', String(purpose).slice(0, 64));
    const cents = Math.round(Number(amountCents) || 0);
    if (cents >= 50 && cents <= 1000000) params.set('app_amount_cents', String(cents));
    if (returnTo) params.set('app_redirect_uri', oauth.redirectUri());
    return `${c.baseUrl}/${encodeURIComponent(pcUsername)}/tip?${params.toString()}`;
}

// ── Server-minted checkout intents ───────────────────────────
// PowerChat's fixed-price checkout is an INTENT, not a query string: the app calls
//   GET /streamers/:username/tip-checkout-link?amount_cents&purpose&ref&redirect_uri
// (streamer token, scope checkout:attribute) and gets back { url, expiresAt } — a
// single-use, one-hour URL carrying only app_intent=<token>. Amount/purpose/ref live
// server-side on the intent, so the viewer can neither edit the price nor strip the
// correlation ref; the tip page renders the amount read-only and a mismatched or
// replayed submit is a 400 with no Event. That is the mechanism the plain
// app_amount_cents query param only approximates — so every PINNED checkout (Vibes
// packs, subscriptions) is minted here first and the canonical URL is the fallback.
//
// Deployment gate: the endpoint ships on PowerChat's 103-integrations-system branch
// and may 404 in production. A 404 marks intents unsupported for a while (no
// re-probe per order); a 403 (scope shrunk / redirect URI not registered) and any
// other failure fall back per call. Both are logged at most once per 10 minutes.
//
// Minting needs a token for the HOST account. Streamer-direct hosts have one (their
// own connection); the site tips account has one only when its PowerChat username is
// also connected on this site (the owner's dashboard card) — otherwise it stays on
// the canonical link. `item_name` is the viewer-facing label PowerChat is adding to
// intents ("1,000 Vibes", "goosely — 1 month sub"); today `purpose` is a machine key
// only, and if the running PowerChat rejects the unknown param we retry without it so
// the fixed amount still lands.
const INTENT_UNSUPPORTED_MS = 15 * 60 * 1000;
const _intentSupport = new Map(); // apiBase → { unsupportedUntil, reason }
function checkoutIntentSupport() {
    const key = oauth.getConfig().apiBase;
    const st = _intentSupport.get(key);
    if (!st) return { state: 'unknown' };
    if (st.unsupportedUntil > Date.now()) return { state: 'unsupported', reason: st.reason, until: st.unsupportedUntil };
    if (st.supported) return { state: 'supported' };
    return { state: 'unknown' };
}
function _mintHostConn(pcUsername) {
    try {
        const conn = db.getPowerchatConnectionByUsername(pcUsername);
        if (!conn || !conn.access_token || !conn.refresh_token) return null;
        if (conn.scope && !String(conn.scope).split(/\s+/).includes('checkout:attribute')) return null;
        return conn;
    } catch { return null; }
}
const _mintWarned = new Map();
function _mintWarn(key, msg) {
    const now = Date.now();
    if ((now - (_mintWarned.get(key) || 0)) < 10 * 60 * 1000) return;
    _mintWarned.set(key, now);
    console.warn(`[PowerChat] checkout intent for @${key} not minted — using canonical link: ${msg}`);
}
async function mintCheckoutLink(pcUsername, ref, { purpose = null, amountCents = null, itemName = null, returnTo = true } = {}) {
    const fallback = (reason) => ({ url: tipLinkFor(pcUsername, ref, { purpose, amountCents, returnTo }), minted: false, expiresAt: null, reason });
    const apiBase = oauth.getConfig().apiBase;
    const sup = _intentSupport.get(apiBase);
    if (sup && sup.unsupportedUntil > Date.now()) return fallback('intents unsupported: ' + sup.reason);
    const conn = _mintHostConn(pcUsername);
    if (!conn) { _mintWarn(pcUsername, 'no connected account with checkout:attribute for that username'); return fallback('no host token'); }
    const cents = Math.round(Number(amountCents) || 0);
    const base = { ref: String(ref).slice(0, 128) };
    if (returnTo) base.redirect_uri = oauth.redirectUri();
    if (purpose) base.purpose = String(purpose).slice(0, 64);
    if (cents >= 50 && cents <= 1000000) base.amount_cents = String(cents);
    const label = itemName ? String(itemName).replace(/\s+/g, ' ').trim().slice(0, 64) : '';
    const attempt = async (withLabel) => {
        const query = withLabel && label ? { ...base, item_name: label } : base;
        const json = await oauth.apiRequest(conn.user_id, { method: 'GET', path: '/tip-checkout-link', username: pcUsername, query });
        const d = (json && json.data && typeof json.data === 'object') ? json.data : (json || {});
        const url = d.url || null;
        if (!url || !/^https?:\/\//i.test(String(url))) throw new Error('response carried no url');
        let out = String(url);
        // PowerChat builds the link on ITS configured public host. When we talk to it
        // through a different hostname (dev instance behind a tunnel), viewers can only
        // reach the one we're configured with — the intent token is what matters, so
        // re-home the link onto our baseUrl and keep path + query intact.
        try {
            const u = new URL(out), b = new URL(oauth.getConfig().baseUrl);
            if (u.host !== b.host) { u.protocol = b.protocol; u.host = b.host; }
            out = u.toString();
        } catch { /* keep as-is */ }
        return { url: out, expiresAt: d.expiresAt ? String(d.expiresAt) : null };
    };
    try {
        const r = await attempt(true);
        _intentSupport.set(apiBase, { supported: true, unsupportedUntil: 0 });
        return { url: r.url, minted: true, expiresAt: r.expiresAt };
    } catch (e1) {
        if (label && e1.status === 400) {
            try {
                const r = await attempt(false);
                _intentSupport.set(apiBase, { supported: true, unsupportedUntil: 0 });
                return { url: r.url, minted: true, expiresAt: r.expiresAt };
            } catch (e2) { e1 = e2; }
        }
        if (e1.status === 404) {
            // Endpoint absent on this PowerChat deployment — stop probing for a while.
            _intentSupport.set(apiBase, { supported: false, unsupportedUntil: Date.now() + INTENT_UNSUPPORTED_MS, reason: 'tip-checkout-link returned 404 (not deployed on this PowerChat)' });
            _mintWarn(pcUsername, `404 — checkout intents are not deployed on ${apiBase}; using canonical links for ${INTENT_UNSUPPORTED_MS / 60000} min`);
        } else {
            _mintWarn(pcUsername, `${e1.status || ''} ${e1.message}`.trim());
        }
        return fallback(`${e1.status || 'error'}: ${e1.message}`);
    }
}

// ── Link builders ────────────────────────────────────────────
// Buy Vibes: always the site account (the site must receive the money it mints
// against). The checkout is PINNED to the package price and categorized "vibes".
async function buildPurchaseLink(order) {
    const site = getSiteAccount();
    if (!site) return null;
    const bucks = Number(order.bucks) || 0;
    const link = await mintCheckoutLink(site.username, `pcorder:${order.id}`, {
        purpose: 'vibes', amountCents: order.amount_cents, returnTo: true,
        itemName: bucks ? `${bucks.toLocaleString()} Vibes` : 'Vibes',
    });
    return { url: link.url, mode: 'site', minted: link.minted, expiresAt: link.expiresAt };
}

// Subscription: streamer-direct when possible, site fallback otherwise.
// The chosen mode (and the subscriber's auto-renew wish) is persisted on the order's
// provider_ref ("direct" | "site", ":renew" suffix) — webhook fulfillment reads it to
// decide the streamer share and the sub's auto_renew flag.
// route: 'direct' (the streamer's own PowerChat — they keep 100%, no fee) or 'site'
// (OpenVibe's PowerChat account — a small platform fee is added on top of the sub price
// and the streamer receives their normal share of the BASE price). 'auto' = direct when
// the streamer has PowerChat connected, else site.
// provider_ref persists the decision: "direct[:renew]" | "site[:fee=<cents>][:renew]".
async function buildSubscribeLink(order, streamerUserId, { autoRenew = 0, route = 'auto', feeCents = 0 } = {}) {
    const suffix = autoRenew ? ':renew' : '';
    const streamer = db.getUserById(streamerUserId);
    const who = streamer ? (streamer.display_name || streamer.username) : 'channel';
    const opts = {
        purpose: 'subscription', amountCents: order.amount_cents, returnTo: true,
        itemName: `${who} — 1 month subscription${autoRenew ? ' (auto-renew)' : ''}`,
    };
    const direct = route !== 'site' ? _checkoutConn(streamerUserId) : null;
    if (direct) {
        db.updatePaymentOrder(order.id, { provider_ref: `direct${suffix}` });
        const link = await mintCheckoutLink(direct.powerchat_username, `pcsub:${order.id}`, opts);
        return { url: link.url, mode: 'direct', minted: link.minted, expiresAt: link.expiresAt };
    }
    if (route === 'direct') return null;   // caller asked for the streamer's page and they have none
    const site = getSiteAccount();
    if (!site) return null;
    const fee = Math.max(0, Math.round(Number(feeCents) || 0));
    db.updatePaymentOrder(order.id, { provider_ref: `site${fee ? `:fee=${fee}` : ''}${suffix}` });
    const link = await mintCheckoutLink(site.username, `pcsub:${order.id}`, opts);
    return { url: link.url, mode: 'site', feeCents: fee, minted: link.minted, expiresAt: link.expiresAt };
}

/** Which PowerChat subscription routes a streamer currently supports (for the UI). */
function subscribeRoutes(streamerUserId) {
    return { direct: !!_checkoutConn(streamerUserId), site: !!getSiteAccount() };
}

// Donation: streamer's own page when they have PowerChat (the normal
// donation.completed flow handles it), else the site account with a routing ref.
// When the viewer picked a donation goal before heading over, the goal rides in
// app_purpose ("goal:<id>") and the webhook credits that exact goal. Amount stays
// the viewer's free choice — donations are never pinned.
function buildDonateLink(streamerUserId, donorUserId, { goalId = null } = {}) {
    const purpose = goalId ? `goal:${goalId}` : 'donation';
    // returnTo: donors get auto-redirected back to our confirmation page after the
    // checkout too — without app_redirect_uri PowerChat only offers a plain
    // "Return to app" link and viewers just sat on the tip page.
    const opts = { purpose, returnTo: true };
    // Direct ONLY: money through PowerChat goes to a streamer exclusively via THEIR
    // OWN connected account. Streamers without PowerChat don't get site-routed tips
    // any more — the viewer buys Vibes through the site account instead (pcorder;
    // see /donate-link) and donates Vibes from their balance. The pcdon webhook
    // handler stays only to honor links already in flight.
    // ALWAYS send an app_ref: attribution fields (appPurpose included — that's how
    // the goal pick travels) only echo back for tips through our checkout link, and a
    // ref-less link may not count as one. "dontip:" refs fall through to the normal
    // donation pipeline on the webhook side.
    const direct = _checkoutConn(streamerUserId);
    if (direct) {
        const ref = `dontip:${streamerUserId}:${donorUserId || 0}`;
        return { url: tipLinkFor(direct.powerchat_username, ref, opts), mode: 'direct' };
    }
    return null;
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
            // Credit what was ACTUALLY paid (intents pin the amount; the canonical
            // fallback link can't) — never the package price on faith.
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
            // Underpaid (canonical-link fallback can't enforce amounts; minted intents
            // can): treat the tip as a plain
            // donation to the order's streamer rather than silently activating a
            // discounted sub. Direct mode = the receiving account IS the streamer, so
            // falling through does the right thing; site mode routes explicitly.
            const mode = String(order.provider_ref || 'site').split(':')[0];
            const autoRenew = /:renew$/.test(String(order.provider_ref || '')) ? 1 : 0;
            const feeCents = Number((String(order.provider_ref || '').match(/:fee=(\d+)/) || [])[1] || 0);
            if (usdCents + 1 < (order.amount_cents || 0)) {
                console.warn(`[PowerChat] sub order ${order.id} underpaid (${_usd(usdCents)} < ${_usd(order.amount_cents)}) — treating as a donation`);
                if (mode === 'site') { _creditSiteRoutedDonation(order.streamer_id, order.user_id, data); return true; }
                return false;
            }
            const pay = require('../monetization/payments');
            db.updatePaymentOrder(order.id, { status: 'paid' });
            // Streamer-direct: they already hold the cash — no cashout-Vibes share.
            // Site route: the streamer's share is computed on the sub price, not on the fee.
            pay.fulfillSubscriptionOrder(db.getPaymentOrderById(order.id), { creditShare: mode !== 'direct', autoRenew, shareBaseCents: Math.max(0, (order.amount_cents || 0) - feeCents) });
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
    isAvailable, getSiteAccount, tipLinkFor, mintCheckoutLink, checkoutIntentSupport, subscribeRoutes,
    _test: { resetIntentSupport: () => _intentSupport.clear() },
    buildPurchaseLink, buildSubscribeLink, buildDonateLink,
    handleAttributedDonation,
};
