'use strict';
/**
 * A chat connection keeps the channel it was opened for (public/js/chat.js initChat).
 *
 * destroyChat() clears chatChannelUserId (a later global fetch must not inherit a page's channel), and initChat()
 * called it AFTER setting the new page's channel, so from 2026-09-19 every fresh socket joined with no channel. On the
 * streamer's own channel page _isOwnChannelChat() was then false, chat took it for someone else's, and the streamer's
 * own messages were never read aloud there while everyone else's were (owner, 2026-10-17: Chat's queue had the TTS
 * delivered to stream 2628, the page skipped it). The broadcast page and the re-auth / account-switch reconnects also
 * opened the chat with no channel at all.
 *
 * initChat and destroyChat run here as written, on stub sockets; everything else they touch is a no-op.
 *
 *   node test/chat-channel-scope.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/js/chat.js'), 'utf8');
function fn(name) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} is in chat.js`);
    let depth = 0, end = src.indexOf('{', start);
    for (let i = end; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    return src.slice(start, end);
}

function load({ streaming = false } = {}) {
    const sent = [];
    class FakeWS {
        constructor(url) { this.url = url; this.readyState = FakeWS.CONNECTING; FakeWS.last = this; }
        send(data) { sent.push(JSON.parse(data)); }
        close() { this.readyState = FakeWS.CLOSED; }
    }
    Object.assign(FakeWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    const state = {
        WebSocket: FakeWS,
        window: { location: { hostname: 'openvibe.live', port: '', protocol: 'https:' } },
        localStorage: { getItem: () => 'tok' },
        isStreaming: () => streaming,
        getChatRenderTargetId: () => 'chat-messages',
        getChatEl: () => ({ messages: null }),
        refreshVibeWidgetFeed: () => Promise.resolve(),
        hydrateActiveChatHistory: () => Promise.resolve(),
        CHAT_RECONNECT_BASE: 1000,
        console,
    };
    const names = ['chatWs', 'chatStreamId', 'chatChannelUserId', 'chatRenderTargetId', '_chatActive',
        '_chatIntentionalClose', '_chatReconnectDelay', '_chatReconnectTimer', '_bgBroadcastWs', '_bgBroadcastStreamId',
        '_fullscreenChatRecent', '_suppressNextAuthNotice'];
    for (const n of names) state[n] = null;
    // Anything else the two functions touch (rendering, notices, widgets) is a no-op.
    const scope = new Proxy(state, {
        has: (t, k) => typeof k === 'string' && !(k in globalThis && !(k in t)),
        get: (t, k) => (k in t ? t[k] : () => undefined),
        set: (t, k, v) => { t[k] = v; return true; },
    });
    const run = new Function('scope', `with (scope) { ${fn('initChat')}\n${fn('destroyChat')}\n return { initChat, destroyChat }; }`);
    return { ...run(scope), state, sent, FakeWS };
}

// A channel page while the streamer is live (app-channel.js: initChat(stream.id, stream.user_id)): a fresh socket
// joins with the channel, and the page knows whose chat it is.
{
    const { initChat, state, sent, FakeWS } = load();
    initChat(2628, 1);
    assert.strictEqual(state.chatChannelUserId, 1, 'the page keeps its channel after the fresh-socket teardown');
    FakeWS.last.readyState = FakeWS.OPEN;
    FakeWS.last.onopen();
    assert.deepStrictEqual(sent.map((m) => [m.type, m.streamId, m.channelUserId]), [['join', 2628, 1]]);
}

// An offline channel page (initChat(null, ch.user_id)): the join names the channel, or Chat puts the socket in global.
{
    const { initChat, state, sent, FakeWS } = load();
    initChat(null, 7);
    FakeWS.last.readyState = FakeWS.OPEN;
    FakeWS.last.onopen();
    assert.strictEqual(state.chatChannelUserId, 7);
    assert.deepStrictEqual(sent.map((m) => [m.streamId, m.channelUserId]), [[null, 7]]);
}

// Leaving for global chat still drops the channel (what destroyChat's reset is for).
{
    const { initChat, destroyChat, state } = load();
    initChat(null, 7);
    destroyChat(true);
    initChat(null);
    assert.strictEqual(state.chatChannelUserId, null);
}

// Back on the broadcast page while live: the background socket is reclaimed, and the channel set for this page stays.
{
    const { initChat, state, FakeWS } = load({ streaming: true });
    const bg = new FakeWS('wss://bg');
    bg.readyState = FakeWS.OPEN;
    Object.assign(state, { _bgBroadcastWs: bg, _bgBroadcastStreamId: 2628 });
    initChat(2628, 1);
    assert.strictEqual(state.chatWs, bg, 'the background socket is reused');
    assert.strictEqual(state.chatChannelUserId, 1);
}

// The callers that reopen a chat pass its channel on: the broadcast page (its own channel), the re-auth reconnect and
// the account switch.
const bcast = fs.readFileSync(path.join(__dirname, '../public/js/broadcast.js'), 'utf8');
assert.match(bcast, /initChat\(streamId, \(typeof currentUser !== 'undefined' && currentUser && currentUser\.id\) \|\| null\)/);
assert.match(src, /if \(sid \|\| ch\) initChat\(sid \|\| null, ch\);/);
assert.match(src, /destroyChat\(true\);\s*initChat\(sid \|\| null, ch\);/);

console.log('chat-channel-scope: ok');
