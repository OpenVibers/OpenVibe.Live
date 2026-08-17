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

const router = express.Router();

// ── Buy Vibes ───────────────────────────────────────────
router.post('/purchase', requireAuth, (req, res) => {
    try {
        const { amount, paypal_transaction_id } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // In production, validate PayPal transaction here
        openvibeBucks.purchase(req.user.id, amount, paypal_transaction_id);

        const user = db.getUserById(req.user.id);
        res.json({
            message: `Purchased ${amount} Vibes`,
            balance: user.openvibe_bucks_balance,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
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
router.post('/donate', requireAuth, (req, res) => {
    try {
        let { streamer_id, stream_id, amount, message, goal_id } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid donation' });
        }

        // Resolve streamer_id from the stream record if not provided
        if (!streamer_id && stream_id) {
            const stream = db.getStreamById(stream_id);
            if (stream) streamer_id = stream.user_id;
        }
        if (!streamer_id) {
            return res.status(400).json({ error: 'Could not determine streamer' });
        }
        streamer_id = Number(streamer_id);

        const result = openvibeBucks.donate(req.user.id, streamer_id, stream_id, amount, message, goal_id || null);

        const chatServer = require('../chat/chat-server');
        const alerts = require('./alerts');
        const donorUser = db.getUserById(req.user.id);
        const donor = donorUser?.display_name || donorUser?.username || 'Someone';
        const ts = new Date().toISOString();

        // 1) Donation chat message — broadcast live AND persist to channel history so
        //    late-joiners see it. Channel-room broadcast reaches all slots + offline.
        chatServer.broadcastToChannelRoom(streamer_id, stream_id || null, {
            type: 'donation', username: donor, user_id: req.user.id,
            avatar_url: donorUser?.avatar_url || null,
            amount: result.amount, message: message || '', timestamp: ts,
        });
        try {
            db.saveChatMessage({
                stream_id: stream_id || null, channel_user_id: streamer_id, user_id: req.user.id,
                username: donor,
                message: `${donor} donated ${result.amount.toLocaleString()} Vibes${message ? ': ' + message : ''}`,
                message_type: 'donation',
                metadata: { kind: 'donation', amount: result.amount, message: message || '', username: donor, user_id: req.user.id, avatar_url: donorUser?.avatar_url || null },
            });
        } catch { /* non-critical */ }

        // 2) Donation sound (streamer-configured).
        alerts.playAlertSound(chatServer, streamer_id, stream_id, 'donation');

        // 3) Live goal progress → widget.
        if (result.goal) {
            chatServer.broadcastToChannelRoom(streamer_id, stream_id || null, { type: 'goal-update', goal: publicGoal(result.goal) });
        }

        // 4) Goal reached → flashy animated chat event (persisted) + goal sound.
        if (result.goalReached) {
            const g = result.goalReached;
            chatServer.broadcastToChannelRoom(streamer_id, stream_id || null, {
                type: 'goal-reached', goal: publicGoal(g), by: donor, timestamp: ts,
            });
            try {
                db.saveChatMessage({
                    stream_id: stream_id || null, channel_user_id: streamer_id, user_id: null,
                    username: 'Donation Goal',
                    message: `🎉 Goal reached: ${g.title} (${(g.target_amount || 0).toLocaleString()} Vibes)`,
                    message_type: 'donation',
                    metadata: { kind: 'goal-reached', goal_id: g.id, title: g.title, target: g.target_amount, image: g.image_url || null, media_type: g.media_type || null, by: donor },
                });
            } catch { /* non-critical */ }
            alerts.playAlertSound(chatServer, streamer_id, stream_id, 'goal');
        }

        const user = db.getUserById(req.user.id);
        res.json({ success: true, amount: result.amount, balance: user.openvibe_bucks_balance, goal_reached: !!result.goalReached });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Request Cashout ──────────────────────────────────────────
router.post('/cashout', requireAuth, (req, res) => {
    try {
        const { amount, paypal_email } = req.body;
        if (!amount || !paypal_email) {
            return res.status(400).json({ error: 'Amount and PayPal email required' });
        }

        const result = openvibeBucks.requestCashout(req.user.id, amount, paypal_email);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get Balance ──────────────────────────────────────────────
router.get('/balance', requireAuth, (req, res) => {
    const user = db.getUserById(req.user.id);
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
router.post('/recycle', requireAuth, (req, res) => {
    try {
        const result = openvibeBucks.recycleCashout(req.user.id, req.body.amount);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Transaction History ──────────────────────────────────────
router.get('/history', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const history = openvibeBucks.getHistory(req.user.id, limit);
    res.json({ transactions: history });
});

// ── Stream Donation Leaderboard ──────────────────────────────
router.get('/leaderboard/:streamId', (req, res) => {
    const leaderboard = openvibeBucks.getLeaderboard(req.params.streamId);
    res.json({ leaderboard });
});

// ── Manage own goals (dashboard) — all goals incl. completed ──
router.get('/goals/manage/mine', requireAuth, (req, res) => {
    res.json({ goals: openvibeBucks.getManageGoals(req.user.id).map(publicGoal) });
});

// ── Create Donation Goal ─────────────────────────────────────
router.post('/goals', requireAuth, (req, res) => {
    try {
        const { title, target_amount, image_url, media_type } = req.body;
        if (!title || !target_amount) {
            return res.status(400).json({ error: 'Title and target amount required' });
        }
        openvibeBucks.createGoal(req.user.id, { title, target_amount, image_url, media_type });
        res.status(201).json({ goals: openvibeBucks.getManageGoals(req.user.id).map(publicGoal) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Update a Donation Goal ───────────────────────────────────
router.put('/goals/:id', requireAuth, (req, res) => {
    try {
        openvibeBucks.updateGoal(parseInt(req.params.id, 10), req.user.id, req.body);
        res.json({ goals: openvibeBucks.getManageGoals(req.user.id).map(publicGoal) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Delete a Donation Goal (+ best-effort media cleanup) ─────
router.delete('/goals/:id', requireAuth, (req, res) => {
    try {
        const g = openvibeBucks.deleteGoal(parseInt(req.params.id, 10), req.user.id);
        if (g && g.image_url && /^\/data\/offline\//.test(g.image_url)) {
            try {
                const fs = require('fs'); const path = require('path');
                const p = path.join(process.env.OFFLINE_SCREEN_PATH || './data/offline', path.basename(g.image_url));
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch { /* orphan is harmless */ }
        }
        res.json({ goals: openvibeBucks.getManageGoals(req.user.id).map(publicGoal) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get User Goals (public widget set: active + recently reached) ──
router.get('/goals/:userId', (req, res) => {
    const goals = openvibeBucks.getGoals(req.params.userId).map(publicGoal);
    res.json({ goals });
});

// ── Admin: Approve Cashout ───────────────────────────────────
router.post('/cashout/:id/approve', requireOwner, (req, res) => {
    try {
        openvibeBucks.approveCashout(req.params.id);
        res.json({ message: 'Cashout approved' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Admin: Deny Cashout ──────────────────────────────────────
router.post('/cashout/:id/deny', requireOwner, (req, res) => {
    try {
        openvibeBucks.denyCashout(req.params.id, req.body.reason);
        res.json({ message: 'Cashout denied, funds refunded' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Admin: Get Pending Cashouts ──────────────────────────────
router.get('/cashouts/pending', requireOwner, (req, res) => {
    const pending = db.all(`
        SELECT t.*, u.username, u.display_name, u.email
        FROM transactions t
        JOIN users u ON t.from_user_id = u.id
        WHERE t.type = 'cashout' AND t.status = 'escrow'
        ORDER BY t.created_at ASC
    `);
    res.json({ cashouts: pending });
});

module.exports = router;
