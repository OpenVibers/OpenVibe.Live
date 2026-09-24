'use strict';
/**
 * Live's money actions when BILLING_AUTHORITY=billing (roadmap Wave 8, ADR-012).
 *
 * Each function is the Billing-backed twin of what vibes.js / payments-routes.js do against Live's
 * own columns, returning the SAME response shapes so the routes and the SPA do not change:
 *
 *   checkout (Buy Vibes)       → POST /intents {kind: purchase}           billing.intent.create
 *   PayPal return              → POST /intents/:id/capture                billing.intent.create
 *   donation / tip             → POST /transfers {kind: donation}         billing.transfer.create
 *   Vibes-paid media request   → POST /transfers {kind: paid_interaction} billing.transfer.create
 *   …and its refund            → POST /transfers/:id/refund               billing.transfer.create
 *   cashout request            → POST /cashouts                           billing.cashout.request
 *   recycle                    → POST /recycle                            billing.cashout.request
 *   subscribe (Vibes)          → POST /subscriptions {source: credit}     billing.subscription.manage
 *   subscribe (PowerChat/Stripe) → POST /intents {kind: subscription}     billing.intent.create
 *   cancel                     → POST /subscriptions/:id/cancel           billing.subscription.manage
 *   balance / history          → GET /balances/:s, /transactions          billing.balance.read
 *   subscriber perks, "subscribed?" → GET /entitlements/:s?streamer=      billing.entitlement.check
 *
 * Idempotency: every POST's key is derived once per Live action and kept in billing_actions
 * (live:<action>:<uuid>, or live:<action>:u<user>:c<client key> when the browser sent an
 * Idempotency-Key, or a natural key such as live:media_refund:<request id>). A retry of the same
 * action re-sends the same key and body, so Billing applies it at most once. billing_actions is a
 * request journal, not a balance: amounts in it are what Live asked for, never what anyone holds.
 */
const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');
const billing = require('./billing-client');
const { BillingCallError, subjectFor, ref, api } = billing;

