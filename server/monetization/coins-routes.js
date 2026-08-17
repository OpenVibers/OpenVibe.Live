/**
 * OpenVibe.Live — OpenCoins API Routes
 * 
 * GET    /api/coins/balance         - Get user's coin balance
 * GET    /api/coins/rates           - Get earning rates
 * GET    /api/coins/history         - Get coin transaction history
 * GET    /api/coins/rewards/:userId - Get available rewards for a streamer
 * POST   /api/coins/rewards         - Create a reward (streamer)
 * PUT    /api/coins/rewards/:id     - Update a reward (streamer)
 * DELETE /api/coins/rewards/:id     - Delete a reward (streamer)
 * POST   /api/coins/redeem          - Redeem a reward (viewer)
 * POST   /api/coins/heartbeat       - Watch time heartbeat (earns coins)
 * GET    /api/coins/redemptions      - Get pending redemptions (streamer)
 * POST   /api/coins/redemptions/:id  - Resolve a redemption (streamer)
 * POST   /api/coins/admin/grant      - Admin: grant coins to user
 */
const express = require('express');
const { requireAuth, requireAdmin, extractToken } = require('../auth/auth');
const { requireOwner } = require('../auth/permissions');
const openvibeCoins = require('./opencoins');
const db = require('../db/database');

const router = express.Router();

// ── Get OpenCoins balance (network-wide wallet on openvibe.network) ──
router.get('/balance', requireAuth, async (req, res) => {
    res.json({ balance: await openvibeCoins.getGold(req.user.id, extractToken(req)) });
});

// ── Get channel-points balance for a specific streamer ──────
router.get('/channel-balance', requireAuth, (req, res) => {
    const streamerId = parseInt(req.query.streamerId) || null;
    res.json({ balance: streamerId ? openvibeCoins.getBalance(req.user.id, streamerId) : 0, streamerId });
});

// ── Get Earning Rates ────────────────────────────────────────
router.get('/rates', (req, res) => {
    res.json({ rates: openvibeCoins.getRates() });
});

// ── Coin Transaction History ─────────────────────────────────
// OpenCoins history comes from the Network wallet; the local coin_transactions log
// (channel-point events) is appended so the page still shows both currencies.
router.get('/history', requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const local = db.getCoinTransactions(req.user.id, limit) || [];
    const walletHistory = await require('./wallet-client').historyForToken(extractToken(req), limit) || [];
    res.json({ transactions: [...walletHistory, ...local].slice(0, limit), wallet: walletHistory.length > 0 });
});

