/**
 * OpenVibe.Live — Vibes Engine
 * 
 * Vibes are integer "bit"-style units: 100 = $1.00 of streamer cashout value, bought at a premium with volume
 * discounts (priceUsdForBucks). OpenVibe.Billing keeps every balance and moves every Vibe since 2026-10-17
 * (billing-actions.js); what stays here is the arithmetic, the channel's donation goals and its tip leaderboard
 * (channel_tips).
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

class Vibes {
    /**
     * Route a donation toward a single goal: the donor's chosen goal if valid+active,
     * otherwise the streamer's sole active goal (if exactly one). Returns
     * { goal, reached } for the goal that advanced, or null if none applied.
     */
    async applyDonationToGoal(userId, amount, goalId = null) {
        const uid = Number(userId);
        let target = null;
        if (goalId) {
            const g = await db.getDonationGoalById(goalId);
            if (g && Number(g.user_id) === uid && g.is_active) target = g;
        }
        if (!target) {
            const active = await db.getActiveDonationGoals(uid);
            if (active.length === 1) target = active[0];
        }
        if (!target) return null;
        return await db.addToDonationGoal(target.id, amount);
    }

    /**
     * A stream's tip leaderboard from channel_tips (on-site Vibes, PowerChat and OpenVibe.Tips alike). A supporter
     * without a Live account has from_user_id and username null and their name as display_name.
     */
    async getLeaderboard(streamId, limit = 10) {
        const { SUPPORTER_KEY } = require('./channel-tips');
        return await db.all(`
            SELECT MAX(t.from_user_id) AS from_user_id, MAX(u.username) AS username,
                   MAX(COALESCE(u.display_name, u.username, t.username)) AS display_name, MAX(u.avatar_url) AS avatar_url,
                   SUM(t.amount)::bigint AS total_donated
            FROM channel_tips t
            LEFT JOIN users u ON t.from_user_id = u.id
            WHERE t.stream_id = ? AND t.amount IS NOT NULL
            GROUP BY ${SUPPORTER_KEY}
            ORDER BY total_donated DESC
            LIMIT ?
        `, [streamId, limit]);
    }

    /**
     * Goals shown to viewers in the on-stream widget: active goals + any reached in the
     * last hour (so a completed goal celebrates, then auto-clears).
     */
    async getGoals(userId) {
        return await db.getDonationGoalsForWidget(userId, 1);
    }

    /** All of a streamer's goals (active + completed) for the dashboard manager. */
    async getManageGoals(userId) {
        return await db.getAllDonationGoals(userId);
    }

    /**
     * Create a donation goal (optionally with an uploaded image/video already
     * transcoded to a served URL).
     */
    async createGoal(userId, { title, target_amount, image_url = null, media_type = null } = {}) {
        const safeTitle = normalizeText(title, 120);
        const safeAmount = Math.round(normalizeBucks(target_amount));
        if (!safeTitle) throw new Error('Title is required');
        const mt = ['image', 'video'].includes(media_type) ? media_type : null;
        return await db.createDonationGoal(userId, { title: safeTitle, target_amount: safeAmount, image_url: image_url || null, media_type: mt });
    }

    /** Update a goal the user owns. */
    async updateGoal(id, userId, patch = {}) {
        const g = await db.getDonationGoalById(id);
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
        await db.updateDonationGoal(id, userId, fields);
        return await db.getDonationGoalById(id);
    }

    /** Delete a goal the user owns; returns the removed row (for media cleanup). */
    async deleteGoal(id, userId) {
        const g = await db.getDonationGoalById(id);
        if (!g || Number(g.user_id) !== Number(userId)) throw new Error('Goal not found');
        await db.deleteDonationGoal(id, userId);
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
