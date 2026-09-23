/**
 * OpenVibe.Live — Payments & Subscriptions API  (mounted at /api/payments)
 *
 * - Buy Vibes via PayPal / Stripe / CCBill / crypto (hosted checkout).
 * - Subscribe to a channel via Stripe (recurring) or Vibes (30 days).
 * - Provider webhooks credit bucks / activate subs idempotently.
 */
const express = require('express');
const db = require('../db/database');
const config = require('../config');
const { requireAuth, optionalAuth } = require('../auth/auth');
const pay = require('./payments');
const openvibeBucks = require('./vibes');
// BILLING_AUTHORITY=billing: checkouts, subscriptions and entitlements go to OpenVibe.Billing and
// the provider webhooks below answer 410 (they land in Billing). money_writes_frozen refuses new
// money actions in both modes; provider confirmations of checkouts started before a freeze still
// settle in `live` mode (see money-authority.js).
const money = require('./money-authority');
const billingActions = require('./billing-actions');
const billingClient = require('./billing-client');
const BILLING_WEBHOOK = { stripe: 'stripe', paypal: 'paypal', ccbill: 'ccbill', crypto: 'nowpayments' };
function webhookMovedToBilling(provider) {
    return (req, res, next) => {
        if (!money.onBilling()) return next();
        return res.status(410).json({
            error: 'Payment webhooks are received by OpenVibe.Billing now.',
            webhook_url: `${billingClient.publicUrl()}/webhooks/${BILLING_WEBHOOK[provider]}`,
        });
    };
}

const router = express.Router();
function base() { return config.baseUrl.replace(/\/+$/, ''); }

// ── Public config (which providers are live + pricing) ───────
router.get('/config', (req, res) => {
    res.json(pay.publicConfig());
});

// ── Buy Vibes ───────────────────────────────────────────
router.post('/bucks/checkout', requireAuth, money.guardWrite, async (req, res) => {
    const provider = String(req.body.provider || '').toLowerCase();
    // PowerChat purchases run on their own enablement (powerchat_enabled + site tips
    // account) — the master payments switch only gates the card/PayPal/crypto rails.
    if (!pay.isEnabled() && provider !== 'powerchat') return res.status(403).json({ error: 'Payments are not enabled' });
    // The client picks a Vibes amount (bit-style); the USD price is derived from the
    // volume-discount tiers so bigger buys are cheaper per buck and the platform keeps the spread.
    let bucks;
    try { bucks = openvibeBucks.normalizeBucks(req.body.bucks); } catch (e) { return res.status(400).json({ error: e.message }); }
    const minBucks = pay._num('bucks_min_purchase_bucks', 100);
    if (bucks < minBucks) return res.status(400).json({ error: `Minimum purchase is ${minBucks.toLocaleString()} Vibes` });
    if (bucks > 1_000_000) return res.status(400).json({ error: 'Amount too large' });

    if (money.onBilling()) {
        if (!['stripe', 'paypal', 'ccbill', 'crypto', 'powerchat'].includes(provider)) return res.status(400).json({ error: 'Unknown payment provider' });
        try {
            const r = await billingActions.checkout(req, { provider, bucks });
            return res.status(r.status).json(r.body);
        } catch (err) {
            if (billingActions.sendError(res, err)) return;
            console.error('[Payments] billing checkout error:', err.message);
            return res.status(502).json({ error: 'Payment provider error. Try again.' });
        }
    }

    const amountUsd = openvibeBucks.priceUsdForBucks(bucks);
    const order = db.createPaymentOrder({
        user_id: req.user.id, provider, kind: 'bucks',
        amount_cents: Math.round(amountUsd * 100), bucks,
    });
    const name = `${bucks.toLocaleString()} Vibes`;
    try {
        if (provider === 'stripe') {
            const r = await pay.stripeCheckout({
                order, name, amountCents: order.amount_cents, kind: 'bucks',
                successUrl: `${base()}/?purchase=success`, cancelUrl: `${base()}/?purchase=cancel`,
            });
            return res.json({ url: r.url });
        }
        if (provider === 'paypal') {
            const r = await pay.paypalCreateOrder({ order, amountUsd, description: name });
            return res.json({ url: r.url });
        }
        if (provider === 'ccbill') {
            return res.json({ url: pay.ccbillUrl({ order, amountUsd }) });
        }
        if (provider === 'crypto') {
            const r = await pay.cryptoCreateInvoice({ order, amountUsd, description: name });
            return res.json({ url: r.url });
        }
        if (provider === 'powerchat') {
            // Tip the site's PowerChat account; the checkout is PINNED to the package
            // price (a server-minted intent locks the tip page's amount) and the
            // donation.completed webhook credits the buyer once it confirms.
            const link = await require('../integrations/powerchat-checkout').buildPurchaseLink(order);
            if (!link) { db.updatePaymentOrder(order.id, { status: 'failed' }); return res.status(400).json({ error: 'PowerChat purchases are not available right now' }); }
            return res.json({
                url: link.url, powerchat: true, amountUsd, pinned: !!link.minted, expires_at: link.expiresAt || null,
                note: `Complete the $${amountUsd.toFixed(2)} tip on PowerChat — your Vibes are credited automatically once it confirms.`,
            });
        }
        return res.status(400).json({ error: 'Unknown payment provider' });
    } catch (err) {
        console.error('[Payments] checkout error:', err.message);
        db.updatePaymentOrder(order.id, { status: 'failed' });
        return res.status(502).json({ error: 'Payment provider error. Try again.' });
    }
});

