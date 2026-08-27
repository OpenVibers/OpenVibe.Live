/**
 * powerchat-platform.js — PLATFORM direction (OpenVibe.Live sends data INTO PowerChat).
 *
 * When a streamer has connected PowerChat with the relevant scopes, OpenVibe.Live acts
 * like a streaming platform feeding PowerChat's unified overlays:
 *   - chat:write          → real OpenVibe.Live chat merges into the unified chat overlay
 *   - viewcount:write     → OpenVibe.Live's viewer count shows as its own branded chip
 *   - follows:write       → new follows fire PowerChat follow alerts + follow goals
 *   - subscriptions:write → paid channel subs fire sub alerts + credit goals/subathon
 *   - currency:write      → channel-point redemptions fire PowerChat alerts + leaderboards
 *   - tips:write          → on-site Vibes donations fire PowerChat tip alerts + credit
 *                           tip goals/totals (Vibes are bit-style: 100 = $1, so the
 *                           declared currency carries unitsPerUsd=100)
 *
 * Everything is best-effort and scope-gated: a missing scope / sandbox restriction just
 * makes the call a no-op (PowerChat also checks scopes live and 403s, which we surface
 * on the connection's last_error so the dashboard can prompt a reconnect).
 */
'use strict';
const crypto = require('crypto');
const db = require('../db/database');
const oauth = require('./powerchat-oauth');
const config = require('../config');

// Virtual-currency keys the app declares in the PowerChat dashboard.
// - openvibe_points: points-only (no USD rate) — channel-point redemptions.
// - openvibe_vibes:  monetary — MUST be declared with unitsPerUsd=100 (Vibes are
//   bit-style, 100 Vibes = $1) or POST /tips 400s with "no USD rate".
const CURRENCY_KEY = 'openvibe_points';
const TIP_CURRENCY_KEY = 'openvibe_vibes';

