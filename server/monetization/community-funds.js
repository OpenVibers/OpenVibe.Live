/**
 * OpenVibe.Live — Community Funds (legacy Vibes engine variant)
 *
 * Kept for the community-funds flows (donations, goals, escrow cashout with
 * admin approval). The active tipping currency engine is vibes.js — this module
 * is not currently mounted; see monetization/routes.js for the live routes.
 */
const db = require('../db/database');
const config = require('../config');

class CommunityFunds {
    /**
     * Purchase Vibes
     * @param {number} userId 
     * @param {number} amount - Number of Vibes to purchase
     * @param {string} paypalTxId - PayPal transaction ID
     */
    purchase(userId, amount, paypalTxId) {
        const tx = db.createTransaction({
            from_user_id: null,
            to_user_id: userId,
            amount,
            type: 'purchase',
            status: 'completed',
            message: `Purchased ${amount} Vibes`,
        });

        // Update PayPal reference
        if (paypalTxId) {
            db.run('UPDATE transactions SET paypal_transaction_id = ? WHERE id = ?',
                [paypalTxId, tx.lastInsertRowid]);
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
    donate(fromUserId, toUserId, streamId, amount, message) {
        if (amount <= 0) throw new Error('Amount must be positive');

        // Deduct from donor
        if (!db.deductVibes(fromUserId, amount)) {
            throw new Error('Insufficient Vibes');
        }

        // Credit streamer (held in their balance)
        db.addVibes(toUserId, amount);

        // Record transaction
        db.createTransaction({
            from_user_id: fromUserId,
            to_user_id: toUserId,
            stream_id: streamId,
            amount,
            type: 'donation',
            status: 'completed',
            message: message || null,
        });

        // Update donation goals
        this.updateGoals(toUserId, amount);

        return { success: true, amount };
    }

    /**
     * Update active donation goals for a user
     */
    updateGoals(userId, amount) {
        const goals = db.all(
            'SELECT * FROM donation_goals WHERE user_id = ? AND is_active = 1 ORDER BY created_at',
            [userId]
        );

        for (const goal of goals) {
            const newAmount = Math.min(goal.current_amount + amount, goal.target_amount);
            db.run('UPDATE donation_goals SET current_amount = ? WHERE id = ?',
                [newAmount, goal.id]);

            if (newAmount >= goal.target_amount) {
                db.run('UPDATE donation_goals SET is_active = 0 WHERE id = ?', [goal.id]);
            }
        }
    }

    /**
     * Request cashout (goes to escrow for admin review)
     */
    requestCashout(userId, amount, paypalEmail) {
        if (amount < config.openvibeBucks.minCashoutBucks) {
            throw new Error(`Minimum cashout is ${config.openvibeBucks.minCashoutBucks.toLocaleString()} Vibes`);
        }

        if (!db.deductVibes(userId, amount)) {
            throw new Error('Insufficient Vibes');
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
            usd_value: (amount / 100).toFixed(2),
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

        // Refund the amount
        db.addVibes(tx.from_user_id, tx.amount);
        db.run('UPDATE transactions SET status = ? WHERE id = ?', ['refunded', transactionId]);

        return tx;
    }

    /**
     * Get user's transaction history
     */
    getHistory(userId, limit = 50) {
        return db.all(`
            SELECT * FROM transactions
            WHERE from_user_id = ? OR to_user_id = ?
            ORDER BY created_at DESC LIMIT ?
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
     * Get active donation goals for a user
     */
    getGoals(userId) {
        return db.all(
            'SELECT * FROM donation_goals WHERE user_id = ? AND is_active = 1 ORDER BY created_at',
            [userId]
        );
    }

    /**
     * Create a donation goal
     */
    createGoal(userId, title, targetAmount) {
        return db.run(
            'INSERT INTO donation_goals (user_id, title, target_amount) VALUES (?, ?, ?)',
            [userId, title, targetAmount]
        );
    }
}

module.exports = new CommunityFunds();
