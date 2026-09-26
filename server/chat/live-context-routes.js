'use strict';
/**
 * What OpenVibe.Chat asks of Live (roadmap Wave 6). Chat owns chat; Live still owns accounts,
 * streams, channels, bans, cosmetics, coins, AI viewers, the arena, the media queue and hardware.
 * Chat's single adapter (OpenVibe.Chat server/live-context.js) calls these with a Network service
 * token for audience openvibe.live (server/net/service-guard.js); nothing here is routed by nginx.
 *
 * /internal/chat-context/*   capability live.chat_context.read — projections Chat caches
 *   POST /auth {token}                       → { user, expires_at, reason } (Live's own token rules)
 *   GET  /users?after_id&limit               → { rows }   users projection (paged by id)
 *   POST /users/lookup {ids?, usernames?}    → { users }
 *   GET  /users/:id/follows                  → { streamer_ids }
 *   GET  /users/profile?username&viewer_id   → the /api/chat/user/:username/profile card
 *   GET  /streams?after_id&limit, /streams/active, /streams/:id
 *   GET  /managed-streams?after_id&limit, /channels?after_id&limit, /channels/by-user/:userId
 *   GET  /channels/:id/policy                → { channel, settings, moderator_ids, language }
 *   GET  /channels/:id/approved-ip?ip        → { approved }
 *   GET  /bans?version                       → { version, bans } | { version, unchanged: true }
 *   POST /decor {user_ids}                   → { decor: { id: { cosmetic, tag } } }
 *   GET  /settings                           → { settings } (tts_*, GIF and soundboard keys only)
 *   GET  /anon/:num, /anon-first-seen?ip     → { first_seen }
 *   GET  /tts-audio/:file                    → a clip from the arena voice cache
 *
 * /internal/chat-effects/*   capability live.chat_effects.write — side effects (CHAT_AUTHORITY=chat only)
 *   anon, ip-log, viewer-counts, viewer-snapshots, user-color, ban, approve-ip, channel-settings,
 *   alert-sound, ensure-channel, site-settings, chat-message, ai/mod-command, arena-command,
 *   media-queue, hardware, paste, translate, notify/dm, notify/dm-read, notify/call-invite, asset-sync
 *   mirror  (capability live.chat_mirror.write) — Chat's changes to its tables, applied to Live's copy
 *
 * Every effect that acts for a person re-checks that person here (moderator, owner, admin) — Chat
 * checked first; Live does not take its word for it.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');
const permissions = require('../auth/permissions');
const { guard } = require('../net/service-guard');
const { isRemote } = require('./chat-authority');
const chatTables = require('./chat-tables');

const contextRouter = express.Router();
const effectsRouter = express.Router();

const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const pageArgs = (req) => ({ after: Math.max(0, int(req.query.after_id)), limit: Math.min(5000, Math.max(1, int(req.query.limit, 1000))) });
const fail = (res, status, error) => res.status(status).json({ error });

// ── Projections ─────────────────────────────────────────────────

const SUBJECT_SQL = "(SELECT la.subject_id FROM linked_accounts la WHERE la.user_id = u.id AND la.service = 'network' AND la.subject_id IS NOT NULL ORDER BY la.id DESC LIMIT 1)";
const USER_SQL = `SELECT u.id, u.username, u.display_name, u.avatar_url, u.profile_color, u.role, u.is_banned, u.ban_reason,
        COALESCE(u.is_owner, 0) AS is_owner, u.created_at, ${SUBJECT_SQL} AS subject_id FROM users u`;
const STREAM_SQL = 'SELECT id, user_id, channel_id, managed_stream_id, title, is_live, started_at, ended_at, created_at FROM streams';
const MS_SQL = 'SELECT id, user_id, slug, title, sort_order, created_at FROM managed_streams';
const CHANNEL_SQL = 'SELECT id, user_id, title FROM channels';

/** The chat projection of a user row (no secrets: no email, password, stream key, balances). */
function userProjection(user, subjectId) {
    if (!user) return null;
    let subject = subjectId || user.subject_id || null;
    if (!subject) {
        try { subject = db.get("SELECT subject_id FROM linked_accounts WHERE user_id = ? AND service = 'network' AND subject_id IS NOT NULL ORDER BY id DESC LIMIT 1", [user.id])?.subject_id || null; } catch { subject = null; }
    }
    return {
        id: user.id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url || null,
        profile_color: user.profile_color || null, role: user.role, is_banned: user.is_banned ? 1 : 0, ban_reason: user.ban_reason || null,
        is_owner: user.is_owner ? 1 : 0, created_at: user.created_at, subject_id: subject,
    };
}

