'use strict';

// CHAT_AUTHORITY=chat (T3 J2): Live's chat producers call OpenVibe.Chat's typed service-token
// ingress (/internal/chat/messages|events|moderation|invalidate, presence) through
// server/chat/chat-delivery.js — the only path; the old bridge (/internal/live/calls) and its outbox
// are gone. Each producer family reaches its endpoint with a bearer token and a stable idempotency
// key, and a Chat 5xx is logged and counted, never thrown. Against stub Network and Chat servers.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chatingress-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
process.env.CHAT_AUTHORITY = 'chat';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const ISS = 'https://openvibe.network';
const now = () => Math.floor(Date.now() / 1000);
const CAPS = ['chat.message.send', 'chat.event.publish', 'chat.moderation.write', 'chat.cache.invalidate', 'chat.presence.read'];

const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url !== '/oauth/token') { res.statusCode = 404; return res.end('{}'); }
        const f = new URLSearchParams(raw);
        const token = serviceAuth.signServiceToken({ iss: ISS, sub: 'svc:live', actor_type: 'service', aud: [f.get('audience')], cap: CAPS, iat: now(), exp: now() + 300, jti: `tok_${crypto.randomUUID()}` }, keys.privateKey);
        res.end(JSON.stringify({ access_token: token, expires_in: 300 }));
    });
});

// Stub Chat: records every ingress call; `fail` answers chosen families with a status.
const calls = [];
const bridgeCalls = [];
const fail = {};
let nextId = 5000;
const chat = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        const auth = String(req.headers.authorization || '');
        if (req.url.startsWith('/internal/live/')) {
            if (req.url === '/internal/live/calls') bridgeCalls.push(JSON.parse(raw));
            return res.end(JSON.stringify({ ok: true, results: [] }));
        }
        const m = req.url.match(/^\/internal\/chat\/(messages|events|moderation|invalidate|presence)(?:\?|$)/);
        if (!m) { res.statusCode = 404; return res.end('{}'); }
        const family = m[1];
        if (family === 'presence') return res.end(JSON.stringify({ total: 4, streams: { 1: 2 }, slow_mode: {}, users: [{ user_id: 99, ip: '198.51.100.9', stream_id: 1 }], anons: [] }));
        // Chat's message READ (Chat holds the rows now; Live reads them through it): answer the
        // row Live's own copy carries, so the moderation path's permission check sees it.
        if (family === 'messages' && req.method === 'GET') {
            const d3 = require('../server/db/database');
            const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
            const row = d3.getChatMessageById(id);
            return res.end(JSON.stringify({ ok: true, messages: row ? [row] : [], max_id: row ? id : null }));
        }
        const body = JSON.parse(raw || '{}');
        calls.push({ family, auth, body });
        const f = fail[family];
        if (f && f.times > 0) { f.times--; res.statusCode = f.status; return res.end(JSON.stringify({ error: 'down' })); }
        if (family === 'messages') return res.end(JSON.stringify({ ok: true, id: ++nextId }));
        if (family === 'moderation' && /^delete-/.test(body.action)) return res.end(JSON.stringify({ ok: true, ids: [Number(body.id) || 1] }));
        res.end(JSON.stringify({ ok: true }));
    });
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(10); }
    throw new Error(`timed out waiting for ${what}`);
}
const KEY_RE = /^live:[a-z]+:[A-Za-z0-9:._-]+$/;
const find = (family, pred) => calls.find((c) => c.family === family && pred(c.body));
function assertSigned(c, what) {
    assert.ok(c, `${what} reached Chat`);
    assert.ok(/^Bearer \S+$/.test(c.auth), `${what} carries a bearer token`);
    assert.ok(KEY_RE.test(c.body.key) && c.body.key.length <= 160, `${what} carries an idempotency key (${c.body.key})`);
}

