'use strict';
/**
 * Who runs chat (roadmap Wave 6).
 *
 * CHAT_AUTHORITY=chat: OpenVibe.Chat (127.0.0.1:4400) serves /ws/chat and the chat REST routes
 * (nginx routes them there) and owns the chat tables. Live then
 *   - does not start its chat WebSocket server or mount /api/chat, /api/dm, /api/tts, /api/sounds;
 *   - delivers every chat call its other modules make through Chat's typed ingress
 *     (server/chat/chat-delivery.js → chat-client.js); require('./chat/chat-server') returns a
 *     RemoteChatServer that reads Chat's presence and never listens;
 *   - reads chat stats, queues and history from Chat's internal read API
 *     (server/chat/chat-reads.js → chat-client.js), and still keeps its chat tables as a read
 *     mirror Chat writes (POST /internal/chat-effects/mirror) so the readers that have not moved
 *     yet keep working and a rollback loses nothing;
 *   - answers Chat's reads and side effects on /internal/chat-context/* and /internal/chat-effects/*.
 * Anything else (default): Live runs chat itself, exactly as before.
 */

const CHAT_URL = (process.env.OV_CHAT_INTERNAL_URL || 'http://127.0.0.1:4400').replace(/\/+$/, '');

function isRemote() {
    return process.env.CHAT_AUTHORITY === 'chat';
}

module.exports = { isRemote, CHAT_URL };
