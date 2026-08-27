'use strict';

/**
 * Shared notification helpers for OpenVibe.Live.
 * Pushes notifications to openvibe.network (the ONE notification store) via its internal API.
 *
 * Identity: callers pass LIVE user ids (req.user.id). The store is keyed by NETWORK user
 * ids, so every id is translated through linked_accounts(service='network') here. Users
 * who never signed in through the network have no linked row and are skipped (logged),
 * rather than being delivered to whichever unrelated network account shares the integer —
 * which is what used to happen.
 */

const config = require('../config');

const OV_NETWORK_INTERNAL_URL = (config.openvibeToolsInternalUrl || process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const INTERNAL_API_KEY = config.internalApiKey || process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY || '';

let _db = null;
function db() { if (!_db) _db = require('../db/database'); return _db; }

/** Live user id → Network user id (or null). */
function toNetworkId(liveUserId) {
    if (liveUserId == null) return null;
    try {
        const row = db().get("SELECT service_user_id FROM linked_accounts WHERE service = 'network' AND user_id = ?", [liveUserId]);
        const n = row && parseInt(row.service_user_id, 10);
        return Number.isInteger(n) && n > 0 ? n : null;
    } catch { return null; }
}
/** Batch translate; returns { ids: number[] (unique network ids), unlinked: number } */
function toNetworkIds(liveUserIds) {
    const ids = new Set(); let unlinked = 0;
    for (const id of (liveUserIds || [])) { const n = toNetworkId(id); if (n) ids.add(n); else unlinked++; }
    return { ids: [...ids], unlinked };
}

function _post(path, body) {
    if (!INTERNAL_API_KEY) return Promise.resolve(null);
    return fetch(`${OV_NETWORK_INTERNAL_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_API_KEY },
        body: JSON.stringify(body),
    });
}

/**
 * Push a single notification to a (LIVE) user. Fire-and-forget — does not block or throw.
 * Pass `network_user_id` instead of `user_id` to skip translation.
 */
function pushNotification(payload) {
    if (!payload) return;
    const networkId = payload.network_user_id || toNetworkId(payload.user_id);
    if (!networkId) { if (payload.user_id) console.log(`[Notify] user ${payload.user_id} has no linked network account — skipped ${payload.type || 'notification'}`); return; }
    const { user_id, network_user_id, ...rest } = payload;
    void user_id; void network_user_id;
    // sender_id is shown/deduped on the network side — translate it too when it is a Live id.
    if (rest.sender_id != null && !rest.sender_network_id) rest.sender_id = toNetworkId(rest.sender_id) || null;
    delete rest.sender_network_id;
    _post('/internal/notifications/push', { ...rest, user_id: networkId, service: rest.service || 'live' })
        .then(r => { if (r && !r.ok) console.warn(`[Notify] Push failed: ${r.status}`); })
        .catch(err => console.warn('[Notify] Push error:', err.message));
}

// Register this user as having a linked OpenVibe.Live account on openvibe.network so it
// appears under their Linked Services. Fire-and-forget + deduped per process.
const _linkedReported = new Set();
function reportLinkedAccount(user) {
    if (!user?.id || _linkedReported.has(user.id) || !INTERNAL_API_KEY) return;
    _linkedReported.add(user.id);
    const networkId = toNetworkId(user.id);
    if (!networkId) { _linkedReported.delete(user.id); return; }
    _post('/internal/link-account', {
        user_id: networkId,
        service: 'live',
        service_user_id: String(user.id),
        service_username: user.username || user.display_name || null,
    }).catch(() => { _linkedReported.delete(user.id); });
}

/**
 * Push the same notification to many LIVE users (translated, deduped, chunked to the
 * network's 1000-per-call limit).
 */
function pushBulkNotification(userIds, data, { alreadyNetworkIds = false } = {}) {
    if (!userIds?.length) return;
    const { ids, unlinked } = alreadyNetworkIds ? { ids: [...new Set(userIds)], unlinked: 0 } : toNetworkIds(userIds);
    if (unlinked) console.log(`[Notify] ${unlinked} of ${userIds.length} recipient(s) have no linked network account — skipped`);
    if (!ids.length) return;
    const body = { ...data, service: data.service || 'live' };
    if (body.sender_id != null && !alreadyNetworkIds) body.sender_id = toNetworkId(body.sender_id) || body.sender_id;
    for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        _post('/internal/notifications/push-bulk', { ...body, user_ids: chunk })
            .then(r => { if (r && !r.ok) console.warn(`[Notify] Bulk push failed: ${r.status}`); else if (r) console.log(`[Notify] Bulk ${body.type || 'notification'} sent to ${chunk.length} user(s)`); })
            .catch(err => console.warn('[Notify] Bulk push error:', err.message));
    }
}

/** Build sender info object from a (Live) user row. */
function actorInfo(user, fallback = 'Someone') {
    return {
        sender_id: user?.id || null,
        sender_name: user ? (user.display_name || user.username) : fallback,
        sender_avatar: user?.avatar_url || null,
    };
}

/**
 * Mark notifications as read on openvibe.network by type and optional URL pattern.
 * @param {number} userId  LIVE user id
 */
function markNotificationsRead(userId, type, urlPattern) {
    if (!userId || !type) return;
    const networkId = toNetworkId(userId);
    if (!networkId) return;
    _post('/internal/notifications/mark-read', { user_id: networkId, type, url_pattern: urlPattern || null })
        .catch(err => console.warn('[Notify] Mark-read error:', err.message));
}

module.exports = { pushNotification, pushBulkNotification, actorInfo, markNotificationsRead, reportLinkedAccount, toNetworkId, toNetworkIds, OV_NETWORK_INTERNAL_URL, INTERNAL_API_KEY };
