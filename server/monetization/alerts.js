/**
 * alerts.js — streamer alert sounds for donations / donation-goal-reached events.
 *
 * The sound mapping lives on channel_moderation_settings, which OpenVibe.Chat owns and reads locally
 * (roadmap T3), so Live no longer reads the file or broadcasts base64 itself. With CHAT_AUTHORITY=chat it
 * asks Chat to play the alert with an `alert` event on Chat's typed ingress (server/chat/chat-delivery.js),
 * and Chat resolves the sound from its own settings row, reads the shared sounds file and broadcasts the
 * `soundboard-audio` message to the channel room. A goal-reached event is `kind: 'goal'` (Chat falls back
 * to the donation sound).
 */
'use strict';

/**
 * Ask Chat to play a streamer's alert sound to their viewers (channel-wide, so it reaches every slot
 * plus the offline room). kind: 'donation' | 'goal'. Chat answers `played:false` (never an error) when
 * the channel has no sound; outside chat mode the event is dropped and logged by chat-delivery.js.
 */
async function playAlertSound(streamerId, streamId, kind) {
    try {
        // An `alert` event on Chat's typed ingress.
        await require('../chat/chat-delivery').event({ kind: 'channel', id: streamerId }, { type: 'alert', streamerId: Number(streamerId), streamId: streamId ? Number(streamId) : null, kind: kind === 'goal' ? 'goal' : 'donation' });
    } catch { /* non-critical */ }
}

module.exports = { playAlertSound };
