'use strict';

// Chat moved to OpenVibe.Chat (roadmap Wave 6). What Live answers it on /internal/chat-context/*
// and /internal/chat-effects/* (service tokens, capabilities, re-checked moderators, the read
// mirror), and the chat-server proxy Live's own modules get with CHAT_AUTHORITY=chat (ordered
// bridge calls, placeholder ids for forwarded inserts, presence reads). Against stub Network and
// Chat servers.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chatctx-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
fs.mkdirSync(path.join(tmp, 'sounds'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
process.env.SOUNDS_PATH = path.join(tmp, 'sounds');
process.env.CHAT_AUTHORITY = 'chat';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const ISS = 'https://openvibe.network';
const now = () => Math.floor(Date.now() / 1000);
let jti = 0;
function serviceToken(cap, { aud = 'openvibe.live', sub = 'svc:chat' } = {}) {
    return serviceAuth.signServiceToken({ iss: ISS, sub, actor_type: 'service', aud: [aud], cap, iat: now(), exp: now() + 300, jti: `tok_test_${++jti}` }, keys.privateKey);
}
const READ = serviceToken(['live.chat_context.read']);
const WRITE = serviceToken(['live.chat_effects.write']);
const MIRROR = serviceToken(['live.chat_mirror.write']);

// Stub Network (Live's own service token for audience openvibe.chat) and stub Chat (the bridge).
const bridgeCalls = [];
const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') {
            const f = new URLSearchParams(raw);
            return res.end(JSON.stringify({ access_token: serviceToken(['chat.live_bridge.write', 'chat.presence.read'], { aud: f.get('audience'), sub: 'svc:live' }), expires_in: 300 }));
        }
        res.statusCode = 404; res.end('{}');
    });
});
const chat = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        assert.ok(String(req.headers.authorization || '').startsWith('Bearer '), 'Live calls Chat with a service token');
        if (req.url === '/internal/live/calls') {
            const body = JSON.parse(raw);
            bridgeCalls.push(body);
            return res.end(JSON.stringify({ ok: true, results: body.ops.map((o) => ({ seq: o.seq, ok: true })) }));
        }
        if (req.url === '/internal/live/presence') {
            return res.end(JSON.stringify({ total: 7, streams: { 1: 3 }, slow_mode: { 1: 5000 }, users: [{ user_id: 3, ip: '198.51.100.3', stream_id: 1 }], anons: [{ anon_id: 'anon9', ip: '203.0.113.9', stream_id: 1 }] }));
        }
        res.statusCode = 404; res.end('{}');
    });
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${await listen(network)}`;
    process.env.OV_CHAT_INTERNAL_URL = `http://127.0.0.1:${await listen(chat)}`;

    const db = require('../server/db/database');
    db.initDb();
    require('../server/chat/dm').ensureTables();
    const d = db.getDb();
    const mkUser = (username, role = 'user', extra = {}) => {
        const id = db.createUser({ username, email: `${username}@example.test`, password_hash: '!x', display_name: username.toUpperCase(), stream_key: `key-${username}` }).lastInsertRowid;
        d.prepare('UPDATE users SET role = ?, is_owner = ? WHERE id = ?').run(role, extra.owner ? 1 : 0, id);
        return Number(id);
    };
    const owner = mkUser('owner', 'admin', { owner: true });
    const admin = mkUser('admin2', 'admin');
    const streamer = mkUser('streamer', 'streamer');
    const mod = mkUser('moddy');
    const viewer = mkUser('viewer');
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', '501', 'usr_01J9ZZZZZZZZZZZZZZZZZZZZZZ')").run(viewer);
    db.createChannel({ user_id: streamer, title: 'Streamer TV' });
    const channel = db.getChannelByUserId(streamer);
    const streamId = Number(db.createStream({ user_id: streamer, channel_id: channel.id, title: 'Live now' }).lastInsertRowid);
    db.addChannelModerator ? db.addChannelModerator(channel.id, mod, streamer) : d.prepare('INSERT INTO channel_moderators (channel_id, user_id, added_by) VALUES (?, ?, ?)').run(channel.id, mod, streamer);
    d.prepare('INSERT INTO follows (follower_id, streamer_id) VALUES (?, ?)').run(viewer, streamer);
    db.setSetting('tts_enabled', 'true');
    db.setSetting('stripe_secret_key', 'sk_live_never_shared');

    const express = require('express');
    const routes = require('../server/chat/live-context-routes');
    const app = express();
    app.use(express.json());
    app.use('/internal/chat-context', routes.contextRouter);
    app.use('/internal/chat-effects', routes.effectsRouter);
    const port = await listen(http.createServer(app));
    const call = async (method, p, { token, body, headers = {} } = {}) => {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, body: json, text };
    };

    let exit = 0;
    try {
        // 1. Service tokens only: none, wrong audience, missing capability, through nginx.
        assert.strictEqual((await call('GET', '/internal/chat-context/users')).status, 401);
        assert.strictEqual((await call('GET', '/internal/chat-context/users', { token: serviceToken(['live.chat_context.read'], { aud: 'openvibe.media' }) })).status, 401);
        assert.strictEqual((await call('GET', '/internal/chat-context/users', { token: WRITE })).status, 403);
        assert.strictEqual((await call('GET', '/internal/chat-context/users', { token: READ, headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403, 'loopback only');
        assert.strictEqual((await call('POST', '/internal/chat-effects/user-color', { token: READ, body: { user_id: viewer, color: '#ff00ff' } })).status, 403, 'reads cannot write');

        // 2. Users projection: paged, with the Network subject, never secrets.
        const users = (await call('GET', '/internal/chat-context/users?after_id=0&limit=2', { token: READ })).body.rows;
        assert.strictEqual(users.length, 2);
        const all = (await call('GET', `/internal/chat-context/users?after_id=${users[1].id}`, { token: READ })).body.rows;
        const v = all.find((u) => u.id === viewer);
        assert.strictEqual(v.subject_id, 'usr_01J9ZZZZZZZZZZZZZZZZZZZZZZ');
        for (const u of users.concat(all)) { assert.ok(!('email' in u) && !('password_hash' in u) && !('stream_key' in u), 'no secrets in the projection'); }

        // 3. Token resolution follows Live's rules and carries the subject.
        const userJwt = jwt.sign({ sub: '501', username: 'viewer', subject_id: 'usr_01J9ZZZZZZZZZZZZZZZZZZZZZZ' }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: 600 });
        const auth = (await call('POST', '/internal/chat-context/auth', { token: READ, body: { token: userJwt } })).body;
        assert.strictEqual(auth.user.id, viewer);
        assert.strictEqual(auth.user.subject_id, 'usr_01J9ZZZZZZZZZZZZZZZZZZZZZZ');
        assert.strictEqual(auth.user.auth_source, 'network');
        assert.ok(auth.expires_at);
        assert.deepStrictEqual((await call('POST', '/internal/chat-context/auth', { token: READ, body: { token: 'garbage' } })).body, { user: null, reason: 'invalid' });

        // 4. Streams, channel policy (settings + moderators + language), follows, bans with version.
        const s = (await call('GET', `/internal/chat-context/streams/${streamId}`, { token: READ })).body;
        assert.strictEqual(s.stream.user_id, streamer);
        assert.strictEqual(s.owner.username, 'streamer');
        assert.strictEqual(s.channel.id, channel.id);
        assert.ok(!('stream_key' in s.stream));
        const active = (await call('GET', '/internal/chat-context/streams/active', { token: READ })).body.rows;
        assert.ok(active.some((r) => r.id === streamId && r.is_live === 1));
        const policy = (await call('GET', `/internal/chat-context/channels/${channel.id}/policy`, { token: READ })).body;
        assert.deepStrictEqual(policy.moderator_ids, [mod]);
        assert.strictEqual(policy.settings.allow_anonymous, 1, 'defaults when the channel has no row');
        assert.deepStrictEqual((await call('GET', `/internal/chat-context/users/${viewer}/follows`, { token: READ })).body.streamer_ids, [streamer]);
        const b1 = (await call('GET', '/internal/chat-context/bans', { token: READ })).body;
        assert.deepStrictEqual(b1.bans, []);
        assert.strictEqual((await call('GET', `/internal/chat-context/bans?version=${encodeURIComponent(b1.version)}`, { token: READ })).body.unchanged, true);
        const settings = (await call('GET', '/internal/chat-context/settings', { token: READ })).body.settings;
        assert.strictEqual(settings.tts_enabled, db.getSetting('tts_enabled'), 'typed like Live\'s getSetting');
        assert.ok(!('stripe_secret_key' in settings), 'only chat settings leave Live');

        // 5. Effects need CHAT_AUTHORITY=chat.
        process.env.CHAT_AUTHORITY = '';
        assert.strictEqual((await call('POST', '/internal/chat-effects/user-color', { token: WRITE, body: { user_id: viewer, color: '#ff00ff' } })).status, 409);
        process.env.CHAT_AUTHORITY = 'chat';
        assert.strictEqual((await call('POST', '/internal/chat-effects/user-color', { token: WRITE, body: { user_id: viewer, color: '#ff00ff' } })).status, 200);
        assert.strictEqual(db.getUserById(viewer).profile_color, '#ff00ff');

        // 6. Bans: Live re-checks the moderator; the rows are exactly chat-server's.
        const ban = (body) => call('POST', '/internal/chat-effects/ban', { token: WRITE, body });
        assert.strictEqual((await ban({ action: 'ban', actor_user_id: viewer, moderation_stream_id: streamId, stream_id: streamId, user_id: mod })).status, 403, 'a viewer cannot ban');
        assert.strictEqual((await ban({ action: 'ban', actor_user_id: mod, moderation_stream_id: streamId, stream_id: streamId, user_id: owner })).status, 403, 'a channel mod cannot ban an admin');
        assert.strictEqual((await ban({ action: 'ban', actor_user_id: mod, moderation_stream_id: streamId, stream_id: streamId, user_id: viewer, reason: 'Banned by moderator', banned_by: mod })).status, 200);
        assert.ok(db.isUserBanned(viewer, streamId));
        const b2 = (await call('GET', `/internal/chat-context/bans?version=${encodeURIComponent(b1.version)}`, { token: READ })).body;
        assert.strictEqual(b2.bans.length, 1, 'the version moved with the table');
        assert.strictEqual((await ban({ action: 'unban', actor_user_id: mod, moderation_stream_id: streamId, stream_id: streamId, user_id: viewer })).status, 200);
        assert.ok(!db.isUserBanned(viewer, streamId));
        // A null stream id is a site-wide ban: global staff only, and a channel unban never lifts one.
        assert.strictEqual((await ban({ action: 'ban', actor_user_id: mod, moderation_stream_id: streamId, stream_id: null, user_id: viewer })).status, 403, 'a channel mod cannot ban site-wide');
        assert.strictEqual((await ban({ action: 'ban', actor_user_id: admin, stream_id: null, user_id: viewer, reason: 'site' })).status, 200);
        assert.strictEqual((await ban({ action: 'unban', actor_user_id: mod, moderation_stream_id: streamId, stream_id: null, user_id: viewer })).status, 403, 'a channel mod cannot lift a site-wide ban');
        assert.strictEqual((await ban({ action: 'unban', actor_user_id: mod, moderation_stream_id: streamId, stream_id: streamId, user_id: viewer })).status, 200);
        assert.ok(db.get('SELECT 1 FROM bans WHERE user_id = ? AND stream_id IS NULL', [viewer]), 'the channel unban left the site-wide row');
        assert.strictEqual((await ban({ action: 'unban', actor_user_id: admin, stream_id: null, user_id: viewer })).status, 200);
        assert.ok(!db.get('SELECT 1 FROM bans WHERE user_id = ?', [viewer]));

        // 7. TTS settings: admins; credentials only the owner.
        const put = (actor, settingsBody) => call('POST', '/internal/chat-effects/site-settings', { token: WRITE, body: { actor_user_id: actor, settings: settingsBody } });
        assert.strictEqual((await put(viewer, { tts_enabled: 'false' })).status, 403);
        assert.strictEqual((await put(admin, { tts_max_length: 300, tts_google_api_key: 'admin-cannot' })).body.updated, 1);
        assert.notStrictEqual(db.getSetting('tts_google_api_key'), 'admin-cannot', 'an admin cannot set a credential');
        assert.strictEqual((await put(owner, { tts_google_api_key: 'owner-can' })).body.updated, 1);
        assert.strictEqual(db.getSetting('tts_google_api_key'), 'owner-can');

        // 8. Slow mode persistence and alert sounds: only for people who may.
        assert.strictEqual((await call('POST', '/internal/chat-effects/channel-settings', { token: WRITE, body: { channel_id: channel.id, actor_user_id: viewer, fields: { slow_mode_seconds: 9 } } })).status, 403);
        assert.strictEqual((await call('POST', '/internal/chat-effects/channel-settings', { token: WRITE, body: { channel_id: channel.id, actor_user_id: mod, fields: { slow_mode_seconds: 9 } } })).status, 200);
        assert.strictEqual(db.getChannelModerationSettings(channel.id).slow_mode_seconds, 9);
        const snd = path.join(tmp, 'sounds', 'alert.mp3'); fs.writeFileSync(snd, 'x');
        assert.strictEqual((await call('POST', '/internal/chat-effects/alert-sound', { token: WRITE, body: { channel_id: channel.id, actor_user_id: mod, kind: 'donation', url: snd } })).status, 403, 'only the channel owner');
        assert.strictEqual((await call('POST', '/internal/chat-effects/alert-sound', { token: WRITE, body: { channel_id: channel.id, actor_user_id: streamer, kind: 'donation', url: '/etc/passwd' } })).status, 400, 'files stay in the sounds dir');
        assert.strictEqual((await call('POST', '/internal/chat-effects/alert-sound', { token: WRITE, body: { channel_id: channel.id, actor_user_id: streamer, kind: 'donation', url: snd } })).status, 200);

        // 9. The read mirror: same ids, Chat-only columns ignored, Live-only columns kept.
        const mirror = (changes) => call('POST', '/internal/chat-effects/mirror', { token: MIRROR, body: { changes } });
        assert.strictEqual((await call('POST', '/internal/chat-effects/mirror', { token: WRITE, body: { changes: [] } })).status, 403, 'mirror has its own capability');
        let m = await mirror([{ table: 'chat_messages', op: 'upsert', row: { id: 900001, stream_id: streamId, channel_user_id: streamer, user_id: viewer, username: 'VIEWER', message: 'hi from chat', message_type: 'chat', is_global: 0, is_deleted: 0, timestamp: '2026-09-22 10:00:00', subject_id: 'usr_01J9ZZZZZZZZZZZZZZZZZZZZZZ' } }]);
        assert.strictEqual(m.body.applied, 1);
        assert.strictEqual(db.getChatMessageById(900001).message, 'hi from chat');
        // Columns only Live's copy has (media-proxy/asset-sync adds them at start).
        for (const c of ['media_url TEXT', 'media_asset_id INTEGER']) { try { d.exec(`ALTER TABLE channel_sounds ADD COLUMN ${c}`); } catch { /* present */ } }
        d.prepare("INSERT INTO channel_sounds (id, channel_owner_id, command, url, media_asset_id) VALUES (77, ?, 'honk', '/x.mp3', 555)").run(streamer);
        m = await mirror([{ table: 'channel_sounds', op: 'upsert', row: { id: 77, channel_owner_id: streamer, command: 'honk2', url: '/x.mp3', created_by_subject_id: null } }, { table: 'chat_messages', op: 'delete', pk: { id: 900001 } }, { table: 'users', op: 'delete', pk: { id: viewer } }]);
        assert.strictEqual(m.body.applied, 2);
        assert.strictEqual(m.body.skipped.length, 1, 'only chat tables are mirrored');
        const s77 = d.prepare('SELECT command, media_asset_id FROM channel_sounds WHERE id = 77').get();
        assert.deepStrictEqual(s77, { command: 'honk2', media_asset_id: 555 });
        assert.strictEqual(db.getChatMessageById(900001), undefined);
        assert.ok(db.getUserById(viewer), 'users are never touched');

        // 10. The proxy Live's modules get: ordered bridge calls, placeholders, presence.
        const chatServer = require('../server/chat/chat-server');
        assert.strictEqual(chatServer.remote, true);
        chatServer.init();
        const before = d.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n;
        const saved = db.saveChatMessage({ stream_id: streamId, user_id: null, username: 'Bot', message: 'beep', message_type: 'chat', source_platform: 'ai' });
        assert.ok(saved.lastInsertRowid <= -(2 ** 40), 'a placeholder id');
        assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, before, 'inserts happen in Chat, not here');
        assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM chat_bridge_outbox').get().n, 1, 'kept until Chat acknowledges');
        chatServer.broadcastToStream(streamId, { type: 'chat', id: saved.lastInsertRowid, message: 'beep' });
        chatServer.synthesizeAndBroadcastTTS(streamId, 'Bot', 'beep', null, null, 'aibot:bot', null, `m${saved.lastInsertRowid}`);
        await chatServer.flush();
        await sleep(100);
        const ops = bridgeCalls.flatMap((c) => c.ops);
        assert.deepStrictEqual(ops.map((o) => o.op), ['db', 'broadcastToStream', 'synthesizeAndBroadcastTTS']);
        assert.strictEqual(ops[0].args[0], 'saveChatMessage');
        assert.strictEqual(ops[0].ref, saved.lastInsertRowid);
        assert.ok(/^live:\d+$/.test(ops[0].key), 'forwarded writes carry an idempotency key');
        assert.strictEqual(ops[1].args[1].id, saved.lastInsertRowid);
        assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM chat_bridge_outbox').get().n, 0, 'acknowledged writes leave the outbox');
        // Deletes run on the mirror at once (their ids are returned) and are forwarded too.
        d.prepare("INSERT INTO chat_messages (id, user_id, username, message) VALUES (900002, ?, 'MODDY', 'x')").run(mod);
        assert.deepStrictEqual(db.deleteUserChatMessages(mod, {}), [900002]);
        await chatServer.flush();
        assert.deepStrictEqual(bridgeCalls.at(-1).ops[0].args.slice(0, 2), ['deleteUserChatMessages', mod]);
        // Live's own writes to data Chat caches (dashboard mods, IP approvals) tell Chat to reload it.
        db.addChannelModerator(channel.id, viewer, streamer);
        await chatServer.flush();
        assert.deepStrictEqual(bridgeCalls.at(-1).ops.map((o) => [o.op, ...o.args]), [['invalidate', 'channel', channel.id]]);
        assert.ok(d.prepare('SELECT 1 FROM channel_moderators WHERE channel_id = ? AND user_id = ?').get(channel.id, viewer), 'the write itself still happens in Live');
        // The /api/mod global delete loops over chatServer.clients: one pseudo-socket reaches everyone.
        for (const [ws] of chatServer.clients) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'delete-messages', ids: [1] })); }
        await chatServer.flush();
        assert.strictEqual(bridgeCalls.at(-1).ops[0].op, 'broadcastAllRaw');
        // Synchronous reads come from Chat's presence snapshot.
        await sleep(200);
        assert.strictEqual(chatServer.getTotalConnections(), 7);
        assert.strictEqual(chatServer.getStreamViewerCount(1), 3);
        assert.strictEqual(chatServer.slowModeByStream.get(1), 5000);
        assert.strictEqual(chatServer.getConnectedUserIp(3), '198.51.100.3');
        assert.strictEqual(chatServer.findClientByAnonId('anon9', 1).ip, '203.0.113.9');
        assert.strictEqual(chatServer.findClientByAnonId('anon9', 2), null);
        // A /ws/chat upgrade that still lands on Live is refused, not served from the mirror.
        let written = '';
        chatServer.handleUpgrade({}, { write: (x) => { written += x; }, destroy() {} });
        assert.match(written, /^HTTP\/1\.1 503/);
        chatServer.close();

        // Rollback: writes Chat never acknowledged are applied to Live's own tables.
        d.prepare("INSERT INTO chat_bridge_outbox (boot, ref, op, args) VALUES ('old', -1, 'db', ?)").run(JSON.stringify(['recordFirstChat', 'user:77', streamer]));
        chatServer._restoreDb();
        assert.strictEqual(require('../server/chat/chat-remote').drainToLocal({ log() {}, warn() {} }), 1);
        assert.ok(d.prepare("SELECT 1 FROM stream_first_chats WHERE chatter_key = 'user:77'").get());
        assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM chat_bridge_outbox').get().n, 0);

        quiet('chat context (Live side of OpenVibe.Chat): all checks passed');
    } catch (err) {
        console.error(err);
        exit = 1;
    } finally {
        try { db.close(); } catch { /* */ }
        fs.rmSync(tmp, { recursive: true, force: true });
        process.exit(exit);
    }
})();
