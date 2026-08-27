'use strict';
/**
 * "X is live" fan-out — ONE place, called from every go-live path (Go-Live page, OBS/RTMP
 * ingest, WHIP/browser). Sends followers' NETWORK ids to openvibe.network's unified
 * stream-live event (Discord + inbox + push + email), with a fallback to the plain bulk
 * push if the network is unreachable.
 *
 * Deduped per streamer+slot for 60 minutes: reconnects, deploy restarts and the recorder
 * re-creating a session must not spam followers.
 */
const config = require('../config');
const db = require('../db/database');
const { pushBulkNotification, toNetworkIds, toNetworkId, OV_NETWORK_INTERNAL_URL, INTERNAL_API_KEY } = require('../utils/notify');
const { notifyDiscordGoLive } = require('../integrations/discord-webhook');

const DEDUPE_MS = 60 * 60 * 1000;
const _recent = new Map(); // `${userId}:${slot}` → ts

function _channelUrl(streamer) { return `${(config.baseUrl || 'https://openvibe.live').replace(/\/$/, '')}/${streamer.username}`; }

function notifyFollowersGoLive(streamer, stream, { force = false } = {}) {
    if (!streamer || !streamer.id) return;
    const slot = (stream && (stream.managed_stream_id || stream.slot_slug)) || 'default';
    // Keyed by STREAMER (not slot): a person flapping between slots is still one person
    // going live. This in-memory guard is only a fast path — openvibe.network enforces the
    // persisted per-streamer cooldown + daily cap and reports `skipped` back.
    const key = String(streamer.id);
    const now = Date.now();
    if (!force && _recent.get(key) && now - _recent.get(key) < DEDUPE_MS) {
        console.log(`[GoLive] ${streamer.username}: followers already notified for slot ${slot} in the last hour — skipped`);
        return;
    }
    _recent.set(key, now);
    for (const [k, t] of _recent) if (now - t > DEDUPE_MS * 2) _recent.delete(k);

    let followerLiveIds = [];
    try { followerLiveIds = db.getFollowerIds(streamer.id) || []; } catch { /* */ }
    const { ids: followerNetworkIds, unlinked } = toNetworkIds(followerLiveIds);
    console.log(`[GoLive] ${streamer.username} (slot ${slot}): ${followerLiveIds.length} follower(s), ${followerNetworkIds.length} reachable on openvibe.network${unlinked ? `, ${unlinked} never linked` : ''}`);

    const payload = {
        streamer: {
            id: streamer.id,
            network_id: toNetworkId(streamer.id),
            username: streamer.username,
            display_name: streamer.display_name || null,
            avatar_url: streamer.avatar_url || null,
        },
        stream: {
            id: stream?.id || null,
            title: stream?.title || null,
            protocol: stream?.protocol || null,
            managed_stream_id: stream?.managed_stream_id || null,
            url: _channelUrl(streamer),
        },
        follower_network_ids: followerNetworkIds,
    };

    if (!INTERNAL_API_KEY) { _fallback(streamer, stream, followerNetworkIds); return; }
    fetch(`${OV_NETWORK_INTERNAL_URL}/internal/events/stream-live`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_API_KEY },
        body: JSON.stringify(payload),
    }).then(async (r) => {
        if (r.ok) {
            let d = null; try { d = await r.json(); } catch { /* */ }
            if (d && d.skipped) { console.log(`[GoLive] ${streamer.username}: network skipped announcement (${d.reason}${d.next_allowed_at ? `, next ${d.next_allowed_at}` : ''})`); return; }
            console.log(`[GoLive] Unified event sent for ${streamer.username}: notifications ${d?.notifications?.sent ?? '?'}/${d?.notifications?.total ?? '?'}, discord ${d?.discord?.sent ? 'sent' : 'no'}`);
        } else {
            console.warn(`[GoLive] Unified event failed (${r.status}), using fallback`);
            _fallback(streamer, stream, followerNetworkIds);
        }
    }).catch(err => {
        console.warn('[GoLive] Unified event error, using fallback:', err.message);
        _fallback(streamer, stream, followerNetworkIds);
    });
}

/** Fallback: direct Discord webhook + bulk push (if openvibe.network is down/unauthorized). */
function _fallback(streamer, stream, followerNetworkIds) {
    try { notifyDiscordGoLive(streamer, stream); } catch { /* */ }
    if (!followerNetworkIds.length) return;
    pushBulkNotification(followerNetworkIds, {
        type: 'STREAM_LIVE',
        title: `${streamer.display_name || streamer.username} is live!`,
        message: stream?.title || 'Started streaming',
        icon: '🔴',
        sender_id: toNetworkId(streamer.id),
        sender_name: streamer.display_name || streamer.username,
        sender_avatar: streamer.avatar_url || null,
        url: _channelUrl(streamer),
        rich_content: { thumbnail: streamer.avatar_url || null, context: { stream_id: stream?.id || null, username: streamer.username, title: stream?.title || 'Started streaming' } },
    }, { alreadyNetworkIds: true });
}

module.exports = { notifyFollowersGoLive };