let _tablesReady = false;
function ensureTables() {
    if (_tablesReady) return;
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS billing_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        live_user_id INTEGER,
        live_ref TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        http_status INTEGER,
        billing_ref TEXT,
        response_json TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_billing_actions_ref ON billing_actions(action, live_ref);
    CREATE INDEX IF NOT EXISTS idx_billing_actions_status ON billing_actions(status, created_at);`);
    _tablesReady = true;
}

const base = () => config.baseUrl.replace(/\/+$/, '');

/** The key for one Live action. */
function actionKey(action, req) {
    const client = req && typeof req.get === 'function' ? req.get('Idempotency-Key') : null;
    if (client && /^[A-Za-z0-9._-]{8,100}$/.test(client) && req.user) return `live:${action}:u${req.user.id}:c${client}`;
    return `live:${action}:${crypto.randomUUID()}`;
}

function refOf(out) {
    if (!out) return null;
    const x = out.transaction || out.cashout || out.intent || out.subscription;
    return x && x.id ? String(x.id) : null;
}

/**
 * Journal + call. Returns { out, replayed }. A key already done returns its stored answer without
 * calling Billing; a key already used with another body is refused; anything else is (re)sent.
 */
async function perform({ action, method = 'POST', path, body, key, liveUserId = null, liveRef = null, trace }) {
    ensureTables();
    const d = db.getDb();
    const requestJson = JSON.stringify(body || {});
    const row = d.prepare('SELECT * FROM billing_actions WHERE idempotency_key = ?').get(key);
    if (row) {
        if (row.request_json !== requestJson) throw new BillingCallError('refused', { status: 422, code: 'idempotency.key_reused', detail: 'that request id was already used for a different request' });
        if (row.status === 'done') return { out: JSON.parse(row.response_json || '{}'), replayed: true, actionId: row.id };
    } else {
        d.prepare(`INSERT OR IGNORE INTO billing_actions (action, idempotency_key, live_user_id, live_ref, method, path, request_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(action, key, liveUserId, liveRef, method, path, requestJson);
    }
    const id = d.prepare('SELECT id FROM billing_actions WHERE idempotency_key = ?').get(key).id;
    d.prepare('UPDATE billing_actions SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    try {
        const out = await billing.request(method, path, { body, idempotencyKey: key, trace });
        d.prepare(`UPDATE billing_actions SET status = 'done', http_status = 200, billing_ref = ?, response_json = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(refOf(out), JSON.stringify(out), id);
        return { out, replayed: !!out._replayed, actionId: id };
    } catch (err) {
        const status = err instanceof BillingCallError ? ({ unknown: 'unknown', refused: 'refused' }[err.kind] || 'failed') : 'failed';
        d.prepare('UPDATE billing_actions SET status = ?, http_status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(status, err.status || null, `${err.code || err.kind || 'error'}: ${String(err.detail || err.message).slice(0, 300)}`, id);
        if (status === 'unknown') console.warn(`[Billing] ${action} ${key}: outcome unknown (${err.detail || err.message}); resolve from /api/admin/money`);
        throw err;
    }
}

// ── Errors → Live's usual { error } shapes ───────────────────
/**
 * msgs: { insufficient: string | (details) => string, insufficientStatus, self, unavailable }.
 * Returns { status, body } or null for errors that are not Billing's.
 */
function toLive(err, msgs = {}) {
    if (!(err instanceof BillingCallError)) return null;
    switch (err.kind) {
        case 'no_subject':
            return { status: 409, body: { error: err.detail, code: 'no_subject' } };
        case 'unavailable':
            return { status: 503, body: { error: msgs.unavailable || 'Billing is unavailable right now — nothing was charged. Please try again in a moment.', code: 'billing_unavailable', unavailable: true } };
        case 'unknown':
            return { status: 504, body: { error: 'Billing did not confirm this in time. Check your balance before trying again — it may have gone through.', code: 'billing_outcome_unknown' } };
        case 'misconfigured':
            return { status: 503, body: { error: 'Payments are unavailable right now (billing service configuration). Nothing was charged.', code: 'billing_misconfigured', unavailable: true } };
        default: break;
    }
    // Billing counts Vibes in "bits"; people read Vibes.
    const detail = String(err.detail || 'Request refused').replace(/\bbits\b/g, 'Vibes');
    switch (err.code) {
        case 'billing.insufficient_funds': {
            const m = typeof msgs.insufficient === 'function' ? msgs.insufficient(err.details || {}) : (msgs.insufficient || 'Insufficient Vibes');
            return { status: msgs.insufficientStatus || 400, body: { error: m, code: 'insufficient_funds' } };
        }
        case 'billing.self_dealing': return { status: 400, body: { error: msgs.self || 'You cannot send Vibes to yourself', code: 'self_dealing' } };
        case 'billing.frozen': return { status: 503, body: { error: 'Payments, donations and cashouts are paused for maintenance. Nothing was charged — please try again later.', code: 'billing_frozen' } };
        case 'billing.provider_disabled': return { status: 403, body: { error: 'Payments are not enabled', code: 'provider_disabled' } };
        case 'billing.provider_error': return { status: 502, body: { error: 'Payment provider error. Try again.', code: 'provider_error' } };
        case 'billing.invalid_subject': return { status: 409, body: { error: 'This account is not linked to an OpenVibe account yet — sign out and back in, then try again.', code: 'no_subject' } };
        case 'idempotency.key_reused': return { status: 409, body: { error: 'That request id was already used for a different request.', code: 'idempotency_key_reused' } };
        default: break;
    }
    if (/_not_found$/.test(String(err.code || ''))) return { status: 404, body: { error: detail, code: 'not_found' } };
    return { status: err.status === 409 ? 409 : 400, body: { error: detail.charAt(0).toUpperCase() + detail.slice(1), code: String(err.code || 'refused').replace(/^billing\./, '') } };
}

/** Route helper: answers a Billing failure; returns false for anything else (the caller handles it). */
function sendError(res, err, msgs) {
    const r = toLive(err, msgs);
    if (!r) return false;
    res.status(r.status).json(r.body);
    return true;
}

// ── Donations and paid interactions ──────────────────────────
function normalizeMessage(message, max) {
    if (message === undefined || message === null || message === '') return null;
    const t = String(message).trim();
    if (!t) return null;
    if (t.length > max) throw new Error(`Text must be ${max} characters or fewer`);
    return t;
}

const streamTarget = (streamId) => (streamId ? { service: 'live', type: 'stream', id: String(streamId) } : undefined);

/** POST /api/funds/donate under Billing. Same result shape as vibes.donate() plus `balance`. */
async function donate(req, { toUserId, streamId, amount, message, goalId = null }) {
    const vibes = require('./vibes');
    const amt = vibes.normalizeBucks(amount);
    const msg = normalizeMessage(message, 300);
    const from = await subjectFor(req.user.id);
    const to = await subjectFor(toUserId, { role: 'recipient' });
    const body = { from: ref(from), to: ref(to), amount: amt, kind: 'donation', ...(streamTarget(streamId) ? { target: streamTarget(streamId) } : {}), ...(msg ? { message: msg } : {}), on_behalf_of: ref(from) };
    const { out, replayed } = await perform({ action: 'donation', path: '/transfers', body, key: actionKey('donation', req), liveUserId: req.user.id, liveRef: streamId ? `stream:${streamId}` : null, trace: req.headers });
    // The goal bar is a Live display counter (not money); a replayed request must not advance it twice.
    const goalResult = replayed ? null : vibes.applyDonationToGoal(toUserId, amt, goalId);
    return {
        success: true, amount: amt, transactionId: out.transaction ? out.transaction.id : null,
        goal: goalResult ? goalResult.goal : null, goalReached: goalResult && goalResult.reached ? goalResult.goal : null,
        balance: out.balance && Number.isFinite(out.balance.credit) ? out.balance.credit : null, replayed,
    };
}

/**
 * Media request paid in Vibes: a paid interaction to the streamer. Returns { actionId, transactionId }.
 * Keyed by the request it pays for (`live:media_charge:<request id>`, ADR-012 rule 5), and linked
 * to it from the start, so a retried charge is replayed rather than taken twice.
 */
async function chargeMedia({ userId, streamerId, streamId, cost, label, requestId }) {
    if (!requestId) throw new Error('chargeMedia needs the media request id (its idempotency key)');
    const from = await subjectFor(userId);
    const to = await subjectFor(streamerId, { role: 'recipient' });
    const body = { from: ref(from), to: ref(to), amount: cost, kind: 'paid_interaction', ...(streamTarget(streamId) ? { target: streamTarget(streamId) } : {}), message: String(label || 'Media request').slice(0, 500), on_behalf_of: ref(from) };
    const { out, actionId } = await perform({ action: 'media_charge', path: '/transfers', body, key: `live:media_charge:${requestId}`, liveUserId: userId, liveRef: `media_request:${requestId}` });
    return { actionId, transactionId: out.transaction ? out.transaction.id : null };
}

/** Tie a media charge to the request it paid for, so a refund can find the Billing transfer. */
function linkMediaCharge(actionId, requestId) {
    ensureTables();
    db.getDb().prepare("UPDATE billing_actions SET live_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND action = 'media_charge'").run(`media_request:${requestId}`, actionId);
}

/** Refund a Vibes-paid media request through Billing. Resolves the refunded amount, or 0. */
async function refundMedia(request) {
    ensureTables();
    const charge = db.getDb().prepare("SELECT * FROM billing_actions WHERE action = 'media_charge' AND live_ref = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(`media_request:${request.id}`);
    if (!charge || !charge.billing_ref) {
        console.warn(`[MediaQueue] refund of request ${request.id} skipped: no Billing charge on record for it`);
        return 0;
    }
    try {
        await perform({
            action: 'media_refund', path: `/transfers/${encodeURIComponent(charge.billing_ref)}/refund`,
            body: { amount: request.cost, reason: `Refund: ${String(request.title || 'media request').slice(0, 200)}` },
            key: `live:media_refund:${request.id}`, liveUserId: request.user_id, liveRef: `media_request:${request.id}`,
        });
        return request.cost;
    } catch (err) {
        console.warn(`[MediaQueue] Billing refund of request ${request.id} refused: ${err.code || err.kind || ''} ${err.detail || err.message}`);
        return 0;
    }
}

// ── Cashouts and recycling ───────────────────────────────────
async function requestCashout(req, { amount, paypalEmail }) {
    const vibes = require('./vibes');
    const amt = vibes.normalizeBucks(amount);
    const email = String(paypalEmail || '').trim();
    if (!email) throw new Error('PayPal email required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Invalid PayPal email');
    const sid = await subjectFor(req.user.id);
    const body = { subject: ref(sid), amount: amt, payout_method: { type: 'paypal', address: email }, on_behalf_of: ref(sid) };
    const { out } = await perform({ action: 'cashout', path: '/cashouts', body, key: actionKey('cashout', req), liveUserId: req.user.id, trace: req.headers });
    const c = out.cashout || {};
    const holdMs = c.escrow_until ? Date.parse(c.escrow_until) - Date.now() : NaN;
    return {
        transaction_id: c.id, amount: c.amount_bits, usd_value: ((c.value_cents || 0) / 100).toFixed(2), status: 'escrow',
        hold_days: Number.isFinite(holdMs) ? Math.max(0, Math.round(holdMs / 86_400_000)) : config.openvibeBucks.escrowDays,
        escrow_until: c.escrow_until || null,
    };
}

async function recycle(req, amount) {
    const vibes = require('./vibes');
    const amt = vibes.normalizeBucks(amount);
    const sid = await subjectFor(req.user.id);
    const { out } = await perform({ action: 'recycle', path: '/recycle', body: { subject: ref(sid), amount: amt, on_behalf_of: ref(sid) }, key: actionKey('recycle', req), liveUserId: req.user.id, trace: req.headers });
    const b = out.balance || {};
    return { success: true, amount: amt, balance: b.credit, cashout_balance: b.payable };
}

// ── Reads ────────────────────────────────────────────────────
/** GET /api/funds/balance shape. Throws BillingCallError when Billing cannot answer. */
async function balance(liveUserId, trace) {
    const sid = await subjectFor(liveUserId);
    const b = await api.balance(sid, { trace });
    const per = Number(b.bits_per_usd) || 100;
    const usd = (n) => (Math.round(Number(n) || 0) / per).toFixed(2);
    return {
        balance: b.credit, usd_value: usd(b.credit),
        cashout_balance: b.payable, cashout_usd_value: usd(b.payable),
        pending_payouts: b.pending_payouts, authority: 'billing',
    };
}

const LIVE_TYPE = { cashout_request: 'cashout', cashout_denied: 'refund', cashout_paid: 'cashout_paid' };
/** GET /api/funds/history rows in Live's transaction shape (the dashboard renders these). */
async function history(liveUserId, limit = 50) {
    const sid = await subjectFor(liveUserId);
    const page = await api.transactions(sid, { limit: Math.min(200, Math.max(1, limit)) });
    const txns = page.transactions || [];
    const people = billing.liveUsersForSubjects(txns.flatMap((t) => [t.from_subject, t.to_subject]));
    return txns.map((t) => {
        const m = t.metadata || {};
        const mine = (t.entries || []).filter((e) => e.account && e.account.owner === sid && e.account.currency === 'vibes-bits');
        const amount = m.amount_bits ?? m.cost_bits ?? m.share_bits ?? m.bits ?? mine.reduce((a, e) => Math.max(a, Math.abs(e.amount)), 0);
        const from = people.get(t.from_subject);
        const to = people.get(t.to_subject);
        return {
            id: t.id, type: LIVE_TYPE[t.type] || t.type, status: t.status, amount, created_at: t.created_at,
            message: m.message || null,
            from_user_id: from ? from.id : (t.from_subject === sid ? liveUserId : null), to_user_id: to ? to.id : (t.to_subject === sid ? liveUserId : null),
            from_username: from ? from.username : null, from_display: from ? from.display_name : null,
            to_username: to ? to.username : null, to_display: to ? to.display_name : null,
        };
    });
}

// ── Checkout (Buy Vibes) ─────────────────────────────────────
const PROVIDER = { crypto: 'nowpayments' };

async function checkout(req, { provider, bucks }) {
    const sid = await subjectFor(req.user.id);
    const pc = provider === 'powerchat' ? require('../integrations/powerchat-checkout') : null;
    if (pc && !pc.isAvailable()) return { status: 400, body: { error: 'PowerChat purchases are not available right now' } };
    const body = {
        provider: PROVIDER[provider] || provider, kind: 'purchase', subject: ref(sid), bits: bucks,
        success_url: provider === 'paypal' ? `${base()}/api/payments/paypal/return` : `${base()}/?purchase=success`,
        cancel_url: `${base()}/?purchase=cancel`, on_behalf_of: ref(sid),
    };
    const { out } = await perform({ action: 'checkout', path: '/intents', body, key: actionKey('checkout', req), liveUserId: req.user.id, trace: req.headers });
    const intent = out.intent || {};
    const amountUsd = (intent.amount_cents || 0) / 100;
    if (pc) {
        const link = await pc.buildBillingPurchaseLink(intent);
        if (!link) return { status: 400, body: { error: 'PowerChat purchases are not available right now' } };
        return {
            status: 200,
            body: {
                url: link.url, powerchat: true, amountUsd, pinned: !!link.minted, expires_at: link.expiresAt || null,
                note: `Complete the $${amountUsd.toFixed(2)} tip on PowerChat — your Vibes are credited automatically once it confirms.`,
            },
        };
    }
    if (!out.checkout_url) return { status: 502, body: { error: 'Payment provider error. Try again.' } };
    return { status: 200, body: { url: out.checkout_url } };
}

/** PayPal sends the buyer back with ?token=<PayPal order id>: capture that intent through Billing. */
async function paypalReturn(token) {
    ensureTables();
    const row = db.getDb().prepare(`SELECT * FROM billing_actions WHERE action IN ('checkout', 'subscribe_intent') AND status = 'done'
        AND json_extract(response_json, '$.intent.provider') = 'paypal' AND json_extract(response_json, '$.intent.provider_ref') = ? ORDER BY id DESC LIMIT 1`).get(String(token || ''));
    if (!row) return false;
    const intentId = JSON.parse(row.response_json).intent.id;
    const { out } = await perform({ action: 'paypal_capture', path: `/intents/${encodeURIComponent(intentId)}/capture`, body: {}, key: `live:paypal_capture:${intentId}`, liveUserId: row.live_user_id });
    return !!(out.intent && out.intent.status === 'settled');
}

// ── Subscriptions and entitlements ───────────────────────────
// VIP first (roadmap W10, proof flow 3): whether a member is subscribed to a creator, for showing it
// and for gates, is OpenVibe.VIP's entitlement answer (its projection of Billing's entitlements,
// through openvibe-sdk/vip with Live's service token, vip.entitlement.check). Billing's own answer
// stands in only when VIP cannot say (unknown, unreachable, no token), and a purchase decision
// (subscribe) always asks Billing. LIVE_VIP_ENTITLEMENTS=off asks Billing only.
let _vip = null;
function vipClient() {
    if (_vip) return _vip;
    const principal = require('../net/network-principal');
    const { createVipClient } = require('openvibe-sdk/vip');
    _vip = createVipClient({
        baseUrl: process.env.OV_VIP_INTERNAL_URL || 'http://127.0.0.1:4620',
        tokenClient: { authHeaders: () => principal.serviceHeaders('openvibe.vip'), invalidate: () => principal.invalidate('openvibe.vip') },
        timeoutMs: 2000,
    });
    return _vip;
}
async function entitlementOf(member, creator) {
    if (process.env.LIVE_VIP_ENTITLEMENTS !== 'off') {
        const e = await vipClient().checkEntitlement({ subject: member, creator, product: 'live' });
        if (e && e.status !== 'unknown') return { active: !!e.active, via: 'vip' };
    }
    const e = await api.entitlement(member, creator);
    return { active: !!(e && e.active), via: 'billing' };
}

function viewerOrNull(fn) { return fn().catch((e) => { if (e instanceof BillingCallError && e.kind === 'no_subject') return null; throw e; }); }

async function subscribe(req, { streamer, provider, autoRenewRaw }) {
    const subscriber = await subjectFor(req.user.id);
    const to = await subjectFor(streamer.id, { role: 'recipient' });
    const ent = await api.entitlement(subscriber, to, { trace: req.headers });
    if (ent && ent.active) return { status: 409, body: { error: 'Already subscribed' } };

    if (provider === 'bucks') {
        const autoRenew = autoRenewRaw === undefined ? true : !!autoRenewRaw;
        const body = { subscriber: ref(subscriber), streamer: ref(to), source: 'credit', auto_renew: autoRenew, on_behalf_of: ref(subscriber) };
        const { out, replayed } = await perform({ action: 'subscribe', path: '/subscriptions', body, key: actionKey('subscribe', req), liveUserId: req.user.id, liveRef: `streamer:${streamer.id}`, trace: req.headers });
        const sub = out.subscription || {};
        if (!replayed) {
            // Sub alert on the streamer's PowerChat overlay, keyed by the Billing transaction.
            try {
                require('../integrations/powerchat-platform').forwardSubscription(streamer.id, {
                    subscriberName: req.user.display_name || req.user.username || 'Someone',
                    externalId: `sub-billing:${out.transaction ? out.transaction.id : sub.id}`, tier: '1',
                    isResub: !!(out.transaction && out.transaction.metadata && out.transaction.metadata.renewal),
                });
            } catch { /* non-critical */ }
        }
        invalidateEntitlement(req.user.id, streamer.id);
        return { status: 200, body: { ok: true, subscription: { streamer: streamer.username, current_period_end: sub.current_period_end, auto_renew: !!sub.auto_renew } } };
    }

    const viaPowerchat = provider === 'powerchat' || provider === 'powerchat_site';
    if (viaPowerchat) {
        const checkout = require('../integrations/powerchat-checkout');
        const routes = checkout.subscribeRoutes(streamer.id);
        const wantSite = provider === 'powerchat_site' || !routes.direct;
        if (wantSite && !routes.site) return { status: 400, body: { error: 'PowerChat payments are not available right now' } };
        const body = { provider: 'powerchat', kind: 'subscription', subject: ref(subscriber), streamer: ref(to), route: wantSite ? 'site' : 'direct', auto_renew: !!autoRenewRaw, on_behalf_of: ref(subscriber) };
        const { out } = await perform({ action: 'subscribe_intent', path: '/intents', body, key: actionKey('subscribe_intent', req), liveUserId: req.user.id, liveRef: `streamer:${streamer.id}`, trace: req.headers });
        const intent = out.intent || {};
        const link = await checkout.buildBillingSubscribeLink(intent, streamer.id);
        if (!link) return { status: 400, body: { error: 'PowerChat payments are not available right now' } };
        const totalUsd = (intent.amount_cents || 0) / 100;
        const feeUsd = (intent.fee_cents || 0) / 100;
        return {
            status: 200,
            body: {
                url: link.url, powerchat: true, route: link.mode, amountUsd: totalUsd, feeUsd, pinned: !!link.minted, expires_at: link.expiresAt || null,
                note: link.mode === 'direct'
                    ? `Tip $${totalUsd.toFixed(2)} on ${streamer.display_name || streamer.username}'s PowerChat — your subscription activates automatically once the tip confirms.`
                    : `Tip $${totalUsd.toFixed(2)} on OpenVibe's PowerChat (includes a $${feeUsd.toFixed(2)} platform fee) — your subscription activates automatically once the tip confirms.`,
            },
        };
    }

    if (provider === 'stripe') {
        const body = {
            provider, kind: 'subscription', subject: ref(subscriber), streamer: ref(to), auto_renew: true,
            success_url: `${base()}/@${streamer.username}?sub=success`,
            cancel_url: `${base()}/@${streamer.username}?sub=cancel`, on_behalf_of: ref(subscriber),
        };
        const { out } = await perform({ action: 'subscribe_intent', path: '/intents', body, key: actionKey('subscribe_intent', req), liveUserId: req.user.id, liveRef: `streamer:${streamer.id}`, trace: req.headers });
        if (!out.checkout_url) return { status: 502, body: { error: 'Payment provider error. Try again.' } };
        return { status: 200, body: { url: out.checkout_url } };
    }
    return { status: 400, body: { error: 'Subscriptions support Stripe or Vibes' } };
}

