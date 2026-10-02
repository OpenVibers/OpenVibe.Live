'use strict';
/**
 * Who runs chat (roadmap Wave 6).
 *
 * CHAT_AUTHORITY=chat: OpenVibe.Chat (127.0.0.1:4400) serves /ws/chat and the chat REST routes
 * (nginx routes them there) and owns the chat tables. Live then
 *   - does not start its chat WebSocket server or mount /api/chat, /api/dm, /api/tts, /api/sounds;
 *   - gives the modules that call require('./chat/chat-server') an inert server (RemoteChatServer
 *     in chat-server.js): nothing is forwarded to Chat;
 *   - keeps its chat tables as a read mirror that Chat writes (POST /internal/chat-effects/mirror)
 *     so its own readers (home stats, recaps, AI context, /api/mod queues) keep working and a
 *     rollback loses nothing;
 *   - answers Chat's reads and side effects on /internal/chat-context/* and /internal/chat-effects/*.
 * Anything else (default): Live runs chat itself, exactly as before.
 */

const CHAT_URL = (process.env.OV_CHAT_INTERNAL_URL || 'http://127.0.0.1:4400').replace(/\/+$/, '');

function isRemote() {
    return process.env.CHAT_AUTHORITY === 'chat';
}

module.exports = { isRemote, CHAT_URL };
