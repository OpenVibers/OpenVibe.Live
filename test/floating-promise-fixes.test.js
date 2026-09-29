'use strict';

// Plan T0 regressions: the async calls whose result nobody awaited, fixed in the two places where
// the call site — not the callee — had to change.
//
//   1. The control socket's `message` handler now AWAITS handleCommand(), so a rejection is caught
//      and logged by the handler instead of escaping as an unhandled rejection. (The other handlers
//      on that socket, key events and video clicks, are synchronous and stay as they are.)
//   2. A chat-relay bridge that fails to connect (Kick/YouTube) is still fire-and-forget — the
//      stream is already live and the relay must not block go-live — but its rejection is now
//      logged at the call site.
//
// Both modules are loaded with their DB / auth / peer-service dependencies stubbed so the test
// exercises the promise plumbing only: a rejecting dependency, never a live socket.

const assert = require('assert');
const path = require('path');

function stub(modPath, exportsObj) {
    const full = require.resolve(modPath);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

stub(path.join(__dirname, '../server/db/database'), {});
stub(path.join(__dirname, '../server/auth/auth'), { authenticateWs: () => null, extractWsToken: () => null });
stub(path.join(__dirname, '../server/chat/chat-server'), { _broadcastMessage: () => {} });

const controlServer = require('../server/controls/control-server');
const chatRelay = require('../server/integrations/chat-relay-service');

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Run `fn` with console.warn captured and every unhandled rejection recorded. */
async function capture(fn) {
    const warns = [];
    const unhandled = [];
    const originalWarn = console.warn;
    const onUnhandled = (err) => unhandled.push(err);
    console.warn = (...args) => warns.push(args.map(String).join(' '));
    process.on('unhandledRejection', onUnhandled);
    try {
        await fn();
        await tick();
        await tick();
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        console.warn = originalWarn;
    }
    return { warns, unhandled };
}

(async () => {
    // ── 1. control socket: a rejecting command handler ──────────────────────
    const listeners = [];
    const ws = {
        readyState: 1,
        on: (event, fn) => { if (event === 'message') listeners.push(fn); },
        send: () => {},
        close: () => {},
    };
    controlServer.handleViewerConnection(ws, null, new URLSearchParams(''));
    assert.strictEqual(listeners.length, 1, 'the viewer control socket registers exactly one message handler');

    const realHandleCommand = controlServer.handleCommand;
    controlServer.handleCommand = async () => { throw new Error('camera exploded'); };

    let control;
    try {
        control = await capture(() => listeners[0](JSON.stringify({ type: 'command', control_id: 1 })));
    } finally {
        controlServer.handleCommand = realHandleCommand;
    }
    assert.deepStrictEqual(control.unhandled, [], 'an awaited command failure is not an unhandled rejection');
    assert.ok(control.warns.some((w) => w.includes('camera exploded')),
        `the command failure is logged, got ${JSON.stringify(control.warns)}`);

    // The synchronous branches still run and a malformed frame is still ignored.
    let keyEvents = 0;
    controlServer.handleKeyEvent = () => { keyEvents++; };
    listeners[0]('not json at all');
    listeners[0](JSON.stringify({ type: 'key_down', key: 'w' }));
    assert.strictEqual(keyEvents, 1, 'key events still reach their handler');
    delete controlServer.handleKeyEvent;

    // ── 2. chat relay: a bridge whose connect() rejects ─────────────────────
    const realKick = chatRelay._connectKick;
    const realYouTube = chatRelay._connectYouTube;
    chatRelay._connectKick = async () => { throw new Error('kick ws refused'); };
    chatRelay._connectYouTube = async () => { throw new Error('youtube api refused'); };

    let relay;
    try {
        relay = await capture(() => {
            chatRelay.startBridge(101, { id: 7, name: 'kick example', channel_url: 'https://kick.com/example', enabled: 1, chat_relay: 1 });
            chatRelay.startBridge(102, { id: 8, name: 'yt example', channel_url: 'https://youtube.com/live/abcdefghijk', enabled: 1, chat_relay: 1 });
        });
    } finally {
        chatRelay._connectKick = realKick;
        chatRelay._connectYouTube = realYouTube;
        for (const key of Array.from(chatRelay.bridges.keys())) chatRelay.bridges.delete(key);
    }
    assert.deepStrictEqual(relay.unhandled, [], 'a failed bridge connect is not an unhandled rejection');
    assert.ok(relay.warns.some((w) => w.includes('kick ws refused')),
        `the Kick connect failure is logged, got ${JSON.stringify(relay.warns)}`);
    assert.ok(relay.warns.some((w) => w.includes('youtube api refused')),
        `the YouTube connect failure is logged, got ${JSON.stringify(relay.warns)}`);

    console.log('floating-promise-fixes: control command + chat-relay bridge rejections are logged, not unhandled');
})().catch((err) => { console.error(err); process.exit(1); });
