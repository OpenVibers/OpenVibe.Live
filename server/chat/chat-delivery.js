'use strict';
/**
 * The one seam Live's chat producers call (T3 J2; Live's own ChatServer is deleted).
 *
 * CHAT_AUTHORITY=chat: OpenVibe.Chat's typed ingress (chat-client.js) — Chat persists, broadcasts, mirrors,
 * speaks and moderates in one call per operation. This is the only path to Chat: the old ordered-calls bridge
 * and its outbox are gone, and Live no longer runs a chat server in any mode. This module also carries the
 * ChatServer surface Live's remaining modules still use.
 *
 * A Chat 4xx/5xx is logged and counted by chat-client.js and never thrown into the caller.
 *
 *   ingress()                      which path is active (CHAT_AUTHORITY=chat)
 *   message(body)                  ingress only: a chat line (Chat's /messages body) → Promise<real id | null>
 *   event(target, frame, opts)     a transient frame; target { kind: stream|channel|global|all|user | Chat's own kinds }
 *   moderate(action, fields)       ingress only: Chat's /moderation actions → Promise<Chat's answer | null>
 *   logModeration(entry)           a moderation-log row (Chat's moderation_actions shape)
 *   disconnect({ userId, ip, streamId })
 *   invalidate(hint, legacy)       a cache hint ({ user, user_data, approvals, bans, channel })
 *   after(value, fn)               fn(value) now for a plain value, after it resolves for a promise
 *
 * The pushes Live's modules used to make on the chat server keep their names here — broadcastToStream,
 * broadcastToChannelRoom, broadcastGlobal, broadcastAll, sendDm, sendUserUpdate, disconnectUser — and go
 * to the same ingress. A push Chat's ingress has no target for (forwardToGlobal, forwardToStreamerRooms,
 * triggerChannelSound, synthesizeAndBroadcastTTS — Chat speaks a message's `tts` field and plays channel
 * sounds from its own settings) is dropped and logged once, exactly as the old RemoteChatServer did.
 *
 * Synchronous reads came from Chat's presence snapshot (GET /internal/chat/presence), polled every few
 * seconds by init()/close() (called from server/index.js at boot and drain): connection and viewer counts,
 * slow modes, a connected user's address. Live's own address/anon helpers live here too (call-server,
 * Chat's /internal/chat-effects/anon), along with Live's writes to data Chat caches (IP approvals, bans)
 * which send Chat a cache hint instead of waiting for its cache to expire.
 */
const db = require('../db/database');
const chatAuthority = require('./chat-authority');
const client = require('./chat-client');

function ingress() { return chatAuthority.isRemote(); }

function defined(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = v;
    return out;
}

// Chat's ingress takes these as positive integers; route params and bodies hand Live strings.
const INT_FIELDS = ['id', 'user_id', 'stream_id', 'channel_id', 'channel_user_id', 'reply_to_id', 'reviewed_by', 'actor_user_id', 'target_user_id', 'created_by', 'set_by'];
function ints(o) {
    for (const k of INT_FIELDS) if (typeof o[k] === 'string' && /^\d+$/.test(o[k])) o[k] = Number(o[k]);
    return o;
}

function message(body) {
    const b = ints(defined(body));
    if (b.key) b.key = client.key('messages', b.key);
    if (b.is_global != null) b.is_global = !!b.is_global;
    if (b.frame) b.frame = defined(b.frame);
    if (b.tts) b.tts = defined(b.tts);
    return client.message(b).then((r) => (r && r.id != null ? Number(r.id) : null));
}

// Pushes with no Chat ingress target: logged once per name, never synthesised.
const _dropped = new Set();
function dropped(name, why = 'has no Chat ingress target and was dropped') {
    if (_dropped.has(name)) return;
    _dropped.add(name);
    console.warn(`[Chat] ${name} ${why}`);
}

async function event(target, frame, { key } = {}) {
    if (!ingress()) { dropped(`event(${target.kind})`, 'dropped — Live runs no chat server (CHAT_AUTHORITY is not chat)'); return undefined; }
    const t = { kind: target.kind };
    if (target.id != null) t.id = Number(target.id);
    return await client.event({ key: key ? client.key('events', key) : undefined, target: t, frame: defined(frame) });
}

async function moderate(action, fields, { key } = {}) {
    return await client.moderation(ints({ ...defined(fields), action, key: key ? client.key('moderation', key) : undefined }));
}

const LOG_FIELDS = ['scope_type', 'scope_id', 'actor_user_id', 'target_user_id', 'action_type', 'details'];
// Chat owns the moderation log (its moderation_actions; Live keeps no copy), so this always goes
// through Chat's ingress — in every mode, like every other moderation write.
async function logModeration(entry) {
    const fields = {};
    for (const k of LOG_FIELDS) if (entry[k] != null) fields[k] = entry[k];
    if (typeof fields.scope_id === 'string' && fields.scope_type !== 'room' && /^\d+$/.test(fields.scope_id)) fields.scope_id = Number(fields.scope_id);
    return await moderate('log', fields);
}

