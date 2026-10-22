/**
 * OpenVibe.Live — Payments & Subscriptions API  (mounted at /api/payments)
 *
 * OpenVibe.Billing is the money ledger (since the cutover of 2026-10-17). Every action here asks it
 * (billing-actions.js): buying Vibes (PayPal / Stripe / CCBill / crypto / PowerChat checkouts),
 * subscribing to a channel (tier 1, at the creator's price), cancelling and reading subscriptions.
 * Live keeps no money record. money_writes_frozen (money-authority.js) still refuses new money
 * actions. The old provider webhooks answer 410 with Billing's address: providers deliver there.
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');
const pay = require('./payments');
const openvibeBucks = require('./vibes');
const money = require('./money-authority');
const billingActions = require('./billing-actions');
const billingClient = require('./billing-client');

const BILLING_WEBHOOK = { stripe: 'stripe', paypal: 'paypal', ccbill: 'ccbill', crypto: 'nowpayments' };
const router = express.Router();

// ── Public config (which providers are live + pricing) ───────
router.get('/config', async (req, res) => {
    res.json(await pay.publicConfig());
});

// ── Buy Vibes ───────────────────────────────────────────
router.post('/bucks/checkout', requireAuth, money.guardWrite, async (req, res) => {
    const provider = String(req.body.provider || '').toLowerCase();
    // PowerChat purchases run on their own enablement (powerchat_enabled + site tips
    // account) — the master payments switch only gates the card/PayPal/crypto rails.
    if (!await pay.isEnabled() && provider !== 'powerchat') return res.status(403).json({ error: 'Payments are not enabled' });
    let bucks;
    try { bucks = openvibeBucks.normalizeBucks(req.body.bucks); } catch (e) { return res.status(400).json({ error: e.message }); }
    const minBucks = await pay._num('bucks_min_purchase_bucks', 100);
    if (bucks < minBucks) return res.status(400).json({ error: `Minimum purchase is ${minBucks.toLocaleString()} Vibes` });
    if (bucks > 1_000_000) return res.status(400).json({ error: 'Amount too large' });
    if (!['stripe', 'paypal', 'ccbill', 'crypto', 'powerchat'].includes(provider)) return res.status(400).json({ error: 'Unknown payment provider' });
    if (provider !== 'powerchat' && !(await pay.offered())[provider]) return res.status(403).json({ error: 'That way to pay is not available right now' });
    try {
        const r = await billingActions.checkout(req, { provider, bucks });
        return res.status(r.status).json(r.body);
    } catch (err) {
        if (billingActions.sendError(res, err)) return;
        console.error('[Payments] billing checkout error:', err.message);
        return res.status(502).json({ error: 'Payment provider error. Try again.' });
    }
});

// PayPal buyer returns here after approving: Billing's PayPal intents come back with ?token=<PayPal order id>,
// and Billing captures and settles.
router.get('/paypal/return', async (req, res) => {
    try { return res.redirect(await billingActions.paypalReturn(req.query.token) ? '/?purchase=success' : '/?purchase=error'); }
    catch (err) { console.error('[Payments] billing paypal return:', err.detail || err.message); return res.redirect('/?purchase=error'); }
});

// ── Subscriptions ────────────────────────────────────────────
router.post('/subscribe', requireAuth, money.guardWrite, async (req, res) => {
    const provider = String(req.body.provider || '').toLowerCase();
    // PowerChat subs run on PowerChat's own enablement; the payments master switch only
    // gates the card/PayPal/Vibes-purchase rails.
    const viaPowerchat = provider === 'powerchat' || provider === 'powerchat_site';
    if (!await pay.isEnabled() && !viaPowerchat && provider !== 'bucks') return res.status(403).json({ error: 'Payments are not enabled' });
    if (provider === 'stripe' && !(await pay.offered()).stripe) return res.status(403).json({ error: 'Card subscriptions are not available right now' });
    const streamer = await db.getUserByUsername(String(req.body.streamer || ''));
    if (!streamer) return res.status(404).json({ error: 'Streamer not found' });
    if (streamer.id === req.user.id) return res.status(400).json({ error: 'You cannot subscribe to yourself' });
    try {
        const r = await billingActions.subscribe(req, { streamer, provider, autoRenewRaw: req.body.auto_renew });
        return res.status(r.status).json(r.body);
    } catch (err) {
        if (billingActions.sendError(res, err, { insufficientStatus: 402, insufficient: (d) => `Not enough Vibes${d.required ? ` (need ${d.required})` : ''}`, self: 'You cannot subscribe to yourself' })) return;
        console.error('[Payments] billing subscribe error:', err.message);
        return res.status(502).json({ error: 'Payment provider error. Try again.' });
    }
});

// My subscriptions
router.get('/subscriptions/mine', requireAuth, async (req, res) => {
    try { return res.json({ subscriptions: await billingActions.mySubscriptions(req.user.id) }); }
    catch (err) {
        if (billingActions.sendError(res, err, { unavailable: 'Subscriptions unavailable right now — the billing service is not answering.' })) return;
        return res.status(503).json({ error: 'Subscriptions unavailable right now', unavailable: true });
    }
});

// The channel's memberships on OpenVibe.VIP (tiers) and other ways to support it (OpenVibe.Tips): public, the same
// for everyone, cached a minute (elsewhere.js).
router.get('/channel/:username/elsewhere', async (req, res) => {
    const out = await require('./elsewhere').forChannel(req.params.username);
    res.set('Cache-Control', 'public, max-age=60').json(out);
});

// Am I subscribed to this channel? + subscriber count + what Billing charges for tier 1 (the creator's price on VIP,
// else Billing's default; the site setting only while Billing does not answer).
router.get('/channel/:username', optionalAuth, async (req, res) => {
    const streamer = await db.getUserByUsername(req.params.username);
    if (!streamer) return res.status(404).json({ error: 'Not found' });
    let subscribed = false, subscriberCount = null, billingUnavailable = false, billingPriceCents = null;
    try { ({ subscribed, subscriberCount, priceCents: billingPriceCents } = await billingActions.channelState(streamer, req.user || null)); }
    catch { billingUnavailable = true; }
    const priceUsd = billingPriceCents ? billingPriceCents / 100 : await pay._num('sub_price_usd', 4.99);
    let powerchat = { direct: false, site: false };
    try { powerchat = await require('../integrations/powerchat-checkout').subscribeRoutes(streamer.id); } catch { /* */ }
    const feePct = await pay._num('sub_site_route_fee_pct', 10);
    const siteFeeUsd = Math.round(priceUsd * 100 * feePct / 100) / 100;
    res.json({
        subscribed, subscriberCount, priceUsd, ...(billingUnavailable ? { unavailable: true } : {}),
        powerchat: { ...powerchat, feePct, siteFeeUsd, siteTotalUsd: Math.round((priceUsd + siteFeeUsd) * 100) / 100 },
    });
});

// Cancel a subscription (at the period end; Billing cancels at the provider too).
router.post('/subscriptions/:id/cancel', requireAuth, money.guardWrite, async (req, res) => {
    try {
        const r = await billingActions.cancelSubscription(req, { id: req.params.id, streamerId: parseInt(req.body.streamerId, 10) || null });
        return res.status(r.status).json(r.body);
    } catch (err) {
        if (billingActions.sendError(res, err)) return;
        return res.status(502).json({ error: 'Could not cancel right now. Try again.' });
    }
});

// ── Provider webhooks: received by OpenVibe.Billing ──────────
// A provider dashboard still pointing here learns where to deliver; Live credits nothing.
for (const provider of ['stripe', 'paypal', 'ccbill', 'crypto']) {
    router.all(`/webhook/${provider}`, (req, res) => res.status(410).json({
        error: 'Payment webhooks are received by OpenVibe.Billing now.',
        webhook_url: `${billingClient.publicUrl()}/webhooks/${BILLING_WEBHOOK[provider]}`,
    }));
}

module.exports = router;
