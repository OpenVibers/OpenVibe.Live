'use strict';
/**
 * channel_tips: every tip a channel received, as Live shows it (migrations/0009_channel_tips.sql). Recorded by the
 * three paths that announce a tip (POST /api/funds/donate, integrations/powerchat-webhook.js, tips/delivery-routes.js)
 * and read by the stream leaderboard, the after-stream recap, VOD pages and the home stats. Display rows, never money:
 * Live's `transactions` or OpenVibe.Billing is the ledger.
 */
const db = require('../db/database');

const SOURCES = new Set(['vibes', 'powerchat', 'tips']);

/**
 * Record one tip. ref is the tip's own id (a repeat keeps one row). amount null = hidden by the supporter. Never
 * throws: a display row that failed to save must not fail the tip that was already announced.
 */
async function record({ toUserId, fromUserId = null, username = null, streamId = null, amount = null, source, ref }) {
    if (!toUserId || !SOURCES.has(source) || !ref) return false;
    const amt = amount == null ? null : Math.max(0, Math.round(Number(amount) || 0));
    try {
        const r = await db.run(`INSERT INTO channel_tips (to_user_id, from_user_id, username, stream_id, amount, source, ref)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING`,
        [Number(toUserId), fromUserId ? Number(fromUserId) : null, fromUserId ? null : (username ? String(username).slice(0, 80) : null),
            streamId ? Number(streamId) : null, amt, source, String(ref).slice(0, 200)]);
        return r.changes > 0;
    } catch (e) {
        console.warn('[channel-tips] not recorded:', e.message);
        return false;
    }
}

/** SQL for one supporter, with or without a Live account (alias `t` for channel_tips). */
const SUPPORTER_KEY = "COALESCE(t.from_user_id::text, 'n:' || lower(COALESCE(t.username, '')))";

module.exports = { record, SUPPORTER_KEY };