contextRouter.use(guard('live.chat_context.read'));

// Resolve a browser/bot token exactly as Live's requireAuth / authenticateWs do.
contextRouter.post('/auth', (req, res) => {
    const token = String((req.body && req.body.token) || '');
    if (!token) return res.json({ user: null, reason: 'invalid' });
    const auth = require('../auth/auth');
    const apiUser = auth.authenticateApiToken(token);
    if (apiUser) {
        const user = { ...userProjection(apiUser), auth_source: 'api_token', scopes: apiUser.scopes || [] };
        return res.json({ user, expires_at: null, reason: null });
    }
    const r = auth.verifyTokenWithReason(token);
    if (!r.ok) return res.json({ user: null, reason: 'invalid' });
    const user = auth.resolveNetworkUser(r.decoded);
    if (!user) return res.json({ user: null, reason: 'unresolved' });
    res.json({
        user: { ...userProjection(user, r.decoded.subject_id), auth_source: 'network' },
        expires_at: typeof r.decoded.exp === 'number' ? new Date(r.decoded.exp * 1000).toISOString() : null,
        reason: null,
    });
});

contextRouter.get('/users', (req, res) => {
    const { after, limit } = pageArgs(req);
    res.json({ rows: db.all(`${USER_SQL} WHERE u.id > ? ORDER BY u.id LIMIT ?`, [after, limit]) });
});

contextRouter.post('/users/lookup', (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
    const names = (Array.isArray(req.body?.usernames) ? req.body.usernames : []).map(String).slice(0, 100);
    const rows = [];
    if (ids.length) rows.push(...db.all(`${USER_SQL} WHERE u.id IN (${ids.map(() => '?').join(',')})`, ids));
    for (const n of names) { const r = db.get(`${USER_SQL} WHERE u.username = ? COLLATE NOCASE`, [n]); if (r) rows.push(r); }
    res.json({ users: rows });
});

contextRouter.get('/users/profile', (req, res) => {
    // The same card /api/chat/user/:username/profile built in Live.
    try {
        const name = String(req.query.username || '');
        let user = db.getUserByUsername(name);
        if (!user) user = db.get('SELECT * FROM users WHERE display_name = ? COLLATE NOCASE', [name]);
        if (!user) return fail(res, 404, 'User not found');
        const profile = db.getUserProfile(user.id);
        if (!profile) return fail(res, 404, 'Profile not found');
        // OpenCoins are part of the game; Vibes (real money) and presence stay with the user.
        const viewerId = int(req.query.viewer_id, 0);
        if (!viewerId || viewerId !== user.id) {
            delete profile.openvibe_bucks_balance;
            delete profile.last_seen;
        }
        // Legacy game skills, read-only (never creates a game_players row)
        const game = db.getLegacyGameProfile(user.id);
        if (game) profile.game = game;
        res.json(profile);
    } catch (err) {
        fail(res, 500, 'Failed to get profile');
    }
});

contextRouter.get('/users/:id/follows', (req, res) => {
    res.json({ streamer_ids: db.all('SELECT streamer_id FROM follows WHERE follower_id = ?', [int(req.params.id)]).map((r) => r.streamer_id) });
});

contextRouter.get('/streams', (req, res) => {
    const { after, limit } = pageArgs(req);
    res.json({ rows: db.all(`${STREAM_SQL} WHERE id > ? ORDER BY id LIMIT ?`, [after, limit]) });
});
// Live now, plus anything that ended in the last quarter hour (so Chat sees it go offline).
contextRouter.get('/streams/active', (req, res) => {
    res.json({ rows: db.all(`${STREAM_SQL} WHERE is_live = 1 OR (ended_at IS NOT NULL AND ended_at >= datetime('now', '-15 minutes'))`) });
});
contextRouter.get('/streams/:id', (req, res) => {
    const stream = db.get(`${STREAM_SQL} WHERE id = ?`, [int(req.params.id)]);
    if (!stream) return res.json({ stream: null });
    res.json({
        stream,
        owner: db.get(`${USER_SQL} WHERE u.id = ?`, [stream.user_id]) || null,
        managed_stream: stream.managed_stream_id ? (db.get(`${MS_SQL} WHERE id = ?`, [stream.managed_stream_id]) || null) : null,
        channel: stream.channel_id ? (db.get(`${CHANNEL_SQL} WHERE id = ?`, [stream.channel_id]) || null) : (db.get(`${CHANNEL_SQL} WHERE user_id = ?`, [stream.user_id]) || null),
    });
});