// PowerChat's /chat avatarUrl only renders when it's a full absolute http(s) URL — relative
// paths, data:/blob:, or bare values are silently treated as "no avatar" (an initial-letter
// placeholder shows instead). OpenVibe.Live stores avatars as site-relative paths
// (e.g. /data/pastes/screenshots/..), so we resolve them against the public base URL and
// prefer https so the avatar actually displays on the overlay.
function _absoluteAvatarUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const url = raw.trim();
    if (!url) return null;
    if (/^https:\/\//i.test(url)) return url;                 // already displayable
    if (/^http:\/\//i.test(url)) {                            // absolute but http
        try {
            const u = new URL(url);
            const baseHost = new URL(config.baseUrl).host;
            if (u.host === baseHost) { u.protocol = 'https:'; return u.toString(); } // upgrade our own host
        } catch { /* fall through */ }
        return url;                                           // foreign http — best effort
    }
    if (url.startsWith('/')) {                                // site-relative → absolutise
        const base = String(config.baseUrl || '').replace(/\/+$/, '');
        if (!base) return null;
        return (base + url).replace(/^http:\/\//i, 'https://'); // public base is https in prod
    }
    return null;                                              // data:/blob:/bare — not displayable
}

// Only a real OAuth app connection (has tokens) with the needed scope may push.
function _connFor(userId, scopeNeeded) {
    try {
        if (!oauth.getConfig().enabled) return null;
        const conn = db.getPowerchatConnection(userId);
        if (!conn || !conn.access_token || !conn.refresh_token) return null;
        if (scopeNeeded && conn.scope && !String(conn.scope).split(/\s+/).includes(scopeNeeded)) {
            // The grant was minted without this scope (classic "registered but not
            // requested"). Surface it once so the dashboard can prompt a reconnect —
            // silently skipping here is exactly how "0 viewers on the overlay" happens.
            _noteScopeGap(userId, scopeNeeded);
            return null;
        }
        return conn;
    } catch { return null; }
}

// Record a missing-scope condition on the connection at most once per hour per scope,
// so /status can say "reconnect to grant X" instead of the relay failing invisibly.
const _scopeGapNoted = new Map(); // `${userId}:${scope}` → notedAt
function _noteScopeGap(userId, scope) {
    const key = `${userId}:${scope}`;
    const now = Date.now();
    if ((_scopeGapNoted.get(key) || 0) > now - 3600000) return;
    _scopeGapNoted.set(key, now);
    console.warn(`[PowerChat] user ${userId}'s grant is missing scope ${scope} — reconnect (re-consent) required for that feature`);
    try { db.setPowerchatConnectionError(userId, `Reconnect needed: your PowerChat grant is missing the "${scope}" permission`); } catch { /* */ }
}

// A 403 from PowerChat means the scope was granted but later disabled/shrunk by the
// streamer (or sandbox restriction). Same remedy: surface it, rate-limited.
function _noteApiError(userId, scope, err) {
    if (err && err.status === 403) _noteScopeGap(userId, `${scope} (disabled on PowerChat)`);
}

// Undeclared-currency warnings, once per 10 min per key — the earn flusher would
// otherwise print one line per buffered viewer per flush.
const _undeclaredWarned = new Map();
function _warnUndeclared(key, message) {
    const now = Date.now();
    if ((_undeclaredWarned.get(key) || 0) > now - 600000) return;
    _undeclaredWarned.set(key, now);
    console.warn(`[PowerChat] ${message}`);
}

// ── Relay routing preferences ────────────────────────────────
// Streamers choose, per stream slot and per restream destination, which chat is
// merged into their PowerChat overlay (Broadcast page → slot settings / destination
// editor). Everything defaults to ON; a missing row/column means "relay".
// Slot switch: covers the slot's native chat, its RobotStreamer mirror and every
// restream-destination relay attached to it. `streamId` may be null (offline channel
// chat) → allowed.
function slotRelayEnabled(streamId) {
    if (!streamId) return true;
    try {
        const stream = db.getStreamById(streamId);
        if (!stream || !stream.managed_stream_id) return true;
        const ms = db.get('SELECT slot_powerchat_relay FROM managed_streams WHERE id = ?', [stream.managed_stream_id]);
        return !ms || ms.slot_powerchat_relay !== 0;
    } catch { return true; }
}
// Channel-scoped relay check for chat: PowerChat's unified chat is per STREAMER, not
// per stream slot, and viewers can be pinned to a long-expired stream id (a popout
// opened during an earlier session keeps chatting in the same channel). A stale id
// must not decide the relay — when the referenced stream isn't the live one, fall
// back to the channel's CURRENT live stream's slot setting (or allow when offline).
function channelRelayEnabled(channelUserId, streamId) {
    try {
        let s = streamId ? db.getStreamById(streamId) : null;
        if (!s || !s.is_live) {
            const live = channelUserId ? (db.getLiveStreamsByUserId(channelUserId) || []) : [];
            s = live[0] || null;
        }
        if (!s || !s.managed_stream_id) return true;
        const ms = db.get('SELECT slot_powerchat_relay FROM managed_streams WHERE id = ?', [s.managed_stream_id]);
        return !ms || ms.slot_powerchat_relay !== 0;
    } catch { return true; }
}

// Destination switch: the Twitch/Kick/YouTube relay bridge for one restream destination.
function destRelayEnabled(destId) {
    if (!destId) return true;
    try {
        const d = db.get('SELECT powerchat_relay FROM restream_destinations WHERE id = ?', [destId]);
        return !d || d.powerchat_relay !== 0;
    } catch { return true; }
}

// ── chat:write ───────────────────────────────────────────────
const _chatBuckets = new Map(); // userId → { count, resetAt }  (~120/min limit; we cap at 100)
async function forwardChat(streamerUserId, { chatterName, externalChatterId, message, messageId, avatarUrl, avatarFallback, isModerator, isSubscriber } = {}) {
    if (!message || !chatterName) return;
    const conn = _connFor(streamerUserId, 'chat:write');
    if (!conn) return;
    const now = Date.now();
    let b = _chatBuckets.get(streamerUserId);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60000 }; _chatBuckets.set(streamerUserId, b); }
    if (b.count >= 100) return;
    b.count++;
    const absAvatar = _absoluteAvatarUrl(avatarUrl);
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/chat',
            // Field caps match the PowerChat schema (chatterName 1-48, externalChatterId
            // 1-128, message 1-500) — over-long values 400 with VALIDATION_ERROR.
            // messageId is REQUIRED (idempotency key): a body without it is a 400, so
            // every relay silently failed before this was sent. OpenVibe chat has no
            // retry path, so a generated UUID is a valid one-shot key.
            body: {
                chatterName: String(chatterName).slice(0, 48),
                externalChatterId: String(externalChatterId || chatterName).slice(0, 128),
                message: String(message).slice(0, 500),
                messageId: String(messageId || crypto.randomUUID()).slice(0, 128),
                ...(absAvatar ? { avatarUrl: absAvatar } : {}),
                // Placeholder grapheme when no avatar URL resolves (e.g. 🤖 for AI
                // viewers, or a clean letter for "[RS] name"-style prefixed sources).
                ...(avatarFallback ? { avatarFallback: String(avatarFallback).slice(0, 8) } : {}),
                ...(isModerator ? { isModerator: true } : {}),
                ...(isSubscriber ? { isSubscriber: true } : {}),
            },
        });
        _relayOk(streamerUserId);
    } catch (e) {
        _noteApiError(streamerUserId, 'chat:write', e);
        // This used to be silently swallowed, which meant a broken overlay relay looked
        // exactly like a working one. Log the first failure and then at most one per
        // minute per streamer, so a persistent problem is visible without flooding a
        // busy chat with one line per message.
        _relayFail(streamerUserId, e && e.message);
    }
}

