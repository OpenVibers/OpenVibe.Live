/**
 * powerchat-webhook.js — verify + process PowerChat webhook deliveries.
 *
 * Deliveries are signed and at-least-once. We:
 *   1. Verify the HMAC-SHA256 signature over "<timestamp>.<raw body>" (timing-safe).
 *   2. Reject timestamps older than 15 minutes.
 *   3. Dedupe on X-PowerChat-Delivery-Id.
 *   4. Ack 2xx fast; process async.
 *
 * `donation.completed` is mapped onto OpenVibe.Live's existing donation pipeline: it credits
 * the streamer's active donation goal and fires the same live chat event + alert sound +
 * goal-reached celebration that an on-site Vibes donation does.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/database');
const powerchatOAuth = require('./powerchat-oauth');

const MAX_SKEW_MS = 15 * 60 * 1000;

// ── Signature verification ───────────────────────────────────────────────────
// Returns { ok, reason }. rawBody must be the exact bytes received (Buffer or string).
function verifySignature(rawBody, headers) {
    const secret = powerchatOAuth.getConfig().webhookSecret;
    if (!secret) return { ok: false, reason: 'webhook secret not configured' };

    const sigHeader = headers['x-powerchat-signature'] || '';
    const tsHeader = headers['x-powerchat-timestamp'] || '';
    if (!sigHeader || !tsHeader) return { ok: false, reason: 'missing signature/timestamp headers' };

    // Timestamp is unix ms; reject stale deliveries (replay protection).
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
        return { ok: false, reason: 'timestamp outside allowed window' };
    }

    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret)
        .update(String(tsHeader) + '.').update(bodyBuf).digest('hex');

    const a = Buffer.from(sigHeader);
    const bexp = Buffer.from(expected);
    if (a.length !== bexp.length) return { ok: false, reason: 'signature mismatch' };
    if (!crypto.timingSafeEqual(a, bexp)) return { ok: false, reason: 'signature mismatch' };
    return { ok: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function publicGoal(g) {
    if (!g) return null;
    return {
        id: g.id, user_id: g.user_id, title: g.title,
        target_amount: g.target_amount, current_amount: g.current_amount,
        is_active: g.is_active, reached_at: g.reached_at || null,
        image_url: g.image_url || null, media_type: g.media_type || null,
        sort_order: g.sort_order || 0,
    };
}

// Resolve the OpenVibe.Live user who owns the PowerChat account this event is for.
function _resolveStreamerUserId(streamer) {
    if (!streamer) return null;
    let conn = null;
    if (streamer.id) conn = db.getPowerchatConnectionByPcUserId(String(streamer.id));
    if (!conn && streamer.username) conn = db.getPowerchatConnectionByUsername(streamer.username);
    return conn ? conn.user_id : null;
}

// app_ref may encode a target goal, e.g. "goal:12" (see the checkout-attribution link).
function _goalIdFromRef(ref) {
    if (!ref || typeof ref !== 'string') return null;
    const m = ref.match(/(?:^|[:_-])goal[:_-]?(\d+)/i);
    return m ? Number(m[1]) : null;
}

// ── Donation handling — mirrors POST /api/funds/donate ───────────────────────
function _handleDonation(userId, data) {
    const chatServer = require('../chat/chat-server');
    const alerts = require('../monetization/alerts');
    const openvibeBucks = require('../monetization/vibes');

    // PowerChat amounts are in cents. Vibes are bit-style (100 bucks = $1), so 1 buck
    // = 1 cent — the cent value IS the Vibes value of an external tip.
    const cents = Number(data.amountUsdCents || data.amountCents || 0);
    const amount = Math.max(0, Math.round(cents)); // Vibes (= USD cents)
    const donor = String(data.donorName || 'Someone').slice(0, 80);
    const message = String(data.message || '').slice(0, 500);
    const goalId = _goalIdFromRef(data.appExternalRef);
    const ts = new Date().toISOString();

    // If the streamer is live, attach to the live session so it lands in that slot too.
    let streamId = null;
    try { const live = db.getLiveStreamsByUserId(userId) || []; if (live.length) streamId = live[0].id; } catch { /* */ }

    // Credit a goal (donor's chosen one via app_ref, else the sole active goal).
    let goalResult = null;
    try { goalResult = openvibeBucks.applyDonationToGoal(userId, amount, goalId); } catch { /* */ }

    // 1) Donation chat event — live + persisted to channel history.
    const donationEvent = {
        type: 'donation', username: donor, user_id: null, avatar_url: null,
        amount, message, source: 'powerchat', timestamp: ts,
    };
    chatServer.broadcastToChannelRoom(userId, streamId, donationEvent);
    try { chatServer.broadcastGlobal({ ...donationEvent, global: true, channel_user_id: userId }); } catch { /* */ }
    try {
        db.saveChatMessage({
            stream_id: streamId, channel_user_id: userId, user_id: null, username: donor,
            message: `${donor} tipped ${amount.toLocaleString()} Vibes${message ? ': ' + message : ''} (PowerChat)`,
            message_type: 'donation',
            metadata: { kind: 'donation', amount, message, username: donor, source: 'powerchat' },
        });
    } catch { /* */ }

    // 2) Donation sound.
    try { alerts.playAlertSound(chatServer, userId, streamId, 'donation'); } catch { /* */ }

    // 3) Goal progress + 4) goal reached.
    if (goalResult && goalResult.goal) {
        chatServer.broadcastToChannelRoom(userId, streamId, { type: 'goal-update', goal: publicGoal(goalResult.goal) });
    }
    if (goalResult && goalResult.reached) {
        const g = goalResult.goal;
        chatServer.broadcastToChannelRoom(userId, streamId, { type: 'goal-reached', goal: publicGoal(g), by: donor, timestamp: ts });
        try {
            db.saveChatMessage({
                stream_id: streamId, channel_user_id: userId, user_id: null, username: 'Donation Goal',
                message: `🎉 Goal reached: ${g.title} (${Number(g.target_amount || 0).toLocaleString()} HB)`,
                message_type: 'donation',
                metadata: { kind: 'goal-reached', goal_id: g.id, title: g.title, target: g.target_amount, image: g.image_url || null, media_type: g.media_type || null, by: donor },
            });
        } catch { /* */ }
        try { alerts.playAlertSound(chatServer, userId, streamId, 'goal'); } catch { /* */ }
    }

    console.log(`[PowerChat] Donation: ${amount} bucks to user ${userId} from ${donor}${goalResult && goalResult.reached ? ' (goal reached!)' : ''}`);
}

