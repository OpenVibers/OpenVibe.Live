'use strict';
/**
 * A donation goal moved: tell the channel. One place for every path that credits a Live donation goal:
 * on-site Vibes donations (POST /api/funds/donate), tips on a streamer's own PowerChat
 * (integrations/powerchat-webhook.js) and tips OpenVibe.Tips announces after Billing settled them
 * (tips/delivery-routes.js).
 *
 *   goal-update    the goal widget's new numbers, a channel event
 *   goal reached   a saved "🎉 Goal reached" donation line, then the streamer's goal sound, then the
 *                  overlay feed's goal alert (server/overlay/overlay-alerts.js)
 */
const delivery = require('../chat/chat-delivery');

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

/**
 * goalResult is vibes.applyDonationToGoal's answer ({ goal, reached } or null). `by` names the supporter on the
 * goal-reached line; `key` makes that line once-only in Chat (a retried announcement does not post it twice).
 */
async function announceGoal({ userId, streamId = null, goalResult, by, key }) {
    if (!goalResult || !goalResult.goal) return;
    const g = goalResult.goal;
    await delivery.event({ kind: 'channel', id: userId, stream: streamId || null }, { type: 'goal-update', goal: publicGoal(g) });
    if (!goalResult.reached) return;
    try {
        await delivery.message({
            stream_id: streamId || null, channel_user_id: userId, user_id: null, username: 'Donation Goal',
            message: `🎉 Goal reached: ${g.title} (${Number(g.target_amount || 0).toLocaleString()} Vibes)`,
            message_type: 'donation',
            metadata: { kind: 'goal-reached', goal_id: g.id, title: g.title, target: g.target_amount, image: g.image_url || null, media_type: g.media_type || null, by: by || null },
            key,
        });
    } catch (e) { console.warn('[Goals] goal-reached line not saved:', e.message); }
    try { await require('./alerts').playAlertSound(userId, streamId, 'goal'); } catch { /* non-critical */ }
    // The overlay alert feed: "Goal reached" with the goal's target, for the streamer's OBS overlay.
    try {
        await require('../overlay/overlay-alerts').emit({
            streamerId: userId,
            kind: 'goal',
            who: null,
            amount: { value: Number(g.target_amount) || 0, unit: 'vibes' },
            text: null,
            naturalKey: `goal:${g.id}:${g.reached_at || key || 'reached'}`,
        });
    } catch { /* non-critical */ }
}

module.exports = { publicGoal, announceGoal };