// PayPal buyer returns here after approving — capture + fulfill.
router.get('/paypal/return', async (req, res) => {
    if (money.onBilling()) {
        // Billing's PayPal intents come back with ?token=<PayPal order id>; Billing captures + settles.
        try { return res.redirect(await billingActions.paypalReturn(req.query.token) ? '/?purchase=success' : '/?purchase=error'); }
        catch (err) { console.error('[Payments] billing paypal return:', err.detail || err.message); return res.redirect('/?purchase=error'); }
    }
    try {
        const order = db.getPaymentOrderById(parseInt(req.query.order, 10));
        if (!order || order.provider !== 'paypal' || !order.provider_ref) return res.redirect('/?purchase=error');
        const cap = await pay.paypalCaptureOrder(order.provider_ref);
        const captured = cap.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
        const ok = cap.status === 'COMPLETED' && pay.paidAmountCovers(order, captured) !== false;
        if (ok) {
            if (order.kind === 'subscription') pay.fulfillSubscriptionOrder(order);
            else pay.fulfillBucksOrder(order);
            return res.redirect('/?purchase=success');
        }
        return res.redirect('/?purchase=error');
    } catch (err) {
        console.error('[Payments] paypal return:', err.message);
        return res.redirect('/?purchase=error');
    }
});