// Relay health: quiet on success, but surface failures at a sane rate.
const _relayState = new Map();  // userId → { failAt, okAfterFail }
function _relayOk(userId) {
    const st = _relayState.get(userId);
    if (st && st.failAt) {
        console.log(`[PowerChat] chat relay recovered for user ${userId}`);
        _relayState.delete(userId);
    }
}
function _relayFail(userId, reason) {
    const now = Date.now();
    const st = _relayState.get(userId) || { failAt: 0 };
    if (now - st.failAt > 60000) {
        console.warn(`[PowerChat] chat relay failed for user ${userId}: ${reason || 'unknown'}`);
        st.failAt = now;
        _relayState.set(userId, st);
    }
}

// ── follows:write ────────────────────────────────────────────
async function forwardFollow(streamerUserId, { followerName, externalId } = {}) {
    if (!followerName) return;
    const conn = _connFor(streamerUserId, 'follows:write');
    if (!conn) return;
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/follows',
            // externalId is REQUIRED (idempotency) — a follow/unfollow/follow cycle
            // reuses the same id, so PowerChat dedupes instead of re-alerting.
            body: {
                followerName: String(followerName).slice(0, 48),
                externalId: String(externalId || crypto.randomUUID()).slice(0, 128),
                occurredAt: new Date().toISOString(),
            },
        });
    } catch (e) { _noteApiError(streamerUserId, 'follows:write', e); }
}

// ── subscriptions:write ──────────────────────────────────────
// A paid OpenVibe channel subscription → PowerChat sub alert + goal/subathon credit.
async function forwardSubscription(streamerUserId, { subscriberName, externalId, tier, isResub, isGift, giftCount } = {}) {
    if (!subscriberName) return;
    const conn = _connFor(streamerUserId, 'subscriptions:write');
    if (!conn) return;
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/subscriptions',
            // Schema: subscriberName 1-48, externalId 1-128 (REQUIRED), tier ≤32,
            // isResub/isGift bool, giftCount 1-1000.
            body: {
                subscriberName: String(subscriberName).slice(0, 48),
                externalId: String(externalId || crypto.randomUUID()).slice(0, 128),
                ...(tier ? { tier: String(tier).slice(0, 32) } : {}),
                ...(isResub ? { isResub: true } : {}),
                ...(isGift ? { isGift: true, ...(giftCount >= 1 ? { giftCount: Math.min(1000, Math.round(giftCount)) } : {}) } : {}),
                occurredAt: new Date().toISOString(),
            },
        });
    } catch (e) { _noteApiError(streamerUserId, 'subscriptions:write', e); }
}

