/**
 * OpenVibe.Live — Community Funds (legacy Vibes engine variant)
 *
 * Kept for the community-funds flows (donations, goals, escrow cashout with
 * admin approval). The active tipping currency engine is vibes.js — this module
 * is not currently mounted; see monetization/routes.js for the live routes.
 */
const db = require('../db/database');
const config = require('../config');
const { assertLiveLedger } = require('./money-authority');

class CommunityFunds {
    /**
     * Purchase Vibes
     * @param {number} userId 
     * @param {number} amount - Number of Vibes to purchase
     * @param {string} paypalTxId - PayPal transaction ID
     */
    async purchase(userId, amount, paypalTxId) {
        assertLiveLedger('transactions insert');
        const tx = await db.run(`INSERT INTO transactions (from_user_id, to_user_id, amount, type, status, message)
            VALUES (NULL, ?, ?, 'purchase', 'completed', ?) RETURNING id`, [userId, amount, `Purchased ${amount} Vibes`]);

        // Update PayPal reference
        if (paypalTxId) {
            await db.run('UPDATE transactions SET paypal_transaction_id = ? WHERE id = ?',
                [paypalTxId, tx.lastInsertRowid]);
        }

        await db.addVibes(userId, amount);
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
    async donate(fromUserId, toUserId, streamId, amount, message) {
        if (amount <= 0) throw new Error('Amount must be positive');

        // Deduct from donor
        if (!await db.deductVibes(fromUserId, amount)) {
            throw new Error('Insufficient Vibes');
        }

        // Credit streamer (held in their balance)
        await db.addVibes(toUserId, amount);

        // Record transaction
        await db.createTransaction({
            from_user_id: fromUserId,
            to_user_id: toUserId,
            stream_id: streamId,
            amount,
            type: 'donation',
            status: 'completed',
            message: message || null,
        });

        // Update donation goals
        await this.updateGoals(toUserId, amount);

        return { success: true, amount };
    }

    /**
     * Update active donation goals for a user
     */
    async updateGoals(userId, amount) {
        const goals = await db.all(
            'SELECT * FROM donation_goals WHERE user_id = ? AND is_active = 1 ORDER BY created_at',
            [userId]
        );

        for (const goal of goals) {
            const newAmount = Math.min(goal.current_amount + amount, goal.target_amount);
            await db.run('UPDATE donation_goals SET current_amount = ? WHERE id = ?',
                [newAmount, goal.id]);

            if (newAmount >= goal.target_amount) {
                await db.run('UPDATE donation_goals SET is_active = 0 WHERE id = ?', [goal.id]);
            }
        }
    }

    /**
     * Request cashout (goes to escrow for admin review)
     */
    async requestCashout(userId, amount, paypalEmail) {
        assertLiveLedger('transactions insert');
        if (amount < config.openvibeBucks.minCashoutBucks) {
            throw new Error(`Minimum cashout is ${config.openvibeBucks.minCashoutBucks.toLocaleString()} Vibes`);
        }

        if (!await db.deductVibes(userId, amount)) {
            throw new Error('Insufficient Vibes');
        }

        const tx = await db.run(`INSERT INTO transactions (from_user_id, to_user_id, amount, type, status, message)
            VALUES (?, NULL, ?, 'cashout', 'escrow', ?) RETURNING id`, [userId, amount, `Cashout to PayPal: ${paypalEmail}`]);

        return {
            transaction_id: tx.lastInsertRowid,
            amount,
            usd_value: (amount / 100).toFixed(2),
            status: 'escrow',
            hold_days: config.openvibeBucks.escrowDays,
        };
    }

    /**
     * Admin: Approve a cashout (release from escrow)
     */
    async approveCashout(transactionId) {
        const tx = await db.get('SELECT * FROM transactions WHERE id = ? AND status = ?',
            [transactionId, 'escrow']);
        if (!tx) throw new Error('Transaction not found or not in escrow');

        await db.run('UPDATE transactions SET status = ? WHERE id = ?', ['completed', transactionId]);
        return tx;
    }

    /**
     * Admin: Deny a cashout (refund to user)
     */
    async denyCashout(transactionId, reason) {
        const tx = await db.get('SELECT * FROM transactions WHERE id = ? AND status = ?',
            [transactionId, 'escrow']);
        if (!tx) throw new Error('Transaction not found or not in escrow');

        // Refund the amount
        await db.addVibes(tx.from_user_id, tx.amount);
        await db.run('UPDATE transactions SET status = ? WHERE id = ?', ['refunded', transactionId]);

        return tx;
    }

    /**
     * Get user's transaction history
     */
    async getHistory(userId, limit = 50) {
        return await db.all(`
            SELECT * FROM transactions
            WHERE from_user_id = ? OR to_user_id = ?
            ORDER BY created_at DESC LIMIT ?
        `, [userId, userId, limit]);
    }

    /**
     * Get donation leaderboard for a stream
     */
    async getLeaderboard(streamId, limit = 10) {
        return await db.all(`
            SELECT from_user_id, u.username, u.display_name, u.avatar_url,
                   SUM(amount)::bigint as total_donated
            FROM transactions t
            JOIN users u ON t.from_user_id = u.id
            WHERE t.stream_id = ? AND t.type = 'donation' AND t.status = 'completed'
            GROUP BY from_user_id, u.id
            ORDER BY total_donated DESC
            LIMIT ?
        `, [streamId, limit]);
    }

    /**
     * Get active donation goals for a user
     */
    async getGoals(userId) {
        return await db.all(
            'SELECT * FROM donation_goals WHERE user_id = ? AND is_active = 1 ORDER BY created_at',
            [userId]
        );
    }

    /**
     * Create a donation goal
     */
    async createGoal(userId, title, targetAmount) {
        return await db.run(
            'INSERT INTO donation_goals (user_id, title, target_amount) VALUES (?, ?, ?)',
            [userId, title, targetAmount]
        );
    }
}

module.exports = new CommunityFunds();