// ── Subscriptions ────────────────────────────────────────────
router.post('/subscribe', requireAuth, money.guardWrite, async (req, res) => {
    const provider = String(req.body.provider || '').toLowerCase();
    // PowerChat subs run on PowerChat's own enablement; the payments master switch only
    // gates the card/PayPal/Vibes-purchase rails.
    const viaPowerchat = provider === 'powerchat' || provider === 'powerchat_site';
    if (!pay.isEnabled() && !viaPowerchat && provider !== 'bucks') return res.status(403).json({ error: 'Payments are not enabled' });
    const streamer = db.getUserByUsername(String(req.body.streamer || ''));
    if (!streamer) return res.status(404).json({ error: 'Streamer not found' });
    if (streamer.id === req.user.id) return res.status(400).json({ error: 'You cannot subscribe to yourself' });
    if (money.onBilling()) {
        try {
            const r = await billingActions.subscribe(req, { streamer, provider, autoRenewRaw: req.body.auto_renew });
            return res.status(r.status).json(r.body);
        } catch (err) {
            if (billingActions.sendError(res, err, { insufficientStatus: 402, insufficient: (d) => `Not enough Vibes${d.required ? ` (need ${d.required})` : ''}`, self: 'You cannot subscribe to yourself' })) return;
            console.error('[Payments] billing subscribe error:', err.message);
            return res.status(502).json({ error: 'Payment provider error. Try again.' });
        }
    }
    if (db.isActiveSubscriber(req.user.id, streamer.id)) return res.status(409).json({ error: 'Already subscribed' });

    const priceUsd = pay._num('sub_price_usd', 4.99);
    const amountCents = Math.round(priceUsd * 100);

    // Pay with Vibes — instant 30-day sub; auto-renews from the Vibes balance unless
    // the subscriber opted out.
    if (provider === 'bucks') {
        const autoRenew = req.body.auto_renew === undefined ? 1 : (req.body.auto_renew ? 1 : 0);
        const cost = pay.bucksForUsd(priceUsd);
        if (!db.deductVibes(req.user.id, cost)) return res.status(402).json({ error: `Not enough Vibes (need ${cost})` });
        const order = db.createPaymentOrder({
            user_id: req.user.id, provider: 'bucks', kind: 'subscription',
            amount_cents: amountCents, streamer_id: streamer.id, status: 'paid',
        });
        const sub = pay.fulfillSubscriptionOrder(order, { autoRenew });
        return res.json({ ok: true, subscription: { streamer: streamer.username, current_period_end: sub.current_period_end, auto_renew: !!autoRenew } });
    }

    // Pay with a PowerChat tip — streamer's own tip page when they have PowerChat
    // (they keep the money directly), else the site-wide PowerChat account (the site
    // holds the money and the streamer gets their normal cashout-Vibes share). The
    // donation.completed webhook confirms and activates the sub. Renewals come from
    // the Vibes balance when auto_renew is on (a tip can't be auto-charged).
    if (viaPowerchat) {
        const autoRenew = req.body.auto_renew ? 1 : 0;
        const checkout = require('../integrations/powerchat-checkout');
        const routes = checkout.subscribeRoutes(streamer.id);
        // 'powerchat' = the streamer's own PowerChat (no fee). 'powerchat_site' = OpenVibe's
        // PowerChat account with the platform routing fee on top. A plain 'powerchat'
        // request for a streamer without PowerChat falls back to the site route (+fee) so
        // older clients keep working — the new UI always asks explicitly.
        const wantSite = provider === 'powerchat_site' || !routes.direct;
        if (wantSite && !routes.site) return res.status(400).json({ error: 'PowerChat payments are not available right now' });
        const feePct = wantSite ? pay._num('sub_site_route_fee_pct', 10) : 0;
        const feeCents = wantSite ? Math.round(amountCents * feePct / 100) : 0;
        const totalCents = amountCents + feeCents;
        const order = db.createPaymentOrder({
            user_id: req.user.id, provider: 'powerchat', kind: 'subscription',
            amount_cents: totalCents, streamer_id: streamer.id,
        });
        const link = await checkout.buildSubscribeLink(order, streamer.id, { autoRenew, route: wantSite ? 'site' : 'direct', feeCents });
        if (!link) { db.updatePaymentOrder(order.id, { status: 'failed' }); return res.status(400).json({ error: 'PowerChat payments are not available right now' }); }
        const totalUsd = totalCents / 100;
        return res.json({
            url: link.url, powerchat: true, route: link.mode, amountUsd: totalUsd, feeUsd: feeCents / 100,
            pinned: !!link.minted, expires_at: link.expiresAt || null,
            note: link.mode === 'direct'
                ? `Tip $${totalUsd.toFixed(2)} on ${streamer.display_name || streamer.username}'s PowerChat — your subscription activates automatically once the tip confirms.`
                : `Tip $${totalUsd.toFixed(2)} on OpenVibe's PowerChat (includes a $${(feeCents / 100).toFixed(2)} platform fee) — your subscription activates automatically once the tip confirms.`,
        });
    }

    // Stripe recurring subscription (auto-renew monthly).
    if (provider === 'stripe') {
        const order = db.createPaymentOrder({
            user_id: req.user.id, provider: 'stripe', kind: 'subscription',
            amount_cents: amountCents, streamer_id: streamer.id,
        });
        try {
            const r = await pay.stripeCheckout({
                order, name: `Subscription to ${streamer.display_name || streamer.username}`,
                amountCents, kind: 'subscription',
                successUrl: `${base()}/@${streamer.username}?sub=success`, cancelUrl: `${base()}/@${streamer.username}?sub=cancel`,
            });
            return res.json({ url: r.url });
        } catch (err) {
            console.error('[Payments] stripe sub:', err.message);
            db.updatePaymentOrder(order.id, { status: 'failed' });
            return res.status(502).json({ error: 'Stripe error. Try again.' });
        }
    }
    return res.status(400).json({ error: 'Subscriptions support Stripe or Vibes' });
});

