/**
 * OpenVibe.Live — Monetization API Routes
 * 
 * POST   /api/funds/purchase       - Buy Vibes
 * POST   /api/funds/donate         - Donate to a streamer
 * POST   /api/funds/cashout        - Request cashout
 * GET    /api/funds/balance         - Get user balance
 * GET    /api/funds/history         - Get transaction history
 * GET    /api/funds/leaderboard/:id - Get stream donation leaderboard
 * POST   /api/funds/goals          - Create a donation goal
 * GET    /api/funds/goals/:userId  - Get user's donation goals
 */
const express = require('express');
const { requireAuth, requireAdmin } = require('../auth/auth');
const { requireOwner } = require('../auth/permissions');
const openvibeBucks = require('./vibes');
const db = require('../db/database');
const delivery = require('../chat/chat-delivery');
// BILLING_AUTHORITY=billing: every money action below goes to OpenVibe.Billing instead of Live's
// columns (billing-actions.js); money_writes_frozen refuses them in both modes.
const money = require('./money-authority');
const billingActions = require('./billing-actions');
const cashoutsInBilling = (res) => res.status(409).json({
    error: 'Cashouts are decided in OpenVibe.Billing now: approving or denying a payout needs its operator API (billing.cashout.manage) and the PayPal payout reference.',
    code: 'cashouts_in_billing',
});

const router = express.Router();

// ── Buy Vibes ───────────────────────────────────────────
/**
 * DISABLED — this route credited Vibes with no payment verification whatsoever.
 *
 * It took an `amount` and a `paypal_transaction_id` from the request body, never checked the
 * transaction against PayPal, and called purchase() directly. The comment in its place read
 * "In production, validate PayPal transaction here". Any signed-in account could mint up to the
 * balance ceiling for free and then move it somewhere spendable.
 *
 * Real purchases are credited by the verified payment webhooks (fulfillBucksOrder), which check a
 * signature and an order record. Returning 410 rather than deleting the route so an old client
 * calling it gets a clear answer instead of a 404 that looks like a routing bug.
 */
router.post('/purchase', (req, res) => {
    res.status(410).json({
        error: 'Direct purchase is disabled. Vibes are credited by the payment provider webhook.',
    });
});

// Serialize a goal for the client (no private fields to leak).
function publicGoal(g) {
    if (!g) return null;
    return {
        id: g.id, user_id: g.user_id, title: g.title,
        target_amount: g.target_amount, current_amount: g.current_amount,
        is_active: g.is_active, reached_at: g.reached_at || null,
        image_url: g.image_url || null, media_type: g.media_type || null,
        sort_order: g.sort_order || 0,
    };
}