function presentSub(s, people) {
    const st = people.get(s.streamer && s.streamer.id);
    return {
        id: s.id, streamer_id: st ? st.id : null, streamer_username: st ? st.username : null,
        streamer_display: st ? st.display_name : null, streamer_avatar: st ? st.avatar_url : null,
        tier: s.tier, provider: s.provider, status: s.status, auto_renew: s.auto_renew ? 1 : 0,
        cancel_at_period_end: s.cancel_at_period_end ? 1 : 0, price_cents: s.price_cents,
        current_period_end: s.current_period_end, started_at: s.created_at,
    };
}

async function mySubscriptions(liveUserId) {
    const sid = await subjectFor(liveUserId);
    const out = await api.listSubscriptions({ subscriber: sid });
    const subs = out.subscriptions || [];
    const people = billing.liveUsersForSubjects(subs.map((s) => s.streamer && s.streamer.id));
    return subs.map((s) => presentSub(s, people));
}

/** { subscribed, subscriberCount } for the channel page. */
async function channelState(streamer, viewer) {
    const to = await viewerOrNull(() => subjectFor(streamer.id, { role: 'recipient' }));
    if (!to) return { subscribed: false, subscriberCount: 0 };
    const me = viewer ? await viewerOrNull(() => subjectFor(viewer.id)) : null;
    const [ent, list] = await Promise.all([
        me ? entitlementOf(me, to) : Promise.resolve(null),
        api.listSubscriptions({ streamer: to, status: 'active' }),
    ]);
    const now = Date.now();
    const count = (list.subscriptions || []).filter((s) => !s.current_period_end || Date.parse(s.current_period_end) > now).length;
    return { subscribed: !!(ent && ent.active), subscriberCount: count };
}

