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
const { publicGoal, announceGoal } = require('./goal-announce');
const channelTips = require('./channel-tips');
// OpenVibe.Billing is the ledger (since 2026-10-17): every money action below asks it (billing-actions.js);
// money_writes_frozen refuses them. Goals and the channel's tip history stay Live's.
const money = require('./money-authority');
const billingActions = require('./billing-actions');
const cashoutsInBilling = (res) => res.status(409).json({
    error: 'Cashouts are decided in OpenVibe.Billing now: approve or deny them in its staff console at https://billing.openvibe.network/cashouts (approving needs the PayPal payout reference).',
    code: 'cashouts_in_billing',
});

const router = express.Router();

// ── Buy Vibes ───────────────────────────────────────────
// Disabled (it once credited Vibes with no payment check). Purchases are checkouts through OpenVibe.Billing
// (/api/payments/bucks/checkout); 410 rather than 404 so an old client gets a clear answer.
router.post('/purchase', (req, res) => {
    res.status(410).json({ error: 'Direct purchase is disabled. Buy Vibes with a checkout: OpenVibe.Billing credits them when the payment confirms.' });
});

// Serialize a goal for the client (no private fields to leak).
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

        const result = await billingActions.donate(req, { toUserId: streamer_id, streamId: stream_id, amount, message, goalId: goal_id || null });
        // A request the browser repeated with the same Idempotency-Key: already celebrated.
        if (result.replayed) return res.json({ success: true, amount: result.amount, balance: result.balance, goal_reached: false });

        // The channel's tip history (leaderboard, recap, home stats).
        await channelTips.record({
            toUserId: streamer_id, fromUserId: req.user.id, streamId: stream_id || null, amount: result.amount, source: 'vibes',
            ref: result.transactionId ? `billing-txn:${result.transactionId}` : `vibes:${require('crypto').randomUUID()}`,
        });

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

        // 3) Live goal progress → widget, 4) goal reached → a saved "Goal reached" line + the goal sound.
        await announceGoal({
            userId: streamer_id, streamId: stream_id || null, by: donor,
            goalResult: result.goal ? { goal: result.goal, reached: !!result.goalReached } : null,
            key: result.transactionId ? `goal:${result.transactionId}` : undefined,
        });

        res.json({ success: true, amount: result.amount, balance: result.balance, goal_reached: !!result.goalReached });
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

        const result = await billingActions.requestCashout(req, { amount, paypalEmail: paypal_email });
        res.json(result);
    } catch (err) {
        if (billingActions.sendError(res, err, { insufficient: 'Insufficient cashout balance — only Vibes sent to you can be cashed out' })) return;
        res.status(400).json({ error: err.message });
    }
});

// ── Get Balance ──────────────────────────────────────────────
router.get('/balance', requireAuth, async (req, res) => {
    // Billing is the only truth: when it cannot answer, the balance is "unavailable", never a guess.
    try { return res.json(await billingActions.balance(req.user.id, req.headers)); }
    catch (err) {
        if (billingActions.sendError(res, err, { unavailable: 'Vibes balance unavailable right now — the billing service is not answering.' })) return;
        return res.status(503).json({ error: 'Vibes balance unavailable right now', unavailable: true });
    }
});

// ── Recycle cashout balance → spendable Vibes ───────────
router.post('/recycle', requireAuth, money.guardWrite, async (req, res) => {
    try {
        const result = await billingActions.recycle(req, req.body.amount);
        res.json(result);
    } catch (err) {
        if (billingActions.sendError(res, err, { insufficient: 'Insufficient cashout balance' })) return;
        res.status(400).json({ error: err.message });
    }
});

// ── Transaction History ──────────────────────────────────────
router.get('/history', requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    try { return res.json({ transactions: await billingActions.history(req.user.id, limit) }); }
    catch (err) {
        if (billingActions.sendError(res, err, { unavailable: 'Vibes history unavailable right now — the billing service is not answering.' })) return;
        return res.status(503).json({ error: 'Vibes history unavailable right now', unavailable: true });
    }
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

// ── Cashout decisions: OpenVibe.Billing's staff console ──────
// Old admin clients get a clear answer instead of a 404.
router.post('/cashout/:id/approve', requireOwner, (req, res) => cashoutsInBilling(res));
router.post('/cashout/:id/deny', requireOwner, (req, res) => cashoutsInBilling(res));
router.get('/cashouts/pending', requireOwner, (req, res) => cashoutsInBilling(res));

module.exports = router;