// ── viewcount:write ──────────────────────────────────────────
// Re-push at least this often even when the count is UNCHANGED. PowerChat drops a viewer-count
// slot that hasn't been refreshed (~90s freshness sweep), so a stable count would make our chip
// silently disappear after the first push. A heartbeat inside that window keeps it alive.
const VIEWCOUNT_HEARTBEAT_MS = 60000;
const _lastViewCount = new Map(); // userId → { count, sentAt }
async function sendViewCount(streamerUserId, count) {
    const conn = _connFor(streamerUserId, 'viewcount:write');
    if (!conn) return;
    // Schema: count is int ≥0, or null = stream ended (clears our chip).
    count = count == null ? null : Math.max(0, Math.round(Number(count) || 0));
    const prev = _lastViewCount.get(streamerUserId);
    const now = Date.now();
    // Push on change, or when the last push is going stale (heartbeat).
    if (prev && prev.count === count && (now - prev.sentAt) < VIEWCOUNT_HEARTBEAT_MS) return;
    _lastViewCount.set(streamerUserId, { count, sentAt: now });
    try {
        await oauth.apiRequest(streamerUserId, { method: 'POST', path: '/view-count', body: { count } });
    } catch (e) {
        _lastViewCount.delete(streamerUserId); // let the next tick retry
        _noteApiError(streamerUserId, 'viewcount:write', e);
    }
}

// The count pushed to PowerChat is the TOTAL audience of a live stream: OpenVibe
// viewers + each restream platform's viewers (Twitch/Kick/YouTube, from the restream
// manager's cache) + RobotStreamer viewers. Streamers can exclude any restream
// destination (powerchat_count_views) or the slot's RS viewers
// (slot_powerchat_count_rs_views) in the Broadcast page — those still show on
// OpenVibe, they just don't count toward the PowerChat chip.
function totalViewersForStream(s) {
    let total = s.viewer_count || 0;
    const slotId = s.managed_stream_id || null;
    try {
        const restreamManager = require('../streaming/restream-manager');
        const ext = restreamManager.getExternalViewerCountsForUser(s.user_id, slotId);
        for (const b of ext.breakdown || []) {
            if (!b.count) continue;
            const d = b.destId ? db.get('SELECT powerchat_count_views FROM restream_destinations WHERE id = ?', [b.destId]) : null;
            if (d && d.powerchat_count_views === 0) continue;
            total += b.count;
        }
    } catch { /* restream manager unavailable — OpenVibe count only */ }
    try {
        const ms = slotId ? db.get('SELECT slot_powerchat_count_rs_views FROM managed_streams WHERE id = ?', [slotId]) : null;
        if (!ms || ms.slot_powerchat_count_rs_views !== 0) {
            const rs = require('./robotstreamer-service');
            const rsActive = rs.chatBridges?.has(s.id) || rs._activePublish?.has(s.id);
            if (rsActive) total += rs.getRsViewerCount(s.user_id, slotId) || 0;
        }
    } catch { /* */ }
    return total;
}

// Periodic sweeper: push each connected live streamer's viewer count; push null once
// when they go offline so PowerChat drops the chip.
let _vcTimer = null;
function startViewerCountSweeper() {
    if (_vcTimer) return;
    const seenLive = new Set();
    _vcTimer = setInterval(() => {
        try {
            if (!oauth.getConfig().enabled) return;
            const live = db.getLiveStreams() || [];
            const liveOwners = new Map(); // userId → summed viewer count
            for (const s of live) {
                if (!s.user_id) continue;
                liveOwners.set(s.user_id, (liveOwners.get(s.user_id) || 0) + totalViewersForStream(s));
            }
            for (const [userId, count] of liveOwners) { seenLive.add(userId); sendViewCount(userId, count); }
            // Owners that were live last tick but aren't now → send null (stream ended).
            for (const userId of Array.from(seenLive)) {
                if (!liveOwners.has(userId)) {
                    seenLive.delete(userId);
                    if (_connFor(userId, 'viewcount:write')) {
                        _lastViewCount.delete(userId);
                        oauth.apiRequest(userId, { method: 'POST', path: '/view-count', body: { count: null } }).catch(() => {});
                    }
                }
            }
        } catch (e) { /* silent */ }
    }, 30000);
    if (_vcTimer.unref) _vcTimer.unref();
    console.log('[PowerChat] viewer-count sweeper started');
}