contextRouter.get('/managed-streams', (req, res) => {
    const { after, limit } = pageArgs(req);
    res.json({ rows: db.all(`${MS_SQL} WHERE id > ? ORDER BY id LIMIT ?`, [after, limit]) });
});

contextRouter.get('/channels', (req, res) => {
    const { after, limit } = pageArgs(req);
    res.json({ rows: db.all(`${CHANNEL_SQL} WHERE id > ? ORDER BY id LIMIT ?`, [after, limit]) });
});
contextRouter.get('/channels/by-user/:userId', (req, res) => {
    res.json({ channel: db.get(`${CHANNEL_SQL} WHERE user_id = ?`, [int(req.params.userId)]) || null });
});
contextRouter.get('/channels/:id/policy', (req, res) => {
    const channelId = int(req.params.id);
    const channel = db.get(`${CHANNEL_SQL} WHERE id = ?`, [channelId]) || null;
    let language = 'en';
    try { if (channel) language = require('../i18n/translate').channelLanguage(channel.user_id) || 'en'; } catch { language = 'en'; }
    res.json({
        channel,
        settings: db.getChannelModerationSettings(channelId),
        moderator_ids: db.all('SELECT user_id FROM channel_moderators WHERE channel_id = ?', [channelId]).map((r) => r.user_id),
        language,
    });
});
contextRouter.get('/channels/:id/approved-ip', (req, res) => {
    res.json({ approved: db.isIpApproved(int(req.params.id), String(req.query.ip || '')) });
});

// Active bans (user, IP and CIDR rows). `version` changes whenever the table does, so an
// unchanged table is one small answer.
contextRouter.get('/bans', (req, res) => {
    const v = db.get('SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m, COALESCE(SUM(id * 7 + COALESCE(stream_id, 0) + LENGTH(COALESCE(expires_at, \'\'))), 0) AS s FROM bans');
    const version = `${v.c}:${v.m}:${v.s}`;
    if (req.query.version && String(req.query.version) === version) return res.json({ version, unchanged: true });
    res.json({
        version,
        bans: db.all('SELECT id, stream_id, user_id, ip_address, anon_id, expires_at FROM bans WHERE expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP'),
    });
});

contextRouter.post('/decor', (req, res) => {
    const ids = (Array.isArray(req.body?.user_ids) ? req.body.user_ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
    let cosmetics = null, tags = null;
    try { cosmetics = require('../monetization/cosmetics'); } catch { /* */ }
    try { tags = require('./tags'); } catch { /* */ }
    const decor = {};
    for (const id of ids) {
        let cosmetic = {}, tag = null;
        try { if (cosmetics) cosmetic = cosmetics.getCosmeticProfile(id) || {}; } catch { cosmetic = {}; }
        try { if (tags) tag = tags.getTagProfile(id) || null; } catch { tag = null; }
        decor[id] = { cosmetic, tag };
    }
    res.json({ decor });
});

// Site settings chat reads (TTS config, GIF provider keys, the 101soundboards key) — nothing else.
const CHAT_SETTING_KEYS = new Set(['gif_tenor_api_key', 'gif_giphy_api_key', 'soundboard_101_api_key']);
const isChatSetting = (k) => CHAT_SETTING_KEYS.has(k) || /^tts_[a-z0-9_]+$/.test(k);
contextRouter.get('/settings', (req, res) => {
    const settings = {};
    for (const r of db.all("SELECT key FROM site_settings WHERE key LIKE 'tts\\_%' ESCAPE '\\' OR key IN ('gif_tenor_api_key', 'gif_giphy_api_key', 'soundboard_101_api_key')")) {
        if (isChatSetting(r.key)) settings[r.key] = db.getSetting(r.key);
    }
    res.json({ settings });
});

contextRouter.get('/anon/:num', (req, res) => {
    res.json({ first_seen: db.get('SELECT created_at FROM anon_ip_mappings WHERE anon_num = ?', [int(req.params.num)])?.created_at || null });
});
contextRouter.get('/anon-first-seen', (req, res) => {
    res.json({ first_seen: db.getAnonFirstSeen(String(req.query.ip || '')) });
});

contextRouter.get('/tts-audio/:file', (req, res) => {
    try {
        const hit = require('../arena/voice').cachedByName(req.params.file);
        if (!hit) return fail(res, 404, 'No such clip');
        res.set({ 'Content-Type': hit.mimeType });
        require('fs').createReadStream(hit.path).pipe(res);
    } catch (err) { fail(res, 500, err.message); }
});

// ── Effects ────────────────────────────────────────────────────

effectsRouter.post('/mirror', guard('live.chat_mirror.write'), (req, res, next) => next());
effectsRouter.use((req, res, next) => {
    if (req.path === '/mirror') return next();
    return guard('live.chat_effects.write')(req, res, next);
});
// Live only takes Chat's writes while Chat is the authority — a rehearsal Chat pointed at
// production Live can never award coins, post to AI viewers or overwrite chat tables.
effectsRouter.use((req, res, next) => {
    if (!isRemote()) return fail(res, 409, 'Live runs chat itself (CHAT_AUTHORITY is not "chat")');
    next();
});

const chatServer = () => require('./chat-server');
const actorOf = (id) => (id ? db.getUserById(id) : null);

effectsRouter.post('/anon', async (req, res) => {
    const ip = String(req.body?.ip || '');
    if (!ip) return fail(res, 400, 'ip required');
    try { res.json(await chatServer().resolveAnon(ip)); } catch (err) { fail(res, 500, err.message); }
});

effectsRouter.post('/ip-log', (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 1000) : [];
    let ipUtils = null;
    try { ipUtils = require('../admin/ip-utils'); } catch { /* */ }
    for (const e of entries) {
        try {
            const geo = ipUtils ? ipUtils.enrichIp(e.ip) : null;
            db.logIp({ userId: e.userId || null, anonId: e.anonId || null, ip: e.ip, action: e.action || 'chat', geo });
        } catch { /* non-critical */ }
    }
    res.json({ ok: true, logged: entries.length });
});

