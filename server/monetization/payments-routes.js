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

const router = express.Router();
function base() { return config.baseUrl.replace(/\/+$/, ''); }

// ── Public config (which providers are live + pricing) ───────
router.get('/config', (req, res) => {
    res.json(pay.publicConfig());
});

// ── Buy Vibes ───────────────────────────────────────────
router.post('/bucks/checkout', requireAuth, async (req, res) => {
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
            // price (app_amount_cents locks the tip page's amount picker) and the
            // donation.completed webhook credits the buyer once it confirms.
            const link = require('../integrations/powerchat-checkout').buildPurchaseLink(order);
            if (!link) { db.updatePaymentOrder(order.id, { status: 'failed' }); return res.status(400).json({ error: 'PowerChat purchases are not available right now' }); }
            return res.json({
                url: link.url, powerchat: true, amountUsd,
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
    try {
        const order = db.getPaymentOrderById(parseInt(req.query.order, 10));
        if (!order) return res.redirect('/?purchase=error');
        const cap = await pay.paypalCaptureOrder(order.provider_ref);
        const ok = cap.status === 'COMPLETED';
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
router.post('/subscribe', requireAuth, async (req, res) => {
    if (!pay.isEnabled()) return res.status(403).json({ error: 'Payments are not enabled' });
    const provider = String(req.body.provider || '').toLowerCase();
    const streamer = db.getUserByUsername(String(req.body.streamer || ''));
    if (!streamer) return res.status(404).json({ error: 'Streamer not found' });
    if (streamer.id === req.user.id) return res.status(400).json({ error: 'You cannot subscribe to yourself' });
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
    if (provider === 'powerchat') {
        const autoRenew = req.body.auto_renew ? 1 : 0;
        const order = db.createPaymentOrder({
            user_id: req.user.id, provider: 'powerchat', kind: 'subscription',
            amount_cents: amountCents, streamer_id: streamer.id,
        });
        const link = require('../integrations/powerchat-checkout').buildSubscribeLink(order, streamer.id, { autoRenew });
        if (!link) { db.updatePaymentOrder(order.id, { status: 'failed' }); return res.status(400).json({ error: 'PowerChat payments are not available right now' }); }
        return res.json({
            url: link.url, powerchat: true, amountUsd: priceUsd,
            note: `Tip $${priceUsd.toFixed(2)} on PowerChat — your subscription activates automatically once the tip confirms.`,
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
router.get('/subscriptions/mine', requireAuth, (req, res) => {
    res.json({ subscriptions: db.getSubscriptionsBySubscriber(req.user.id) });
});

// Am I subscribed to this channel? + subscriber count
router.get('/channel/:username', optionalAuth, (req, res) => {
    const streamer = db.getUserByUsername(req.params.username);
    if (!streamer) return res.status(404).json({ error: 'Not found' });
    const subscribed = req.user ? db.isActiveSubscriber(req.user.id, streamer.id) : false;
    res.json({ subscribed, subscriberCount: db.getActiveSubscriberCount(streamer.id), priceUsd: pay._num('sub_price_usd', 4.99) });
});

// Cancel a subscription (Stripe: at period end; bucks: immediate)
router.post('/subscriptions/:id/cancel', requireAuth, async (req, res) => {
    const sub = db.getActiveSubscription(req.user.id, parseInt(req.body.streamerId, 10)) ||
        (db.getSubscriptionsBySubscriber(req.user.id) || []).find(x => String(x.id) === String(req.params.id));
    if (!sub || sub.subscriber_id !== req.user.id) return res.status(404).json({ error: 'Subscription not found' });
    // Stripe subs auto-renew; mark cancel-at-period-end (provider stops billing via dashboard/API).
    db.setSubscriptionStatus(sub.id, sub.provider === 'stripe' ? 'active' : 'canceled', { cancel_at_period_end: true, current_period_end: sub.current_period_end });
    res.json({ ok: true });
});

// ════════════════════════ WEBHOOKS ════════════════════════════
function rawBody(req) { return req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}); }

// Stripe
router.post('/webhook/stripe', (req, res) => {
    const event = pay.stripeVerify(rawBody(req), req.headers['stripe-signature']);
    if (!event) return res.status(400).send('bad signature');
    try {
        const obj = event.data && event.data.object;
        const orderId = obj && ((obj.metadata && obj.metadata.order_id) || obj.client_reference_id);
        if (event.type === 'checkout.session.completed' && orderId) {
            const order = db.getPaymentOrderById(parseInt(orderId, 10));
            if (order) {
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
router.post('/webhook/paypal', async (req, res) => {
    try {
        const ok = await pay.paypalVerify(req.headers, rawBody(req));
        if (!ok) return res.status(400).send('unverified');
        const event = req.body;
        const rsrc = event.resource || {};
        if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
            const orderId = rsrc.custom_id || (rsrc.supplementary_data && rsrc.supplementary_data.related_ids && rsrc.supplementary_data.related_ids.order_id);
            const order = orderId && db.getPaymentOrderById(parseInt(orderId, 10));
            if (order) (order.kind === 'subscription' ? pay.fulfillSubscriptionOrder(order) : pay.fulfillBucksOrder(order));
        }
    } catch (err) { console.error('[Payments] paypal webhook:', err.message); }
    res.json({ received: true });
});

// CCBill (FlexForms datalink / webhook). Verified via shared secret in query.
router.all('/webhook/ccbill', (req, res) => {
    if (!pay.ccbillVerify(req.query)) return res.status(403).send('forbidden');
    try {
        const p = { ...req.query, ...req.body };
        const orderId = p['X-order'] || p.order;
        const order = orderId && db.getPaymentOrderById(parseInt(orderId, 10));
        const success = String(p.eventType || p.transactionType || '').toLowerCase().includes('success')
            || p.accountingAmount || p.priceInfo || p.eventType === 'NewSaleSuccess';
        if (order && success) (order.kind === 'subscription' ? pay.fulfillSubscriptionOrder(order) : pay.fulfillBucksOrder(order));
    } catch (err) { console.error('[Payments] ccbill webhook:', err.message); }
    res.status(200).send('OK');
});

// Crypto (NOWPayments IPN)
router.post('/webhook/crypto', (req, res) => {
    const body = pay.cryptoVerify(rawBody(req), req.headers['x-nowpayments-sig']);
    if (!body) return res.status(400).send('bad signature');
    try {
        if (['finished', 'confirmed', 'sending'].includes(String(body.payment_status))) {
            const order = db.getPaymentOrderById(parseInt(body.order_id, 10));
            if (order) (order.kind === 'subscription' ? pay.fulfillSubscriptionOrder(order) : pay.fulfillBucksOrder(order));
        }
    } catch (err) { console.error('[Payments] crypto webhook:', err.message); }
    res.json({ received: true });
});

module.exports = router;