async function disconnect({ userId, ip, streamId } = {}) {
    if (!ingress()) { dropped('disconnectUser', 'dropped — Live runs no chat server (CHAT_AUTHORITY is not chat)'); return undefined; }
    return await moderate('disconnect', { user_id: userId || undefined, ip: ip || undefined, stream_id: streamId || undefined });
}
const disconnectUser = disconnect;

/** legacy: what to run when Live is the chat authority (cache hints had no single local call). */
async function invalidate(hint, legacy) {
    if (ingress()) return await client.invalidate(defined(hint));
    return legacy ? legacy() : undefined;
}

function after(value, fn) {
    return value && typeof value.then === 'function' ? value.then(fn) : fn(value);
}

// ── The pushes modules still make on the chat server (names kept from ChatServer) ─────────────
async function broadcastToStream(streamId, frame) { return await event({ kind: 'stream', id: streamId }, frame); }
async function broadcastToChannelRoom(channelUserId, streamId, frame) { return await event({ kind: 'channel', id: channelUserId }, frame); }
async function broadcastGlobal(frame) { return await event({ kind: 'global' }, frame); }
async function broadcastAll(frame) { return await event({ kind: 'all' }, frame); }
async function sendDm(userId, frame) { return await event({ kind: 'user', id: userId }, frame); }
async function sendUserUpdate(userId, u) {
    const id = Number(userId) || undefined;
    const userData = u ? { id, username: u.username, display_name: u.display_name || null, role: u.role || null, avatar_url: u.avatar_url || null, profile_color: u.profile_color || null } : undefined;
    return await invalidate({ user: id, user_data: userData });
}
// No ingress target — the old ChatServer forwarded these to Live's own other rooms/slots; Chat fans a
// channel event out to the channel's rooms itself, and speaks/sounds from the message's own fields.
function forwardToGlobal() { dropped('forwardToGlobal'); }
function forwardToStreamerRooms() { dropped('forwardToStreamerRooms'); }
function triggerChannelSound() { dropped('triggerChannelSound'); }
function synthesizeAndBroadcastTTS() { dropped('synthesizeAndBroadcastTTS'); return Promise.resolve(); }

// ── Presence: Chat's snapshot, polled (the synchronous reads health, diagnostics and moderation use) ──
const OBSERVED_DB = {
    approveIp: (a) => ({ approvals: Number(a[0]) || undefined }),
    revokeIpApproval: (a) => ({ approvals: Number(a[0]) || undefined }),
    forgiveBan: () => ({ bans: true }),
};
const PRESENCE_MS = 3000;
const slowModeByStream = new Map();
let _presence = { total: 0, streams: {}, slow_mode: {}, users: [], anons: [], at: null };
let _presenceTimer = null;
let _dbObserved = false;

// Live-owned data Chat caches, written by Live's own routes (IP approvals, bans): after the write Chat is
// told to reload it instead of waiting for its cache to expire.
function _observeDb() {
    for (const [fn, hint] of Object.entries(OBSERVED_DB)) {
        const orig = db[fn];
        if (typeof orig !== 'function' || orig._chatObserved) continue;
        const observed = async (...args) => {
            const result = await orig(...args);
            try { await invalidate(hint(args)); } catch { /* non-critical */ }
            return result;
        };
        observed._chatObserved = true;
        db[fn] = observed;
    }
}

async function _pollPresence() {
    try {
        const p = await client.presence();
        if (!p) return;
        _presence = p;
        slowModeByStream.clear();
        for (const [k, v] of Object.entries(p.slow_mode || {})) slowModeByStream.set(Number(k), Number(v) || 0);
    } catch { /* keep the last snapshot */ }
}

/** Start the presence poll (and the cache-hint observers). Called once at startup; no-op outside chat mode. */
async function init() {
    if (!ingress()) return null;
    if (!_dbObserved) { _dbObserved = true; _observeDb(); }
    if (_presenceTimer) return null;
    _pollPresence().catch((e) => console.warn('[Chat] presence:', e.message));
    _presenceTimer = setInterval(() => _pollPresence().catch((e) => console.warn('[Chat] presence:', e.message)), PRESENCE_MS);
    if (_presenceTimer.unref) _presenceTimer.unref();
    console.log('[Chat] CHAT_AUTHORITY=chat — chat runs in OpenVibe.Chat; Live delivers through its ingress');
    return null;
}

function close() {
    if (_presenceTimer) clearInterval(_presenceTimer);
    _presenceTimer = null;
}

function getTotalConnections() { return Number(_presence.total) || 0; }
function getStreamViewerCount(streamId) { return Number((_presence.streams || {})[streamId]) || 0; }
function getConnectedUserIp(userId) {
    const hit = (_presence.users || []).find((u) => u.user_id === userId);
    return hit ? hit.ip : null;
}
function findClientByAnonId(anonId, streamId) {
    // The socket's stream must equal streamId; with no streamId given (a moderator looking an anon up by id alone),
    // any of that anon's sockets answers.
    const hit = (_presence.anons || []).find((a) => a.anon_id === anonId && (streamId === undefined || (a.stream_id ?? null) === streamId));
    return hit ? { anonId: hit.anon_id, ip: hit.ip, streamId: hit.stream_id || null, user: null } : null;
}

