'use strict';
/**
 * Which WebSocket paths Live upgrades, and the answer for the rest (server/index.js's upgrade handler).
 *
 * A path Live never served, or no longer serves, gets a real HTTP answer instead of a dropped socket: nginx logged
 * every drop as a 502. Old Pi robot clients still reconnect to /ws/control every few seconds (robots moved to
 * OpenVibe.Bot, plan T15): 2,137 502s from two of them in three hours on 2026-10-23. They now get a 410 that says
 * where control went, and neither answer costs a ban lookup. The vibe coding publisher socket answers the same way
 * since feeds moved to OpenVibe.Chat.
 */
const SERVED = ['/ws/broadcast', '/ws/robotstreamer-publish'];
const GONE = {
    '/ws/control': 'Robot control moved to OpenVibe.Bot: https://openvibe.bot',
    // Vibe coding feeds moved to OpenVibe.Chat (2026-10-24): a publisher posts to the feed's API there with its key.
    '/ws/vibe-coding/publish': 'Vibe coding feeds moved to OpenVibe.Chat: https://openvibe.chat/feeds',
};

/** 'served' for a path a WebSocket server here answers, else { status, text } to answer with. */
function classify(url) {
    const path = String(url || '').split('?')[0];
    if (SERVED.some((p) => path.startsWith(p))) return 'served';
    if (GONE[path]) return { status: '410 Gone', text: GONE[path] };
    return { status: '404 Not Found', text: 'No WebSocket here' };
}

/** Answer an upgrade request with a plain HTTP status and close the socket. */
function refuse(socket, { status, text }) {
    const body = `${text}\n`;
    try {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
    } catch {
        try { socket.destroy(); } catch { /* */ }
    }
}

module.exports = { classify, refuse, SERVED };