(async () => {
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${await listen(network)}`;
    process.env.OV_CHAT_INTERNAL_URL = `http://127.0.0.1:${await listen(chat)}`;

    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    const mkUser = (username, role = 'user') => {
        const id = Number(db.createUser({ username, email: `${username}@example.test`, password_hash: '!x', display_name: username.toUpperCase(), stream_key: `key-${username}` }).lastInsertRowid);
        d.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
        return id;
    };
    const admin = mkUser('admin2', 'admin');
    const streamer = mkUser('streamer', 'streamer');
    const viewer = mkUser('viewer');
    db.createChannel({ user_id: streamer, title: 'Streamer TV' });
    const channel = db.getChannelByUserId(streamer);
    const streamId = Number(db.createStream({ user_id: streamer, channel_id: channel.id, title: 'Live now' }).lastInsertRowid);

    const delivery = require('../server/chat/chat-delivery');
    const chatServer = require('../server/chat/chat-server');
    assert.strictEqual(chatServer.remote, true);
    assert.strictEqual(delivery.ingress(), true, 'CHAT_AUTHORITY=chat is ingress, with no flag');
    chatServer.init();
    delivery.client._setRetryMs([20, 20]);

    let exit = 0;
    let rs = null;
    try {
        // 1. AI viewer line: one /messages call (persist + mirror + TTS); the caller gets no placeholder id.
        const poster = require('../server/ai/viewers/poster');
        const ret = poster.post({ streamId, userId: streamer, settings: { powerchat_forward: false } }, { id: 1, username: 'Botty', persona_json: '{}' }, 'hello from a bot');
        assert.strictEqual(ret, null, 'no placeholder id');
        const ai = await waitFor(() => find('messages', (b) => b.source_platform === 'ai'), 'AI line');
        assertSigned(ai, 'AI line');
        assert.deepStrictEqual([ai.body.stream_id, ai.body.channel_user_id, ai.body.username, ai.body.mirror, ai.body.is_global, ai.body.frame.is_ai, ai.body.tts.identity_key],
            [streamId, streamer, 'Botty', true, false, true, 'aibot:botty']);

        // 2. Donation line + alert sound (PowerChat test tip) and a direct alert.
        require('../server/integrations/powerchat-webhook').simulateDonation(streamer, { amountUsd: 2, donor: 'Tipper', message: 'gg' });
        const tip = await waitFor(() => find('messages', (b) => b.message_type === 'donation' && b.username === 'Tipper'), 'donation line');
        assertSigned(tip, 'donation line');
        assert.strictEqual(tip.body.metadata.amount, 200);
        const alert = await waitFor(() => find('events', (b) => b.frame.type === 'alert'), 'alert');
        assertSigned(alert, 'alert');
        assert.deepStrictEqual(alert.body.target, { kind: 'channel', id: streamer }, 'an alert targets its channel owner');
        assert.deepStrictEqual([alert.body.frame.streamerId, alert.body.frame.streamId, alert.body.frame.kind], [streamer, streamId, 'donation']);

        // 3. Relayed chat (Twitch): the line, the relay-user record, the welcome card; Live's own first-chat copy is kept.
        const relay = require('../server/integrations/chat-relay-service');
        relay._broadcastMessage({ platform: 'twitch', streamId }, 'alice', 'hi from twitch', {});
        const rl = await waitFor(() => find('messages', (b) => b.source_platform === 'twitch'), 'relay line');
        assertSigned(rl, 'relay line');
        assert.deepStrictEqual([rl.body.username, rl.body.frame.role, rl.body.mirror, rl.body.tts.identity_key], ['[Twitch] alice', 'external', true, 'twitch:[Twitch] alice']);
        assertSigned(await waitFor(() => find('moderation', (b) => b.action === 'relay-record' && b.username === 'alice'), 'relay record'), 'relay record');
        assertSigned(await waitFor(() => find('events', (b) => b.frame.type === 'system' && /Welcome alice/.test(b.frame.message)), 'welcome'), 'welcome');
        assert.ok(d.prepare("SELECT 1 FROM stream_first_chats WHERE chatter_key = '[Twitch] alice' OR chatter_key = 'ext:[Twitch] alice'").get(), 'Live keeps its first-chat copy');

        // 4. RobotStreamer mirror: a stub RS chat socket sends one line.
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        await new Promise((r) => wss.on('listening', r));
        rs = require('../server/integrations/robotstreamer-service');
        rs.getIntegrationForStream = () => ({ enabled: 1, token: 'rs-token', robot_id: '42', owner_id: '7', mirror_chat: 1, chat_url: `ws://127.0.0.1:${wss.address().port}` });
        wss.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify({ robot_id: '42', username: 'Goose', message: 'beep boop' }))));
        await rs.startForStream({ id: streamId, user_id: streamer, channel_id: channel.id, protocol: 'rtmp' });
        const robot = await waitFor(() => find('messages', (b) => b.source_platform === 'rs'), 'RobotStreamer line');
        assertSigned(robot, 'RobotStreamer line');
        assert.deepStrictEqual([robot.body.username, robot.body.message, robot.body.tts.identity_key], ['[RS] Goose', 'beep boop', 'rs:[RS] Goose']);
        rs.stopChatBridge(streamId);
        wss.close();

        // 5. Moderation through /api/mod: a message delete and a site ban (disconnect + log), as an admin.
        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use('/api/mod', require('../server/admin/mod-routes'));
        const port = await listen(http.createServer(app));
        const session = jwt.sign({ sub: '601', username: 'admin2', role: 'admin' }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: 300 });
        const mod = async (p, body) => {
            const r = await fetch(`http://127.0.0.1:${port}/api/mod${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` }, body: JSON.stringify(body) });
            return { status: r.status, body: await r.json().catch(() => null) };
        };
        d.prepare("INSERT INTO chat_messages (id, stream_id, channel_user_id, user_id, username, message) VALUES (900010, ?, ?, ?, 'VIEWER', 'bad')").run(streamId, streamer, viewer);
        assert.strictEqual((await mod('/delete-message', { message_id: 900010 })).status, 200);
        const del = find('moderation', (b) => b.action === 'delete-message');
        assertSigned(del, 'message delete');
        assert.deepStrictEqual([del.body.id, del.body.deleted_by, del.body.key], [900010, admin, 'live:moderation:delete:900010']);
        assert.strictEqual(db.getChatMessageById(900010).is_deleted || 0, 0, 'Chat holds the row now — Live no longer mirrors the delete');
        assertSigned(await waitFor(() => find('moderation', (b) => b.action === 'log' && b.action_type === 'message_delete'), 'delete log'), 'delete log');
        const ban = await mod(`/users/${viewer}/ban`, { reason: 'spam' });
        assert.ok(ban.status < 300, `ban answered ${ban.status}`);
        const disc = await waitFor(() => find('moderation', (b) => b.action === 'disconnect' && b.user_id === viewer), 'ban disconnect');
        assertSigned(disc, 'ban disconnect');
        assertSigned(await waitFor(() => find('moderation', (b) => b.action === 'log' && b.target_user_id === viewer && b.action_type !== 'message_delete'), 'ban log'), 'ban log');

        // 5b. A news headline: one keyed /events card to the stream.
        const news = require('../server/news/news-service');
        news._chatServer = chatServer;
        news._getActiveStreamIds = () => [streamId];
        news.isEnabledForStream = () => true;
        news._pendingQueue.push({ headline: 'Big news', sourceId: 'test' });
        news._processQueue();
        const nw = await waitFor(() => find('events', (b) => b.frame.message_type === 'news'), 'news card');
        assertSigned(nw, 'news card');
        assert.deepStrictEqual(nw.body.target, { kind: 'stream', id: streamId });
        assert.ok(/^live:events:news:\d+:\d+$/.test(nw.body.key), `news key ${nw.body.key}`);

        // 6. Deploy notice: no ingress endpoint, Events off → left unannounced (next boot retries), never bridged.
        const before = db.getSetting('deploy_last_announced');
        const dn = await require('../server/chat/deploy-notice').announce({ db, chatServer, log: { warn() {}, log() {}, info() {} } });
        assert.strictEqual(dn.announced, 0);
        assert.strictEqual(db.getSetting('deploy_last_announced'), before, 'not recorded as announced');

        // 7. Cache hints: an IP approval Live wrote, and an account change pushed by Network.
        db.approveIp(channel.id, '203.0.113.5', admin, 'manual');
        assertSigned(await waitFor(() => find('invalidate', (b) => b.approvals === channel.id), 'approvals hint'), 'approvals hint');
        delivery.invalidate({ user: viewer });
        assertSigned(await waitFor(() => find('invalidate', (b) => b.user === viewer), 'user hint'), 'user hint');

        // 8. Presence comes from /internal/chat/presence.
        await waitFor(() => chatServer.getTotalConnections() === 4, 'presence snapshot');
        assert.strictEqual(chatServer.getConnectedUserIp(99), '198.51.100.9');

        // 9. A Chat 5xx: retried with the same key, then given up; never thrown, never bridged.
        fail.events = { status: 503, times: 1 };
        const keyed = await delivery.event({ kind: 'stream', id: streamId }, { type: 'system', message: 'retry me' }, { key: 'retry-test' });
        assert.deepStrictEqual(keyed, { ok: true }, 'the retry after a 503 delivered it');
        const tries = calls.filter((c) => c.family === 'events' && c.body.frame.message === 'retry me');
        assert.deepStrictEqual(tries.map((c) => c.body.key), ['live:events:retry-test', 'live:events:retry-test'], 'a retry reuses the key');
        fail.messages = { status: 500, times: 99 };
        const failedBefore = delivery.client.stats.failed;
        let threw = null;
        try { require('../server/integrations/powerchat-webhook').simulateDonation(streamer, { donor: 'Unlucky' }); } catch (err) { threw = err; }
        assert.strictEqual(threw, null, 'a Chat 5xx is not thrown into the caller');
        await waitFor(() => delivery.client.stats.failed > failedBefore, 'the failure to be counted');
        const lost = calls.filter((c) => c.family === 'messages' && c.body.username === 'Unlucky');
        assert.strictEqual(lost.length, 3, 'tried three times');
        assert.ok(lost.every((c) => c.body.key === lost[0].body.key), 'with one key');
        fail.messages = null;
        fail.moderation = { status: 400, times: 1 };
        assert.strictEqual(await delivery.moderate('log', { action_type: 'x' }), null, 'a 4xx resolves null');
        assert.strictEqual(calls.filter((c) => c.family === 'moderation' && c.body.action_type === 'x').length, 1, 'a 4xx is not retried');

        // 10. Nothing went over the bridge, and Live keeps no outbox.
        assert.deepStrictEqual(bridgeCalls, [], 'no bridge calls');
        assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_bridge_outbox'").get(), 'no outbox table');

        // 11. A push a module still makes on the chat server goes to the ingress too (review 2026-10-02, PR #12);
        // one with no ingress target is dropped, and TTS is never synthesised here (Chat speaks `tts` lines).
        const tts = require('../server/chat/tts-engine');
        const synth = Object.keys(tts).filter((k) => typeof tts[k] === 'function');
        const touched = [];
        const saved = {};
        for (const k of synth) { saved[k] = tts[k]; tts[k] = (...a) => { touched.push(k); return saved[k](...a); }; }
        const n = calls.length;
        chatServer.broadcastToStream(streamId, { type: 'system', message: 'direct' });
        chatServer.sendDm(viewer, { type: 'dm-notice' });
        chatServer.disconnectUser({ userId: viewer, streamId });
        chatServer.sendUserUpdate(viewer, { username: 'viewer', display_name: 'VIEWER', password_hash: 'never' });
        chatServer.forwardToGlobal(streamId, { type: 'chat', message: 'no target' });
        await chatServer.synthesizeAndBroadcastTTS(streamId, 'Bot', 'beep', null, null, 'aibot:bot', null, 'm1');
        for (const k of synth) tts[k] = saved[k];
        assert.deepStrictEqual(touched, [], 'no TTS synthesis in Live');
        await waitFor(() => calls.length >= n + 4, 'direct pushes');
        const direct = calls.slice(n).map((c) => [c.family, (c.body.target && c.body.target.kind) || c.body.action || (c.body.user != null ? 'user' : null)]);
        assert.deepStrictEqual(direct.sort(), [['events', 'stream'], ['events', 'user'], ['invalidate', 'user'], ['moderation', 'disconnect']].sort());
        assert.ok(!JSON.stringify(calls.slice(n)).includes('never'), 'only the public account fields');
        // CHAT_AUTHORITY unset under a RemoteChatServer (a test or a bad env edit): dropped, never bounced back.
        process.env.CHAT_AUTHORITY = '';
        assert.strictEqual(delivery.ingress(), false);
        assert.strictEqual(chatServer.broadcastToStream(streamId, { type: 'system', message: 'x' }), undefined);
        process.env.CHAT_AUTHORITY = 'chat';
        chatServer.close();

        quiet('chat ingress (CHAT_AUTHORITY=chat): all checks passed');
    } catch (err) {
        console.error(err);
        exit = 1;
    } finally {
        try { if (rs) rs.stopChatBridge(streamId); } catch { /* */ }
        try { db.close(); } catch { /* */ }
        fs.rmSync(tmp, { recursive: true, force: true });
        process.exit(exit);
    }
})();