// My subscriptions
router.get('/subscriptions/mine', requireAuth, async (req, res) => {
    if (money.onBilling()) {
        try { return res.json({ subscriptions: await billingActions.mySubscriptions(req.user.id) }); }
        catch (err) {
            if (billingActions.sendError(res, err, { unavailable: 'Subscriptions unavailable right now — the billing service is not answering.' })) return;
            return res.status(503).json({ error: 'Subscriptions unavailable right now', unavailable: true });
        }
    }
    res.json({ subscriptions: db.getSubscriptionsBySubscriber(req.user.id) });
});

// Am I subscribed to this channel? + subscriber count
router.get('/channel/:username', optionalAuth, async (req, res) => {
    const streamer = db.getUserByUsername(req.params.username);
    if (!streamer) return res.status(404).json({ error: 'Not found' });
    let subscribed = false, subscriberCount = null, billingUnavailable = false;
    if (money.onBilling()) {
        try { ({ subscribed, subscriberCount } = await billingActions.channelState(streamer, req.user || null)); }
        catch { billingUnavailable = true; }
    } else {
        subscribed = req.user ? db.isActiveSubscriber(req.user.id, streamer.id) : false;
        subscriberCount = db.getActiveSubscriberCount(streamer.id);
    }
    const priceUsd = pay._num('sub_price_usd', 4.99);
    let powerchat = { direct: false, site: false };
    try { powerchat = require('../integrations/powerchat-checkout').subscribeRoutes(streamer.id); } catch { /* */ }
    const feePct = pay._num('sub_site_route_fee_pct', 10);
    const siteFeeUsd = Math.round(priceUsd * 100 * feePct / 100) / 100;
    res.json({
        subscribed, subscriberCount, priceUsd, ...(billingUnavailable ? { unavailable: true } : {}),
        powerchat: { ...powerchat, feePct, siteFeeUsd, siteTotalUsd: Math.round((priceUsd + siteFeeUsd) * 100) / 100 },
    });
});

// Cancel a subscription (Stripe: at period end; bucks: immediate)
router.post('/subscriptions/:id/cancel', requireAuth, money.guardWrite, async (req, res) => {
    if (money.onBilling()) {
        try {
            const r = await billingActions.cancelSubscription(req, { id: req.params.id, streamerId: parseInt(req.body.streamerId, 10) || null });
            return res.status(r.status).json(r.body);
        } catch (err) {
            if (billingActions.sendError(res, err)) return;
            return res.status(502).json({ error: 'Could not cancel right now. Try again.' });
        }
    }
    const sub = db.getActiveSubscription(req.user.id, parseInt(req.body.streamerId, 10)) ||
        (db.getSubscriptionsBySubscriber(req.user.id) || []).find(x => String(x.id) === String(req.params.id));
    if (!sub || sub.subscriber_id !== req.user.id) return res.status(404).json({ error: 'Subscription not found' });
    // Stripe subs auto-renew; mark cancel-at-period-end (provider stops billing via dashboard/API).
    db.setSubscriptionStatus(sub.id, sub.provider === 'stripe' ? 'active' : 'canceled', { cancel_at_period_end: true, current_period_end: sub.current_period_end });
    res.json({ ok: true });
});

// ════════════════════════ WEBHOOKS ════════════════════════════
function rawBody(req) { return req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}); }

// Every webhook: the order must belong to that provider, and when the provider reports what was
// paid it must cover the order (an order id is passed through the buyer's browser for some
// providers, so without this a small payment could be pointed at a large order).
function payable(order, provider, paidUsd) {
    if (!order || order.provider !== provider) return false;
    if (pay.paidAmountCovers(order, paidUsd) === false) {
        console.warn(`[Payments] ${provider} paid ${paidUsd} for order ${order.id} (${order.amount_cents / 100}) — not credited`);
        return false;
    }
    return true;
}

