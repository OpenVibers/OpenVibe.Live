/**
 * OpenVibe.Live — Vibes Engine
 * 
 * Virtual currency: integer "bit"-style Vibes. 100 Bucks = $1.00 streamer cashout.
 * Viewers buy at a premium with volume discounts (priceUsdForBucks) — the platform margin.
 * Features: 
 *   - Buy Vibes (PayPal)
 *   - Donate to streamers
 *   - Donation goals with progress bars
 *   - Escrow cashout with admin approval
 *   - Subscription tiers
 */
const db = require('../db/database');
const config = require('../config');

// Vibes are integer "bit"-style units: 100 bucks = $1.00 streamer cashout.
const CASHOUT_BUCKS_PER_USD = 100;
const MAX_BUCKS = 10_000_000;

function normalizeBucks(amount) {
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value)) throw new Error('Amount must be a valid number');
    if (value <= 0) throw new Error('Amount must be a positive whole number of Vibes');
    if (value > MAX_BUCKS) throw new Error('Amount exceeds maximum allowed');
    return value;
}

// Streamer cashout value of N bucks, in USD.
function cashoutUsd(bucks) { return Math.round((Number(bucks) || 0)) / CASHOUT_BUCKS_PER_USD; }

// Viewer purchase price (USD) for buying `bucks`. Volume discount: bigger buys are
// cheaper per buck. Cashout is fixed at $0.01/buck, so the spread is the platform margin.
const BUCKS_PRICE_TIERS = [
    { min: 25000, perBuck: 0.0110 },
    { min: 10000, perBuck: 0.0115 },
    { min: 5000,  perBuck: 0.0120 },
    { min: 2500,  perBuck: 0.0124 },
    { min: 1000,  perBuck: 0.0130 },
    { min: 500,   perBuck: 0.0140 },
    { min: 0,     perBuck: 0.0150 },
];
function priceUsdForBucks(bucks) {
    const b = Math.max(0, Math.round(Number(bucks) || 0));
    const tier = BUCKS_PRICE_TIERS.find(t => b >= t.min) || BUCKS_PRICE_TIERS[BUCKS_PRICE_TIERS.length - 1];
    return Math.round(b * tier.perBuck * 100) / 100; // USD, cents precision
}
// Preset packages surfaced in the buy UI.
const BUCKS_PACKAGES = [100, 500, 1000, 2500, 5000, 10000, 25000].map(bucks => ({
    bucks, usd: priceUsdForBucks(bucks),
}));

function normalizeText(value, maxLen = 300) {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > maxLen) throw new Error(`Text must be ${maxLen} characters or fewer`);
    return text;
}

function validatePaypalEmail(value) {
    const email = String(value || '').trim();
    if (!email) throw new Error('PayPal email required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw new Error('Invalid PayPal email');
    }
    return email;
}

class Vibes {
    /**
     * Purchase Vibes
     * @param {number} userId 
     * @param {number} amount - Number of Vibes to purchase
     * @param {string} paypalTxId - PayPal transaction ID
     */
    purchase(userId, amount, paypalTxId) {
        amount = normalizeBucks(amount);
        const txId = normalizeText(paypalTxId, 128);
        const tx = db.createTransaction({
            from_user_id: null,
            to_user_id: userId,
            amount,
            type: 'purchase',
            status: 'completed',
            message: `Purchased ${amount} Vibes`,
        });

        // Update PayPal reference
        if (txId) {
            db.run('UPDATE transactions SET paypal_transaction_id = ? WHERE id = ?',
            [txId, tx.lastInsertRowid]);
        }

        db.addVibes(userId, amount);
        return tx;
    }

    /**
     * Donate Vibes to a streamer
     * @param {number} fromUserId - Donor
     * @param {number} toUserId - Streamer
     * @param {number} streamId - Current stream
     * @param {number} amount - Vibes to donate
     * @param {string} message - Donation message
     */
    donate(fromUserId, toUserId, streamId, amount, message, goalId = null) {
        amount = normalizeBucks(amount);
        message = normalizeText(message, 300);

        // Deduct from donor
        if (!db.deductVibes(fromUserId, amount)) {
            throw new Error('Insufficient Vibes');
        }

        // Credit the streamer's CASHOUT balance (received bucks are the only cashout-able
        // ones; their spendable balance is for bucks they bought).
        db.addVibesCashout(toUserId, amount);

        // Record transaction
        const txn = db.createTransaction({
            from_user_id: fromUserId,
            to_user_id: toUserId,
            stream_id: streamId,
            amount,
            type: 'donation',
            status: 'completed',
            message: message || null,
        });

        // Apply toward a donation goal (the donor's pick, else the sole active goal).
        const goalResult = this.applyDonationToGoal(toUserId, amount, goalId);

        return {
            success: true,
            amount,
            transactionId: txn && txn.lastInsertRowid ? Number(txn.lastInsertRowid) : null,
            goal: goalResult ? goalResult.goal : null,      // the goal that advanced (for the widget)
            goalReached: goalResult && goalResult.reached ? goalResult.goal : null,
        };
    }

