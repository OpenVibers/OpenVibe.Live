'use strict';
/**
 * Who runs chat (roadmap Wave 6).
 *
 * CHAT_AUTHORITY=chat: OpenVibe.Chat (127.0.0.1:4400) serves /ws/chat and the chat REST routes
 * (nginx routes them there) and owns the chat tables. Live then
 *   - does not start its chat WebSocket server or mount /api/chat, /api/dm, /api/tts, /api/sounds;
 *   - delivers every chat call its other modules make through Chat's typed ingress
 *     (server/chat/chat-delivery.js → chat-client.js), which also carries the push names, the
 *     presence reads and the address/anon helpers Live's modules used on its old chat server — Live
 *     runs no chat server in any mode;
 *   - reads chat stats, queues and history from Chat's internal read API
 *     (server/chat/chat-reads.js → chat-client.js); the read mirror Chat used to write back was
 *     retired on 2026-10-05 and Live keeps its chat tables only until a later change drops them;
 *   - answers Chat's reads and side effects on /internal/chat-context/* and /internal/chat-effects/*.
 * Anything else (default): Live runs no chat server any more (chat-server.js is gone), so chat is inert: every push
 * is dropped and logged once by chat-delivery.js. Unsetting CHAT_AUTHORITY is therefore no rollback lever.
 */

const CHAT_URL = (process.env.OV_CHAT_INTERNAL_URL || 'http://127.0.0.1:4400').replace(/\/+$/, '');

function isRemote() {
    return process.env.CHAT_AUTHORITY === 'chat';
}

module.exports = { isRemote, CHAT_URL };