// Stripe
router.post('/webhook/stripe', webhookMovedToBilling('stripe'), (req, res) => {
    const event = pay.stripeVerify(rawBody(req), req.headers['stripe-signature']);
    if (!event) return res.status(400).send('bad signature');
    try {
        const obj = event.data && event.data.object;
        const orderId = obj && ((obj.metadata && obj.metadata.order_id) || obj.client_reference_id);
        if (event.type === 'checkout.session.completed' && orderId) {
            const order = db.getPaymentOrderById(parseInt(orderId, 10));
            const paid = Number.isFinite(obj.amount_total) ? obj.amount_total / 100 : null;
            if (payable(order, 'stripe', paid)) {
                if (order.kind === 'subscription') pay.fulfillSubscriptionOrder(order, { providerRef: obj.subscription });
                else pay.fulfillBucksOrder(order);
            }
        } else if (event.type === 'invoice.paid') {
            // Recurring renewal — extend the sub by ~1 month.
            const subRef = obj.subscription;
            const existing = subRef && db.getSubscriptionByProviderRef('stripe', subRef);
            if (existing) {
                const end = new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();
                db.setSubscriptionStatus(existing.id, 'active', { current_period_end: end });
            }
        } else if (event.type === 'customer.subscription.deleted') {
            const existing = db.getSubscriptionByProviderRef('stripe', obj.id);
            if (existing) db.setSubscriptionStatus(existing.id, 'canceled');
        }
    } catch (err) { console.error('[Payments] stripe webhook:', err.message); }
    res.json({ received: true });
});

// PayPal
router.post('/webhook/paypal', webhookMovedToBilling('paypal'), async (req, res) => {
    try {
        const ok = await pay.paypalVerify(req.headers, rawBody(req));
        if (!ok) return res.status(400).send('unverified');
        const event = req.body;
        const rsrc = event.resource || {};
        if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
            const orderId = rsrc.custom_id || (rsrc.supplementary_data && rsrc.supplementary_data.related_ids && rsrc.supplementary_data.related_ids.order_id);
            const order = orderId && db.getPaymentOrderById(parseInt(orderId, 10));
            const paid = rsrc.amount && rsrc.amount.currency_code === 'USD' ? rsrc.amount.value : null;
            if (payable(order, 'paypal', paid)) (order.kind === 'subscription' ? pay.fulfillSubscriptionOrder(order) : pay.fulfillBucksOrder(order));
        }
    } catch (err) { console.error('[Payments] paypal webhook:', err.message); }
    res.json({ received: true });
});

// CCBill (FlexForms datalink / webhook). Verified via shared secret in query.
router.all('/webhook/ccbill', webhookMovedToBilling('ccbill'), (req, res) => {
    if (!pay.ccbillVerify(req.query)) return res.status(403).send('forbidden');
    try {
        const p = { ...req.query, ...req.body };
        const orderId = p['X-order'] || p.order;
        const order = orderId && db.getPaymentOrderById(parseInt(orderId, 10));
        const success = String(p.eventType || p.transactionType || '').toLowerCase().includes('success')
            || p.accountingAmount || p.priceInfo || p.eventType === 'NewSaleSuccess';
        // X-order rides in the buyer-editable form URL (the digest covers only the price), so
        // CCBill's reported price is required here, not optional.
        const paid = [p.billedInitialPrice, p.subscriptionInitialPrice, p.accountingInitialPrice, p.initialPrice, p.accountingAmount]
            .find((v) => v != null && v !== '' && Number.isFinite(Number(v)));
        if (order && success && paid == null) console.warn(`[Payments] ccbill webhook for order ${order.id} carried no price — not credited`);
        else if (success && payable(order, 'ccbill', paid)) (order.kind === 'subscription' ? pay.fulfillSubscriptionOrder(order) : pay.fulfillBucksOrder(order));
    } catch (err) { console.error('[Payments] ccbill webhook:', err.message); }
    res.status(200).send('OK');
});

// Crypto (NOWPayments IPN)
router.post('/webhook/crypto', webhookMovedToBilling('crypto'), (req, res) => {
    const body = pay.cryptoVerify(rawBody(req), req.headers['x-nowpayments-sig']);
    if (!body) return res.status(400).send('bad signature');
    try {
        if (['finished', 'confirmed', 'sending'].includes(String(body.payment_status))) {
            const order = db.getPaymentOrderById(parseInt(body.order_id, 10));
            const paid = String(body.price_currency || 'usd').toLowerCase() === 'usd' ? body.price_amount : null;
            if (payable(order, 'crypto', paid)) (order.kind === 'subscription' ? pay.fulfillSubscriptionOrder(order) : pay.fulfillBucksOrder(order));
        }
    } catch (err) { console.error('[Payments] crypto webhook:', err.message); }
    res.json({ received: true });
});

module.exports = router;
