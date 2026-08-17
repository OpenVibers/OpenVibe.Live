'use strict';

/**
 * Shared notification helpers for OpenVibe.Live.
 * Pushes notifications to openvibe-tools via internal API.
 */

const OV_NETWORK_INTERNAL_URL = process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:3100';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY || '';

/**
 * Push a single notification to a user via openvibe-tools internal API.
 * Fire-and-forget — does not block or throw.
 * @param {Object} payload - Notification fields (user_id required)
 */
function pushNotification(payload) {
    if (!payload?.user_id) return;

    fetch(`${OV_NETWORK_INTERNAL_URL}/internal/notifications/push`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_API_KEY,
        },
        body: JSON.stringify({ ...payload, service: payload.service || 'live' }),
    }).then(r => {
        if (!r.ok) console.warn(`[Notify] Push failed: ${r.status}`);
    }).catch(err => {
        console.warn('[Notify] Push error:', err.message);
    });
}

// Register this user as having a linked OpenVibe.Live account on openvibe.tools so it
// appears under their Linked Services. Fire-and-forget + deduped per process.
const _linkedReported = new Set();
function reportLinkedAccount(user) {
    if (!user?.id || _linkedReported.has(user.id) || !INTERNAL_API_KEY) return;
    _linkedReported.add(user.id);
    fetch(`${OV_NETWORK_INTERNAL_URL}/internal/link-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_API_KEY },
        body: JSON.stringify({
            user_id: user.id,
            service: 'live',
            service_user_id: String(user.id),
            service_username: user.username || user.display_name || null,
        }),
    }).catch(() => { _linkedReported.delete(user.id); });
}

/**
 * Push bulk notifications to multiple users.
 * @param {number[]} userIds - Array of user IDs
 * @param {Object} data - Notification fields (without user_id)
 */
function pushBulkNotification(userIds, data) {
    if (!userIds?.length) return;

    fetch(`${OV_NETWORK_INTERNAL_URL}/internal/notifications/push-bulk`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_API_KEY,
        },
        body: JSON.stringify({ user_ids: userIds, ...data, service: data.service || 'live' }),
    }).then(r => {
        if (!r.ok) console.warn(`[Notify] Bulk push failed: ${r.status}`);
        else console.log(`[Notify] Bulk sent to ${userIds.length} users`);
    }).catch(err => {
        console.warn('[Notify] Bulk push error:', err.message);
    });
}

/**
 * Build sender info object from a user row.
 */
function actorInfo(user, fallback = 'Someone') {
    return {
        sender_id: user?.id || null,
        sender_name: user ? (user.display_name || user.username) : fallback,
        sender_avatar: user?.avatar_url || null,
    };
}

/**
 * Mark notifications as read on openvibe-tools by type and optional URL pattern.
 * Fire-and-forget.
 * @param {number} userId
 * @param {string} type - e.g. 'DIRECT_MESSAGE'
 * @param {string} [urlPattern] - SQL LIKE pattern, e.g. '%/dm/42'
 */
function markNotificationsRead(userId, type, urlPattern) {
    if (!userId || !type) return;

    fetch(`${OV_NETWORK_INTERNAL_URL}/internal/notifications/mark-read`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_API_KEY,
        },
        body: JSON.stringify({ user_id: userId, type, url_pattern: urlPattern || null }),
    }).catch(err => {
        console.warn('[Notify] Mark-read error:', err.message);
    });
}

module.exports = { pushNotification, pushBulkNotification, actorInfo, markNotificationsRead, reportLinkedAccount };