    /**
     * Route a donation toward a single goal: the donor's chosen goal if valid+active,
     * otherwise the streamer's sole active goal (if exactly one). Returns
     * { goal, reached } for the goal that advanced, or null if none applied.
     */
    applyDonationToGoal(userId, amount, goalId = null) {
        const uid = Number(userId);
        let target = null;
        if (goalId) {
            const g = db.getDonationGoalById(goalId);
            if (g && Number(g.user_id) === uid && g.is_active) target = g;
        }
        if (!target) {
            const active = db.getActiveDonationGoals(uid);
            if (active.length === 1) target = active[0];
        }
        if (!target) return null;
        return db.addToDonationGoal(target.id, amount);
    }

    /**
     * Request cashout (goes to escrow for admin review)
     */
    requestCashout(userId, amount, paypalEmail) {
        amount = normalizeBucks(amount);
        paypalEmail = validatePaypalEmail(paypalEmail);
        const minBucks = config.openvibeBucks.minCashoutBucks;
        if (amount < minBucks) {
            throw new Error(`Minimum cashout is ${minBucks.toLocaleString()} Vibes ($${cashoutUsd(minBucks).toFixed(2)})`);
        }

        // Only the cashout balance (received donations) can be cashed out.
        if (!db.deductVibesCashout(userId, amount)) {
            throw new Error('Insufficient cashout balance — only Vibes sent to you can be cashed out');
        }

        const tx = db.createTransaction({
            from_user_id: userId,
            to_user_id: null,
            amount,
            type: 'cashout',
            status: 'escrow',
            message: `Cashout to PayPal: ${paypalEmail}`,
        });

        return {
            transaction_id: tx.lastInsertRowid,
            amount,
            usd_value: cashoutUsd(amount).toFixed(2),
            status: 'escrow',
            hold_days: config.openvibeBucks.escrowDays,
        };
    }

    /**
     * Admin: Approve a cashout (release from escrow)
     */
    approveCashout(transactionId) {
        const tx = db.get('SELECT * FROM transactions WHERE id = ? AND status = ?',
            [transactionId, 'escrow']);
        if (!tx) throw new Error('Transaction not found or not in escrow');

        db.run('UPDATE transactions SET status = ? WHERE id = ?', ['completed', transactionId]);
        return tx;
    }

    /**
     * Admin: Deny a cashout (refund to user)
     */
    denyCashout(transactionId, reason) {
        const tx = db.get('SELECT * FROM transactions WHERE id = ? AND status = ?',
            [transactionId, 'escrow']);
        if (!tx) throw new Error('Transaction not found or not in escrow');

        // Refund back to the cashout balance it came from.
        db.addVibesCashout(tx.from_user_id, tx.amount);
        db.run('UPDATE transactions SET status = ? WHERE id = ?', ['refunded', transactionId]);

        return tx;
    }

    /**
     * Recycle: move Vibes from the streamer's cashout balance into their spendable
     * balance, so they can re-donate / give back to the community instead of cashing out.
     */
    recycleCashout(userId, amount) {
        amount = normalizeBucks(amount);
        if (!db.deductVibesCashout(userId, amount)) {
            throw new Error('Insufficient cashout balance');
        }
        db.addVibes(userId, amount);
        db.createTransaction({
            from_user_id: userId,
            to_user_id: userId,
            amount,
            type: 'recycle',
            status: 'completed',
            message: 'Moved cashout balance to spendable Vibes',
        });
        const user = db.getUserById(userId);
        return {
            success: true,
            amount,
            balance: user.openvibe_bucks_balance,
            cashout_balance: user.openvibe_bucks_cashout_balance,
        };
    }

    /**
     * Get user's transaction history
     */
    getHistory(userId, limit = 50) {
        return db.all(`
            SELECT t.*,
                   fu.username AS from_username, fu.display_name AS from_display,
                   tu.username AS to_username, tu.display_name AS to_display
            FROM transactions t
            LEFT JOIN users fu ON t.from_user_id = fu.id
            LEFT JOIN users tu ON t.to_user_id = tu.id
            WHERE t.from_user_id = ? OR t.to_user_id = ?
            ORDER BY t.created_at DESC LIMIT ?
        `, [userId, userId, limit]);
    }