// ── currency:write ───────────────────────────────────────────
// Returns true when PowerChat accepted the event (the earn flusher re-buffers on false).
async function sendCurrencyRedemption(streamerUserId, { amount, redeemerName, rewardName, message, externalId } = {}) {
    const conn = _connFor(streamerUserId, 'currency:write');
    if (!conn) return false;
    const amt = Math.round(Number(amount) || 0);
    if (amt < 1) return false; // schema requires amount 1-1000000000
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/currency-events',
            // Caps match the schema: redeemerName 1-48, rewardName ≤64, message ≤250,
            // externalId 1-128. Requires the CURRENCY_KEY declared in the PowerChat dashboard.
            body: {
                currency: CURRENCY_KEY,
                amount: amt,
                redeemerName: String(redeemerName || 'viewer').slice(0, 48),
                ...(rewardName ? { rewardName: String(rewardName).slice(0, 64) } : {}),
                ...(message ? { message: String(message).slice(0, 250) } : {}),
                // externalId is REQUIRED (idempotency) — always send one.
                externalId: String(externalId || crypto.randomUUID()).slice(0, 128),
                occurredAt: new Date().toISOString(),
            },
        });
        return true;
    } catch (e) {
        _noteApiError(streamerUserId, 'currency:write', e);
        // "Unknown currency" means the key isn't DECLARED on the app in the PowerChat
        // dashboard — that's app config, not auth; surface it distinctly.
        if (e && e.status === 400 && /unknown currency/i.test(e.message || '')) {
            _warnUndeclared(CURRENCY_KEY, `currency "${CURRENCY_KEY}" is not declared on the app — declare it in the PowerChat Developer dashboard`);
        }
        return false;
    }
}

// ── Channel-point EARNS → PowerChat leaderboard feed ─────────
// Redemptions alone can't populate a leaderboard (they're rare); the board lives on
// the steady drip of watch/chat/follow point earning. Every award is buffered per
// (streamer, viewer) and flushed as ONE summed currency event per viewer every few
// minutes — that keeps a busy channel inside the ~60/min currency rate limit and
// avoids machine-gunning the overlay with micro-events.
const EARN_FLUSH_MS = 5 * 60 * 1000;
const EARN_MAX_PER_FLUSH = 40;      // stay well under the rate limit per flush pass
const EARN_MAX_VIEWERS = 500;      // per-streamer buffer cap (drop past this, don't grow)
const _earnBuf = new Map();         // streamerId → Map(viewerId → summed amount)
function queueCurrencyEarn(streamerUserId, viewerUserId, amount) {
    const amt = Math.round(Number(amount) || 0);
    if (amt < 1 || !streamerUserId || !viewerUserId) return;
    // Only buffer for streamers with a live currency:write connection — otherwise the
    // buffer would grow forever for channels that never flush.
    if (!_connFor(streamerUserId, 'currency:write')) return;
    let m = _earnBuf.get(streamerUserId);
    if (!m) { m = new Map(); _earnBuf.set(streamerUserId, m); }
    if (!m.has(viewerUserId) && m.size >= EARN_MAX_VIEWERS) return;
    m.set(viewerUserId, (m.get(viewerUserId) || 0) + amt);
}
async function _flushCurrencyEarns() {
    let sent = 0;
    for (const [streamerId, m] of _earnBuf) {
        if (!m.size) { _earnBuf.delete(streamerId); continue; }
        for (const [viewerId, amount] of m) {
            if (sent >= EARN_MAX_PER_FLUSH) return; // leave the rest buffered for next pass
            m.delete(viewerId);
            sent++;
            let name = null;
            try { const u = db.getUserById(viewerId); name = u ? (u.display_name || u.username) : null; } catch { /* */ }
            const ok = await sendCurrencyRedemption(streamerId, {
                amount,
                redeemerName: name || `viewer ${viewerId}`,
                rewardName: 'Points earned',
                externalId: `earn:${streamerId}:${viewerId}:${Date.now()}`,
            });
            // Transient failure → put the amount back so the points aren't lost.
            if (!ok && _connFor(streamerId, 'currency:write')) {
                m.set(viewerId, (m.get(viewerId) || 0) + amount);
            }
        }
    }
}
let _earnTimer = null;
function startCurrencyEarnFlusher() {
    if (_earnTimer) return;
    _earnTimer = setInterval(() => { _flushCurrencyEarns().catch(() => { }); }, EARN_FLUSH_MS);
    if (_earnTimer.unref) _earnTimer.unref();
    console.log('[PowerChat] channel-point earn flusher started (leaderboard feed)');
}