// ── Live's own address / anon helpers (Chat's /internal/chat-effects/anon, call-server) ──
const _openvibeToolsUrl = process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:3100';
const anonMap = new Map();          // IP → number
const pendingResolves = new Map();  // IP → pending resolve promise (dedup concurrent)
let nextAnonId = 1;
let _anonDbLoaded = false;

function normalizeIp(ip) {
    let normalized = String(ip || 'unknown').trim();
    if (!normalized) normalized = 'unknown';
    if (normalized === '::1') return '127.0.0.1';
    if (normalized.startsWith('::ffff:')) return normalized.slice(7);
    return normalized;
}

/**
 * Extract the real client IP from Express/WS request.
 * Prefers CF-Connecting-IP (set by Cloudflare, unforgeable through proxy),
 * then X-Forwarded-For first entry, then socket remote address.
 */
function getClientIp(req) {
    const raw = req.headers?.['cf-connecting-ip']
        || req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || req.connection?.remoteAddress
        || 'unknown';
    return normalizeIp(raw);
}

/** Warm the in-memory anonMap from DB on first use, so anon numbers survive server restarts. */
async function _loadAnonMappings() {
    if (_anonDbLoaded) return;
    _anonDbLoaded = true;
    try {
        const { maxNum, mappings } = await db.loadAnonMappings();
        for (const [ip, num] of mappings) anonMap.set(ip, num);
        nextAnonId = maxNum + 1;
        if (mappings.size > 0) {
            console.log(`[Chat] Loaded ${mappings.size} persistent anon mappings (next: anon${nextAnonId})`);
        }
    } catch (e) {
        console.warn('[Chat] Failed to load anon mappings from DB:', e.message);
    }
}

/** Resolve anon number from openvibe.network unified API. Returns a Promise<number>; falls back to local DB. */
async function _resolveUnifiedAnonNum(ip) {
    if (anonMap.has(ip)) return anonMap.get(ip);
    if (pendingResolves.has(ip)) return pendingResolves.get(ip);

    const promise = (async () => {
        try {
            const auth = await require('../net/network-principal').headersFor('/internal/resolve-anon');
            const res = await fetch(`${_openvibeToolsUrl}/internal/resolve-anon`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ ip }),
            });
            if (res.ok) {
                const data = await res.json();
                const num = data.anon_number;
                anonMap.set(ip, num);
                if (num >= nextAnonId) nextAnonId = num + 1;
                try { await db.getOrCreateAnonNum(ip); } catch { /* ok */ }   // warmup cache
                return num;
            }
            throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            console.warn(`[Chat] Unified anon resolve failed for ${ip}, falling back to local:`, e.message);
            try {
                const num = await db.getOrCreateAnonNum(ip);
                anonMap.set(ip, num);
                if (num >= nextAnonId) nextAnonId = num + 1;
                return num;
            } catch {
                const num = nextAnonId++;
                anonMap.set(ip, num);
                return num;
            }
        } finally {
            pendingResolves.delete(ip);
        }
    })();

    pendingResolves.set(ip, promise);
    return promise;
}

async function getAnonIdForIp(ip) {
    await _loadAnonMappings();
    const anonKey = normalizeIp(ip);
    if (anonMap.has(anonKey)) return `anon${anonMap.get(anonKey)}`;
    // Synchronous fallback for immediate use — kick off the unified resolve in the background.
    _resolveUnifiedAnonNum(anonKey).catch(() => {});
    try {
        const num = await db.getOrCreateAnonNum(anonKey);
        anonMap.set(anonKey, num);
        if (num >= nextAnonId) nextAnonId = num + 1;
        return `anon${num}`;
    } catch {
        const num = nextAnonId++;
        anonMap.set(anonKey, num);
        return `anon${num}`;
    }
}

async function getAnonIdForConnection(ip, streamId = null) {
    const key = normalizeIp(ip);
    const hit = (_presence.anons || []).find((a) => a.ip === key && (streamId == null || (a.stream_id || null) === streamId));
    return hit ? hit.anon_id : await getAnonIdForIp(key);
}

/** The anon number for an address (Network's unified resolve, else Live's table) — for Chat. */
async function resolveAnon(ip) {
    const key = normalizeIp(ip);
    const num = await _resolveUnifiedAnonNum(key);
    return { anon_number: num, first_seen: await db.getAnonFirstSeen(key) };
}

module.exports = {
    ingress, message, event, moderate, logModeration, disconnect, disconnectUser, invalidate, after, client,
    broadcastToStream, broadcastToChannelRoom, broadcastGlobal, broadcastAll, sendDm, sendUserUpdate,
    forwardToGlobal, forwardToStreamerRooms, triggerChannelSound, synthesizeAndBroadcastTTS,
    init, close, slowModeByStream, getTotalConnections, getStreamViewerCount, getConnectedUserIp, findClientByAnonId,
    normalizeIp, getClientIp, getAnonIdForIp, getAnonIdForConnection, resolveAnon,
};
