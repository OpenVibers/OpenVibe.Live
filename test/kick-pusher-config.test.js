/**
 * Kick's chat relay asks web.kick.com which Pusher key and cluster to use (Kick moved its key in October 2026 and the
 * hard-coded one failed with 4001 "not in this cluster" on every reconnect):
 *   - the channel's realtime connection is asked for Pusher only, and its key and cluster are used and cached;
 *   - a failed or odd answer falls back to the last key seen working;
 *   - a 4001 error drops the cache, so the reconnect asks again.
 *
 *   node test/kick-pusher-config.test.js
 */
'use strict';
const assert = require('assert');
process.env.NODE_ENV = 'test';
console.log = () => {};
const warn = console.warn;
console.warn = () => {};

const relay = require('../server/integrations/chat-relay-service');

(async () => {
    const realFetch = globalThis.fetch;
    const asked = [];
    const KEY = 'ab'.repeat(10);   // a made-up key, built so no scanner mistakes it for a real one
    let answer = { status: 200, body: { data: { connections: [{ provider: 'pusher', credentials: { app_key: KEY, cluster: 'eu' } }], mode: 'websocket' } } };
    globalThis.fetch = async (url, init) => {
        asked.push({ url, init });
        if (answer instanceof Error) throw answer;
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    };
    try {
        relay._kickPusher = null;
        const c = await relay._kickPusherConfig({ kickChannelId: 98564718 });
        assert.deepStrictEqual([c.key, c.cluster], [KEY, 'eu']);
        assert.strictEqual(asked[0].url, 'https://web.kick.com/api/v1/realtime/channels/98564718/chat/connection');
        const body = JSON.parse(asked[0].init.body);
        assert.deepStrictEqual(body.capabilities.accepted_providers, [{ provider: 'pusher' }], 'Pusher only');
        assert.strictEqual(asked[0].init.headers['x-app-platform'], 'web');

        await relay._kickPusherConfig({ kickChannelId: 98564718 });
        assert.strictEqual(asked.length, 1, 'cached');

        relay._kickPusher = null;   // what a 4001 error does
        answer = { status: 200, body: { data: { connections: [{ provider: 'centrifugo', credentials: { url: 'wss://x' } }] } } };
        const fb = await relay._kickPusherConfig({});
        assert.strictEqual(asked[1].url, 'https://web.kick.com/api/v1/realtime/connection', 'no channel id: the general connection');
        assert.deepStrictEqual([fb.key, fb.cluster], ['34bf7a0ff419a2a775b9', 'us2'], 'no Pusher in the answer: the fallback');

        answer = new Error('network down');
        const fb2 = await relay._kickPusherConfig({ kickChannelId: 1 });
        assert.deepStrictEqual([fb2.key, fb2.cluster], ['34bf7a0ff419a2a775b9', 'us2']);

        answer = { status: 200, body: { data: { connections: [{ provider: 'pusher', credentials: { app_key: '"><script>', cluster: 'us2' } }] } } };
        relay._kickPusher = null;
        const bad = await relay._kickPusherConfig({ kickChannelId: 1 });
        assert.strictEqual(bad.key, '34bf7a0ff419a2a775b9', 'a malformed key is never put in the socket URL');
    } finally { globalThis.fetch = realFetch; }
    console.warn = warn;
    process.stdout.write('kick pusher config: all checks passed\n');
    process.exit(0);
})().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