// A membership/sub — surface as a chat event (no OpenVibe.Live sub system to credit).
function _handleSubscription(userId, data) {
    const chatServer = require('../chat/chat-server');
    const name = String(data.subscriberName || data.donorName || 'Someone').slice(0, 80);
    const ts = new Date().toISOString();
    chatServer.broadcastToChannelRoom(userId, null, { type: 'donation', username: name, amount: 0, message: 'subscribed via PowerChat', source: 'powerchat-sub', timestamp: ts });
    try {
        db.saveChatMessage({
            stream_id: null, channel_user_id: userId, user_id: null, username: name,
            message: `${name} subscribed (PowerChat)`, message_type: 'donation',
            metadata: { kind: 'donation', amount: 0, username: name, source: 'powerchat-sub' },
        });
    } catch { /* */ }
}

// A lightweight chat notice for non-money events (follow / host / points redeem).
function _handleNotice(userId, message, kind) {
    try {
        const chatServer = require('../chat/chat-server');
        const ts = new Date().toISOString();
        chatServer.broadcastToChannelRoom(userId, null, { type: 'system', message, source: 'powerchat', kind, timestamp: ts });
        db.saveChatMessage({
            stream_id: null, channel_user_id: userId, user_id: null, username: 'PowerChat',
            message, message_type: 'system', metadata: { kind: kind || 'powerchat', source: 'powerchat' },
        });
    } catch { /* */ }
}

