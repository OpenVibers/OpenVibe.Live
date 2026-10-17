/**
 * powerchat-webhook.js — the on-stream celebration of a PowerChat tip.
 *
 * PowerChat's webhook is received by OpenVibe.Billing since the cutover of 2026-10-17 (openvibe.live's nginx hands
 * /api/powerchat/webhook to it). What stays here is what a tip looks like on Live: the chat line, the alert sound, the
 * donation goal and the channel's tip history (creditDonationPipeline), run by billing-events.js when Billing announces
 * a PowerChat tip, and the streamer's own test tip (simulateDonation).
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/database');
const delivery = require('../chat/chat-delivery');
const { publicGoal, announceGoal } = require('../monetization/goal-announce');

// ── Helpers ──────────────────────────────────────────────────────────────────
// The viewer's chosen donation goal rides in app_purpose ("goal:12" — the purpose
// key is the category vocabulary; see the checkout-attribution docs). Older links
// encoded it in app_ref, so that stays as a fallback.
function _goalIdFromDonation(data) {
    for (const v of [data && data.appPurpose, data && data.appExternalRef]) {
        if (!v || typeof v !== 'string') continue;
        const m = v.match(/(?:^|[:_-])goal[:_-]?(\d+)/i);
        if (m) return Number(m[1]);
    }
    return null;
}

// ── Donation handling — mirrors POST /api/funds/donate ───────────────────────
// A persisted chat line: one Chat ingress call (Chat persists and shows it; `mirror` also puts it
// in global chat). Live keeps no chat table.
async function _chatLine({ line, mirror = false, key }) {
    return await delivery.message({ ...line, mirror, key });
}

async function _handleDonation(userId, data, { fromUserId = null } = {}) {
    const alerts = require('../monetization/alerts');
    const openvibeBucks = require('../monetization/vibes');

    // PowerChat amounts are in cents. Vibes are bit-style (100 bucks = $1), so 1 buck
    // = 1 cent — the cent value IS the Vibes value of an external tip.
    const cents = Number(data.amountUsdCents || data.amountCents || 0);
    const amount = Math.max(0, Math.round(cents)); // Vibes (= USD cents)
    const donor = String(data.donorName || 'Someone').slice(0, 80);
    const message = String(data.message || '').slice(0, 500);
    const goalId = _goalIdFromDonation(data);

    // If the streamer is live, attach to the live session so it lands in that slot too.
    let streamId = null;
    try { const live = await db.getLiveStreamsByUserId(userId) || []; if (live.length) streamId = live[0].id; } catch { /* */ }

    // Credit a goal (donor's chosen one via app_ref, else the sole active goal).
    let goalResult = null;
    try { goalResult = await openvibeBucks.applyDonationToGoal(userId, amount, goalId); } catch { /* */ }

    // 1) Donation chat event — persisted to channel history (and mirrored to global chat).
    const eventKey = data.eventId ? `powerchat:${data.eventId}` : undefined;
    // The channel's tip history (leaderboard, recap, home stats); site-routed tips name the donor's account.
    await require('../monetization/channel-tips').record({
        toUserId: userId, fromUserId, username: donor, streamId, amount, source: 'powerchat', ref: eventKey || `powerchat:${crypto.randomUUID()}`,
    });
    try {
        await _chatLine({
            mirror: true, key: eventKey,
            line: {
                stream_id: streamId, channel_user_id: userId, user_id: null, username: donor,
                message: `${donor} tipped ${amount.toLocaleString()} Vibes${message ? ': ' + message : ''} (PowerChat)`,
                message_type: 'donation',
                metadata: { kind: 'donation', amount, message, username: donor, source: 'powerchat' },
            },
        });
    } catch { /* */ }

    // 2) Donation sound.
    try { await alerts.playAlertSound(userId, streamId, 'donation'); } catch { /* */ }

    // 3) Goal progress + 4) goal reached.
    try { await announceGoal({ userId, streamId, goalResult, by: donor, key: eventKey && `${eventKey}:goal` }); } catch { /* */ }

    console.log(`[PowerChat] Donation: ${amount} bucks to user ${userId} from ${donor}${goalResult && goalResult.reached ? ' (goal reached!)' : ''}`);
}

// Fire a fake tip through the LIVE pipeline so a streamer can verify their alert sound +
// chat celebration render, WITHOUT touching PowerChat (no scope needed) and WITHOUT
// permanently crediting a goal. Broadcasts the donation chat event + plays the alert sound;
// if there's an active goal it also sends a transient goal-update preview (not persisted).
async function simulateDonation(userId, { amountUsd = 5, donor = 'Test Tipper', message = 'Test tip ✨' } = {}) {
    const alerts = require('../monetization/alerts');
    // Vibes are bit-style: $1 = 100 bucks, so the test dollar amount → bucks ×100.
    const amount = Math.max(1, Math.round(amountUsd * 100));
    const ts = new Date().toISOString();
    let streamId = null;
    try { const live = await db.getLiveStreamsByUserId(userId) || []; if (live.length) streamId = live[0].id; } catch { /* */ }

    // Not to global chat: a test tip is the streamer's own preview, and any signed-in user could
    // otherwise announce a fake 99,900-Vibe donation site-wide.
    // Persist it, exactly like a real tip. A test that vanishes on reload does not
    // actually test what the streamer is checking — that the alert lands in chat AND
    // survives a refresh.
    try {
        await _chatLine({
            line: {
                stream_id: streamId, channel_user_id: userId, user_id: null, username: donor,
                message: `${donor} donated ${amount.toLocaleString()} Vibes${message ? ': ' + message : ''}`,
                message_type: 'donation',
                metadata: { kind: 'donation', amount, message, username: donor, source: 'powerchat-test' },
            },
        });
    } catch (e) { console.warn('[PowerChat] test tip not saved to history:', e.message); }
    try { await alerts.playAlertSound(userId, streamId, 'donation'); } catch { /* */ }

    // Transient goal-progress preview (does NOT persist — reload restores the real number).
    try {
        const active = await db.getActiveDonationGoals(userId) || [];
        if (active.length === 1) {
            const g = active[0];
            const preview = { ...g, current_amount: Math.min((g.current_amount || 0) + amount, g.target_amount) };
            await delivery.event({ kind: 'channel', id: userId, stream: streamId }, { type: 'goal-update', goal: publicGoal(preview), preview: true });
        }
    } catch { /* */ }
    return { amount, live: !!streamId };
}

module.exports = {
    publicGoal, simulateDonation,
    // The full on-site donation celebration (chat line, alert sound, goal credit, tip history) for a streamer.
    creditDonationPipeline: _handleDonation,
};
