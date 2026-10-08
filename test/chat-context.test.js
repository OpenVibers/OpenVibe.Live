'use strict';

// Chat moved to OpenVibe.Chat (roadmap Wave 6). What Live answers it on /internal/chat-context/*
// and /internal/chat-effects/* (service tokens, capabilities, re-checked moderators), and the chat
// server Live's own modules get with CHAT_AUTHORITY=chat (presence reads, cache hints and pushes
// over Chat's typed ingress; no bridge, no outbox). Against stub Network and Chat servers.

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

// Stub Network (Live's own service token for audience openvibe.chat) and stub Chat (its typed ingress).
const ingressCalls = [];
const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') {
            const f = new URLSearchParams(raw);
            return res.end(JSON.stringify({ access_token: serviceToken(['chat.message.send', 'chat.event.publish', 'chat.moderation.write', 'chat.cache.invalidate', 'chat.presence.read', 'chat.messages.read'], { aud: f.get('audience'), sub: 'svc:live' }), expires_in: 300 }));
        }
        res.statusCode = 404; res.end('{}');
    });
});
// Chat's internal read API (roadmap T3 J4b): Live reads stats, queues, history and sounds through
// these. The stub answers from Live's own tables (emulating Chat's copy) so the seeds apply, and
// `readState.down` fails every read the way a Chat outage does.
const readState = { down: false, soundAssetDown: false, relayOnly: [], msgById: 0, firstChatCalls: 0, dmBlocked: false, blockStateDown: false };
function readReply(req, res, raw) {
    const url = String(req.url);
    const path = url.split('?')[0];
    const q = new URLSearchParams(url.split('?')[1] || '');
    const isRead = path === '/internal/chat/stats' || path === '/internal/chat/messages' || path === '/internal/chat/first-chat'
        || path.startsWith('/internal/chat/moderation/') || path === '/internal/chat/sounds'
        || path === '/internal/chat/sounds/by-command' || path === '/internal/chat/sounds/asset'
        || path === '/internal/chat/dm/block-state';
    if (!isRead) return false;
    if (readState.down) { res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: 'Chat read unavailable' })); return true; }
    if (path === '/internal/chat/sounds/asset' && readState.soundAssetDown) { res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: 'Chat sound write unavailable' })); return true; }
    const d2 = require('../server/db/database');
    const ok = (o) => { res.end(JSON.stringify({ ok: true, ...o })); return true; };
    const param = (col, v) => (['channel_user_id', 'stream_id', 'user_id', 'id'].includes(col) ? Number(v) : String(v));
    if (path === '/internal/chat/stats') {
        const b = JSON.parse(raw || '{}');
        const sqlTime = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
        const CHATTER = "COALESCE('u:' || user_id, 'a:' || anon_id, source_platform || ':' || username)";
        if (b.kind === 'channel-top') {
            const t = d2.all(`SELECT user_id, MAX(username) AS username, COUNT(*) AS count FROM chat_messages WHERE is_deleted = 0 AND message_type <> 'system' GROUP BY user_id ORDER BY count DESC LIMIT ?`, [b.limit || 10]);
            return ok({ top_chatters: t.map((r) => ({ user_id: r.user_id, username: r.username, count: Number(r.count) })) });
        }
        if (b.kind === 'site-daily') {
            const DAY = 86400000;
            const dayStart = (t) => Math.floor(t / DAY) * DAY;
            const rows = d2.all(`SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS messages, COUNT(DISTINCT ${CHATTER}) AS chatters
                FROM chat_messages WHERE COALESCE(is_deleted, 0) = 0 AND timestamp >= ? AND timestamp < ? GROUP BY day`,
                [sqlTime(b.since), sqlTime(b.until)]);
            const by = new Map(rows.map((r) => [String(r.day), r]));
            const days = [];
            for (let t = dayStart(b.since), last = dayStart(b.until - 1); t <= last; t += DAY) {
                const day = new Date(t).toISOString().slice(0, 10);
                const r = by.get(day);
                days.push({ day, messages: r ? Number(r.messages) : 0, chatters: r ? Number(r.chatters) : 0 });
            }
            return ok({ days });
        }
        const where = ['is_deleted = 0'];
        const params = [];
        if (b.since != null) { where.push('timestamp >= ?'); params.push(sqlTime(b.since)); }
        if (b.until != null) { where.push('timestamp < ?'); params.push(sqlTime(b.until)); }
        if (b.kind === 'user' && b.user_id != null) { where.push('user_id = ?'); params.push(Number(b.user_id)); }
        const r = d2.get(`SELECT COUNT(*) AS messages, COUNT(DISTINCT ${CHATTER}) AS chatters FROM chat_messages WHERE ${where.join(' AND ')}`, params);
        return ok({ messages: Number(r.messages), chatters: Number(r.chatters) });
    }
    if (path === '/internal/chat/dm/block-state') {
        if (readState.blockStateDown) { res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: 'Chat read unavailable' })); return true; }
        return ok({ blocked: !!readState.dmBlocked });
    }
    if (path === '/internal/chat/first-chat') {
        readState.firstChatCalls++;
        const r = d2.get('SELECT 1 AS present FROM stream_first_chats WHERE chatter_key = ? AND channel_user_id = ?', [String(q.get('identity')), Number(q.get('channel_id'))]);
        return ok({ first: !r });
    }
    if (path === '/internal/chat/messages') {
        if (q.get('id') != null) readState.msgById++;
        const filters = ['channel_user_id', 'stream_id', 'user_id', 'anon_id', 'username', 'id'].filter((k) => q.get(k) != null);
        if (filters.length !== 1) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'Give exactly one filter' })); return true; }
        const col = filters[0];
        const where = [`${col} = ?`, 'is_deleted = 0'];
        const params = [param(col, q.get(col))];
        if (q.get('types')) { const types = q.get('types').split(','); where.push(`message_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
        const rows = d2.all(`SELECT id, user_id, anon_id, username, message, message_type, is_global, stream_id, channel_user_id, source_platform, timestamp
            FROM chat_messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, Number(q.get('limit') || 100)]);
        return ok({ messages: rows, max_id: rows.length ? Number(rows[0].id) : null });
    }
    if (path === '/internal/chat/moderation/pending-ip') {
        const rows = d2.all("SELECT * FROM pending_ip_messages WHERE channel_id = ? AND status = 'pending' ORDER BY id LIMIT ?", [Number(q.get('channel_id')), Number(q.get('limit') || 50)]);
        return ok({ pending_ip: rows });
    }
    if (path === '/internal/chat/moderation/relay-users') {
        const rows = d2.all(`SELECT h.*, u.username AS created_by_username FROM hidden_relay_users h LEFT JOIN users u ON u.id = h.created_by
            WHERE h.channel_id = ? OR h.channel_id IS NULL ORDER BY h.id DESC LIMIT ?`, [Number(q.get('channel_id')), Number(q.get('limit') || 100)]);
        return ok({ relay_users: rows.concat(readState.relayOnly) });
    }
    if (/^\/internal\/chat\/moderation\/relay-users\/\d+$/.test(path)) {
        const rid = Number(path.split('/').pop());
        const r = readState.relayOnly.find((x) => x.id === rid)
            || d2.get('SELECT h.*, u.username AS created_by_username FROM hidden_relay_users h LEFT JOIN users u ON u.id = h.created_by WHERE h.id = ?', [rid]) || null;
        return ok({ relay_user: r });
    }
    if (path === '/internal/chat/moderation/tts-override') {
        const r = d2.get('SELECT * FROM tts_voice_overrides WHERE identity_key = ?', [String(q.get('identity_key'))]) || null;
        return ok({ tts_override: r });
    }
    if (path === '/internal/chat/sounds/asset') {
        const b = JSON.parse(raw || '{}');
        d2.run('UPDATE channel_sounds SET media_url = ?, media_asset_id = ? WHERE id = ?', [b.media_url, b.media_asset_id, b.id]);
        return ok({});
    }
    if (path === '/internal/chat/sounds/by-command') {
        const cmd = String(q.get('command') || '').trim().toLowerCase().replace(/^!+/, '');
        // A 404 that is not Chat's own "no such sound" (an older Chat, a proxy page).
        if (cmd === 'bare404') { res.statusCode = 404; res.setHeader('content-type', 'text/html'); res.end('<html>Not Found</html>'); return true; }
        const r = d2.get('SELECT * FROM channel_sounds WHERE channel_owner_id = ? AND command = ? AND is_approved = 1 ORDER BY RANDOM() LIMIT 1', [Number(q.get('channel_id')), cmd]);
        if (!r) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'Sound not found' })); return true; }
        return ok({ sound: r });
    }
    if (path === '/internal/chat/sounds') {
        if (q.get('pending_asset') === '1') {
            const where = ['media_asset_id IS NULL'];
            const params = [];
            if (q.get('channel_owner_id') != null) { where.push('channel_owner_id = ?'); params.push(Number(q.get('channel_owner_id'))); }
            if (q.get('after_id') != null) { where.push('id > ?'); params.push(Number(q.get('after_id'))); }
            const rows = d2.all(`SELECT * FROM channel_sounds WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, [...params, Number(q.get('limit') || 100)]);
            return ok({ sounds: rows });
        }
        const r = d2.get('SELECT COUNT(*) AS n FROM channel_sounds WHERE channel_owner_id = ?', [Number(q.get('channel_owner_id'))]);
        return ok({ count: Number(r.n) });
    }
    return false;
}

const chat = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        assert.ok(!String(req.url).startsWith('/internal/') || String(req.headers.authorization || '').startsWith('Bearer '), 'Live calls Chat with a service token');
        assert.ok(!String(req.url).startsWith('/internal/live/'), 'nothing goes over the old bridge');
        const im = String(req.url).match(/^\/internal\/chat\/(messages|events|moderation|invalidate)$/);
        if (im) {
            ingressCalls.push({ family: im[1], body: JSON.parse(raw || '{}') });
            return res.end(JSON.stringify({ ok: true }));
        }
        if (req.url === '/internal/chat/presence') {
            return res.end(JSON.stringify({ total: 7, streams: { 1: 3 }, slow_mode: { 1: 5000 }, users: [{ user_id: 3, ip: '198.51.100.3', stream_id: 1 }], anons: [{ anon_id: 'anon9', ip: '203.0.113.9', stream_id: 1 }] }));
        }
        if (readReply(req, res, raw)) return;
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
const waitFor = async (pred, what, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(10); }
    throw new Error(`timed out waiting for ${what}`);
};

(async () => {
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${await listen(network)}`;
    process.env.OV_CHAT_INTERNAL_URL = `http://127.0.0.1:${await listen(chat)}`;

    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    // Live no longer has any of OpenVibe.Chat's tables (the staged ones dropped in T3 N+2; the
    // twelve chat tables dropped by 007_drop_chat_tables). The stub Chat below imitates Chat's own copy, so the
    // test keeps local stand-in tables to seed and read.
    d.exec(`
        CREATE TABLE IF NOT EXISTS channel_moderators (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            added_by INTEGER NOT NULL,
            created_at DATETIME DEFAULT ov_now(),
            UNIQUE(channel_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS channel_moderation_settings (
            channel_id INTEGER PRIMARY KEY,
            slow_mode_seconds INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT ov_now()
        );
        CREATE TABLE IF NOT EXISTS emotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            channel_owner_id INTEGER
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stream_id INTEGER, channel_user_id INTEGER, user_id INTEGER, anon_id TEXT, username TEXT,
            message TEXT, message_type TEXT DEFAULT 'chat', is_global INTEGER DEFAULT 0,
            is_deleted INTEGER DEFAULT 0, source_platform TEXT, metadata TEXT,
            timestamp DATETIME DEFAULT ov_now(), auto_delete_at DATETIME
        );
        CREATE TABLE IF NOT EXISTS stream_first_chats (
            chatter_key TEXT NOT NULL, channel_user_id INTEGER NOT NULL,
            first_chat_at DATETIME DEFAULT ov_now(), PRIMARY KEY (chatter_key, channel_user_id)
        );
        CREATE TABLE IF NOT EXISTS hidden_relay_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, platform TEXT NOT NULL,
            external_username TEXT NOT NULL, action TEXT DEFAULT 'hide', reason TEXT, created_by INTEGER,
            created_at DATETIME DEFAULT ov_now()
        );
        CREATE TABLE IF NOT EXISTS tts_voice_overrides (
            identity_key TEXT PRIMARY KEY, voice TEXT, pitch INTEGER, speed INTEGER, gap INTEGER DEFAULT 0,
            set_by INTEGER, updated_at DATETIME DEFAULT ov_now()
        );
        CREATE TABLE IF NOT EXISTS channel_sounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT, channel_owner_id INTEGER NOT NULL, command TEXT NOT NULL,
            url TEXT NOT NULL, mime TEXT DEFAULT 'audio/mpeg', duration_seconds REAL DEFAULT 0,
            created_by INTEGER, created_by_name TEXT DEFAULT '', is_approved INTEGER DEFAULT 1,
            emote_code TEXT DEFAULT '', media_url TEXT, media_asset_id INTEGER,
            created_at DATETIME DEFAULT ov_now()
        );
        CREATE TABLE IF NOT EXISTS pending_ip_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, stream_id INTEGER,
            ip_address TEXT NOT NULL, user_id INTEGER, anon_id TEXT, username TEXT, message TEXT NOT NULL,
            status TEXT DEFAULT 'pending', reviewed_by INTEGER, created_at DATETIME DEFAULT ov_now()
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
    app.use('/api/mod', require('../server/admin/mod-routes'));
    app.use('/api/streams', require('../server/streaming/routes'));
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

        // 6. Bans: Live re-checks the moderator; the rows are exactly Live's own bans table's.
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
        // sound from its own row and plays it on an `alert` event (test/chat-ingress.test.js), so Live's effect is gone.

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

        // 10. The chat seam Live's modules get (T3 J2: Live runs no chat server — the bridge, its
        // outbox and the local ChatServer are gone; chat-delivery carries the push/presence surface).
        const chatDelivery = require('../server/chat/chat-delivery');
        chatDelivery.init();
        assert.ok(!d.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'chat_bridge_outbox'").get(), 'no outbox');
        // Live's own writes to data Chat caches (IP approvals, bans) send Chat a cache hint.
        db.approveIp(channel.id, '203.0.113.7', streamer, 'manual');
        db.forgiveBan(viewer);
        for (let i = 0; i < 100 && ingressCalls.filter((c) => c.family === 'invalidate').length < 2; i++) await sleep(20);
        assert.deepStrictEqual(ingressCalls.filter((c) => c.family === 'invalidate').map((c) => (c.body.bans ? 'bans' : c.body.approvals)), [channel.id, 'bans']);
        // Synchronous reads come from Chat's presence snapshot.
        for (let i = 0; i < 100 && chatDelivery.getTotalConnections() !== 7; i++) await sleep(20);
        assert.strictEqual(chatDelivery.getTotalConnections(), 7);
        assert.strictEqual(chatDelivery.getStreamViewerCount(1), 3);
        assert.strictEqual(chatDelivery.slowModeByStream.get(1), 5000);
        assert.strictEqual(chatDelivery.getConnectedUserIp(3), '198.51.100.3');
        assert.strictEqual(chatDelivery.findClientByAnonId('anon9', 1).ip, '203.0.113.9');
        assert.strictEqual(chatDelivery.findClientByAnonId('anon9', 2), null);
        assert.strictEqual(chatDelivery.findClientByAnonId('anon9').ip, '203.0.113.9', 'no stream given: any of that anon\'s sockets');
        assert.strictEqual(chatDelivery.getAnonIdForConnection('203.0.113.9', 1), 'anon9');
        // Chat asks Live for anon numbers; Live answers from its own helpers.
        assert.strictEqual(typeof (await chatDelivery.resolveAnon('203.0.113.9')).anon_number, 'number');
        // !arena answers the sender in the response, after its own lookup (review 2026-10-02, PR #12).
        const arenaCmd = await call('POST', '/internal/chat-effects/arena-command', { token: WRITE, body: { cmd: '!arena', parts: ['!arena', 'nobody_here_at_all'], client: { conn_id: 'c1', streamId, ip: '203.0.113.30' } } });
        assert.strictEqual(arenaCmd.status, 200);
        assert.strictEqual(arenaCmd.body.handled, true);
        assert.strictEqual(arenaCmd.body.replies.length, 1, 'the reply made after the lookup is in the answer');
        assert.strictEqual(arenaCmd.body.replies[0].type, 'system');
        // /ws/chat is OpenVibe.Chat's (nginx routes it to 127.0.0.1:4400); Live mounts no chat server.
        chatDelivery.close();

        // 11. Live's chat reads (roadmap T3 J4b): stats, queues and history come from Chat's read
        // API through server/chat/chat-reads.js, with the caching and failure rules the moderation
        // console depends on.
        {
            const chatReads = require('../server/chat/chat-reads');
            const d2 = require('../server/db/database');
            chatReads._reset();

            // Chat's copy (the stub reads the stand-in tables): two lines by the same user, a held IP
            // message, a hidden relay user, a TTS override, two pending sounds and a relayed line.
            const chatMsg = (fields) => Number(d.prepare(`INSERT INTO chat_messages (user_id, username, message, channel_user_id, source_platform, message_type)
                VALUES (@user_id, @username, @message, @channel_user_id, @source_platform, @message_type)`).run({ user_id: null, channel_user_id: null, source_platform: null, message_type: 'chat', ...fields }).lastInsertRowid);
            const m1 = chatMsg({ user_id: viewer, username: 'viewer', message: 'hello', channel_user_id: streamer });
            chatMsg({ user_id: viewer, username: 'viewer', message: 'again', channel_user_id: streamer });
            d2.run("INSERT INTO pending_ip_messages (channel_id, ip_address, user_id, username, message, status) VALUES (?, '203.0.113.9', ?, 'viewer', 'held', 'pending')", [channel.id, viewer]);
            d2.run("INSERT INTO hidden_relay_users (channel_id, platform, external_username, action, created_by) VALUES (?, 'twitch', 'alice', 'hide', ?)", [channel.id, streamer]);
            d2.run("INSERT INTO tts_voice_overrides (identity_key, voice, pitch, speed, gap, set_by) VALUES ('user:viewer', 'en+f3', 99, 200, 0, ?)", [admin]);
            d2.run("INSERT INTO channel_sounds (channel_owner_id, command, url, created_by) VALUES (?, 'honk', '/sounds/a.mp3', ?), (?, 'beep', '/sounds/b.mp3', ?)", [streamer, streamer, streamer, streamer]);
            chatMsg({ username: '[Twitch] alice', message: 'hi from twitch', source_platform: 'twitch', channel_user_id: streamer });

            // (2)(3) A peek answers the last good value after its TTL passed, and a failure answers
            // that value too — a failure never overwrites it with null.
            assert.ok((await chatReads.siteStats()).messages >= 3);
            chatReads._age(chatReads.CACHE_TTL_MS + 1000, 'site');
            readState.down = true;
            assert.ok(chatReads.siteStatsPeek(), 'a peek keeps the last good value past its TTL');
            assert.ok(await chatReads.siteStats(), 'a failed read answers the last good value, never null');
            chatReads._reset();
            assert.strictEqual(chatReads.siteStatsPeek(), null, 'a cold peek is null and warms in the background');
            readState.down = false;
            for (let i = 0; i < 300 && !chatReads.siteStatsPeek(); i++) await sleep(10);
            assert.ok(chatReads.siteStatsPeek(), 'the background warm-up answered');

            // (2)(4) A TTS override survives a TTL and a Chat outage (the engine reads it
            // synchronously); in chat mode a cold peek answers null, never Live's frozen copy.
            assert.strictEqual(chatReads.ttsOverridePeek('user:viewer'), null, 'a cold peek answers null, never Live\'s frozen table');
            for (let i = 0; i < 300 && !chatReads.ttsOverridePeek('user:viewer'); i++) await sleep(10);
            assert.strictEqual(chatReads.ttsOverridePeek('user:viewer').voice, 'en+f3');
            chatReads._age(chatReads.CACHE_TTL_MS + 1000, 'ttsp:');
            readState.down = true;
            assert.strictEqual(chatReads.ttsOverridePeek('user:viewer').voice, 'en+f3', 'an override never reverts on a TTL + outage');
            readState.down = false;

            // (2) The AI persona's chat delta keeps its last page over a TTL + outage, not an empty one.
            for (let i = 0; i < 300 && !chatReads.channelMessagesPeek(streamer, 10).length; i++) await sleep(10);
            assert.ok(chatReads.channelMessagesPeek(streamer, 10).length >= 2, 'the channel page warmed');
            chatReads._age(chatReads.CACHE_TTL_MS + 1000, 'ch:');
            readState.down = true;
            assert.ok(chatReads.channelMessagesPeek(streamer, 10).length >= 2, 'the delta answers its last page, never empty');
            readState.down = false;

            // (5) Queue reads are live: a change in Chat shows on the very next read.
            const pending = await chatReads.pendingIp(channel.id, { limit: 5 });
            assert.strictEqual(pending.length, 1);
            assert.strictEqual(pending[0].message, 'held');
            d2.run("UPDATE pending_ip_messages SET status = 'approved' WHERE channel_id = ?", [channel.id]);
            assert.deepStrictEqual(await chatReads.pendingIp(channel.id, { limit: 5 }), [], 'the queue is never served stale');

            // (3)(4) Moderation reads fail closed: Chat unavailable throws, never empty data or a 404.
            readState.down = true;
            chatReads._reset();
            await assert.rejects(chatReads.pendingIp(channel.id, { limit: 5 }), (e) => e.unavailable === true);
            await assert.rejects(chatReads.messageById(m1), (e) => e.unavailable === true);
            readState.down = false;
            chatReads._reset();

            // (8) A user's history total is a page lower bound, not the highest message id.
            const hist = await chatReads.userHistory(viewer, { limit: 1, offset: 0 });
            assert.strictEqual(hist.messages.length, 1);
            assert.strictEqual(hist.total, 1, 'total counts the page, not a message id');
            const hist2 = await chatReads.userHistory(viewer, { limit: 1, offset: 1 });
            assert.strictEqual(hist2.messages.length, 1, 'the second page comes from Chat');
            assert.strictEqual(hist2.total, 2);

            // (7) Relay history searches the stored "[Label] name", not the raw handle.
            const rh = await chatReads.relayHistory('twitch', 'alice', { limit: 10 });
            assert.strictEqual(rh.messages.length, 1, 'relay history finds [Twitch] alice');
            assert.strictEqual(rh.messages[0].message, 'hi from twitch');
            const cs = await chatReads.channelSamples(streamer, { relay: { platform: 'twitch', rawUsername: 'alice' }, limit: 10 });
            assert.strictEqual(cs.length, 1, 'a relay clone sample finds the prefixed row');

            // (1) Hidden relay users come from Chat's list only in chat mode: a cold cache fails
            // open and warms in the background, and a Chat outage answers the last good list.
            chatReads._reset();
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'twitch', 'alice'), false, 'a cold cache fails open');
            readState.relayOnly = [{ id: 999999, channel_id: channel.id, platform: 'youtube', external_username: 'ghost' }];
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost'), false, 'the first check warms Chat in the background');
            for (let i = 0; i < 300 && !chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost'); i++) await sleep(10);
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost'), true, "Chat's queue hides a user");
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'twitch', 'alice'), true, "Chat's copy carries alice (the stub reads the same table)");
            readState.down = true;
            chatReads._age(chatReads.CACHE_TTL_MS + 1000, 'hru:');
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost'), true, 'Chat unreachable answers the last good list');
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'twitch', 'nobody'), false, 'a name no list carries stays unhidden');
            readState.down = false;
            readState.relayOnly = [];
            chatReads._reset();

            // (10) The asset-sync work list pages by id and is never a cached list of what was just uploaded.
            const first = await chatReads.pendingSounds({ limit: 1 });
            assert.strictEqual(first[0].command, 'honk');
            const second = await chatReads.pendingSounds({ afterId: first[0].id, limit: 1 });
            assert.strictEqual(second[0].command, 'beep', 'afterId pages past the first window');
            await chatReads.recordSoundAsset(first[0].id, 'https://media.example/a/1', 4242);
            const after = await chatReads.pendingSounds({ afterId: 0, limit: 10 });
            assert.deepStrictEqual(after.map((s) => s.command), ['beep'], 'the work list is read live, not served from a cache');

            // The sync itself walks the whole list: 119 fileless sounds first, then the one with a
            // local file — a single 100-wide window would never see it.
            fs.writeFileSync(path.join(tmp, 'sounds', 's120.mp3'), 'not really audio');
            const values = [];
            const soundParams = [];
            for (let i = 1; i <= 120; i++) { values.push('(?, ?, ?, ?)'); soundParams.push(streamer, `s${i}`, `/sounds/s${i}.mp3`, streamer); }
            d2.run(`INSERT INTO channel_sounds (channel_owner_id, command, url, created_by) VALUES ${values.join(', ')}`, soundParams);
            const media = require('../server/media-client');
            const realRequest = media.request;
            const uploaded = [];
            media.request = async (method, p) => {
                if (method === 'POST' && p === '/assets') { uploaded.push(1); return { asset: { id: 9000 + uploaded.length, url: `https://media.example/a/${9000 + uploaded.length}` } }; }
                return { ok: true };
            };
            try { await require('../server/media-proxy/asset-sync').syncAll(); } finally { media.request = realRequest; }
            assert.strictEqual(uploaded.length, 1, 'the sync pages past the first window to the sound with a local file');
            const s120 = d2.get("SELECT media_asset_id FROM channel_sounds WHERE command = 's120'");
            assert.ok(s120.media_asset_id, 'the paged sound was recorded as uploaded');

            // (4)(6) The console routes: a text-only search says 501 and usernames match exactly; a
            // Chat outage answers 503 from every queue route, never an empty page or a 404.
            const adminToken = jwt.sign({ sub: String(admin), username: 'admin2', role: 'admin' }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: 300 });
            const modGet = (path) => call('GET', `/api/mod${path}`, { token: adminToken });
            const textOnly = await modGet('/chat/search?q=hello');
            assert.strictEqual(textOnly.status, 501);
            assert.match(textOnly.body.error, /Text search/);
            const byUser = await modGet(`/chat/search?user_id=${viewer}`);
            assert.strictEqual(byUser.status, 200);
            assert.strictEqual(byUser.body.messages.length, 2);
            const byName = await modGet('/chat/search?user_id=viewer');
            assert.strictEqual(byName.body.messages.length, 2, 'an exact username finds the rows');
            assert.strictEqual((await modGet('/chat/search?user_id=view')).body.messages.length, 0, 'username search is exact');
            readState.down = true;
            chatReads._reset();
            assert.strictEqual((await modGet(`/chat/search?user_id=${viewer}`)).status, 503);
            assert.strictEqual((await modGet(`/chat/user/${viewer}`)).status, 503);
            assert.strictEqual((await modGet(`/ip-approval/${channel.id}/pending`)).status, 503);
            assert.strictEqual((await modGet(`/relay-users/hidden/${channel.id}`)).status, 503);
            assert.strictEqual((await modGet('/tts-voice/user/viewer')).status, 503);
            assert.strictEqual((await call('POST', '/api/mod/delete-message', { token: adminToken, body: { message_id: m1 } })).status, 503);
            assert.strictEqual((await call('DELETE', '/api/mod/relay-user/999999', { token: adminToken })).status, 503);
            readState.down = false;
            chatReads._reset();

            // ── Second review round ──────────────────────────────────────────

            // (1) A Chat blip must not block the moderator's very next live read with the 2 s
            // backoff: a ttl:0 / strict read always reaches Chat.
            readState.down = true;
            chatReads._reset();
            await assert.rejects(chatReads.messageById(m1), (e) => e.unavailable === true, 'a live read 503s while Chat is down');
            readState.down = false;
            assert.ok(await chatReads.messageById(m1), 'the next live read reaches Chat, not a cooling 503');

            // (2) A live (ttl 0) read never shares another read's in-flight request.
            readState.msgById = 0;
            await Promise.all([chatReads.messageById(m1), chatReads.messageById(m1)]);
            assert.strictEqual(readState.msgById, 2, 'two concurrent ttl:0 reads both reach Chat');

            // (3) A Chat failure is remembered through the same bounded setter as a good value.
            chatReads._reset();
            const realCap = chatReads._cacheMax();
            chatReads._cacheMax(5);
            readState.down = true;
            try {
                for (let i = 0; i < 12; i++) await chatReads.userHistory(viewer, { limit: i + 1 }).catch(() => {});
                assert.ok(chatReads._size() <= 5, 'failed reads are evicted, never grow the cache past the cap');
            } finally {
                readState.down = false;
                chatReads._cacheMax(realCap);
                chatReads._reset();
            }

            // (4) In chat mode a cold or outage peek answers null, never Live's frozen override table.
            chatReads._reset();
            readState.down = true;
            assert.strictEqual(chatReads.ttsOverridePeek('user:viewer'), null, 'a peek answers null, never Live\'s frozen table');
            readState.down = false;
            chatReads._reset();

            // (5) The home-stats peek outside chat mode: a messages-only zero (Live keeps no
            // chat_messages since the drop, so there is nothing local to count).
            process.env.CHAT_AUTHORITY = '';
            try {
                chatReads._reset();
                const peeked = chatReads.siteStatsPeek();
                assert.strictEqual(peeked.chatters, undefined, 'the peek does not run the distinct-chatter scan');
                assert.strictEqual(peeked.messages, 0, 'no local messages to count');
                const full = await chatReads.siteStats();
                assert.strictEqual(full.messages, 0, 'the full local read is zero too');
            } finally {
                process.env.CHAT_AUTHORITY = 'chat';
                chatReads._reset();
            }

            // (6) A sound whose Chat record fails is counted failed, not synced, and stays pending.
            fs.writeFileSync(path.join(tmp, 'sounds', 's201.mp3'), 'audio');
            d2.run("INSERT INTO channel_sounds (channel_owner_id, command, url, created_by) VALUES (?, 's201', '/sounds/s201.mp3', ?)", [streamer, streamer]);
            readState.soundAssetDown = true;
            {
                const logs = [];
                const origLog = console.log;
                const mediaSync = require('../server/media-client');
                const realReq = mediaSync.request;
                mediaSync.request = async (method, p2) => (method === 'POST' && p2 === '/assets' ? { asset: { id: 9100, url: 'https://media.example/a/9100' } } : { ok: true });
                console.log = (...a) => logs.push(a.join(' '));
                try { await require('../server/media-proxy/asset-sync').syncAll(); }
                finally { mediaSync.request = realReq; console.log = origLog; readState.soundAssetDown = false; }
                assert.ok(logs.some((l) => /\(1 failed/.test(l)), 'a failed Chat record is counted failed, not synced');
                assert.strictEqual(d2.get("SELECT media_asset_id FROM channel_sounds WHERE command = 's201'").media_asset_id, null, 'the sound stays pending for the next pass');
            }

            // (7) A relay hide or unhide through the console drops the cached hidden list at once.
            chatReads._reset();
            readState.relayOnly = [{ id: 999998, channel_id: channel.id, platform: 'twitch', external_username: 'marker1' }];
            for (let i = 0; i < 300 && !chatReads.isRelayUserHidden(channel.id, 'twitch', 'marker1'); i++) await sleep(10);
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'twitch', 'marker1'), true, 'warm: the marker is in the cached list');
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost3'), false, 'warm: ghost3 is not hidden');
            readState.relayOnly = [
                { id: 999998, channel_id: channel.id, platform: 'twitch', external_username: 'marker1' },
                { id: 999997, channel_id: channel.id, platform: 'youtube', external_username: 'ghost3' },
            ];
            const hideRes = await call('POST', '/api/mod/relay-user/hide', { token: adminToken, body: { channel_id: channel.id, platform: 'youtube', external_username: 'ghost3' } });
            assert.strictEqual(hideRes.status, 200, 'the hide route ran');
            for (let i = 0; i < 300 && !chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost3'); i++) await sleep(10);
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost3'), true, 'the hide dropped the cached list at once');
            readState.relayOnly = [];
            const unhideRes = await call('POST', '/api/mod/relay-user/hide', { token: adminToken, body: { channel_id: channel.id, platform: 'youtube', external_username: 'ghost3', action: 'unhide' } });
            assert.strictEqual(unhideRes.status, 200, 'the unhide route ran');
            for (let i = 0; i < 300 && chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost3'); i++) await sleep(10);
            assert.strictEqual(chatReads.isRelayUserHidden(channel.id, 'youtube', 'ghost3'), false, 'the unhide dropped the cached list at once');
            // A site-wide row (channel_id null) invalidates every channel's cached list.
            chatReads._reset();
            readState.relayOnly = [{ id: 999996, channel_id: null, platform: 'twitch', external_username: 'marker2' }];
            for (let i = 0; i < 300 && !chatReads.isRelayUserHidden(424242, 'twitch', 'marker2'); i++) await sleep(10);
            assert.strictEqual(chatReads.isRelayUserHidden(424242, 'twitch', 'marker2'), true, 'warm: another channel sees the site-wide marker');
            readState.relayOnly = [
                { id: 999996, channel_id: null, platform: 'twitch', external_username: 'marker2' },
                { id: 999995, channel_id: null, platform: 'youtube', external_username: 'siteghost' },
            ];
            const siteHide = await call('POST', '/api/mod/relay-user/hide', { token: adminToken, body: { platform: 'youtube', external_username: 'siteghost' } });
            assert.strictEqual(siteHide.status, 200, 'the site-wide hide ran');
            for (let i = 0; i < 300 && !chatReads.isRelayUserHidden(424242, 'youtube', 'siteghost'); i++) await sleep(10);
            assert.strictEqual(chatReads.isRelayUserHidden(424242, 'youtube', 'siteghost'), true, 'a site-wide hide clears every cached list');
            readState.relayOnly = [];
            chatReads._reset();

            // (8) A `q` combined with a filter matches case-insensitively.
            const qUpper = await chatReads.searchMessages({ userId: viewer, query: 'HELLO', limit: 10 });
            assert.strictEqual(qUpper.messages.length, 1, 'q matches regardless of case');
            assert.strictEqual(qUpper.messages[0].message, 'hello');

            // ── Third review round ───────────────────────────────────────────

            // (1) A window's since/until is bucketed before the cache key, so a home-stats compute
            // whose clock moved a few seconds still hits the warm entry, and a cold hero peek answers
            // null rather than a synchronous mirror scan.
            {
                const hour = 3600000;
                const w7 = Math.floor(Date.now() / hour) * hour - 7 * 86400000;   // hour-aligned, 7 days back
                chatReads._reset();
                const warm = await chatReads.windowStats({ since: w7 });
                chatReads._age(chatReads.CACHE_TTL_MS + 1000, 'win:');
                readState.down = true;
                try {
                    const peeked = chatReads.windowStatsPeek({ since: w7 + 3000 });
                    assert.ok(peeked && peeked.messages === warm.messages, 'a since a few seconds later buckets to the same warm key');
                } finally { readState.down = false; }
                chatReads._reset();
                readState.down = true;
                try {
                    assert.strictEqual(chatReads.windowStatsPeek({ since: Date.now() - 7 * 86400000 }), null, 'a cold hero peek is null, never a mirror scan');
                } finally { readState.down = false; chatReads._reset(); }
            }

            // (2) The stream-end analytics write keeps the totals it has and re-upserts Chat's right
            // after (the clip-count pattern) instead of persisting a cold mirror (or zero).
            {
                chatReads._reset();
                d2.run('DELETE FROM stream_analytics WHERE stream_id = ?', [streamId]);
                const computed = d2.computeAndCacheStreamAnalytics(streamId);
                assert.strictEqual(computed.total_messages, 0, 'the synchronous compute writes its prior totals, not a cold scan');
                for (let i = 0; i < 300; i++) { await sleep(10); const a = d2.getStreamAnalytics(streamId); if (a && a.total_messages > 0) break; }
                const sa = d2.getStreamAnalytics(streamId);
                assert.ok(sa.total_messages >= 3, "the setImmediate refresh wrote Chat's totals");
                assert.strictEqual(sa.unique_chatters, 2, "and Chat's chatter count");
                chatReads._reset();
            }

            // (3) A stale local row is dead weight in chat mode: a hide Chat's list does not carry
            // must not hide anyone (the stand-in row is never read).
            {
                const chatClient = require('../server/chat/chat-client');
                const realReadRelayUsers = chatClient.readRelayUsers;
                const relOwner = mkUser('relch');
                db.createChannel({ user_id: relOwner, title: 'Relay channel' });
                const freshCh = db.getChannelByUserId(relOwner).id;   // no hidden rows yet
                chatClient.readRelayUsers = async () => ({ relay_users: [] });   // Chat's list holds nothing
                chatReads._reset();
                try {
                    assert.strictEqual(chatReads.isRelayUserHidden(freshCh, 'twitch', 'localonly'), false, 'a cold cache fails open');
                    d2.run("INSERT INTO hidden_relay_users (channel_id, platform, external_username, action, created_by) VALUES (?, 'twitch', 'localonly', 'hide', ?)", [freshCh, streamer]);
                    for (let i = 0; i < 300 && chatReads._size() === 0; i++) await sleep(10);
                    assert.ok(chatReads._size() > 0, 'the background read warmed the cache');
                    assert.strictEqual(chatReads.isRelayUserHidden(freshCh, 'twitch', 'localonly'), false, "Live's stale local hide is ignored — Chat's list is the truth");
                } finally {
                    chatClient.readRelayUsers = realReadRelayUsers;
                    d2.run('DELETE FROM hidden_relay_users WHERE channel_id = ?', [freshCh]);
                    chatReads._reset();
                }
            }

            // (4) A cold profile count is null (the card omits it), never a mirror number passed off
            // as Chat's.
            {
                chatReads._reset();
                readState.down = true;
                try {
                    assert.strictEqual(chatReads.userMessageCountPeek(viewer), null, 'a cold count is null, not a mirror number');
                    assert.strictEqual(d2.getUserProfile(viewer).messageCount, null, 'the profile carries the null through');
                } finally { readState.down = false; chatReads._reset(); }
            }

            // (5) channelMaxId — the preview path's awaited read — warms the peek's key, so the
            // cursor is Chat's id rather than the mirror once it has answered.
            {
                const chatClient = require('../server/chat/chat-client');
                const realReadMessages = chatClient.readMessages;
                chatClient.readMessages = async (o) => (o && o.tail ? { max_id: 777777, messages: [] } : realReadMessages(o));
                chatReads._reset();
                try {
                    await chatReads.channelMaxId(streamer);
                    assert.strictEqual(chatReads.channelMaxIdPeek(streamer), 777777, "the peek answers Chat's id after the awaited read");
                } finally {
                    chatClient.readMessages = realReadMessages;
                    chatReads._reset();
                }
            }
        }

        // 11b. The last three mirror readers read Chat now (roadmap T3 J4c): the home daily series,
        // the AI context's first-chat flag and the RobotStreamer !sound lookup.
        {
            const chatReads = require('../server/chat/chat-reads');
            const d2 = require('../server/db/database');
            const DAY = 86400000;
            const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

            // ── Home daily series: Chat's site-daily read, mapped per metric; a cold cache during a
            // Chat outage answers Live's own series (never zeros). ──
            d2.run('DELETE FROM chat_messages');
            chatReads._reset();
            const atDay = (back) => new Date(Date.now() - back * DAY).toISOString().slice(0, 10) + ' 12:00:00';
            d2.run("INSERT INTO chat_messages (user_id, username, message, message_type, timestamp) VALUES (?, 'viewer', 'a', 'chat', ?), (?, 'viewer', 'b', 'chat', ?), (?, 'moddy', 'c', 'chat', ?)",
                [viewer, atDay(2), viewer, atDay(2), mod, atDay(2)]);
            d2.run("INSERT INTO chat_messages (user_id, username, message, message_type, timestamp) VALUES (?, 'viewer', 'd', 'chat', ?), (?, 'moddy', 'e', 'chat', ?)",
                [viewer, atDay(1), mod, atDay(1)]);
            await chatReads.homeSeries('messages', 7);   // warm Chat's answer; the peek cannot await
            const series = chatReads.homeSeriesPeek('messages', 7);
            assert.ok(series && Array.isArray(series.points), 'the chat series peek answers in chat mode');
            assert.strictEqual(series.days, 7);
            assert.strictEqual(series.points.length, 7, 'one zero-filled point per day');
            assert.strictEqual(series.points[4].value, 3, 'two days ago: three messages (Chat)');
            assert.strictEqual(series.points[5].value, 2, 'yesterday: two messages (Chat)');
            assert.strictEqual(series.points[6].value, 0, 'today: none');
            assert.strictEqual(series.total, 5);
            assert.strictEqual(series.prev_total, 0, 'the window before the 7 days is empty');
            assert.strictEqual(series.before, 0, 'nothing before the window');
            await chatReads.homeSeries('active', 7);   // warm Chat's answer
            const activeSeries = chatReads.homeSeriesPeek('active', 7);
            assert.strictEqual(activeSeries.points[4].value, 2, 'two days ago: two distinct chatters');
            assert.strictEqual(activeSeries.points[5].value, 2, 'yesterday: two distinct chatters');
            // getHomeStatSeries routes the two chat metrics through the chat series.
            const realSeriesPeek = chatReads.homeSeriesPeek;
            chatReads.homeSeriesPeek = () => ({ metric: 'messages', sentinel: true });
            try { assert.strictEqual(d2.getHomeStatSeries('messages', 7).sentinel, true, 'getHomeStatSeries reads the chat series in chat mode'); }
            finally { chatReads.homeSeriesPeek = realSeriesPeek; }
            // A cold cache during a Chat outage answers null (Live keeps no chat series to fall back to).
            chatReads._reset();
            readState.down = true;
            assert.strictEqual(chatReads.homeSeriesPeek('messages', 7), null, 'a cold + down peek answers null');
            readState.down = false;
            chatReads._reset();

            // ── First chat: `user:<user_id>` (never the username); a false answer is cached longer
            // than a true one; a cold/down peek falls to Live's own table. ──
            d2.run('DELETE FROM stream_first_chats');
            chatReads._reset();
            assert.strictEqual(await chatReads.firstChat(streamer, `user:${viewer}`), true, 'a new identity is first');
            d2.run('INSERT INTO stream_first_chats (chatter_key, channel_user_id) VALUES (?, ?)', [`user:${viewer}`, streamer]);
            chatReads._reset();
            assert.strictEqual(await chatReads.firstChat(streamer, `user:${viewer}`), false, 'after a recorded first chat, not first');
            chatReads._reset();
            readState.firstChatCalls = 0;
            await chatReads.firstChat(streamer, `user:${viewer}`);
            chatReads._age(chatReads.CACHE_TTL_MS + 1000, 'fc:');
            readState.firstChatCalls = 0;
            await chatReads.firstChat(streamer, `user:${viewer}`);
            assert.strictEqual(readState.firstChatCalls, 0, 'a false answer is not re-asked past the true TTL');
            // The same holds through the sync peek the AI context uses.
            chatReads._reset();
            readState.firstChatCalls = 0;
            assert.strictEqual(chatReads.firstChatPeek(streamer, `user:${viewer}`), false);
            await sleep(30);
            chatReads._age(chatReads.CACHE_TTL_MS + 1000, 'fc:');
            readState.firstChatCalls = 0;
            assert.strictEqual(chatReads.firstChatPeek(streamer, `user:${viewer}`), false, 'the peek keeps a false answer past the true TTL');
            assert.strictEqual(readState.firstChatCalls, 0, 'the peek does not re-ask Chat for the cached false answer');
            d2.run('DELETE FROM stream_first_chats WHERE chatter_key = ?', [`user:${viewer}`]);
            chatReads._reset();
            readState.firstChatCalls = 0;
            await chatReads.firstChat(streamer, `user:${viewer}`);
            chatReads._age(chatReads.CACHE_TTL_MS + 1000, 'fc:');
            readState.firstChatCalls = 0;
            await chatReads.firstChat(streamer, `user:${viewer}`);
            assert.strictEqual(readState.firstChatCalls, 1, 'a true answer is re-asked after the short TTL');
            chatReads._reset();
            d2.run('DELETE FROM stream_first_chats WHERE chatter_key = ?', [`user:${viewer}`]);
            readState.down = true;
            assert.strictEqual(chatReads.firstChatPeek(streamer, `user:${viewer}`), false, 'a cold + down peek answers not-first (Live keeps no first-chat table)');
            readState.down = false;
            chatReads._reset();

            // The AI context passes `user:<user_id>`, never the username: a row keyed by the numeric id
            // suppresses the welcome flag, where the old `user:<username>` key would have missed it.
            // Its peek is synchronous, so each case warms Chat's answer first.
            d2.run("INSERT INTO chat_messages (user_id, username, message, message_type, channel_user_id, timestamp) VALUES (?, 'viewer', 'hi there', 'chat', ?, ?)", [viewer, streamer, sqlNow()]);
            await chatReads.channelMessages(streamer, 40);
            const context = require('../server/ai/context');
            const ctxStream = db.getStreamById(streamId);
            const greet = { remember_viewers: true, greet_first_timers: true, max_open_threads: 3, hear_enabled: false };
            d2.run('INSERT INTO stream_first_chats (chatter_key, channel_user_id) VALUES (?, ?)', [`user:${viewer}`, streamer]);
            chatReads.invalidate('fc:');
            await chatReads.firstChat(streamer, `user:${viewer}`);   // warm: the context's peek cannot await
            let tail = context.volatileTail({ userId: streamer, stream: ctxStream, settings: greet, sinceChatId: 0, botNames: new Set() });
            assert.ok(!/first time chatting here/.test(tail.text), 'a user with a recorded first chat is not greeted again');
            d2.run('DELETE FROM stream_first_chats WHERE chatter_key = ?', [`user:${viewer}`]);
            chatReads.invalidate('fc:');
            await chatReads.firstChat(streamer, `user:${viewer}`);
            tail = context.volatileTail({ userId: streamer, stream: ctxStream, settings: greet, sinceChatId: 0, botNames: new Set() });
            assert.ok(/first time chatting here/.test(tail.text), 'a new user is flagged first time (user:<id> identity)');
            chatReads._reset();

            // ── Sounds by command: Chat owns the row; a 404 is authoritative; a cold/down peek
            // answers null, never Live's own frozen table. ──
            d2.run('DELETE FROM channel_sounds WHERE channel_owner_id = ?', [streamer]);
            d2.run("INSERT INTO channel_sounds (channel_owner_id, command, url, created_by) VALUES (?, 'honk', '/sounds/h.mp3', ?)", [streamer, streamer]);
            chatReads._reset();
            assert.strictEqual(chatReads.soundByCommandPeek(streamer, 'honk'), null, 'a cold peek answers null, never Live\'s frozen table');
            for (let i = 0; i < 300 && !chatReads.soundByCommandPeek(streamer, 'honk'); i++) await sleep(10);
            const honk = chatReads.soundByCommandPeek(streamer, 'honk');
            assert.ok(honk && honk.command === 'honk', 'the warmed peek answers Chat\'s sound by command');
            assert.strictEqual(chatReads.soundByCommandPeek(streamer, '!HONK').command, 'honk', 'the command is normalized');
            assert.strictEqual(await chatReads.soundByCommand(streamer, 'nope'), null, 'Chat: no such sound');
            d2.run("INSERT INTO channel_sounds (channel_owner_id, command, url, created_by) VALUES (?, 'nope', '/sounds/n.mp3', ?)", [streamer, streamer]);
            assert.strictEqual(chatReads.soundByCommandPeek(streamer, 'nope'), null, 'a Chat 404 is cached: Live\'s own row is not used');
            chatReads._reset();
            readState.down = true;
            assert.strictEqual(chatReads.soundByCommandPeek(streamer, 'honk'), null, 'a cold + down peek answers null, never Live\'s frozen table');
            readState.down = false;
            chatReads._reset();
            d2.run("INSERT INTO channel_sounds (channel_owner_id, command, url, created_by) VALUES (?, 'bare404', '/sounds/b.mp3', ?)", [streamer, streamer]);
            const bare = await chatReads.soundByCommand(streamer, 'bare404');
            assert.strictEqual(bare, null, 'a 404 without Chat\'s own body is not "no such sound": null, never Live\'s table');
            chatReads._reset();
        }

        // 11c. The mirror's retirement, checked where it would bite: a stale local row must not
        // answer a chat-mode read, the relay welcome asks Chat's first-chat, an asset removal uses
        // the Media id Chat sent, and a call invite fails closed when the block state is unknown.
        {
            const chatReads = require('../server/chat/chat-reads');
            const chatClient = require('../server/chat/chat-client');
            const d2 = require('../server/db/database');

            // (1) ttsOverridePeek ignores Live's stale override: Chat says "none".
            {
                const realReadTts = chatClient.readTtsOverride;
                chatClient.readTtsOverride = async () => ({ tts_override: null });
                chatReads._reset();
                d2.run("INSERT OR REPLACE INTO tts_voice_overrides (identity_key, voice, pitch, speed, gap, set_by) VALUES ('user:stale', 'en+m7', 99, 200, 0, ?)", [admin]);
                try {
                    assert.strictEqual(chatReads.ttsOverridePeek('user:stale'), null, "Chat's 'no override' wins over Live's stale row");
                    assert.strictEqual(chatReads.ttsOverridePeek('user:stale'), null, 'and stays null from the cache');
                } finally {
                    chatClient.readTtsOverride = realReadTts;
                    d2.run("DELETE FROM tts_voice_overrides WHERE identity_key = 'user:stale'");
                    chatReads._reset();
                }
            }

            // (2) The relay welcome asks Chat's first-chat read before the message send; Live's own
            // frozen stream_first_chats neither welcomes nor suppresses.
            {
                const relay = require('../server/integrations/chat-relay-service');
                const realReadFirstChat = chatClient.readFirstChat;
                const realFollowUps = relay._relayFollowUps;
                const welcomes = (name) => ingressCalls.filter((c) => c.family === 'events' && c.body.frame && c.body.frame.type === 'system' && new RegExp(`Welcome ${name}\\b`).test(String(c.body.frame.message)));
                const relayed = (name) => ingressCalls.filter((c) => c.family === 'messages' && c.body.username === `[Twitch] ${name}`);
                relay._relayFollowUps = () => {};   // the welcome decision is what this checks
                chatReads._reset();
                try {
                    // Chat: not first, and Live's copy has no row either — nothing to welcome.
                    d2.run('DELETE FROM stream_first_chats WHERE chatter_key = ?', ['ext:[Twitch] carol']);
                    chatClient.readFirstChat = async () => ({ first: false });
                    await relay._broadcastMessage({ platform: 'twitch', streamId }, 'carol', 'hello from twitch', {});
                    await waitFor(() => relayed('carol').length, 'the relayed line');
                    await sleep(50);
                    assert.strictEqual(welcomes('carol').length, 0, "Chat's not-first answer suppresses the welcome");

                    // Chat: first, even though Live's frozen copy has a row (it used to suppress it).
                    d2.run('INSERT INTO stream_first_chats (chatter_key, channel_user_id) VALUES (?, ?)', ['ext:[Twitch] dave', streamer]);
                    chatClient.readFirstChat = async () => ({ first: true });
                    await relay._broadcastMessage({ platform: 'twitch', streamId }, 'dave', 'first line', {});
                    await waitFor(() => welcomes('dave').length, "dave's welcome");
                    // A second line within Chat's short "first" cache window is not welcomed twice.
                    await relay._broadcastMessage({ platform: 'twitch', streamId }, 'dave', 'second line', {});
                    await waitFor(() => relayed('dave').length >= 2, 'the second relayed line');
                    await sleep(80);
                    assert.strictEqual(welcomes('dave').length, 1, "Chat's first-chat answer welcomes once, deduped in-process");
                } finally {
                    chatClient.readFirstChat = realReadFirstChat;
                    relay._relayFollowUps = realFollowUps;
                    d2.run("DELETE FROM stream_first_chats WHERE chatter_key IN ('ext:[Twitch] carol', 'ext:[Twitch] dave')");
                    chatReads._reset();
                }
            }

            // (3) /asset-sync remove-sound deletes the Media asset id Chat sent, never the one on
            // Live's frozen channel_sounds row.
            {
                const media = require('../server/media-client');
                const realRequest = media.request;
                const deleted = [];
                media.request = async (method, p) => { if (method === 'DELETE') deleted.push(p); return { ok: true }; };
                try {
                    d2.run("INSERT OR REPLACE INTO channel_sounds (id, channel_owner_id, command, url, created_by, media_asset_id) VALUES (777001, ?, 'given', '/sounds/given.mp3', ?, 424242)", [streamer, streamer]);
                    const out = await call('POST', '/internal/chat-effects/asset-sync', { token: WRITE, body: { op: 'remove-sound', asset_id: 555111 } });
                    assert.strictEqual(out.status, 200);
                    await sleep(20);
                } finally {
                    media.request = realRequest;
                    d2.run('DELETE FROM channel_sounds WHERE id = 777001');
                }
                assert.deepStrictEqual(deleted, ['/assets/555111'], 'the Media asset id in the request is the one deleted');
            }

            // (4) The call invite asks Chat for the block state: blocked refuses, an unknown state
            // (Chat down past the cache) refuses too, never rings through.
            {
                const callerToken = jwt.sign({ sub: String(streamer), username: 'streamer', role: 'streamer' }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: 300 });
                const callUser = (body) => call('POST', '/api/streams/voice-channels/call-user', { token: callerToken, body });
                chatReads._reset();
                readState.dmBlocked = true;
                try {
                    const blocked = await callUser({ user_id: viewer });
                    assert.strictEqual(blocked.status, 403, 'a blocked pair cannot ring');
                    assert.match(blocked.body.error, /cannot call this user/i);

                    readState.dmBlocked = false;
                    chatReads._reset();
                    const allowed = await callUser({ user_id: viewer });
                    assert.strictEqual(allowed.status, 200, `an unblocked pair rings (${allowed.text})`);
                    assert.strictEqual(allowed.body.invited, true);

                    readState.down = true;
                    chatReads._reset();
                    const unknown = await callUser({ user_id: viewer });
                    assert.strictEqual(unknown.status, 503, 'an unverifiable block state refuses the ring');
                    assert.match(unknown.body.error, /try again shortly/i);
                } finally {
                    readState.dmBlocked = false;
                    readState.down = false;
                    chatReads._reset();
                }
            }
        }

        // 12. Robot commands from chat pass the control panel's gate: control mode, anonymous switch, whitelist, cooldown.
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
