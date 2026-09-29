'use strict';

// server/chat/moderation-client.js (roadmap T3): Live reads the six chat tables OpenVibe.Chat owns
// through ONE internal read API (Contracts 0.80.0 chat.moderation.read, audience openvibe.chat, Live's
// service token). This file checks the client the permissions hot path now depends on:
//   - it calls Chat with a Bearer service token and reads { ok:true, … } answers;
//   - every answer is cached 30 s (one fetch for repeated reads), invalidate() drops it;
//   - a failure (or no secret) answers the safe default — "not a moderator", Live's moderation
//     defaults, zero emotes — and never throws;
//   - with openvibe-contracts >= 0.80.0 installed the stub's answers validate against the three
//     result contracts (chat.channel-moderation-result@1, chat.moderated-channels-result@1,
//     chat.emote-count-result@1). The repo pins 0.71.0 today, so that block is conditional.
//
// Against stub Network (token endpoint) and stub Chat (the three read routes).

const assert = require('assert');
const http = require('http');

process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'moderation-secret';
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

let failing = false;
const calls = [];

const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'stub-chat-token', expires_in: 300 }));
        res.statusCode = 404; res.end('{}');
    });
});

const MOD_SETTINGS = { channel_id: 5, slow_mode_seconds: 7, custom_emotes_enabled: 1 };
const MOD = { ok: true, settings: MOD_SETTINGS, moderator_ids: [11, 22] };
const CHANS = { ok: true, channels: [{ channel_id: 5, title: 'Streamer TV', owner_user_id: 5, owner_username: 'streamer' }] };
const COUNT = { ok: true, count: 3 };
const chat = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (failing) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: 'boom' })); }
    if (/^\/internal\/moderation\/channels\/\d+\/emote-count$/.test(req.url)) return res.end(JSON.stringify(COUNT));
    if (/^\/internal\/moderation\/channels\/\d+$/.test(req.url)) return res.end(JSON.stringify(MOD));
    if (/^\/internal\/moderation\/users\/\d+\/channels$/.test(req.url)) return res.end(JSON.stringify(CHANS));
    res.statusCode = 404; res.end('{}');
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${await listen(network)}`;
    process.env.OV_CHAT_INTERNAL_URL = `http://127.0.0.1:${await listen(chat)}`;
    const client = require('../server/chat/moderation-client');

    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); quiet(`  ✓ ${name}`); } catch (err) { failures++; quiet(`  ✗ ${name}\n    ${err.stack || err.message}`); }
    };

    await check('enabled, audience and cache TTL', () => {
        assert.strictEqual(client.enabled(), true);
        assert.strictEqual(client.AUDIENCE, 'openvibe.chat');
        assert.strictEqual(client.CACHE_TTL_MS, 30000);
    });

    await check('a channel read: Bearer service token, { settings, moderator_ids }', async () => {
        const m = await client.getChannelModeration(5);
        assert.deepStrictEqual(m.moderator_ids, [11, 22]);
        assert.strictEqual(m.settings.slow_mode_seconds, 7);
        assert.strictEqual(m.settings.channel_id, 5);
        assert.strictEqual(calls.length, 1);
        assert.ok(String(calls[0].auth || '').startsWith('Bearer '), 'Chat is called with a service token');
        assert.strictEqual(calls[0].url, '/internal/moderation/channels/5');
    });

    await check('the answer is cached 30 s; invalidate() drops it', async () => {
        await client.getChannelModeration(5);
        assert.strictEqual(calls.length, 1, 'the second read is served from the cache');
        client.invalidate(5);
        await client.getChannelModeration(5);
        assert.strictEqual(calls.length, 2, 'after invalidate() the next read asks Chat again');
    });

    await check('moderated channels and emote count', async () => {
        const rows = await client.getChannelsByModerator(9);
        assert.deepStrictEqual(rows, [{ id: 5, channel_id: 5, title: 'Streamer TV', user_id: 5, owner_username: 'streamer' }]);
        assert.ok(String(calls[calls.length - 1].auth || '').startsWith('Bearer '));
        assert.strictEqual(await client.getEmoteCount(5), 3);
    });

    await check('a failure answers the safe default, never throws', async () => {
        failing = true;
        const m = await client.getChannelModeration(77);
        assert.deepStrictEqual(m.moderator_ids, [], 'not a moderator');
        assert.strictEqual(m.settings.slow_mode_seconds, 0, 'Live\'s default settings');
        assert.strictEqual(m.settings.channel_id, 77);
        assert.deepStrictEqual(await client.getChannelsByModerator(77), []);
        assert.strictEqual(await client.getEmoteCount(77), 0);
        failing = false;
    });

    await check('without a secret the client is off and answers defaults (no request)', async () => {
        client._reset();
        const before = calls.length;
        process.env.OV_OAUTH_CLIENT_SECRET = '';
        try {
            const m = await client.getChannelModeration(88);
            assert.deepStrictEqual(m.moderator_ids, []);
            assert.strictEqual(await client.getEmoteCount(88), 0);
            assert.strictEqual(calls.length, before, 'nothing is sent when Live is not configured');
        } finally {
            process.env.OV_OAUTH_CLIENT_SECRET = 'moderation-secret';
            client._reset();
        }
    });

    // The three result contracts validate the stub's answers when the package knows them. Live pins
    // openvibe-contracts 0.71.0 (these arrived in 0.80.0), so today this block is skipped; a release
    // that bumps the pin validates here.
    await check('the three result contracts validate the answers (validator present in this pin?)', async () => {
        const contracts = require('openvibe-contracts');
        const known = (name) => { try { return !!contracts.schema(name); } catch { return false; } };
        // The client answers { settings, moderator_ids } (Chat's `ok` is consumed): rebuild the contract
        // payload from the client's own output — Live's defaults merged with Chat's row.
        const m = await client.getChannelModeration(5);
        if (known('chat.channel-moderation-result@1')) contracts.assertValid('chat.channel-moderation-result@1', { ok: true, settings: m.settings, moderator_ids: m.moderator_ids });
        if (known('chat.moderated-channels-result@1')) contracts.assertValid('chat.moderated-channels-result@1', CHANS);
        if (known('chat.emote-count-result@1')) contracts.assertValid('chat.emote-count-result@1', COUNT);
    });

    process.env.OV_OAUTH_CLIENT_SECRET = '';
    network.close(); chat.close();
    if (failures) { quiet(`chat moderation client: ${failures} failed`); process.exit(1); }
    quiet('chat moderation client: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