// ── Watch Heartbeat (earn coins passively) ───────────────────
router.post('/heartbeat', requireAuth, (req, res) => {
    try {
        const { streamId } = req.body;
        if (!streamId) return res.status(400).json({ error: 'streamId required' });

        const result = openvibeCoins.awardWatch(req.user.id, streamId);
        if (result) {
            return res.json({ earned: result.coins, balance: result.total, streamerId: result.streamerId });
        }
        // No points earned this tick (not on a 5-min boundary) — return this channel's balance.
        const streamerId = db.getStreamById(parseInt(streamId))?.user_id || null;
        res.json({ earned: 0, balance: streamerId ? openvibeCoins.getBalance(req.user.id, streamerId) : 0, streamerId });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Claim the clickable bonus game (extra channel points, throttled per channel).
router.post('/bonus', requireAuth, (req, res) => {
    try {
        const { streamId } = req.body;
        if (!streamId) return res.status(400).json({ error: 'streamId required' });
        const r = openvibeCoins.awardBonusGame(req.user.id, streamId);
        if (!r) return res.status(429).json({ error: 'Bonus not available right now' });
        res.json({ earned: r.coins, balance: r.total, streamerId: r.streamerId });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get Available Rewards + this channel's points config ─────
router.get('/rewards/:userId', (req, res) => {
    const streamerId = parseInt(req.params.userId);
    const rewards = openvibeCoins.getRewards(streamerId);
    res.json({ rewards, config: db.getChannelPointsConfig(streamerId) });
});

// Public: a streamer's Channel Points branding/config (name, icon, earn rates).
router.get('/config/:userId', (req, res) => {
    res.json({ config: db.getChannelPointsConfig(parseInt(req.params.userId)) });
});

// A streamer configures their own Channel Points.
router.put('/config', requireAuth, (req, res) => {
    try {
        const b = req.body || {};
        const fields = {};
        if (b.name !== undefined) fields.name = (String(b.name).trim().slice(0, 32)) || 'Channel Points';
        if (b.icon !== undefined) {
            const ic = String(b.icon).trim();
            if (!/^fa-[a-z0-9-]+$/.test(ic)) return res.status(400).json({ error: 'Icon must be a Font Awesome class like fa-coins' });
            fields.icon = ic;
        }
        if (b.watch_interval_min !== undefined) fields.watch_interval_min = Math.max(1, Math.min(120, parseInt(b.watch_interval_min, 10) || 5));
        if (b.watch_amount !== undefined) fields.watch_amount = Math.max(0, Math.min(100000, parseInt(b.watch_amount, 10) || 0));
        if (b.game_interval_min !== undefined) fields.game_interval_min = Math.max(0, Math.min(1440, parseInt(b.game_interval_min, 10) || 0));
        db.setChannelPointsConfig(req.user.id, fields);
        res.json({ config: db.getChannelPointsConfig(req.user.id) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Create Reward (Streamer) ─────────────────────────────────
router.post('/rewards', requireAuth, (req, res) => {
    try {
        const { title, description, icon, color, cooldown_seconds, max_per_stream } = req.body;
        const cost = parseInt(req.body.cost, 10);
        const requires_input = !!req.body.requires_input;
        if (!title || !cost) {
            return res.status(400).json({ error: 'Title and cost required' });
        }
        if (!Number.isFinite(cost) || cost < 1) {
            return res.status(400).json({ error: 'Cost must be an integer ≥ 1' });
        }
        if (icon && !/^fa-[a-z0-9-]+$/.test(icon)) {
            return res.status(400).json({ error: 'Invalid icon class' });
        }
        if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
            return res.status(400).json({ error: 'Color must be a 6-digit hex color' });
        }

        db.createCoinReward({
            streamer_id: req.user.id,
            title,
            description,
            cost,
            icon,
            color,
            cooldown_seconds,
            max_per_stream,
            requires_input,
        });

        const rewards = openvibeCoins.getRewards(req.user.id);
        res.status(201).json({ rewards });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Update Reward ────────────────────────────────────────────
router.put('/rewards/:id', requireAuth, (req, res) => {
    try {
        const reward = db.getCoinRewardById(req.params.id);
        if (!reward || reward.streamer_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your reward' });
        }

        const allowed = ['title', 'description', 'icon', 'color',
                         'cooldown_seconds', 'max_per_stream', 'is_enabled', 'sort_order'];
        const fields = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) fields[key] = req.body[key];
        }
        // Type-coerce numeric/boolean fields to prevent injection
        if (req.body.cost !== undefined) {
            fields.cost = parseInt(req.body.cost, 10);
            if (!Number.isFinite(fields.cost) || fields.cost < 1) {
                return res.status(400).json({ error: 'Cost must be an integer ≥ 1' });
            }
        }
        if (req.body.requires_input !== undefined) {
            fields.requires_input = req.body.requires_input ? 1 : 0;
        }
        if (fields.icon && !/^fa-[a-z0-9-]+$/.test(fields.icon)) {
            return res.status(400).json({ error: 'Invalid icon class' });
        }
        if (fields.color && !/^#[0-9a-fA-F]{6}$/.test(fields.color)) {
            return res.status(400).json({ error: 'Color must be a 6-digit hex color' });
        }

        db.updateCoinReward(req.params.id, fields);
        const rewards = openvibeCoins.getRewards(req.user.id);
        res.json({ rewards });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Delete Reward ────────────────────────────────────────────
router.delete('/rewards/:id', requireAuth, (req, res) => {
    try {
        const reward = db.getCoinRewardById(req.params.id);
        if (!reward || reward.streamer_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your reward' });
        }
        db.deleteCoinReward(req.params.id);
        res.json({ message: 'Reward deleted' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Redeem Reward (Viewer) ───────────────────────────────────
router.post('/redeem', requireAuth, (req, res) => {
    try {
        const { rewardId, streamId, userInput } = req.body;
        if (!rewardId) return res.status(400).json({ error: 'rewardId required' });

        const result = openvibeCoins.redeem(req.user.id, rewardId, streamId, userInput);

        // Broadcast redemption to chat so streamer sees it
        try {
            const chatServer = require('../chat/chat-server');
            const reward = result.redemption.reward;
            chatServer.broadcastToStream(streamId, {
                type: 'redemption',
                username: req.user.display_name || req.user.username,
                reward_title: reward.title,
                reward_icon: reward.icon,
                reward_color: reward.color,
                cost: reward.cost,
                user_input: userInput || '',
                timestamp: new Date().toISOString(),
            });
        } catch { /* chat broadcast optional */ }

        // Feed the redemption into PowerChat as a virtual-currency event (alerts + leaderboard).
        try {
            const reward = result.redemption.reward;
            require('../integrations/powerchat-platform').sendCurrencyRedemption(result.streamerId, {
                amount: reward.cost,
                redeemerName: req.user.display_name || req.user.username,
                rewardName: reward.title,
                message: userInput || '',
                externalId: 'redemption:' + result.redemption.id,
            });
        } catch { /* optional */ }

        res.json({
            message: `Redeemed "${result.redemption.reward.title}"`,
            remaining: result.remaining,
            streamerId: result.streamerId,
            redemption_id: result.redemption.id,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get Pending Redemptions (Streamer Queue) ─────────────────
router.get('/redemptions', requireAuth, (req, res) => {
    const pending = db.getPendingRedemptions(req.user.id);
    res.json({ redemptions: pending });
});

// ── Resolve Redemption (Streamer) ────────────────────────────
router.post('/redemptions/:id', requireAuth, (req, res) => {
    try {
        const { status } = req.body; // 'fulfilled' or 'rejected'
        if (!['fulfilled', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Status must be fulfilled or rejected' });
        }

        // Verify this redemption belongs to one of the streamer's rewards
        const redemption = db.get('SELECT r.*, cr.streamer_id FROM coin_redemptions r JOIN coin_rewards cr ON r.reward_id = cr.id WHERE r.id = ?',
            [req.params.id]);
        if (!redemption || redemption.streamer_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your redemption' });
        }

        // If rejected, refund the channel points to the channel they were spent on.
        if (status === 'rejected') {
            const reward = db.getCoinRewardById(redemption.reward_id);
            if (reward) {
                let refundStreamerId = redemption.streamer_id;
                if (reward.is_global && redemption.stream_id) {
                    const s = db.getStreamById(redemption.stream_id);
                    if (s?.user_id) refundStreamerId = s.user_id;
                }
                db.addChannelPoints(redemption.user_id, refundStreamerId, reward.cost);
                db.createCoinTransaction({
                    user_id: redemption.user_id,
                    stream_id: redemption.stream_id || null,
                    amount: reward.cost,
                    type: 'refund',
                    reward_id: redemption.reward_id,
                    message: `Refunded: ${reward.title} (rejected by streamer)`,
                });
            }
        }

        db.resolveRedemption(req.params.id, status);
        res.json({ message: `Redemption ${status}` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Admin: Grant Coins (network wallet credit) ───────────────
router.post('/admin/grant', requireOwner, async (req, res) => {
    try {
        const { userId, amount, reason } = req.body;
        if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required' });

        const newBalance = await openvibeCoins.adminGrant(userId, amount, reason);
        res.json({ message: `Granted ${amount} OpenCoins`, balance: newBalance });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