// ── Entry point: process a verified, deduped envelope ────────────────────────
function processEvent(envelope) {
    if (!envelope || !envelope.type) return;
    const userId = _resolveStreamerUserId(envelope.streamer);
    if (!userId) { console.warn(`[PowerChat] webhook ${envelope.type} for unknown streamer`, envelope.streamer); return; }
    const data = envelope.data || {};
    try {
        switch (envelope.type) {
            case 'donation.completed':
                // The authoritative money event. paid_message.created is a subset of this
                // (a tip that carried a message) — we DON'T credit on it to avoid double-count.
                _handleDonation(userId, data);
                break;
            case 'subscription.created':
                _handleSubscription(userId, data);
                break;
            case 'follow.created':
                _handleNotice(userId, `${String(data.followerName || 'Someone').slice(0, 80)} followed on PowerChat`, 'follow');
                break;
            case 'host.received':
                _handleNotice(userId, `${String(data.hostChannel || 'Someone').slice(0, 80)} hosted with ${data.viewers || 0} viewers (PowerChat)`, 'host');
                break;
            case 'channel_points.redeemed':
                _handleNotice(userId, `${String(data.redeemerName || 'Someone').slice(0, 80)} redeemed ${String(data.rewardName || 'a reward').slice(0, 80)} (PowerChat)`, 'points');
                break;
            // paid_message.created → display twin of donation.completed (ignored to avoid
            // double-counting). goal.updated/completed reflect PowerChat's own goals;
            // OpenVibe.Live runs its own goals credited by donations above, so we ignore them.
            default:
                break;
        }
    } catch (err) {
        console.warn(`[PowerChat] processEvent(${envelope.type}) failed:`, err.message);
    }
}

// Fire a fake tip through the LIVE pipeline so a streamer can verify their alert sound +
// chat celebration render, WITHOUT touching PowerChat (no scope needed) and WITHOUT
// permanently crediting a goal. Broadcasts the donation chat event + plays the alert sound;
// if there's an active goal it also sends a transient goal-update preview (not persisted).
function simulateDonation(userId, { amountUsd = 5, donor = 'Test Tipper', message = 'Test tip ✨' } = {}) {
    const chatServer = require('../chat/chat-server');
    const alerts = require('../monetization/alerts');
    // Vibes are bit-style: $1 = 100 bucks, so the test dollar amount → bucks ×100.
    const amount = Math.max(1, Math.round(amountUsd * 100));
    const ts = new Date().toISOString();
    let streamId = null;
    try { const live = db.getLiveStreamsByUserId(userId) || []; if (live.length) streamId = live[0].id; } catch { /* */ }

    const testEvent = {
        type: 'donation', username: donor, user_id: null, avatar_url: null,
        amount, message, source: 'powerchat-test', timestamp: ts,
    };
    chatServer.broadcastToChannelRoom(userId, streamId, testEvent);
    try { chatServer.broadcastGlobal({ ...testEvent, global: true, channel_user_id: userId }); } catch { /* */ }
    // Persist it, exactly like a real tip. A test that vanishes on reload does not
    // actually test what the streamer is checking — that the alert lands in chat AND
    // survives a refresh. This was the only donation path that broadcast without saving.
    try {
        db.saveChatMessage({
            stream_id: streamId, channel_user_id: userId, user_id: null, username: donor,
            message: `${donor} donated ${amount.toLocaleString()} Vibes${message ? ': ' + message : ''}`,
            message_type: 'donation',
            metadata: { kind: 'donation', amount, message, username: donor, source: 'powerchat-test' },
        });
    } catch (e) { console.warn('[PowerChat] test tip not saved to history:', e.message); }
    try { alerts.playAlertSound(chatServer, userId, streamId, 'donation'); } catch { /* */ }

    // Transient goal-progress preview (does NOT persist — reload restores the real number).
    try {
        const active = db.getActiveDonationGoals(userId) || [];
        if (active.length === 1) {
            const g = active[0];
            const preview = { ...g, current_amount: Math.min((g.current_amount || 0) + amount, g.target_amount) };
            chatServer.broadcastToChannelRoom(userId, streamId, { type: 'goal-update', goal: publicGoal(preview), preview: true });
        }
    } catch { /* */ }
    return { amount, live: !!streamId };
}

module.exports = { verifySignature, processEvent, publicGoal, simulateDonation };