    /**
     * Get donation leaderboard for a stream
     */
    getLeaderboard(streamId, limit = 10) {
        return db.all(`
            SELECT from_user_id, u.username, u.display_name, u.avatar_url,
                   SUM(amount) as total_donated
            FROM transactions t
            JOIN users u ON t.from_user_id = u.id
            WHERE t.stream_id = ? AND t.type = 'donation' AND t.status = 'completed'
            GROUP BY from_user_id
            ORDER BY total_donated DESC
            LIMIT ?
        `, [streamId, limit]);
    }

    /**
     * Goals shown to viewers in the on-stream widget: active goals + any reached in the
     * last hour (so a completed goal celebrates, then auto-clears).
     */
    getGoals(userId) {
        return db.getDonationGoalsForWidget(userId, 1);
    }

    /** All of a streamer's goals (active + completed) for the dashboard manager. */
    getManageGoals(userId) {
        return db.getAllDonationGoals(userId);
    }

    /**
     * Create a donation goal (optionally with an uploaded image/video already
     * transcoded to a served URL).
     */
    createGoal(userId, { title, target_amount, image_url = null, media_type = null } = {}) {
        const safeTitle = normalizeText(title, 120);
        const safeAmount = Math.round(normalizeBucks(target_amount));
        if (!safeTitle) throw new Error('Title is required');
        const mt = ['image', 'video'].includes(media_type) ? media_type : null;
        return db.createDonationGoal(userId, { title: safeTitle, target_amount: safeAmount, image_url: image_url || null, media_type: mt });
    }

    /** Update a goal the user owns. */
    updateGoal(id, userId, patch = {}) {
        const g = db.getDonationGoalById(id);
        if (!g || Number(g.user_id) !== Number(userId)) throw new Error('Goal not found');
        const fields = {};
        if (patch.title !== undefined) { const t = normalizeText(patch.title, 120); if (!t) throw new Error('Title is required'); fields.title = t; }
        if (patch.target_amount !== undefined) fields.target_amount = Math.round(normalizeBucks(patch.target_amount));
        if (patch.image_url !== undefined) fields.image_url = patch.image_url || null;
        if (patch.media_type !== undefined) fields.media_type = ['image', 'video'].includes(patch.media_type) ? patch.media_type : null;
        if (patch.is_active !== undefined) {
            fields.is_active = patch.is_active ? 1 : 0;
            // Re-activating a goal clears its reached_at so it isn't stuck in the
            // celebration window (the column only became updatable with the manual
            // current-amount editing — before that this intent silently did nothing).
            if (patch.is_active) {
                fields.reached_at = null;
                fields.current_amount = Math.min(g.current_amount, g.target_amount - 1 < 0 ? 0 : g.target_amount);
            }
        }
        if (patch.sort_order !== undefined) fields.sort_order = parseInt(patch.sort_order, 10) || 0;
        // Manual progress correction — for money that arrived outside the site (cash,
        // an external tip, a miscount). Clamped to [0, target]; filling the goal by
        // hand completes it exactly like a donation would, but QUIETLY (no goal-reached
        // celebration — this is bookkeeping, not a live donation moment).
        if (patch.current_amount !== undefined) {
            const target = fields.target_amount !== undefined ? fields.target_amount : g.target_amount;
            const cur = Math.min(Math.max(0, Math.round(Number(patch.current_amount) || 0)), target);
            fields.current_amount = cur;
            const activeAfter = fields.is_active !== undefined ? !!fields.is_active : !!g.is_active;
            if (cur >= target && target > 0 && activeAfter) {
                fields.is_active = 0;
                fields.reached_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
            }
        }
        db.updateDonationGoal(id, userId, fields);
        return db.getDonationGoalById(id);
    }

    /** Delete a goal the user owns; returns the removed row (for media cleanup). */
    deleteGoal(id, userId) {
        const g = db.getDonationGoalById(id);
        if (!g || Number(g.user_id) !== Number(userId)) throw new Error('Goal not found');
        db.deleteDonationGoal(id, userId);
        return g;
    }
}

const _openvibeBucks = new Vibes();
// Expose the pricing/cashout helpers + packages on the singleton for routes.
_openvibeBucks.priceUsdForBucks = priceUsdForBucks;
_openvibeBucks.cashoutUsd = cashoutUsd;
_openvibeBucks.normalizeBucks = normalizeBucks;
_openvibeBucks.BUCKS_PACKAGES = BUCKS_PACKAGES;
_openvibeBucks.CASHOUT_BUCKS_PER_USD = CASHOUT_BUCKS_PER_USD;
module.exports = _openvibeBucks;
