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
 *     (see wallet-client.js). Live keeps no copy: the legacy users.openvibe_coins_balance column is
 *     read and written by nothing and goes in a contract migration.
 *
 * Every channel-points debit and credit carries a deterministic per-event key (ADR-012 rule 5,
 * db.applyChannelPoints): watch = the watch_time row + minute, chat = the user's minute, follow =
 * user + streamer, bonus = the claim window, redeem / redeem refund = the redemption id. A retried
 * or replayed event moves nothing twice.
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
async function _feedPowerchat(streamerId, userId, coins) {
    try { await require('../integrations/powerchat-platform').queueCurrencyEarn(streamerId, userId, coins); } catch { /* non-critical */ }
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
    async awardWatch(userId, streamId) {
        if (!userId || !streamId) return null;

        // Update watch time
        await db.upsertWatchTime(userId, streamId);
        const wt = await db.getWatchTime(userId, streamId);
        if (!wt) return null;

        // Channel points are per-streamer — resolve the streamer + their earn config.
        const streamerId = (await db.getStreamById(streamId))?.user_id;
        if (!streamerId || streamerId === userId) return null; // don't earn on your own stream
        const cfg = await db.getChannelPointsConfig(streamerId);
        const interval = cfg.watch_interval_min || 5;

        // Award every <interval> minutes, per the streamer's config.
        if (wt.minutes_watched % interval !== 0) return null;

        let coins = cfg.watch_amount || 0;
        if (coins <= 0) return null;
        // Streak bonus: 2x after 60 min continuous
        if (wt.minutes_watched >= COINS.STREAK_THRESHOLD_MIN) {
            coins *= COINS.STREAK_MULTIPLIER;
        }

        const r = await db.applyChannelPoints({ userId, streamerId, delta: coins, key: `live:cp:watch:${wt.id}:${wt.minutes_watched}`, reason: 'watch' });
        if (!r.applied) return null;
        const total = r.balance;
        await _feedPowerchat(streamerId, userId, coins);
        await db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: coins,
            type: 'watch',
            message: wt.minutes_watched >= COINS.STREAK_THRESHOLD_MIN
                ? `Watch streak bonus (${wt.minutes_watched} min)`
                : `Watching stream (${wt.minutes_watched} min)`,
        });

        // Update coins_earned on watch_time record
        await db.run('UPDATE watch_time SET coins_earned = coins_earned + ? WHERE id = ?',
            [coins, wt.id]);

        return { coins, total, streamerId };
    }

    /**
     * Award coins for chatting (with cooldown)
     * @param {number} userId
     * @param {number} streamId
     * @returns {{ coins: number, total: number } | null}
     */
    async awardChat(userId, streamId) {
        if (!userId) return null;

        const now = Date.now();
        const lastTime = chatCooldowns.get(userId) || 0;
        if (now - lastTime < COINS.CHAT_COOLDOWN_MS) return null;

        const streamerId = streamId ? (await db.getStreamById(streamId))?.user_id : null;
        if (!streamerId || streamerId === userId) return null;
        chatCooldowns.set(userId, now);

        // The cooldown window is the event: after a restart (empty cooldown map) the same minute
        // still earns once.
        const r = await db.applyChannelPoints({ userId, streamerId, delta: COINS.CHAT_BONUS, key: `live:cp:chat:${userId}:${Math.floor(now / COINS.CHAT_COOLDOWN_MS)}`, reason: 'chat' });
        if (!r.applied) return null;
        const total = r.balance;
        await _feedPowerchat(streamerId, userId, COINS.CHAT_BONUS);
        await db.createCoinTransaction({
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
    async awardFollow(userId, streamerId) {
        if (!userId) return null;

        // Check if user already got follow bonus for this streamer
        const existing = await db.get(
            `SELECT id FROM coin_transactions WHERE user_id = ? AND type = 'follow_bonus' AND message ILIKE '%streamer:' || ? || '%'`,
            [userId, streamerId]
        );
        if (existing) return null;
        if (!streamerId || streamerId === userId) return null;

        const r = await db.applyChannelPoints({ userId, streamerId, delta: COINS.FOLLOW_BONUS, key: `live:cp:follow:${userId}:${streamerId}`, reason: 'follow' });
        if (!r.applied) return null;
        const total = r.balance;
        await _feedPowerchat(streamerId, userId, COINS.FOLLOW_BONUS);
        await db.createCoinTransaction({
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
    async redeem(userId, rewardId, streamId, userInput) {
        const reward = await db.getCoinRewardById(rewardId);
        if (!reward) throw new Error('Reward not found');
        if (!reward.is_enabled) throw new Error('Reward is disabled');

        // Channel points are per-streamer. Normal rewards spend the reward owner's
        // points; a global (admin) reward spends the points of the channel you're
        // currently watching.
        let pointsStreamerId = reward.streamer_id;
        if (reward.is_global && streamId) {
            const s = await db.getStreamById(streamId);
            if (s?.user_id) pointsStreamerId = s.user_id;
        }
        if (!pointsStreamerId) throw new Error('No channel context for this reward');

        // The limits are checked, the redemption row created and the points taken in one
        // transaction, keyed by the redemption id: nothing is taken for a refused redemption
        // (there is no take-then-refund any more), and a replayed spend moves nothing twice.
        const result = await db.getDb().tx(async () => {
            // Check per-user cooldown
            if (reward.cooldown_seconds > 0) {
                const lastRedemption = await db.get(
                    `SELECT created_at FROM coin_redemptions WHERE reward_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
                    [rewardId, userId]
                );
                if (lastRedemption) {
                    const elapsed = (Date.now() - new Date(lastRedemption.created_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
                    if (elapsed < reward.cooldown_seconds) {
                        throw new Error(`Cooldown: wait ${Math.ceil(reward.cooldown_seconds - elapsed)}s`);
                    }
                }
            }

            // Check max per stream
            if (reward.max_per_stream > 0 && streamId) {
                const count = await db.get(
                    `SELECT COUNT(*) as c FROM coin_redemptions WHERE reward_id = ? AND stream_id = ?`,
                    [rewardId, streamId]
                );
                if (count && count.c >= reward.max_per_stream) {
                    throw new Error('Max redemptions reached for this stream');
                }
            }

            // Create redemption, then take the points for it (rolled back together if short)
            const created = await db.run(
                'INSERT INTO coin_redemptions (reward_id, user_id, stream_id, user_input) VALUES (?, ?, ?, ?) RETURNING id',
                [rewardId, userId, streamId || null, userInput || null]
            );
            if (!await db.deductChannelPoints(userId, pointsStreamerId, reward.cost, `live:cp:redeem:${created.lastInsertRowid}`, `redeem reward ${rewardId}`)) {
                const cpName = ((await db.getChannelPointsConfig(pointsStreamerId)).name) || 'Channel Points';
                throw new Error(`Not enough ${cpName}`);
            }
            return created;
        });

        // Log transaction
        await db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: -reward.cost,
            type: 'redeem',
            reward_id: rewardId,
            message: `Redeemed: ${reward.title}`,
        });

        // Increment redemption count
        await db.run('UPDATE coin_rewards SET redemption_count = redemption_count + 1 WHERE id = ?', [rewardId]);

        return {
            redemption: {
                id: result.lastInsertRowid,
                reward: reward,
                user_input: userInput,
            },
            remaining: await db.getChannelPoints(userId, pointsStreamerId),
            streamerId: pointsStreamerId,
        };
    }

    /**
     * Claim the clickable "bonus game" — extra channel points, throttled to once
     * per the streamer's configured interval. Returns { coins, total, streamerId } or null.
     */
    async awardBonusGame(userId, streamId) {
        if (!userId || !streamId) return null;
        const streamerId = (await db.getStreamById(streamId))?.user_id;
        if (!streamerId || streamerId === userId) return null;
        const cfg = await db.getChannelPointsConfig(streamerId);
        if (!cfg.game_interval_min) return null; // bonus game disabled for this channel
        const key = `${userId}:${streamerId}`;
        const now = Date.now();
        const windowMs = cfg.game_interval_min * 60_000 * 0.9; // small grace for client timing
        if (now - (bonusClaims.get(key) || 0) < windowMs) return null;
        bonusClaims.set(key, now);
        const amount = Math.max(1, (cfg.watch_amount || 10) * 3);
        // One claim per window, also across a restart (the throttle map above is in memory).
        const r = await db.applyChannelPoints({ userId, streamerId, delta: amount, key: `live:cp:bonus:${userId}:${streamerId}:${Math.floor(now / windowMs)}`, reason: 'bonus game' });
        if (!r.applied) return null;
        const total = r.balance;
        await _feedPowerchat(streamerId, userId, amount);
        await db.createCoinTransaction({ user_id: userId, stream_id: streamId, amount, type: 'watch', message: 'Bonus game' });
        return { coins: amount, total, streamerId };
    }

    /**
     * A viewer's channel-points balance for a specific streamer.
     */
    async getBalance(userId, streamerId) {
        return await db.getChannelPoints(userId, streamerId);
    }

    /**
     * The network-wide OpenCoins wallet balance (OpenVibe.Network-owned), read with the caller's Network JWT.
     * null when the wallet cannot answer (unreachable, or no Network account): the page says so instead of
     * showing a number that is not the balance.
     */
    async getGold(_userId, userToken = null) {
        return await wallet.balanceForToken(userToken);
    }

    /** Server-side earn/spend passthroughs (idempotency keys: `live:<event>:<id>`). */
    async credit(userId, amount, reason, idempotencyKey, ref) { return await wallet.credit(userId, amount, reason, idempotencyKey, ref); }
    async debit(userId, amount, reason, idempotencyKey, ref) { return await wallet.debit(userId, amount, reason, idempotencyKey, ref); }
    async transfer(fromId, toId, amount, reason, idempotencyKey, ref) { return await wallet.transfer(fromId, toId, amount, reason, idempotencyKey, ref); }

    /**
     * Get available rewards for a stream/channel
     * @param {number} streamerId - the streamer's user ID
     */
    async getRewards(streamerId) {
        const streamerRewards = await db.getCoinRewardsByStreamer(streamerId);
        // Also get global rewards
        const globals = await db.all(
            'SELECT * FROM coin_rewards WHERE is_global = 1 AND is_enabled = 1 ORDER BY sort_order, cost'
        );
        return [...globals, ...streamerRewards];
    }

    /**
     * Admin: grant OpenCoins to a user (network wallet credit).
     *
     * The grant is recorded locally first and the wallet credit is keyed by that record
     * (`live:admin_grant:<grant id>`, ADR-012 rule 5), so retrying a grant whose answer was lost
     * never credits twice. With `clientKey` (the request's Idempotency-Key) a repeated submit is
     * the same grant: it reuses the record and its key instead of making a second one.
     */
    async adminGrant(userId, amount, reason, { adminId = null, clientKey = null } = {}) {
        const d = db.getDb();
        const ck = clientKey ? `a${adminId || 0}:${clientKey}` : null;
        let grant = ck ? await d.prepare('SELECT * FROM opencoin_admin_grants WHERE client_key = ?').get(ck) : null;
        if (grant && (grant.user_id !== Number(userId) || grant.amount !== Number(amount))) {
            throw new Error('That Idempotency-Key was already used for a different grant');
        }
        if (!grant) {
            const id = (await d.prepare('INSERT INTO opencoin_admin_grants (client_key, admin_id, user_id, amount, reason) VALUES (?, ?, ?, ?, ?) RETURNING id')
                .run(ck, adminId, Number(userId), Number(amount), reason || null)).lastInsertRowid;
            grant = { id };
        }
        const result = await wallet.credit(userId, amount, reason || 'Admin grant', `live:admin_grant:${grant.id}`);
        if (!result) throw new Error('User has no linked OpenVibe.Network account (wallet unavailable)');
        await d.prepare('UPDATE opencoin_admin_grants SET balance = ? WHERE id = ?').run(result.balance ?? null, grant.id);
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
