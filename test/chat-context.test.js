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
        // Chat's internal read API (roadmap T3): Live reads the six staged tables through it now.
        const mm = String(req.url).match(/^\/internal\/moderation\/channels\/(\d+)(\/emote-count)?$/);
        if (mm) {
            const d2 = require('../server/db/database');
            const channelId = Number(mm[1]);
            // Chat answers these from its own tables (it owns the six staged tables, roadmap T3); the
            // test reads them directly here to emulate Chat's copy.
            if (mm[2]) {
                const ch = d2.getChannelById(channelId);
                const n = ch ? (d2.get('SELECT COUNT(*) AS n FROM emotes WHERE (channel_owner_id = ?) OR (channel_owner_id IS NULL AND user_id = ?)', [ch.user_id, ch.user_id])?.n || 0) : 0;
                return res.end(JSON.stringify({ ok: true, count: n }));
            }
            return res.end(JSON.stringify({
                ok: true,
                settings: d2.get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [channelId]) || {},
                moderator_ids: d2.all('SELECT user_id FROM channel_moderators WHERE channel_id = ? ORDER BY id', [channelId]).map((r) => r.user_id),
            }));
        }
        const um = String(req.url).match(/^\/internal\/moderation\/users\/(\d+)\/channels$/);
        if (um) {
            const d2 = require('../server/db/database');
            const rows = d2.all('SELECT cm.channel_id AS id, c.title, c.user_id FROM channel_moderators cm JOIN channels c ON cm.channel_id = c.id WHERE cm.user_id = ?', [Number(um[1])]) || [];
            return res.end(JSON.stringify({ ok: true, channels: rows.map((c) => ({ channel_id: c.id, title: c.title, owner_user_id: c.user_id })) }));
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
    // Live no longer has the staged chat tables (dropped in T3 N+2); the stub Chat below imitates
    // Chat's own copy, so the test keeps local copies to seed and read.
    d.exec(`
        CREATE TABLE IF NOT EXISTS channel_moderators (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            added_by INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(channel_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS channel_moderation_settings (
            channel_id INTEGER PRIMARY KEY,
            slow_mode_seconds INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS emotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            channel_owner_id INTEGER
        );
    `);
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
    d.prepare('INSERT INTO channel_moderators (channel_id, user_id, added_by) VALUES (?, ?, ?)').run(channel.id, mod, streamer);
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

        // 4. Streams, channel policy (language; settings and moderator ids are Chat's now), follows, bans with version.
        const s = (await call('GET', `/internal/chat-context/streams/${streamId}`, { token: READ })).body;
        assert.strictEqual(s.stream.user_id, streamer);
        assert.strictEqual(s.owner.username, 'streamer');
        assert.strictEqual(s.channel.id, channel.id);
        assert.ok(!('stream_key' in s.stream));
        const active = (await call('GET', '/internal/chat-context/streams/active', { token: READ })).body.rows;
        assert.ok(active.some((r) => r.id === streamId && r.is_live === 1));
        const policy = (await call('GET', `/internal/chat-context/channels/${channel.id}/policy`, { token: READ })).body;
        // OpenVibe.Chat owns channel_moderation_settings/channel_moderators (roadmap T3) and reads them
        // locally; Live answers only the channel row and the language it owns.
        assert.strictEqual(policy.channel.id, channel.id);
        assert.strictEqual(policy.language, 'en');
        assert.ok(!('settings' in policy) && !('moderator_ids' in policy), 'the policy half is Chat-local now');
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

        // 8. Slow mode and sub-only persistence moved to Chat with channel_moderation_settings (roadmap
        // T3); Live now only writes channels.emote_sources for Chat's PUT /api/emotes/sources.
        assert.strictEqual((await call('POST', '/internal/chat-effects/channel-emote-sources', { token: WRITE, body: { user_id: 999999, sources: { ffz: true } } })).status, 404);
        assert.strictEqual((await call('POST', '/internal/chat-effects/channel-emote-sources', { token: WRITE, body: { user_id: streamer, sources: { ffz: true, bttv: false } } })).status, 200);
        assert.strictEqual(db.getChannelByUserId(streamer).emote_sources, JSON.stringify({ ffz: true, bttv: false }));

        // 8a. Sub-only chat asks whether someone holds an ACTIVE subscription to the streamer's channel:
        // by user id or Network subject; a lapsed period or a cancelled row is not one.
        const subOf = (q) => call('GET', `/internal/chat-context/subscriber?${q}`, { token: READ });
        assert.strictEqual((await call('GET', `/internal/chat-context/subscriber?user_id=${viewer}&streamer_id=${streamer}`, { token: WRITE })).status, 403, 'a read capability');
        assert.strictEqual((await subOf(`streamer_id=${streamer}`)).status, 400);
        assert.deepStrictEqual((await subOf(`user_id=${viewer}&streamer_id=${streamer}`)).body, { subscriber: false, user_id: viewer, streamer_id: streamer });
        db.upsertSubscription({ subscriber_id: viewer, streamer_id: streamer, status: 'active', current_period_end: new Date(Date.now() + 86400e3).toISOString() });
        assert.strictEqual((await subOf(`user_id=${viewer}&streamer_id=${streamer}`)).body.subscriber, true);
        assert.strictEqual((await subOf(`subject=usr_01J9ZZZZZZZZZZZZZZZZZZZZZZ&streamer_id=${streamer}`)).body.subscriber, true, 'by Network subject');
        assert.strictEqual((await subOf(`subject=usr_01J9UNKNOWNZZZZZZZZZZZZZZZ&streamer_id=${streamer}`)).body.subscriber, false, 'an unknown subject');
        assert.strictEqual((await subOf(`user_id=${viewer}&streamer_id=${mod}`)).body.subscriber, false, 'another channel');
        db.upsertSubscription({ subscriber_id: viewer, streamer_id: streamer, status: 'active', current_period_end: new Date(Date.now() - 60e3).toISOString() });
        assert.strictEqual((await subOf(`user_id=${viewer}&streamer_id=${streamer}`)).body.subscriber, false, 'the paid period is over');
        db.upsertSubscription({ subscriber_id: viewer, streamer_id: streamer, status: 'canceled', current_period_end: new Date(Date.now() + 86400e3).toISOString() });
        assert.strictEqual((await subOf(`user_id=${viewer}&streamer_id=${streamer}`)).body.subscriber, false, 'not active');
        // Alert sounds moved to Chat with channel_moderation_settings (roadmap T3): Chat resolves the
        // sound from its own row and plays it through the bridge op, so Live's effect is gone.

        // 8b. A ring from Chat's call server (CALLS_AUTHORITY=chat): Live pushes the VC_CALL_INVITE it used to.
        const notify = require('../server/utils/notify');
        const pushed = [];
        const origPush = notify.pushNotification;
        notify.pushNotification = (p) => pushed.push(p);
        try {
            assert.strictEqual((await call('POST', '/internal/chat-effects/notify/call-invite', { token: READ, body: { caller_id: streamer, target_id: viewer, channel_id: 'user-1-x' } })).status, 403, 'an effect');
            assert.strictEqual((await call('POST', '/internal/chat-effects/notify/call-invite', { token: WRITE, body: { caller_id: streamer, target_id: 999999, channel_id: 'user-1-x' } })).status, 400);
            assert.strictEqual((await call('POST', '/internal/chat-effects/notify/call-invite', { token: WRITE, body: { caller_id: streamer, target_id: viewer, channel_id: `user-${streamer}-x`, channel_name: 'STREAMER\'s call' } })).status, 200);
        } finally { notify.pushNotification = origPush; }
        assert.strictEqual(pushed.length, 1);
        assert.deepStrictEqual([pushed[0].user_id, pushed[0].type, pushed[0].title, pushed[0].message, pushed[0].sender_id, pushed[0].rich_content.context.caller_username],
            [viewer, 'VC_CALL_INVITE', 'STREAMER is calling you', 'Join voice channel: STREAMER\'s call', streamer, 'streamer']);
        assert.ok(pushed[0].url.endsWith(`/?vcInvite=${encodeURIComponent(`user-${streamer}-x`)}`));

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

        // 10. The server Live's modules get in this mode is inert: nothing goes to Chat.
        const chatServer = require('../server/chat/chat-server');
        assert.strictEqual(chatServer.remote, true);
        assert.strictEqual(chatServer.init(), null);
        const before = d.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n;
        const saved = db.saveChatMessage({ stream_id: streamId, user_id: null, username: 'Bot', message: 'beep', message_type: 'chat', source_platform: 'ai' });
        assert.ok(saved.lastInsertRowid > 0, 'a plain local insert, not a placeholder');
        assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, before + 1);
        chatServer.broadcastToStream(streamId, { type: 'chat', id: saved.lastInsertRowid, message: 'beep' });
        await sleep(100);
        assert.strictEqual(bridgeCalls.length, 0, 'Live makes no POST /internal/live/calls');
        assert.strictEqual(chatServer.getTotalConnections(), 0, 'and polls no presence');
        assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_bridge_outbox'").get(), 'the outbox table is gone');
        // A /ws/chat upgrade that still lands on Live is refused, not served from the mirror.
        let written = '';
        chatServer.handleUpgrade({}, { write: (x) => { written += x; }, destroy() {} });
        assert.match(written, /^HTTP\/1\.1 503/);
        chatServer.close();

        // 11. Robot commands from chat pass the control panel's gate: control mode, anonymous switch, whitelist, cooldown.
        {
            const sent = [];
            require('../server/controls/control-server').hardwareClients.set('key-streamer', { readyState: 1, send: (m) => sent.push(JSON.parse(m)) });
            const hw = (body) => call('POST', '/internal/chat-effects/hardware', { token: WRITE, body: { streamer_user_id: streamer, command: 'forward', ...body } });
            const setCh = (mode, anon) => d.prepare('UPDATE channels SET control_mode = ?, anon_controls_enabled = ? WHERE id = ?').run(mode, anon, channel.id);
            setCh('open', 1);
            assert.strictEqual((await hw({ from_anon: 'anon1' })).body.ok, true, 'open channel: anyone');
            assert.strictEqual((await hw({ from_anon: 'anon1' })).body.reason, 'cooldown', 'one command per viewer per 250 ms');
            assert.strictEqual((await hw({ from_anon: 'anon2' })).body.ok, true, 'the cooldown is per viewer');
            setCh('open', 0);
            assert.strictEqual((await hw({ from_anon: 'anon3' })).body.reason, 'login_required');
            assert.strictEqual((await hw({ from_user_id: viewer })).body.ok, true, 'signed-in viewers still may');
            setCh('whitelist', 1);
            assert.strictEqual((await hw({ from_anon: 'anon4' })).body.reason, 'login_required', 'whitelist mode never lets anonymous drive');
            assert.strictEqual((await hw({ from_user_id: mod })).body.reason, 'not_whitelisted');
            d.prepare('INSERT INTO control_whitelist (channel_id, user_id) VALUES (?, ?)').run(channel.id, mod);
            assert.strictEqual((await hw({ from_user_id: mod })).body.ok, true, 'whitelisted');
            assert.strictEqual((await hw({ from_user_id: streamer })).body.ok, true, 'the owner always may');
            setCh('disabled', 1);
            assert.strictEqual((await hw({ from_user_id: streamer, command: 'say:hi' })).body.reason, 'controls_disabled');
            assert.strictEqual(sent.length, 5, 'only the allowed commands reached the robot');
            assert.ok(sent.every((m) => m.type === 'command'));
            require('../server/controls/control-server').hardwareClients.delete('key-streamer');
        }

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
