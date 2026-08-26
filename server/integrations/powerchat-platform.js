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

// ── chat:write ───────────────────────────────────────────────
const _chatBuckets = new Map(); // userId → { count, resetAt }  (~120/min limit; we cap at 100)
async function forwardChat(streamerUserId, { chatterName, externalChatterId, message, messageId, avatarUrl, isModerator, isSubscriber } = {}) {
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
                // externalId is REQUIRED (idempotency) — always send one.
                externalId: String(externalId || crypto.randomUUID()).slice(0, 128),
                occurredAt: new Date().toISOString(),
            },
        });
    } catch (e) {
        _noteApiError(streamerUserId, 'currency:write', e);
        // "Unknown currency" means the key isn't DECLARED on the app in the PowerChat
        // dashboard — that's app config, not auth; surface it distinctly.
        if (e && e.status === 400 && /unknown currency/i.test(e.message || '')) {
            console.warn(`[PowerChat] currency "${CURRENCY_KEY}" is not declared on the app — declare it in the PowerChat Developer dashboard`);
        }
    }
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
            console.warn(`[PowerChat] tip currency "${TIP_CURRENCY_KEY}" must be declared on the app WITH unitsPerUsd=100 in the PowerChat Developer dashboard`);
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
    CURRENCY_KEY, TIP_CURRENCY_KEY,
    forwardChat, forwardFollow, forwardSubscription, forwardTip,
    sendViewCount, startViewerCountSweeper,
    sendCurrencyRedemption, sendCustomAlert,
};