effectsRouter.post('/viewer-counts', (req, res) => {
    for (const [sid, count] of Object.entries(req.body?.counts || {})) {
        try { db.updateViewerCount(int(sid), Math.max(0, int(count))); } catch { /* */ }
    }
    res.json({ ok: true });
});

effectsRouter.post('/viewer-snapshots', (req, res) => {
    for (const s of (Array.isArray(req.body?.snapshots) ? req.body.snapshots : []).slice(0, 1000)) {
        try { db.insertViewerSnapshot(int(s.stream_id), Math.max(0, int(s.viewer_count)), Math.max(0, int(s.chat_messages_5m))); } catch { /* */ }
    }
    res.json({ ok: true });
});

// /color: the user changes their own color.
effectsRouter.post('/user-color', (req, res) => {
    const userId = int(req.body?.user_id);
    const color = String(req.body?.color || '');
    if (!userId || !/^#[0-9a-fA-F]{6}$/.test(color)) return fail(res, 400, 'user_id and a #rrggbb color required');
    db.run('UPDATE users SET profile_color = ? WHERE id = ?', [color, userId]);
    res.json({ ok: true });
});

// /ban, /timeout, /unban from chat. The moderator is checked again: global staff, or a
// moderator of the stream chat decided on (for an offline channel room, its latest stream).
effectsRouter.post('/ban', (req, res) => {
    const b = req.body || {};
    const actor = actorOf(int(b.actor_user_id));
    const modStream = int(b.moderation_stream_id) || null;
    const allowed = actor && !actor.is_banned && (permissions.isGlobalModOrAbove(actor) || (modStream && permissions.canModerateStream(actor, modStream)));
    if (!allowed) return fail(res, 403, 'You do not have permission.');
    const streamId = b.stream_id != null ? int(b.stream_id) || null : null;
    // A null stream id is a SITE-WIDE ban (or lifts one): global staff only. A channel moderator
    // acts on the stream they moderate, never on another channel's.
    const staff = permissions.isGlobalModOrAbove(actor);
    if (!staff && (!streamId || !permissions.canModerateStream(actor, streamId))) return fail(res, 403, 'You do not have permission.');
    if (b.action === 'unban') {
        const userId = int(b.user_id);
        if (!userId) return fail(res, 400, 'user_id required');
        if (streamId) db.run('DELETE FROM bans WHERE user_id = ? AND stream_id = ?', [userId, streamId]);
        else db.run('DELETE FROM bans WHERE user_id = ? AND stream_id IS NULL', [userId]);
        return res.json({ ok: true });
    }
    if (b.action !== 'ban') return fail(res, 400, 'action must be ban or unban');
    if (b.user_id) {
        const target = db.getUserById(int(b.user_id));
        if (!target) return fail(res, 404, 'User not found');
        // Prevent non-admins from banning admins
        if (permissions.isGlobalModOrAbove(target) && target.role === 'admin' && !permissions.isAdmin(actor)) return fail(res, 403, 'You cannot ban an admin.');
        db.run('INSERT INTO bans (stream_id, user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)',
            [streamId, target.id, String(b.reason || 'Banned by moderator').slice(0, 200), actor.id, b.expires_at || null]);
    } else if (b.ip_address) {
        db.run('INSERT INTO bans (stream_id, ip_address, anon_id, reason, banned_by) VALUES (?, ?, ?, ?, ?)',
            [streamId, String(b.ip_address), b.anon_id ? String(b.anon_id) : null, String(b.reason || 'Banned by moderator').slice(0, 200), actor.id]);
    } else {
        return fail(res, 400, 'user_id or ip_address required');
    }
    res.json({ ok: true });
});

// IP approval mode: an address that chatted here before is approved automatically ('auto_existing').
effectsRouter.post('/approve-ip', (req, res) => {
    const channelId = int(req.body?.channel_id);
    const ip = String(req.body?.ip || '');
    if (!channelId || !ip) return fail(res, 400, 'channel_id and ip required');
    db.approveIp(channelId, ip, req.body.approved_by ? int(req.body.approved_by) : null, String(req.body.source || 'auto').slice(0, 32));
    res.json({ ok: true });
});

// /slow persists the channel's slow mode.
effectsRouter.post('/channel-settings', (req, res) => {
    const channelId = int(req.body?.channel_id);
    const actor = actorOf(int(req.body?.actor_user_id));
    if (!channelId || !actor || !permissions.canModerateChannel(actor, channelId)) return fail(res, 403, 'You do not have permission.');
    const fields = {};
    if (req.body.fields && req.body.fields.slow_mode_seconds !== undefined) fields.slow_mode_seconds = Math.max(0, int(req.body.fields.slow_mode_seconds));
    if (!Object.keys(fields).length) return fail(res, 400, 'no chat-settable fields');
    chatTables.write('upsertChannelModerationSettings', channelId, fields)
        .then(() => res.json({ ok: true }), (err) => fail(res, err.status || 500, err.message));
});

// Donation / goal alert sounds: the streamer's own channel only, files in the shared sounds dir.
effectsRouter.post('/alert-sound', (req, res) => {
    const channelId = int(req.body?.channel_id);
    const channel = channelId ? db.getChannelById(channelId) : null;
    if (!channel || channel.user_id !== int(req.body?.actor_user_id)) return fail(res, 403, 'Not your channel');
    const url = req.body.url ? path.resolve(String(req.body.url)) : null;
    if (url) {
        // Compared through realpath: Chat and Live may reach the shared sounds dir via different symlinks.
        let inside = false;
        try { inside = path.dirname(fs.realpathSync(url)) === fs.realpathSync(path.resolve(config.sounds.path)); } catch { inside = false; }
        if (!inside) return fail(res, 400, 'alert sounds live in the sounds directory');
    }
    chatTables.write('setChannelAlertSound', channelId, req.body.kind === 'goal' ? 'goal' : 'donation', url, url ? String(req.body.mime || 'audio/mpeg') : null)
        .then(() => res.json({ ok: true }), (err) => fail(res, err.status || 500, err.message));
});

effectsRouter.post('/ensure-channel', (req, res) => {
    const userId = int(req.body?.user_id);
    if (!userId || !db.getUserById(userId)) return fail(res, 404, 'User not found');
    const ch = db.ensureChannel(userId);
    res.json({ channel: ch ? { id: ch.id, user_id: ch.user_id, title: ch.title } : null });
});

// TTS admin settings: admins; credentials only the owner (Live's /api/tts/admin/settings rules).
effectsRouter.post('/site-settings', (req, res) => {
    const actor = actorOf(int(req.body?.actor_user_id));
    if (!permissions.can(actor, 'staff.site.configure')) return fail(res, 403, 'Admin access required');
    const allowed = ['tts_enabled', 'tts_provider', 'tts_google_api_key', 'tts_google_service_account', 'tts_aws_access_key_id', 'tts_aws_secret_access_key', 'tts_aws_region', 'tts_max_length', 'tts_max_queue_per_user', 'tts_max_queue_global', 'tts_default_voice'];
    const secret = new Set(['tts_google_api_key', 'tts_google_service_account', 'tts_aws_access_key_id', 'tts_aws_secret_access_key']);
    const owner = permissions.isOwner(actor);
    let count = 0;
    for (const [key, value] of Object.entries(req.body.settings || {})) {
        if (!allowed.includes(key)) continue;
        if (secret.has(key) && !owner) continue;
        if (secret.has(key) && typeof value === 'string' && /^••••/.test(value)) continue;
        db.setSetting(key, value);
        count++;
    }
    try { require('./tts-engine').invalidateSettingsCache(); } catch { /* */ }
    res.json({ ok: true, updated: count });
});

// One real chat line: OpenCoins chat bonus, AI chat viewers, the PowerChat overlay relay.
effectsRouter.post('/chat-message', (req, res) => {
    const b = req.body || {};
    let coin = null;
    if (b.award && b.user_id && b.stream_id) {
        try { coin = require('../monetization/opencoins').awardChat(int(b.user_id), int(b.stream_id)); } catch { coin = null; }
    }
    if (b.ai && b.stream_id) {
        try {
            require('../integrations/ai-chatbot-service').onRealChatMessage(int(b.stream_id), {
                username: b.username,
                message: b.message,
                userId: b.user_id || null,
                anonId: b.anon_id || null,
                isStreamer: !!b.is_streamer,
                isMod: !!b.is_mod,
                msgId: b.msg_id || null,
                channelUserId: b.channel_user_id || null,
            });
        } catch { /* non-critical */ }
    }
    if (b.powerchat && b.channel_user_id && b.powerchat_chat) {
        try {
            const pc = require('../integrations/powerchat-platform');
            const channelUserId = int(b.channel_user_id);
            if (pc.channelRelayEnabled(channelUserId, b.stream_id || null)) {
                let isSub = false;
                try { isSub = !!(b.user_id && db.isActiveSubscriber(int(b.user_id), channelUserId)); } catch { /* */ }
                const c = b.powerchat_chat;
                pc.forwardChat(channelUserId, {
                    chatterName: c.chatterName,
                    externalChatterId: c.externalChatterId,
                    message: c.message,
                    avatarUrl: c.avatarUrl || undefined,
                    isModerator: !!c.isModerator,
                    isSubscriber: isSub,
                });
            }
        } catch { /* non-critical */ }
    }
    res.json({ coin });
});

effectsRouter.post('/ai/mod-command', (req, res) => {
    try {
        const engine = require('../integrations/ai-chatbot-service');
        const reply = engine.onModCommand
            ? engine.onModCommand(req.body.channel_user_id || null, req.body.stream_id || null, Array.isArray(req.body.args) ? req.body.args : [], { by: req.body.by })
            : 'AI viewers: command not supported by this engine.';
        res.json({ reply: reply || null });
    } catch (err) { fail(res, 400, err.message); }
});

// !hype / !beef / !arena: arena-chat answers the sender through Chat (sendToConn).
effectsRouter.post('/arena-command', (req, res) => {
    const client = req.body?.client || {};
    const cs = chatServer();
    const shim = {
        sendTo: (_ws, payload) => cs.sendToConn(client.conn_id, payload),
        broadcastToStream: (streamId, payload) => cs.broadcastToStream(streamId, payload),
    };
    let handled = false;
    try { handled = require('../arena/arena-chat').handle(shim, null, client, String(req.body.cmd || ''), Array.isArray(req.body.parts) ? req.body.parts : []); } catch (e) { console.warn('[Arena] chat command:', e.message); }
    res.json({ handled: !!handled });
});

// !sr / !queue / !np / !skip — the media queue is Live's.
effectsRouter.post('/media-queue', async (req, res) => {
    const b = req.body || {};
    const mediaQueue = require('../media/media-queue');
    const streamerId = int(b.streamerId);
    if (!streamerId) return fail(res, 400, 'streamerId required');
    try {
        if (b.op === 'add') {
            const request = await mediaQueue.addRequest({ streamerId, streamId: int(b.streamId) || null, userId: int(b.userId), username: String(b.username || ''), input: String(b.input || '') });
            return res.json({ request });
        }
        if (b.op === 'state') return res.json({ state: mediaQueue.getState(streamerId) });
        if (b.op === 'skip') {
            const actor = actorOf(int(b.actorUserId));
            const streamId = int(b.streamId) || null;
            const allowed = actor && (actor.id === streamerId || permissions.isGlobalModOrAbove(actor) || (streamId && permissions.canModerateStream(actor, streamId)));
            if (!allowed) return fail(res, 403, 'Only the streamer or a moderator can skip media.');
            const ended = mediaQueue.finishCurrent(streamerId, 'skipped');
            const next = mediaQueue.startNext(streamerId);
            return res.json({ ended: ended || null, next: next || null });
        }
        fail(res, 400, 'unknown op');
    } catch (err) {
        fail(res, 400, err.message || 'Media command failed.');
    }
});

// Cozmo / !say: the robot's control socket is in Live, keyed by the streamer's stream key.
const HARDWARE_COMMANDS = new Set(['forward', 'backward', 'turn_left', 'turn_right', 'lift_up', 'lift_down', 'head_up', 'head_down']);
effectsRouter.post('/hardware', (req, res) => {
    const command = String(req.body?.command || '');
    if (!HARDWARE_COMMANDS.has(command) && !/^say:[\s\S]{1,200}$/.test(command)) return fail(res, 400, 'unknown command');
    const user = db.getUserById(int(req.body.streamer_user_id));
    if (!user) return res.json({ ok: false, reason: 'no_user' });
    const controlServer = require('../controls/control-server');
    const hwWs = controlServer.hardwareClients.get(user.stream_key);
    if (!hwWs || hwWs.readyState !== 1) return res.json({ ok: false, reason: 'no_hardware' });
    hwWs.send(JSON.stringify({
        type: 'command',
        command,
        from_user: String(req.body.from_user || ''),
        timestamp: new Date().toISOString(),
    }));
    res.json({ ok: true });
});

// /paste from chat, through Live's pastes client (Community or Media per PASTES_AUTHORITY).
effectsRouter.post('/paste', async (req, res) => {
    const b = req.body || {};
    try {
        const paste = await require('../pastes-client').createPaste({
            title: String(b.title || '').slice(0, 200),
            content: String(b.content || ''),
            language: b.language || 'auto',
            visibility: b.visibility || 'public',
            user_id: b.user_id || undefined,
            stream_id: b.stream_id || undefined,
        });
        res.json({ paste: { slug: paste.slug } });
    } catch (err) { fail(res, 502, err.message); }
});

effectsRouter.post('/translate', async (req, res) => {
    let i18n;
    try { i18n = require('../i18n/translate'); } catch { return res.json({ translation: null }); }
    if (!i18n.available()) return res.json({ translation: null });
    try {
        const tr = await i18n.translateChatMessage(String(req.body?.text || ''), req.body?.channel_user_id || null);
        res.json({ translation: tr && tr.text ? tr : null });
    } catch { res.json({ translation: null }); }
});

effectsRouter.post('/notify/dm', (req, res) => {
    try {
        const { pushBulkNotification, actorInfo } = require('../utils/notify');
        const sender = db.getUserById(int(req.body?.sender_id));
        const otherIds = (Array.isArray(req.body?.recipient_ids) ? req.body.recipient_ids : []).map(Number).filter(Boolean).slice(0, 50);
        const convId = int(req.body?.conversation_id);
        if (otherIds.length && convId) {
            const senderName = sender?.display_name || sender?.username || 'Someone';
            // Generic preview — the message itself only travels over the live socket.
            pushBulkNotification(otherIds, {
                type: 'DIRECT_MESSAGE',
                title: `Message from ${senderName}`,
                message: 'Sent you a message',
                url: `https://openvibe.live/?dm=${convId}`,
                ...actorInfo(sender),
            });
        }
    } catch { /* non-critical */ }
    res.json({ ok: true });
});

// A call-user ring from OpenVibe.Chat's call server (CALLS_AUTHORITY=chat): the cross-site
// notification Live's POST /api/streams/voice-channels/call-user pushed itself.
effectsRouter.post('/notify/call-invite', (req, res) => {
    const caller = db.getUserById(int(req.body?.caller_id));
    const targetId = int(req.body?.target_id);
    const channelId = String(req.body?.channel_id || '').slice(0, 100);
    const channelName = String(req.body?.channel_name || 'Voice Channel').slice(0, 100);
    if (!caller || !targetId || !db.getUserById(targetId) || !channelId) return fail(res, 400, 'caller_id, target_id and channel_id required');
    try {
        const { pushNotification, actorInfo } = require('../utils/notify');
        const callerName = caller.display_name || caller.username || 'Someone';
        pushNotification({
            user_id: targetId,
            type: 'VC_CALL_INVITE',
            title: `${callerName} is calling you`,
            message: `Join voice channel: ${channelName}`,
            url: `${config.baseUrl}/?vcInvite=${encodeURIComponent(channelId)}`,
            rich_content: {
                context: {
                    channel_id: channelId,
                    channel_name: channelName,
                    caller_username: caller.username,
                },
            },
            ...actorInfo(caller, callerName),
        });
    } catch { /* non-critical */ }
    res.json({ ok: true });
});

effectsRouter.post('/notify/dm-read', (req, res) => {
    try {
        const { markNotificationsRead } = require('../utils/notify');
        markNotificationsRead(int(req.body?.user_id), 'DIRECT_MESSAGE', `%/dm/${int(req.body?.conversation_id)}`);
    } catch { /* non-critical */ }
    res.json({ ok: true });
});

// Channel sound files are mirrored to OpenVibe.Media from Live's copy of channel_sounds.
effectsRouter.post('/asset-sync', (req, res) => {
    try {
        const sync = require('../media-proxy/asset-sync');
        if (req.body?.op === 'syncSoon') sync.syncSoon();
        else if (req.body?.op === 'remove-sound') {
            const row = db.get('SELECT media_asset_id FROM channel_sounds WHERE id = ?', [int(req.body.asset_id)]);
            if (row && row.media_asset_id) sync.removeAsset(row.media_asset_id);
        }
    } catch { /* best-effort */ }
    res.json({ ok: true });
});

// ── The read mirror of Chat's tables ──────────────────────────────
// Same tables, same ids. Upserts set only the columns Live's table has (Chat's *subject_id
// columns are skipped; Live-only columns such as channel_sounds.media_asset_id are kept).
// A staged table (roadmap C-04, chat-tables.js) is mirrored only while Chat writes it or hands it
// back; while Live writes it, Chat's rows for it are refused. Its rows REPLACE: the authority's row
// wins over whatever holds its key or one of its unique columns here (both copies have the same
// columns, so nothing of Live's is lost).
const MIRROR_TABLES = {
    chat_messages: ['id'],
    dm_conversations: ['id'],
    dm_participants: ['id'],
    dm_messages: ['id'],
    dm_blocks: ['id'],
    tts_voice_overrides: ['identity_key'],
    channel_sounds: ['id'],
    relay_users: ['platform', 'username'],
    hidden_relay_users: ['id'],
    pending_ip_messages: ['id'],
    stream_first_chats: ['chatter_key', 'channel_user_id'],
    moderation_actions: ['id'],
};
const _cols = new Map();
function liveColumns(table) {
    if (!_cols.has(table)) _cols.set(table, new Set(db.getDb().prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
    return _cols.get(table);
}

function applyMirror(changes) {
    const d = db.getDb();
    let applied = 0;
    const skipped = [];
    // A copy of the authority's rows: foreign keys are the authority's business. Synchronous, so
    // nothing else runs while they are off.
    d.pragma('foreign_keys = OFF');
    try {
        d.transaction(() => {
            for (const c of changes) {
                const staged = !!(c && chatTables.TABLES[c.table]);
                const pk = MIRROR_TABLES[c && c.table] || (staged && chatTables.acceptsMirror(c.table) ? chatTables.TABLES[c.table] : null);
                if (!pk) { skipped.push({ table: c && c.table, reason: staged ? 'Live writes this table (chat_table_authority live)' : 'not a mirrored table' }); continue; }
                const have = liveColumns(c.table);
                try {
                    if (c.op === 'delete') {
                        d.prepare(`DELETE FROM ${c.table} WHERE ${pk.map((k) => `${k} = ?`).join(' AND ')}`).run(...pk.map((k) => c.pk[k]));
                    } else if (c.op === 'upsert' && c.row && staged) {
                        const cols = Object.keys(c.row).filter((k) => have.has(k) && /^[a-z_]+$/.test(k));
                        d.prepare(`INSERT OR REPLACE INTO ${c.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => c.row[k]));
                    } else if (c.op === 'upsert' && c.row) {
                        const cols = Object.keys(c.row).filter((k) => have.has(k) && /^[a-z_]+$/.test(k));
                        const upd = cols.filter((k) => !pk.includes(k));
                        d.prepare(`INSERT INTO ${c.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
                            ON CONFLICT(${pk.join(', ')}) DO ${upd.length ? `UPDATE SET ${upd.map((k) => `${k} = excluded.${k}`).join(', ')}` : 'NOTHING'}`)
                            .run(...cols.map((k) => c.row[k]));
                    } else { skipped.push({ table: c.table, reason: 'bad change' }); continue; }
                    applied++;
                } catch (err) {
                    skipped.push({ table: c.table, pk: c.pk || (c.row && pk.map((k) => c.row[k])), reason: err.message });
                }
            }
        })();
    } finally {
        d.pragma('foreign_keys = ON');
    }
    return { applied, skipped };
}

effectsRouter.post('/mirror', (req, res) => {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes.slice(0, 1000) : [];
    const out = applyMirror(changes);
    if (out.skipped.length) console.warn(`[ChatMirror] ${out.skipped.length} change(s) not applied:`, JSON.stringify(out.skipped.slice(0, 3)));
    res.json({ ok: true, ...out });
});

module.exports = { contextRouter, effectsRouter, applyMirror, userProjection, MIRROR_TABLES };
