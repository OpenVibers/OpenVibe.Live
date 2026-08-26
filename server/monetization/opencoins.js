/**
 * OpenVibe.Live — coins engine
 *
 * Two currencies flow through here:
 *
 *  1. CHANNEL POINTS (per-streamer loyalty, like Twitch Channel Points) — earned by
 *     watching/chatting/following a specific channel, spent on that streamer's
 *     rewards. Live-local (channel_points/coin_* tables in live.db).
 *
 *  2. OPENCOINS (network-wide wallet) — the OpenVibe.Network-owned balance shared by
 *     Live/Games/Tools. All reads and earn/spend go through the Network wallet API
 *     (see wallet-client.js); the legacy users.openvibe_coins_balance column is
 *     frozen for the migration script and is never written anymore.
 *
 * Channel-point earning rates:
 *   - Watching a live stream: per the streamer's config (default 10 / 5 min)
 *   - Sending a chat message: 5 points (max 1 per minute)
 *   - Following a streamer: 50 points (one-time)
 *   - Watch streak bonus: 2x after 60 minutes continuous
 */
const db = require('../db/database');
const wallet = require('./wallet-client');

// ── Earning rates ────────────────────────────────────────────
const COINS = {
    WATCH_PER_5MIN: 10,          // passive watching
    CHAT_BONUS: 5,               // per qualifying message
    CHAT_COOLDOWN_MS: 60_000,    // 1 message per minute earns coins
    FOLLOW_BONUS: 50,            // one-time follow reward
    STREAK_MULTIPLIER: 2,        // after 60 min continuous
    STREAK_THRESHOLD_MIN: 60,    // minutes before streak kicks in
};

// Mirror every channel-point award into the streamer's PowerChat leaderboard feed
// (batched there; a no-op unless the streamer connected PowerChat with currency:write).
function _feedPowerchat(streamerId, userId, coins) {
    try { require('../integrations/powerchat-platform').queueCurrencyEarn(streamerId, userId, coins); } catch { /* non-critical */ }
}

// In-memory cooldown tracker (userId → lastChatCoinTime)
const chatCooldowns = new Map();
// Bonus-game claim throttle ("userId:streamerId" → last claim ms)
const bonusClaims = new Map();

class OpenCoins {