// ── Donate to Streamer ───────────────────────────────────────
router.post('/donate', requireAuth, money.guardWrite, async (req, res) => {
    try {
        let { streamer_id, stream_id, amount, message, goal_id } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid donation' });
        }

        // Resolve streamer_id from the stream record if not provided
        if (!streamer_id && stream_id) {
            const stream = await db.getStreamById(stream_id);
            if (stream) streamer_id = stream.user_id;
        }
        if (!streamer_id) {
            return res.status(400).json({ error: 'Could not determine streamer' });
        }
        streamer_id = Number(streamer_id);
        // Donating to yourself turns bought (spendable) Vibes into received (cash-out-able) Vibes.
        if (streamer_id === req.user.id) return res.status(400).json({ error: 'You cannot donate to yourself' });
        if (stream_id) {
            const s = await db.getStreamById(stream_id);
            if (!s || s.user_id !== streamer_id) return res.status(400).json({ error: 'That stream does not belong to this streamer' });
        }

        const result = money.onBilling()
            ? await billingActions.donate(req, { toUserId: streamer_id, streamId: stream_id, amount, message, goalId: goal_id || null })
            : await openvibeBucks.donate(req.user.id, streamer_id, stream_id, amount, message, goal_id || null);
        // A request the browser repeated with the same Idempotency-Key: already celebrated.
        if (result.replayed) return res.json({ success: true, amount: result.amount, balance: result.balance, goal_reached: false });

        const alerts = require('./alerts');
        const donorUser = await db.getUserById(req.user.id);
        const donor = donorUser?.display_name || donorUser?.username || 'Someone';

        // 1) Donation chat message — Chat persists it to channel history so late-joiners see
        //    it, and mirrors it into global chat.
        const donationLine = {
            stream_id: stream_id || null, channel_user_id: streamer_id, user_id: req.user.id,
            username: donor,
            message: `${donor} donated ${result.amount.toLocaleString()} Vibes${message ? ': ' + message : ''}`,
            message_type: 'donation',
            metadata: { kind: 'donation', amount: result.amount, message: message || '', username: donor, user_id: req.user.id, avatar_url: donorUser?.avatar_url || null },
        };
        // Chat persists the line and shows it in the channel and (mirror) global chat in one call.
        delivery.message({ ...donationLine, mirror: true, key: result.transactionId ? `donation:${result.transactionId}` : undefined });

        // 2) Donation sound (streamer-configured).
        await alerts.playAlertSound(streamer_id, stream_id, 'donation');

        // Mirror the donation onto the streamer's PowerChat overlay as a monetary tip
        // (tips:write). Vibes ARE the declared currency units (100 = $1); PowerChat
        // converts server-side. externalId is the ledger id, so a retry can't double-alert.
        // The webhook echo of this event (source=developer_app) is deliberately ignored.
        try {
            await require('../integrations/powerchat-platform').forwardTip(streamer_id, {
                amount: result.amount,
                tipperName: donor,
                message: message || '',
                externalId: result.transactionId ? `donation:${result.transactionId}` : undefined,
            });
        } catch { /* non-critical */ }

        // 3) Live goal progress → widget.
        if (result.goal) {
            await delivery.event({ kind: 'channel', id: streamer_id, stream: stream_id || null }, { type: 'goal-update', goal: publicGoal(result.goal) });
        }

        // 4) Goal reached → flashy animated chat event (persisted) + goal sound.
        if (result.goalReached) {
            const g = result.goalReached;
            const goalLine = {
                stream_id: stream_id || null, channel_user_id: streamer_id, user_id: null,
                username: 'Donation Goal',
                message: `🎉 Goal reached: ${g.title} (${(g.target_amount || 0).toLocaleString()} Vibes)`,
                message_type: 'donation',
                metadata: { kind: 'goal-reached', goal_id: g.id, title: g.title, target: g.target_amount, image: g.image_url || null, media_type: g.media_type || null, by: donor },
            };
            delivery.message({ ...goalLine, key: result.transactionId ? `goal:${result.transactionId}` : undefined });
            await alerts.playAlertSound(streamer_id, stream_id, 'goal');
        }

        const balance = money.onBilling() ? result.balance : (await db.getUserById(req.user.id)).openvibe_bucks_balance;
        res.json({ success: true, amount: result.amount, balance, goal_reached: !!result.goalReached });
    } catch (err) {
        if (billingActions.sendError(res, err, { insufficient: 'Insufficient Vibes', self: 'You cannot donate to yourself' })) return;
        res.status(400).json({ error: err.message });
    }
});

// ── Request Cashout ──────────────────────────────────────────
router.post('/cashout', requireAuth, money.guardWrite, async (req, res) => {
    try {
        const { amount, paypal_email } = req.body;
        if (!amount || !paypal_email) {
            return res.status(400).json({ error: 'Amount and PayPal email required' });
        }

        const result = money.onBilling()
            ? await billingActions.requestCashout(req, { amount, paypalEmail: paypal_email })
            : await openvibeBucks.requestCashout(req.user.id, amount, paypal_email);
        res.json(result);
    } catch (err) {
        if (billingActions.sendError(res, err, { insufficient: 'Insufficient cashout balance — only Vibes sent to you can be cashed out' })) return;
        res.status(400).json({ error: err.message });
    }
});

// ── Get Balance ──────────────────────────────────────────────
router.get('/balance', requireAuth, async (req, res) => {
    if (money.onBilling()) {
        // Billing is the only truth: when it cannot answer, the balance is "unavailable" — never
        // the frozen legacy column.
        try { return res.json(await billingActions.balance(req.user.id, req.headers)); }
        catch (err) {
            if (billingActions.sendError(res, err, { unavailable: 'Vibes balance unavailable right now — the billing service is not answering.' })) return;
            return res.status(503).json({ error: 'Vibes balance unavailable right now', unavailable: true });
        }
    }
    const user = await db.getUserById(req.user.id);
    const bal = Math.round(user.openvibe_bucks_balance || 0);
    const cashout = Math.round(user.openvibe_bucks_cashout_balance || 0);
    res.json({
        // Integer Vibes; USD is the streamer cashout value (100 bucks = $1).
        balance: bal,
        usd_value: openvibeBucks.cashoutUsd(bal).toFixed(2),
        cashout_balance: cashout,
        cashout_usd_value: openvibeBucks.cashoutUsd(cashout).toFixed(2),
    });
});