// ── tips:write ───────────────────────────────────────────────
// Forward an on-site Vibes donation as a MONETARY tip. amount is in Vibes UNITS;
// PowerChat converts server-side via the declared unitsPerUsd (100 Vibes = $1) and the
// tip then fires PowerChat tip alerts and credits tip goals/subathon/totals.
// externalId MUST be the donation's stable id (retries dedupe; never double-alert).
async function forwardTip(streamerUserId, { amount, tipperName, message, externalId } = {}) {
    const conn = _connFor(streamerUserId, 'tips:write');
    if (!conn) return;
    const amt = Math.round(Number(amount) || 0);
    if (amt < 1) return; // schema: int ≥1
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/tips',
            body: {
                currency: TIP_CURRENCY_KEY,
                amount: amt,
                tipperName: String(tipperName || 'Someone').slice(0, 48),
                ...(message ? { message: String(message).slice(0, 250) } : {}),
                externalId: String(externalId || crypto.randomUUID()).slice(0, 128),
                occurredAt: new Date().toISOString(),
            },
        });
    } catch (e) {
        _noteApiError(streamerUserId, 'tips:write', e);
        if (e && e.status === 400 && /unknown currency|no usd rate/i.test(e.message || '')) {
            _warnUndeclared(TIP_CURRENCY_KEY, `tip currency "${TIP_CURRENCY_KEY}" must be declared on the app WITH unitsPerUsd=100 in the PowerChat Developer dashboard`);
        }
    }
}

// Fire a display-only custom alert on PowerChat (used by "Send test tip" so the
// streamer sees it render on their real PowerChat overlay). Needs alerts:trigger.
async function sendCustomAlert(streamerUserId, { actorName, message, amountCents } = {}) {
    const conn = _connFor(streamerUserId, 'alerts:trigger');
    if (!conn) return false;
    try {
        await oauth.apiRequest(streamerUserId, {
            // No idempotency key on custom alerts → a replayed 5xx could double-alert.
            method: 'POST', path: '/alerts/custom', idempotent: false,
            // Schema: actorName 1-32, message ≤250, amountCents 0-100000000.
            body: {
                actorName: String(actorName || 'Test').slice(0, 32),
                ...(message ? { message: String(message).slice(0, 250) } : {}),
                ...(amountCents ? { amountCents: Math.round(amountCents) } : {}),
            },
        });
        return true;
    } catch { return false; }
}

module.exports = {
    slotRelayEnabled, channelRelayEnabled, destRelayEnabled, totalViewersForStream,
    CURRENCY_KEY, TIP_CURRENCY_KEY,
    forwardChat, forwardFollow, forwardSubscription, forwardTip,
    sendViewCount, startViewerCountSweeper,
    sendCurrencyRedemption, queueCurrencyEarn, startCurrencyEarnFlusher, sendCustomAlert,
};
