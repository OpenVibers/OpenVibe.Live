'use strict';

// server/chat/insight-client.js (roadmap T3): the chat-AI summaries are OpenVibe.Chat's, and Live's own
// features fold them in (the persona's prompt context, the hero slogans, the easter egg, the viewer
// clone, the channel AI timeline and the user card's chat side) by reading Chat's public
// /api/chat/ai/* answers. This checks the client they share:
//   - it reads { insight } from the right path for global / user / anon / relay chatters;
//   - an answer is cached (one fetch for repeated reads, concurrent reads share one fetch);
//   - peek*() answers null on a cold cache, warms it, and answers the insight next time;
//   - a failure answers null and never throws; bad ids never reach Chat.
// Against a stub Chat.

const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
console.warn = () => {};

const GLOBAL = { overview: 'Chat is excited about the raid.', memory: 'Raid at 20:00.', timeline: [] };
const USER = { overview_24h: 'Asks about builds.', memory: 'Plays support.' };
let failing = false;
const calls = [];
const chat = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (failing) { res.statusCode = 503; return res.end('{"error":"down"}'); }
    if (req.url === '/api/chat/ai/global') return res.end(JSON.stringify({ insight: GLOBAL }));
    if (req.url === '/api/chat/ai/user/7') return res.end(JSON.stringify({ insight: USER, streamer: null, user: { id: 7 } }));
    if (req.url === '/api/chat/ai/anon/anon42') return res.end(JSON.stringify({ insight: { overview_24h: 'lurker' } }));
    if (req.url === '/api/chat/ai/relay/twitch/Some%20One') return res.end(JSON.stringify({ insight: { overview_24h: 'from twitch' } }));
    if (req.url === '/api/chat/ai/user/8') return res.end(JSON.stringify({ insight: null }));
    res.statusCode = 404; res.end('{}');
});

(async () => {
    await new Promise((r) => chat.listen(0, '127.0.0.1', r));
    process.env.OV_CHAT_INTERNAL_URL = `http://127.0.0.1:${chat.address().port}`;
    const client = require('../server/chat/insight-client');

    assert.deepStrictEqual(await client.getGlobal(), GLOBAL);
    assert.deepStrictEqual(await client.getUser(7), USER);
    assert.deepStrictEqual(await client.getAnon('anon42'), { overview_24h: 'lurker' });
    assert.deepStrictEqual(await client.getRelay('twitch', 'Some One'), { overview_24h: 'from twitch' });
    assert.strictEqual(await client.getUser(8), null, 'no insight yet answers null');

    // Cached: repeated and concurrent reads cost one fetch.
    const before = calls.length;
    await Promise.all([client.getGlobal(), client.getGlobal(), client.getUser(7)]);
    assert.strictEqual(calls.length, before, 'cached answers are not fetched again');
    client._reset();
    await Promise.all([client.getGlobal(), client.getGlobal(), client.getGlobal()]);
    assert.strictEqual(calls.length, before + 1, 'concurrent reads share one fetch');

    // Peeks: cold → null and a background fetch; warm → the insight.
    client._reset();
    assert.strictEqual(client.peekUser(7), null, 'a cold peek answers null');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(client.peekUser(7), USER, 'the peek warmed the cache');
    assert.strictEqual(client.peekGlobal(), null);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(client.peekGlobal().overview, GLOBAL.overview);

    // Bad ids never reach Chat.
    const n = calls.length;
    assert.strictEqual(await client.getUser('x'), null);
    assert.strictEqual(await client.getAnon('../global'), null);
    assert.strictEqual(client.peekAnon('nope'), null);
    assert.strictEqual(calls.length, n, 'no request for an invalid id');

    // Chat down: null, never a throw.
    client._reset();
    failing = true;
    assert.strictEqual(await client.getGlobal(), null);
    assert.strictEqual(await client.getRelay('kick', 'someone'), null);
    assert.strictEqual(client.peekUser(7), null);

    chat.close();
    console.log('chat insight client: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
