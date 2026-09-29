/**
 * alerts.js — streamer alert sounds for donations / donation-goal-reached events.
 *
 * The sound mapping lives on channel_moderation_settings, which OpenVibe.Chat owns and reads locally
 * (roadmap T3), so Live no longer reads the file or broadcasts base64 itself. It asks Chat to play the
 * alert through the chat bridge — op `playAlertSound [streamerId, streamId, kind]` — and Chat resolves
 * the sound from its own settings row, reads the shared sounds file and broadcasts the
 * `soundboard-audio` message to the channel room. In production CHAT_AUTHORITY=chat, so `chatServer`
 * is the chat-remote proxy (server/chat/chat-remote.js) and the call is queued to Chat like every
 * other push. A goal-reached event is `kind: 'goal'` (Chat falls back to the donation sound).
 */
'use strict';

/**
 * Ask Chat to play a streamer's alert sound to their viewers (channel-wide, so it reaches every slot
 * plus the offline room). kind: 'donation' | 'goal'. No-op if Chat is not the authority or nothing is
 * configured. Chat answers `played:false` (never an error) when the channel has no sound.
 */
function playAlertSound(chatServer, streamerId, streamId, kind) {
    try {
        if (!chatServer || typeof chatServer.playAlertSound !== 'function') return;
        chatServer.playAlertSound(streamerId, streamId, kind === 'goal' ? 'goal' : 'donation');
    } catch { /* non-critical */ }
}

module.exports = { playAlertSound };