// ── Recycle cashout balance → spendable Vibes ───────────
router.post('/recycle', requireAuth, money.guardWrite, async (req, res) => {
    try {
        const result = money.onBilling()
            ? await billingActions.recycle(req, req.body.amount)
            : await openvibeBucks.recycleCashout(req.user.id, req.body.amount);
        res.json(result);
    } catch (err) {
        if (billingActions.sendError(res, err, { insufficient: 'Insufficient cashout balance' })) return;
        res.status(400).json({ error: err.message });
    }
});

// ── Transaction History ──────────────────────────────────────
router.get('/history', requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    if (money.onBilling()) {
        try { return res.json({ transactions: await billingActions.history(req.user.id, limit) }); }
        catch (err) {
            if (billingActions.sendError(res, err, { unavailable: 'Vibes history unavailable right now — the billing service is not answering.' })) return;
            return res.status(503).json({ error: 'Vibes history unavailable right now', unavailable: true });
        }
    }
    const history = await openvibeBucks.getHistory(req.user.id, limit);
    res.json({ transactions: history });
});

// ── Stream Donation Leaderboard ──────────────────────────────
router.get('/leaderboard/:streamId', async (req, res) => {
    const leaderboard = await openvibeBucks.getLeaderboard(req.params.streamId);
    res.json({ leaderboard });
});

// ── Manage own goals (dashboard) — all goals incl. completed ──
router.get('/goals/manage/mine', requireAuth, async (req, res) => {
    res.json({ goals: (await openvibeBucks.getManageGoals(req.user.id)).map(publicGoal) });
});

// ── Create Donation Goal ─────────────────────────────────────
router.post('/goals', requireAuth, async (req, res) => {
    try {
        const { title, target_amount, image_url, media_type } = req.body;
        if (!title || !target_amount) {
            return res.status(400).json({ error: 'Title and target amount required' });
        }
        await openvibeBucks.createGoal(req.user.id, { title, target_amount, image_url, media_type });
        res.status(201).json({ goals: (await openvibeBucks.getManageGoals(req.user.id)).map(publicGoal) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Update a Donation Goal ───────────────────────────────────
router.put('/goals/:id', requireAuth, async (req, res) => {
    try {
        const g = await openvibeBucks.updateGoal(parseInt(req.params.id, 10), req.user.id, req.body);
        // A manual progress correction should show up on open goal widgets right away,
        // same as a donation does (a plain goal-update — no celebration).
        if (req.body.current_amount !== undefined && g) {
            try {
                await delivery.event({ kind: 'channel', id: req.user.id }, { type: 'goal-update', goal: publicGoal(g) });
            } catch { /* live update is best-effort */ }
        }
        res.json({ goals: (await openvibeBucks.getManageGoals(req.user.id)).map(publicGoal) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Delete a Donation Goal (+ best-effort media cleanup) ─────
router.delete('/goals/:id', requireAuth, async (req, res) => {
    try {
        const g = await openvibeBucks.deleteGoal(parseInt(req.params.id, 10), req.user.id);
        if (g && g.image_url && /^\/data\/offline\//.test(g.image_url)) {
            try {
                const fs = require('fs'); const path = require('path');
                const p = path.join(require('../paths').dir('OFFLINE_SCREEN_PATH', 'offline'), path.basename(g.image_url));
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch { /* orphan is harmless */ }
        }
        res.json({ goals: (await openvibeBucks.getManageGoals(req.user.id)).map(publicGoal) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get User Goals (public widget set: active + recently reached) ──
router.get('/goals/:userId', async (req, res) => {
    const goals = (await openvibeBucks.getGoals(req.params.userId)).map(publicGoal);
    res.json({ goals });
});

// ── Admin: Approve Cashout ───────────────────────────────────
router.post('/cashout/:id/approve', requireOwner, money.guardWrite, async (req, res) => {
    if (money.onBilling()) return cashoutsInBilling(res);
    try {
        await openvibeBucks.approveCashout(req.params.id);
        res.json({ message: 'Cashout approved' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Admin: Deny Cashout ──────────────────────────────────────
router.post('/cashout/:id/deny', requireOwner, money.guardWrite, async (req, res) => {
    if (money.onBilling()) return cashoutsInBilling(res);
    try {
        await openvibeBucks.denyCashout(req.params.id, req.body.reason);
        res.json({ message: 'Cashout denied, funds refunded' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Admin: Get Pending Cashouts ──────────────────────────────
router.get('/cashouts/pending', requireOwner, async (req, res) => {
    if (money.onBilling()) return cashoutsInBilling(res);
    const pending = await db.all(`
        SELECT t.*, u.username, u.display_name
        FROM transactions t
        JOIN users u ON t.from_user_id = u.id
        WHERE t.type = 'cashout' AND t.status = 'escrow'
        ORDER BY t.created_at ASC
    `);
    res.json({ cashouts: pending });
});

module.exports = router;
