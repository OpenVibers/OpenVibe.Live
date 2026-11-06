'use strict';
/**
 * Agent-stream tickets.
 *
 * A publish ticket (`wpt_`, 32 random bytes, four hours) is what a desk publishes with; Live stores only its sha256
 * and never answers it again. One ticket is current per stream: renewing replaces it (the desk renews at three hours),
 * and revoking it is the kill switch — the route ends the WHIP session at once.
 *
 * A view ticket (`wvt_`, ten minutes) is what a player joins a private or unlisted stream with. It names the stream,
 * the person it was minted for (owner, a guest the sharing system allowed, or the holder of the unlisted link) and
 * when it dies. The page renews it while it is open; the embed's ticket is minted server-side for a caller with no
 * cookies.
 */
const db = require('../db/database');
const { PUBLISH_TICKET_TTL_MS, VIEW_TICKET_TTL_MS, sha256, token } = require('./service');

/** How long a chain of view-ticket renewals may last (the design's "at most 4 h"). */
const VIEW_RENEW_WINDOW_MS = 4 * 60 * 60 * 1000;

function expiry(ms) { return new Date(Date.now() + ms); }

// ── Publish tickets ────────────────────────────────────────────

/** A fresh publish ticket for this stream. Any earlier one stops working at once (one desk, one ticket). */
async function issuePublish(managedStreamId) {
    const raw = token('wpt_');
    const expires = expiry(PUBLISH_TICKET_TTL_MS);
    await db.getDb().tx(async () => {
        await db.run('UPDATE agent_publish_tickets SET revoked_at = now() WHERE managed_stream_id = ? AND revoked_at IS NULL', [managedStreamId]);
        await db.run('INSERT INTO agent_publish_tickets (managed_stream_id, token_hash, expires_at) VALUES (?, ?, ?)',
            [managedStreamId, sha256(raw), expires]);
    });
    return { ticket: raw, expires_at: expires.toISOString() };
}

/** The live ticket this raw value names, or null. Expired and revoked tickets are not tickets. */
async function findPublish(raw) {
    if (typeof raw !== 'string' || !/^wpt_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const row = await db.get(`SELECT * FROM agent_publish_tickets
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now()`, [sha256(raw)]);
    return row || null;
}

/** The session a ticket is bound to (the first WHIP POST that accepted it), if any. */
async function bindSession(ticketId, sessionId) {
    await db.run('UPDATE agent_publish_tickets SET session_id = COALESCE(session_id, ?) WHERE id = ?', [sessionId, ticketId]);
}

/** Every ticket of this stream stops working (revoked, expired or replaced). */
async function revokeAll(managedStreamId) {
    return await db.run('UPDATE agent_publish_tickets SET revoked_at = now() WHERE managed_stream_id = ? AND revoked_at IS NULL', [managedStreamId]);
}

/** The stream's current ticket expiry, for the desk's `ends_at`. */
async function currentExpiry(managedStreamId) {
    const row = await db.get(`SELECT expires_at FROM agent_publish_tickets
        WHERE managed_stream_id = ? AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`, [managedStreamId]);
    return row ? row.expires_at : null;
}

// ── View tickets ───────────────────────────────────────────────

/**
 * Mint a view ticket for this stream. `via` is who let the caller in. A chain of renewals may last four hours from its
 * first mint: `renewsUntil` carries that ceiling forward, a new ticket starts it.
 */
async function issueView(managedStreamId, { subject = null, via = 'owner', renewsUntil = null } = {}) {
    const raw = token('wvt_');
    const now = Date.now();
    const ceiling = renewsUntil ? new Date(renewsUntil) : new Date(now + VIEW_RENEW_WINDOW_MS);
    const expires = new Date(Math.min(now + VIEW_TICKET_TTL_MS, ceiling.getTime()));
    await db.run('INSERT INTO agent_view_tickets (managed_stream_id, token_hash, subject, via, expires_at, renews_until) VALUES (?, ?, ?, ?, ?, ?)',
        [managedStreamId, sha256(raw), subject, via, expires, ceiling]);
    return { ticket: raw, expires_at: expires.toISOString() };
}

/** The live view ticket this raw value names, for this stream, or null. */
async function findViewById(raw, managedStreamId) {
    if (typeof raw !== 'string' || !/^wvt_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const row = await db.get(`SELECT * FROM agent_view_tickets
        WHERE token_hash = ? AND managed_stream_id = ? AND expires_at > now()`, [sha256(raw), managedStreamId]);
    return row || null;
}

/** Housekeeping: tickets that expired are useless; they go so the table stays small. */
async function prune() {
    await db.run('DELETE FROM agent_publish_tickets WHERE expires_at < now() - interval \'1 day\'');
    await db.run('DELETE FROM agent_view_tickets WHERE expires_at < now() - interval \'1 day\'');
}

module.exports = {
    PUBLISH_TICKET_TTL_MS, VIEW_TICKET_TTL_MS,
    issuePublish, findPublish, bindSession, revokeAll, currentExpiry,
    issueView, findViewById, prune,
};