async function cancelSubscription(req, { id, streamerId }) {
    const sid = await subjectFor(req.user.id);
    const out = await api.listSubscriptions({ subscriber: sid }, { trace: req.headers });
    const subs = (out.subscriptions || []).filter((s) => s.subscriber && s.subscriber.id === sid);
    let sub = subs.find((s) => String(s.id) === String(id));
    if (!sub && streamerId) {
        const st = await viewerOrNull(() => subjectFor(streamerId, { role: 'recipient' }));
        sub = st ? subs.find((s) => s.streamer && s.streamer.id === st && s.status === 'active') : null;
    }
    if (!sub) return { status: 404, body: { error: 'Subscription not found' } };
    if (sub.status !== 'active' || sub.cancel_at_period_end) return { status: 200, body: { ok: true } };
    await perform({
        action: 'sub_cancel', path: `/subscriptions/${encodeURIComponent(sub.id)}/cancel`, body: { on_behalf_of: ref(sid) },
        key: `live:sub_cancel:${sub.id}:${sub.current_period_end || 'open'}`, liveUserId: req.user.id, trace: req.headers,
    });
    return { status: 200, body: { ok: true } };
}

// Subscriber perks (the sub badge sent to PowerChat's overlay, the AI's "subscriber" flag) are read
// synchronously on hot paths, so they come from a short-lived cache refreshed from Billing's
// entitlement check. The cache is a display aid, not authorization: an entry is trusted for 60 s,
// served stale at most 10 min while a refresh runs, and unknown means "not a subscriber".
const ENT_FRESH_MS = 60 * 1000;
const ENT_MAX_STALE_MS = 10 * 60 * 1000;
const _ent = new Map();       // "sub:streamer" -> { active, at }
const _entInflight = new Map();
function invalidateEntitlement(subscriberId, streamerId) { _ent.delete(`${subscriberId}:${streamerId}`); }
function refreshEntitlement(subscriberId, streamerId) {
    const k = `${subscriberId}:${streamerId}`;
    if (_entInflight.has(k)) return _entInflight.get(k);
    const p = (async () => {
        try {
            const [a, b] = await Promise.all([subjectFor(subscriberId), subjectFor(streamerId, { role: 'recipient' })]);
            const e = await entitlementOf(a, b);
            _ent.set(k, { active: !!(e && e.active), at: Date.now() });
        } catch (err) {
            if (err instanceof BillingCallError && err.kind === 'no_subject') _ent.set(k, { active: false, at: Date.now() });
        } finally { _entInflight.delete(k); }
        return _ent.has(k) ? _ent.get(k).active : false;
    })();
    _entInflight.set(k, p);
    return p;
}
function isSubscriberCached(subscriberId, streamerId) {
    if (!subscriberId || !streamerId) return false;
    const hit = _ent.get(`${subscriberId}:${streamerId}`);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (age >= ENT_FRESH_MS) refreshEntitlement(subscriberId, streamerId).catch(() => {});
    return !!(hit && age < ENT_MAX_STALE_MS && hit.active);
}

