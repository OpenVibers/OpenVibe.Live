/**
 * powerchat-platform.js — PLATFORM direction (OpenVibe.Live sends data INTO PowerChat).
 *
 * When a streamer has connected PowerChat with the relevant scopes, OpenVibe.Live acts
 * like a streaming platform feeding PowerChat's unified overlays:
 *   - chat:write       → real OpenVibe.Live chat merges into the unified chat overlay
 *   - viewcount:write  → OpenVibe.Live's viewer count shows as its own branded chip
 *   - currency:write   → channel-point redemptions fire PowerChat alerts + leaderboards
 *
 * Everything is best-effort and scope-gated: a missing scope / sandbox restriction just
 * makes the call a no-op (PowerChat also checks scopes live and 403s, which we swallow).
 */
'use strict';
const db = require('../db/database');
const oauth = require('./powerchat-oauth');
const config = require('../config');

// The virtual-currency key the app declares in the PowerChat dashboard for channel points.
const CURRENCY_KEY = 'openvibe_points';

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
        if (scopeNeeded && conn.scope && !String(conn.scope).split(/\s+/).includes(scopeNeeded)) return null;
        return conn;
    } catch { return null; }
}

// ── chat:write ───────────────────────────────────────────────
const _chatBuckets = new Map(); // userId → { count, resetAt }  (~120/min limit; we cap at 100)
async function forwardChat(streamerUserId, { chatterName, externalChatterId, message, avatarUrl, isModerator } = {}) {
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
            body: {
                chatterName: String(chatterName).slice(0, 48),
                externalChatterId: String(externalChatterId || chatterName).slice(0, 128),
                message: String(message).slice(0, 500),
                ...(absAvatar ? { avatarUrl: absAvatar } : {}),
                ...(isModerator ? { isModerator: true } : {}),
            },
        });
        _relayOk(streamerUserId);
    } catch (e) {
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
            body: {
                followerName: String(followerName).slice(0, 48),
                ...(externalId ? { externalId: String(externalId).slice(0, 128) } : {}),
            },
        });
    } catch { /* silent */ }
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
    const prev = _lastViewCount.get(streamerUserId);
    const now = Date.now();
    // Push on change, or when the last push is going stale (heartbeat).
    if (prev && prev.count === count && (now - prev.sentAt) < VIEWCOUNT_HEARTBEAT_MS) return;
    _lastViewCount.set(streamerUserId, { count, sentAt: now });
    try {
        await oauth.apiRequest(streamerUserId, { method: 'POST', path: '/view-count', body: { count } });
    } catch { _lastViewCount.delete(streamerUserId); /* let the next tick retry */ }
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
                liveOwners.set(s.user_id, (liveOwners.get(s.user_id) || 0) + (s.viewer_count || 0));
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
async function sendCurrencyRedemption(streamerUserId, { amount, redeemerName, rewardName, message, externalId } = {}) {
    const conn = _connFor(streamerUserId, 'currency:write');
    if (!conn) return;
    const amt = Math.round(Number(amount) || 0);
    if (amt < 1) return; // schema requires amount 1-1000000000
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
                ...(externalId ? { externalId: String(externalId).slice(0, 128) } : {}),
            },
        });
    } catch { /* silent */ }
}

// Fire a display-only custom alert on PowerChat (used by "Send test tip" so the
// streamer sees it render on their real PowerChat overlay). Needs alerts:trigger.
async function sendCustomAlert(streamerUserId, { actorName, message, amountCents } = {}) {
    const conn = _connFor(streamerUserId, 'alerts:trigger');
    if (!conn) return false;
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/alerts/custom',
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
    CURRENCY_KEY,
    forwardChat, forwardFollow, sendViewCount, startViewerCountSweeper,
    sendCurrencyRedemption, sendCustomAlert,
};