    /**
     * Award coins for watching (called by heartbeat interval)
     * @param {number} userId
     * @param {number} streamId
     * @returns {{ coins: number, total: number } | null}
     */
    awardWatch(userId, streamId) {
        if (!userId || !streamId) return null;

        // Update watch time
        db.upsertWatchTime(userId, streamId);
        const wt = db.getWatchTime(userId, streamId);
        if (!wt) return null;

        // Channel points are per-streamer — resolve the streamer + their earn config.
        const streamerId = db.getStreamById(streamId)?.user_id;
        if (!streamerId || streamerId === userId) return null; // don't earn on your own stream
        const cfg = db.getChannelPointsConfig(streamerId);
        const interval = cfg.watch_interval_min || 5;

        // Award every <interval> minutes, per the streamer's config.
        if (wt.minutes_watched % interval !== 0) return null;

        let coins = cfg.watch_amount || 0;
        if (coins <= 0) return null;
        // Streak bonus: 2x after 60 min continuous
        if (wt.minutes_watched >= COINS.STREAK_THRESHOLD_MIN) {
            coins *= COINS.STREAK_MULTIPLIER;
        }

        const total = db.addChannelPoints(userId, streamerId, coins);
        _feedPowerchat(streamerId, userId, coins);
        db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: coins,
            type: 'watch',
            message: wt.minutes_watched >= COINS.STREAK_THRESHOLD_MIN
                ? `Watch streak bonus (${wt.minutes_watched} min)`
                : `Watching stream (${wt.minutes_watched} min)`,
        });

        // Update coins_earned on watch_time record
        db.run('UPDATE watch_time SET coins_earned = coins_earned + ? WHERE id = ?',
            [coins, wt.id]);

        return { coins, total, streamerId };
    }

    /**
     * Award coins for chatting (with cooldown)
     * @param {number} userId
     * @param {number} streamId
     * @returns {{ coins: number, total: number } | null}
     */
    awardChat(userId, streamId) {
        if (!userId) return null;

        const now = Date.now();
        const lastTime = chatCooldowns.get(userId) || 0;
        if (now - lastTime < COINS.CHAT_COOLDOWN_MS) return null;

        const streamerId = streamId ? db.getStreamById(streamId)?.user_id : null;
        if (!streamerId || streamerId === userId) return null;
        chatCooldowns.set(userId, now);

        const total = db.addChannelPoints(userId, streamerId, COINS.CHAT_BONUS);
        _feedPowerchat(streamerId, userId, COINS.CHAT_BONUS);
        db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: COINS.CHAT_BONUS,
            type: 'chat_bonus',
            message: 'Chat activity bonus',
        });

        return { coins: COINS.CHAT_BONUS, total, streamerId };
    }

    /**
     * Award one-time follow bonus
     * @param {number} userId
     * @param {number} streamerId
     */
    awardFollow(userId, streamerId) {
        if (!userId) return null;

        // Check if user already got follow bonus for this streamer
        const existing = db.get(
            `SELECT id FROM coin_transactions WHERE user_id = ? AND type = 'follow_bonus' AND message LIKE '%streamer:' || ? || '%'`,
            [userId, streamerId]
        );
        if (existing) return null;
        if (!streamerId || streamerId === userId) return null;

        const total = db.addChannelPoints(userId, streamerId, COINS.FOLLOW_BONUS);
        _feedPowerchat(streamerId, userId, COINS.FOLLOW_BONUS);
        db.createCoinTransaction({
            user_id: userId,
            stream_id: null,
            amount: COINS.FOLLOW_BONUS,
            type: 'follow_bonus',
            message: `Followed streamer:${streamerId}`,
        });

        return { coins: COINS.FOLLOW_BONUS, total, streamerId };
    }

    /**
     * Redeem a reward (spend coins)
     * @param {number} userId
     * @param {number} rewardId
     * @param {number} streamId
     * @param {string} userInput - optional viewer message
     * @returns {{ redemption: object, remaining: number }}
     */
    redeem(userId, rewardId, streamId, userInput) {
        const reward = db.getCoinRewardById(rewardId);
        if (!reward) throw new Error('Reward not found');
        if (!reward.is_enabled) throw new Error('Reward is disabled');

        // Channel points are per-streamer. Normal rewards spend the reward owner's
        // points; a global (admin) reward spends the points of the channel you're
        // currently watching.
        let pointsStreamerId = reward.streamer_id;
        if (reward.is_global && streamId) {
            const s = db.getStreamById(streamId);
            if (s?.user_id) pointsStreamerId = s.user_id;
        }
        if (!pointsStreamerId) throw new Error('No channel context for this reward');

        // Check user has enough points for this channel
        if (!db.deductChannelPoints(userId, pointsStreamerId, reward.cost)) {
            const cpName = (db.getChannelPointsConfig(pointsStreamerId).name) || 'Channel Points';
            throw new Error(`Not enough ${cpName}`);
        }

        // Check per-user cooldown
        if (reward.cooldown_seconds > 0) {
            const lastRedemption = db.get(
                `SELECT created_at FROM coin_redemptions WHERE reward_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
                [rewardId, userId]
            );
            if (lastRedemption) {
                const elapsed = (Date.now() - new Date(lastRedemption.created_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
                if (elapsed < reward.cooldown_seconds) {
                    db.addChannelPoints(userId, pointsStreamerId, reward.cost); // refund
                    throw new Error(`Cooldown: wait ${Math.ceil(reward.cooldown_seconds - elapsed)}s`);
                }
            }
        }

        // Check max per stream
        if (reward.max_per_stream > 0 && streamId) {
            const count = db.get(
                `SELECT COUNT(*) as c FROM coin_redemptions WHERE reward_id = ? AND stream_id = ?`,
                [rewardId, streamId]
            );
            if (count && count.c >= reward.max_per_stream) {
                db.addChannelPoints(userId, pointsStreamerId, reward.cost); // refund
                throw new Error('Max redemptions reached for this stream');
            }
        }

        // Create redemption
        const result = db.createCoinRedemption({
            reward_id: rewardId,
            user_id: userId,
            stream_id: streamId,
            user_input: userInput,
        });

        // Log transaction
        db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: -reward.cost,
            type: 'redeem',
            reward_id: rewardId,
            message: `Redeemed: ${reward.title}`,
        });

        // Increment redemption count
        db.run('UPDATE coin_rewards SET redemption_count = redemption_count + 1 WHERE id = ?', [rewardId]);

        return {
            redemption: {
                id: result.lastInsertRowid,
                reward: reward,
                user_input: userInput,
            },
            remaining: db.getChannelPoints(userId, pointsStreamerId),
            streamerId: pointsStreamerId,
        };
    }

    /**
     * Claim the clickable "bonus game" — extra channel points, throttled to once
     * per the streamer's configured interval. Returns { coins, total, streamerId } or null.
     */
    awardBonusGame(userId, streamId) {
        if (!userId || !streamId) return null;
        const streamerId = db.getStreamById(streamId)?.user_id;
        if (!streamerId || streamerId === userId) return null;
        const cfg = db.getChannelPointsConfig(streamerId);
        if (!cfg.game_interval_min) return null; // bonus game disabled for this channel
        const key = `${userId}:${streamerId}`;
        const now = Date.now();
        const windowMs = cfg.game_interval_min * 60_000 * 0.9; // small grace for client timing
        if (now - (bonusClaims.get(key) || 0) < windowMs) return null;
        bonusClaims.set(key, now);
        const amount = Math.max(1, (cfg.watch_amount || 10) * 3);
        const total = db.addChannelPoints(userId, streamerId, amount);
        _feedPowerchat(streamerId, userId, amount);
        db.createCoinTransaction({ user_id: userId, stream_id: streamId, amount, type: 'watch', message: 'Bonus game' });
        return { coins: amount, total, streamerId };
    }

    /**
     * A viewer's channel-points balance for a specific streamer.
     */
    getBalance(userId, streamerId) {
        return db.getChannelPoints(userId, streamerId);
    }

    /**
     * The network-wide OpenCoins wallet balance (OpenVibe.Network-owned).
     * Reads via the wallet API using the caller's Network JWT; falls back to the
     * frozen legacy column only when the wallet is unreachable/unlinked.
     */
    async getGold(userId, userToken = null) {
        const balance = await wallet.balanceForToken(userToken);
        if (balance !== null) return balance;
        const user = db.getUserById(userId);
        return user ? (user.openvibe_coins_balance || 0) : 0;
    }

    /** Server-side earn/spend passthroughs (idempotency keys: `live:<event>:<id>`). */
    credit(userId, amount, reason, idempotencyKey, ref) { return wallet.credit(userId, amount, reason, idempotencyKey, ref); }
    debit(userId, amount, reason, idempotencyKey, ref) { return wallet.debit(userId, amount, reason, idempotencyKey, ref); }
    transfer(fromId, toId, amount, reason, idempotencyKey, ref) { return wallet.transfer(fromId, toId, amount, reason, idempotencyKey, ref); }

    /**
     * Get available rewards for a stream/channel
     * @param {number} streamerId - the streamer's user ID
     */
    getRewards(streamerId) {
        const streamerRewards = db.getCoinRewardsByStreamer(streamerId);
        // Also get global rewards
        const globals = db.all(
            'SELECT * FROM coin_rewards WHERE is_global = 1 AND is_enabled = 1 ORDER BY sort_order, cost'
        );
        return [...globals, ...streamerRewards];
    }

    /**
     * Admin: grant OpenCoins to a user (network wallet credit).
     */
    async adminGrant(userId, amount, reason) {
        const key = `live:admin_grant:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const result = await wallet.credit(userId, amount, reason || 'Admin grant', key);
        if (!result) throw new Error('User has no linked OpenVibe.Network account (wallet unavailable)');
        return result.balance;
    }

    /**
     * Get earning rates config (for UI display)
     */
    getRates() {
        return { ...COINS };
    }
}

module.exports = new OpenCoins();