// ── Operator view ────────────────────────────────────────────
async function adminStatus() {
    ensureTables();
    const d = db.getDb();
    const counts = Object.fromEntries(d.prepare('SELECT status, COUNT(*) AS n FROM billing_actions GROUP BY status').all().map((r) => [r.status, r.n]));
    const attention = d.prepare("SELECT id, action, idempotency_key, live_user_id, live_ref, status, error, attempts, created_at, updated_at FROM billing_actions WHERE status IN ('unknown', 'pending') ORDER BY id DESC LIMIT 50").all();
    let reachable = null;
    try { reachable = (await api.ready()).ok; } catch { reachable = false; }
    let rates = null;
    try {
        const r = await api.rates();
        const pay = require('./payments');
        const live = {
            bits_per_usd: pay._num('bucks_per_usd', 100), min_purchase_bits: pay._num('bucks_min_purchase_bucks', 100),
            sub_price_cents: Math.round(pay._num('sub_price_usd', 4.99) * 100), streamer_share_pct: pay._num('sub_streamer_share_pct', 70),
            site_route_fee_pct: pay._num('sub_site_route_fee_pct', 10), min_cashout_bits: config.openvibeBucks.minCashoutBucks, escrow_days: config.openvibeBucks.escrowDays,
        };
        const billingSide = {
            bits_per_usd: r.bits_per_usd, min_purchase_bits: r.min_purchase_bits, sub_price_cents: r.subscription && r.subscription.price_cents,
            streamer_share_pct: r.subscription && r.subscription.streamer_share_pct, site_route_fee_pct: r.subscription && r.subscription.site_route_fee_pct,
            min_cashout_bits: r.cashout && r.cashout.min_bits, escrow_days: r.cashout && r.cashout.escrow_days,
        };
        const drift = Object.keys(live).filter((k) => Number(live[k]) !== Number(billingSide[k])).map((k) => ({ rate: k, live: live[k], billing: billingSide[k] }));
        rates = { providers: r.providers || null, drift };
    } catch (err) { rates = { error: err.detail || err.message }; }
    return { internal_url: billing.baseUrl(), webhook_url: `${billing.publicUrl()}/webhooks/powerchat`, reachable, rates, actions: { counts, attention } };
}

/** Owner: re-send an action whose outcome is unknown (same key, same body) to learn it. */
async function resolveAction(id) {
    ensureTables();
    const row = db.getDb().prepare('SELECT * FROM billing_actions WHERE id = ?').get(id);
    if (!row) return { status: 404, body: { error: 'No such action' } };
    if (row.status === 'done') return { status: 200, body: { action: row.action, status: 'done', billing_ref: row.billing_ref } };
    const { out } = await perform({ action: row.action, method: row.method, path: row.path, body: JSON.parse(row.request_json), key: row.idempotency_key, liveUserId: row.live_user_id, liveRef: row.live_ref });
    return { status: 200, body: { action: row.action, status: 'done', billing_ref: refOf(out) } };
}

module.exports = {
    ensureTables, actionKey, perform, toLive, sendError,
    donate, chargeMedia, linkMediaCharge, refundMedia, requestCashout, recycle, balance, history,
    checkout, paypalReturn, subscribe, mySubscriptions, channelState, cancelSubscription,
    isSubscriberCached, refreshEntitlement, invalidateEntitlement, adminStatus, resolveAction,
    entitlementOf,
    _reset() { _ent.clear(); _entInflight.clear(); _tablesReady = false; _vip = null; },
};
