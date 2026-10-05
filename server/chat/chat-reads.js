'use strict';
/**
 * The chat reads Live's own features still make, answered from OpenVibe.Chat (plan T3 J4b:
 * "Read Live's chat stats, queues and history from Chat"). Chat owns chat_messages, channel_sounds,
 * pending_ip_messages, hidden_relay_users and tts_voice_overrides, so Live's home stats, recaps,
 * AI context, admin console and mod queues read them through Chat's internal read API
 * (server/chat/chat-client.js). Live's own tables remain as Chat's read mirror until a later step
 * drops them, so the rollback path and the readers that have not moved yet keep working.
 *
 * Mode-aware: when CHAT_AUTHORITY=chat, every answer comes from Chat; otherwise Live runs chat
 * itself and the same call answers from Live's own tables (the rollback / dev path) — the caller
 * never has to know which.
 *
 * Caching: an answer is fresh for CACHE_TTL_MS. An async read past that asks Chat again; a peek
 * (for a caller that cannot await) answers the last good value while that refresh runs, so a peek
 * never drops a known answer just because its TTL passed. A good value is kept for CACHE_KEEP_MS,
 * so a Chat failure answers the last good value, else null — a failure never overwrites a good
 * answer, and it sets a FAIL_TTL_MS backoff so a Chat outage cannot turn a hot reader (a relay
 * line, a peek per tick) into a retry per call. That backoff is only for cached reads: a read the
 * moderation console acts on (queues, one message, a voice override) is never cached (ttl: 0), is
 * never short-circuited by a cooling failure and never shares another read's in-flight request, and
 * throws a `Chat unavailable` error (`.unavailable`) on a Chat failure, so those routes answer 503
 * instead of stale or empty queue data. Off under LIVE_DRILL.
 *
 * Callers that can await use the async function; the few that cannot (the AI persona prompt, the
 * home-stats snapshot, the TTS engine) use the matching peek*().
 */
const { isRemote } = require('./chat-authority');
const client = require('./chat-client');

const CACHE_TTL_MS = 15_000;        // how long an answer is used without asking Chat again
const CACHE_KEEP_MS = 15 * 60_000;  // how long a last-good value answers peeks and failures
const FAIL_TTL_MS = 2_000;          // how long a failure is not retried (it never replaces the value)

const cache = new Map();     // key -> { at, value, failed?, failedAt? }
const inflight = new Map();  // key -> Promise
let cacheMax = 2000;         // test hook; the cap remember()/rememberFailure() evict down to
let lastLog = null;

function drill() { try { return require('../drill').enabled; } catch { return false; } }
function remote() { return isRemote() && !drill(); }
function local() { return require('../db/database'); }
/** Run a local (Live-table) read for a synchronous caller, answering `dflt` if it throws. */
function safeLocal(fn, dflt) { try { const v = fn(); return v == null ? dflt : v; } catch { return dflt; } }
/** Epoch ms → the UTC 'YYYY-MM-DD HH:MM:SS' text chat_messages.timestamp stores. */
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function note(what, err) {
    const m = `Chat read ${what}: ${(err && err.message) || err}`;
    if (m === lastLog) return;   // log once until it changes or a read succeeds
    lastLog = m;
    console.warn(`[ChatRead] ${m}`);
}

/** A Chat failure on a read the moderation console acts on: its route answers 503, never stale data. */
function unavailable(what) {
    const err = new Error(`Chat unavailable (${what})`);
    err.unavailable = true;
    return err;
}
/** A read Chat's API does not offer: the route answers with err.status (501) and this message. */
function unsupported(message, status = 501) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function fresh(key) { const h = cache.get(key); return h && !h.failed && Date.now() - h.at < CACHE_TTL_MS ? h : null; }
function kept(key) { const h = cache.get(key); return h && !h.failed && Date.now() - h.at < CACHE_KEEP_MS ? h : null; }
function cooling(key) { const h = cache.get(key); const at = h && (h.failedAt || (h.failed && h.at)); return !!at && Date.now() - at < FAIL_TTL_MS; }
/** Keep the cache bounded: drop entries past the keep window first, then the oldest. */
function evict() {
    if (cache.size <= cacheMax) return;
    for (const [k, h] of cache) if (Date.now() - h.at >= CACHE_KEEP_MS) cache.delete(k);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
}
function remember(key, value) {
    cache.set(key, { at: Date.now(), value });
    evict();
}

/** Record that this key just failed without overwriting its last good value. */
function rememberFailure(key) {
    const h = cache.get(key);
    if (h && !h.failed) { h.failedAt = Date.now(); return; }
    // Same bounded insert as a good value: a Chat outage fails per-chatter, per-message and
    // per-query keys, and must not grow the cache past the cap.
    cache.set(key, { at: Date.now(), value: null, failed: true });
    evict();
}

/**
 * Async answer: Chat (remote) or Live's own tables (local), cached. A failure answers the last
 * good value, else null; with `strict` it throws `Chat unavailable` instead (the moderation
 * console). `ttl: 0` always reads live and never caches. An error carrying a `status` (a
 * deliberate "not supported") is handed to the caller as it is.
 */
function load(key, remoteFn, localFn, { ttl = CACHE_TTL_MS, strict = false } = {}) {
    if (!remote()) {
        return Promise.resolve().then(async () => { try { return await localFn(); } catch (err) { note(key, err); return null; } });
    }
    if (ttl > 0) { const hit = fresh(key); if (hit) return Promise.resolve(hit.value); }
    // The backoff only short-circuits a cached, non-strict read. A read the console acts on
    // (ttl 0 / strict) always reaches Chat, so one blip cannot answer the moderator's retry with an
    // instant 503 from the failure that is still cooling.
    if (ttl > 0 && !strict && cooling(key)) {
        const last = kept(key);
        return Promise.resolve(last ? last.value : null);
    }
    // Only cached reads share an in-flight request. A live (ttl 0) read must not join a read that
    // started before the write it follows (an approve, a delete, an unhide).
    if (ttl > 0 && inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        let value;
        try { value = await remoteFn(); }
        catch (err) {
            note(key, err);
            if (err && err.status) throw err;
            rememberFailure(key);
            if (strict) throw unavailable(key);
            const last = kept(key);
            return last ? last.value : null;
        }
        lastLog = null;
        if (ttl > 0) remember(key, value);
        return value;
    })().finally(() => inflight.delete(key));
    if (ttl > 0) inflight.set(key, p);
    return p;
}

/** Sync answer for a caller that cannot await: fresh value, else the last good value + a background refresh, else null. */
function peek(key, remoteFn, localFn) {
    if (!remote()) { try { return localFn(); } catch (err) { note(key, err); return null; } }
    const hit = fresh(key);
    if (hit) return hit.value;
    load(key, remoteFn, localFn).catch(() => { /* logged in load() */ });   // floating-ok: refreshes for the next peek
    const last = kept(key);
    return last ? last.value : null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function localSiteStats() {
    const db = local();
    const r = db.get(`SELECT COUNT(*) AS messages,
        COUNT(DISTINCT COALESCE('u:' || user_id, 'a:' || anon_id, source_platform || ':' || username)) AS chatters
        FROM chat_messages WHERE is_deleted = 0`) || {};
    return { messages: Number(r.messages) || 0, chatters: Number(r.chatters) || 0 };
}
async function remoteSiteStats() {
    const out = await client.readStats({ kind: 'site' });
    if (!out) throw unavailable('site stats');
    return { messages: Number(out.messages) || 0, chatters: Number(out.chatters) || 0 };
}
/** { messages, chatters } across the whole site. */
function siteStats() { return load('site', remoteSiteStats, localSiteStats); }
/**
 * The home-stats snapshot answers with `messages` only, so its local (rollback / dev) answer is a
 * plain COUNT(*): the distinct-chatter scan `siteStats()` runs is a full scan this synchronous peek
 * would otherwise force on every home-stats compute. In chat mode it answers Chat's cached value.
 */
function localSiteStatsMessages() {
    const db = local();
    const r = db.get('SELECT COUNT(*) AS messages FROM chat_messages WHERE is_deleted = 0') || {};
    return { messages: Number(r.messages) || 0 };
}
function siteStatsPeek() { return peek('site', remoteSiteStats, localSiteStatsMessages); }

/** The busiest chatters of a room (or the site, when neither stream nor channel is given), newest window first. */
function topChatters({ since, streamId, channelUserId, limit = 10 } = {}) {
    const key = `top:${since || 0}:${streamId || 0}:${channelUserId || 0}:${limit}`;
    return load(key, async () => {
        const out = await client.readStats({ kind: 'channel-top', since, stream_id: streamId, channel_user_id: channelUserId, limit });
        if (!out || !Array.isArray(out.top_chatters)) throw unavailable('top chatters');
        return out.top_chatters;
    }, () => {
        const db = local();
        const where = ['c.is_deleted = 0', "c.message_type <> 'system'", 'COALESCE(u.is_banned, 0) = 0'];
        const params = [];
        if (since) { where.push('c.timestamp >= ?'); params.push(new Date(since).toISOString().slice(0, 19).replace('T', ' ')); }
        if (streamId) { where.push('c.stream_id = ?'); params.push(streamId); }
        if (channelUserId) { where.push('c.channel_user_id = ?'); params.push(channelUserId); }
        params.push(limit);
        return db.all(`SELECT c.user_id, MAX(c.username) AS username, u.display_name, u.avatar_url, u.profile_color, COUNT(*) AS count
            FROM chat_messages c LEFT JOIN users u ON u.id = c.user_id
            WHERE ${where.join(' AND ')}
            GROUP BY c.user_id, CASE WHEN c.user_id IS NULL THEN c.username END
            ORDER BY count DESC LIMIT ?`, params) || [];
    });
}

// ── Stats over a window / one room ───────────────────────────────────────────
// Chat's stats read takes since/until plus at most one of stream_id / channel_user_id and answers
// { messages, chatters } for that window (kind 'stream' also answers the soundboard count). The
// home-stats snapshot and the digest ask site-wide, the recap and stream analytics ask per stream,
// the star picker per channel. The local (rollback / dev) answer is the same SQL Live's own chat
// runs; a peek answers the last good value while Chat refreshes in the background.
function localWindowStats({ since, until, streamId, channelUserId } = {}) {
    const db = local();
    const where = ['is_deleted = 0'];
    const params = [];
    if (since != null) { where.push('timestamp >= ?'); params.push(sqlTime(since)); }
    if (until != null) { where.push('timestamp < ?'); params.push(sqlTime(until)); }
    if (streamId != null) { where.push('stream_id = ?'); params.push(Number(streamId)); }
    if (channelUserId != null) { where.push('channel_user_id = ?'); params.push(Number(channelUserId)); }
    const r = db.get(`SELECT COUNT(*) AS messages,
        COUNT(DISTINCT COALESCE('u:' || user_id, 'a:' || anon_id, source_platform || ':' || username)) AS chatters
        FROM chat_messages WHERE ${where.join(' AND ')}`, params) || {};
    return { messages: Number(r.messages) || 0, chatters: Number(r.chatters) || 0 };
}
async function remoteWindowStats({ since, until, streamId, channelUserId } = {}) {
    const out = await client.readStats({ kind: 'site', since, until, stream_id: streamId, channel_user_id: channelUserId });
    if (!out) throw unavailable('window stats');
    return { messages: Number(out.messages) || 0, chatters: Number(out.chatters) || 0 };
}
const windowKey = (o) => `win:${o.since || 0}:${o.until || 0}:${o.streamId || 0}:${o.channelUserId || 0}`;
/** Message/chatter counts over [since, until), site-wide or scoped to one stream/channel (async). */
function windowStats(o = {}) {
    return load(windowKey(o), () => remoteWindowStats(o), () => localWindowStats(o))
        .then((v) => v || safeLocal(() => localWindowStats(o), { messages: 0, chatters: 0 }));
}
/** The same, for a caller that cannot await (the home-stats snapshot, the digest). */
function windowStatsPeek(o = {}) {
    const v = peek(windowKey(o), () => remoteWindowStats(o), () => localWindowStats(o));
    if (v) return v;
    return safeLocal(() => localWindowStats(o), null);
}

function localStreamStats(streamId) {
    const db = local();
    const r = db.get(`SELECT COUNT(*) AS messages,
        COUNT(DISTINCT COALESCE(user_id, anon_id, username)) AS chatters,
        SUM(CASE WHEN message_type = 'soundboard' THEN 1 ELSE 0 END) AS sounds
        FROM chat_messages WHERE stream_id = ? AND COALESCE(is_deleted, 0) = 0`, [Number(streamId)]) || {};
    return { messages: Number(r.messages) || 0, chatters: Number(r.chatters) || 0, sounds: Number(r.sounds) || 0 };
}
async function remoteStreamStats(streamId) {
    const out = await client.readStats({ kind: 'stream', stream_id: Number(streamId) });
    if (!out) throw unavailable('stream stats');
    return { messages: Number(out.messages) || 0, chatters: Number(out.chatters) || 0, sounds: Number(out.sounds) || 0 };
}
/** One stream's chat totals: { messages, chatters, sounds } (the recap, stream analytics). */
function streamStats(streamId) {
    const id = Number(streamId) || 0;
    if (!id) return Promise.resolve({ messages: 0, chatters: 0, sounds: 0 });
    return load(`st:${id}`, () => remoteStreamStats(id), () => localStreamStats(id))
        .then((v) => v || safeLocal(() => localStreamStats(id), { messages: 0, chatters: 0, sounds: 0 }));
}
/** The same, for a caller that cannot await (stream analytics run at stream end). */
function streamStatsPeek(streamId) {
    const id = Number(streamId) || 0;
    if (!id) return { messages: 0, chatters: 0, sounds: 0 };
    const v = peek(`st:${id}`, () => remoteStreamStats(id), () => localStreamStats(id));
    if (v) return v;
    return safeLocal(() => localStreamStats(id), { messages: 0, chatters: 0, sounds: 0 });
}

async function remoteChannelMaxId(channelUserId) {
    const out = await client.readMessages({ channel_user_id: channelUserId, tail: true });
    if (!out) throw unavailable('channel max id');
    return Number(out.max_id) || 0;
}
/**
 * The newest chat id in a channel — Chat's id, so the AI context delta (channelMessagesPeek reads
 * Chat's ids) stays aligned. `channelMaxId` awaits Chat (and warms the peek); `channelMaxIdPeek` is
 * for the caller that cannot await and answers the last good id, else Live's own table.
 */
function channelMaxId(channelUserId) {
    const id = Number(channelUserId) || 0;
    if (!id) return Promise.resolve(0);
    return load(`cmid:${id}`, () => remoteChannelMaxId(id), () => local().getMaxChatMessageIdForChannel(id))
        .then((v) => (v != null ? Number(v) || 0 : safeLocal(() => local().getMaxChatMessageIdForChannel(id), 0)));
}
function channelMaxIdPeek(channelUserId) {
    const id = Number(channelUserId) || 0;
    if (!id) return 0;
    const v = peek(`cmid:${id}`, () => remoteChannelMaxId(id), () => local().getMaxChatMessageIdForChannel(id));
    if (v != null) return Number(v) || 0;
    return safeLocal(() => local().getMaxChatMessageIdForChannel(id), 0);
}

function localUserMessageCount(userId) {
    const r = local().get(`SELECT COUNT(*) AS c FROM chat_messages
        WHERE user_id = ? AND is_deleted = 0
          AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)`, [Number(userId)]);
    return Number(r && r.c) || 0;
}
async function remoteUserMessageCount(userId) {
    const out = await client.readStats({ kind: 'user', user_id: Number(userId) });
    if (!out) throw unavailable('user message count');
    return Number(out.messages) || 0;
}
/** A user's non-deleted chat total, for a caller that cannot await (the profile card). */
function userMessageCountPeek(userId) {
    const id = Number(userId) || 0;
    if (!id) return 0;
    const v = peek(`um:${id}`, () => remoteUserMessageCount(id), () => localUserMessageCount(id));
    if (v != null) return Number(v) || 0;
    return safeLocal(() => localUserMessageCount(id), 0);
}

// ── Messages / history ────────────────────────────────────────────────────────
/**
 * The admin console's chat search: { messages, total }. Chat's message read takes exactly one
 * exact filter, so the first of user/anon/stream/username that is given is the one asked for and
 * the rest are applied as a local post-filter. A username is matched EXACTLY (Chat's filter; it
 * used to be a substring) — searching "bob" finds bob, not bob2. Chat offers no free-text search,
 * so a search with only `query` answers 501 with a clear message rather than an empty page.
 *
 * A `query` combined with a filter is a local post-filter (case-insensitive `includes`) over the
 * newest `limit + offset` rows Chat returned, not a scan of the whole table: a match older than
 * that window is missed. (Full text search lands when Chat offers it.)
 */
function searchMessages({ query = '', userId = null, anonId = null, username = null, streamId = null, limit = 50, offset = 0 } = {}) {
    const key = `search:${userId || ''}:${anonId || ''}:${username || ''}:${streamId || ''}:${query}:${limit}:${offset}`;
    return load(key, async () => {
        if (query && !userId && !anonId && !username && !streamId) {
            throw unsupported('Text search is not available while OpenVibe.Chat serves chat — search by user id, anon id, stream id, or an exact username.');
        }
        const filter = userId ? { user_id: Number(userId) }
            : anonId ? { anon_id: String(anonId) }
                : streamId ? { stream_id: Number(streamId) }
                    : { username: String(username) };
        const out = await client.readMessages({ ...filter, limit: Math.min(500, limit + offset) });
        if (!out || !Array.isArray(out.messages)) throw unavailable('message search');
        let rows = out.messages;
        if (userId) rows = rows.filter((m) => Number(m.user_id) === Number(userId));
        if (streamId) rows = rows.filter((m) => Number(m.stream_id) === Number(streamId));
        if (anonId) rows = rows.filter((m) => String(m.anon_id) === String(anonId));
        if (username) rows = rows.filter((m) => String(m.username || '').toLowerCase() === String(username).toLowerCase());
        if (query) { const q = String(query).toLowerCase(); rows = rows.filter((m) => String(m.message || '').toLowerCase().includes(q)); }
        const page = offset ? rows.slice(offset, offset + limit) : rows.slice(0, limit);
        return { messages: page, total: rows.length + offset };
    }, () => local().searchChatMessages({ query, userId, anonId, username, streamId, limit, offset }), { strict: true });
}

/** One message by id (the moderation delete path checks the row it is about). Live, never cached. */
function messageById(id) {
    if (!(Number(id) > 0)) return Promise.resolve(null);
    return load(`m:${id}`, async () => {
        const out = await client.readMessages({ id: Number(id) });
        if (!out || !Array.isArray(out.messages)) throw unavailable('message');
        return out.messages[0] || null;
    }, () => local().getChatMessageById(Number(id)) || null, { ttl: 0, strict: true });
}

/** Newest `limit` messages of a channel, oldest→newest (the AI persona's chat delta reads the cache). */
function channelMessages(channelUserId, limit = 40) {
    const id = Number(channelUserId) || 0;
    if (!id) return Promise.resolve([]);
    const key = `ch:${id}:${limit}`;
    return load(key, async () => {
        const out = await client.readMessages({ channel_user_id: id, limit, types: ['chat', 'donation'] });
        if (!out || !Array.isArray(out.messages)) throw unavailable('channel messages');
        return out.messages.slice().reverse();   // Chat answers newest-first; the caller wants oldest-first
    }, () => local().getChannelChatSince(id, 0, limit) || []);
}
function channelMessagesPeek(channelUserId, limit = 40) {
    const id = Number(channelUserId) || 0;
    if (!id) return [];
    return peek(`ch:${id}:${limit}`, async () => {
        const out = await client.readMessages({ channel_user_id: id, limit, types: ['chat', 'donation'] });
        if (!out || !Array.isArray(out.messages)) throw unavailable('channel messages');
        return out.messages.slice().reverse();
    }, () => local().getChannelChatSince(id, 0, limit) || []) || [];
}

/** A user's chat history page (admin console): { messages, total }. */
function userHistory(userId, { limit = 50, offset = 0 } = {}) {
    const id = Number(userId) || 0;
    if (!id) return Promise.resolve({ messages: [], total: 0 });
    const key = `uh:${id}:${limit}:${offset}`;
    return load(key, async () => {
        const want = Math.min(500, limit + offset);
        const out = await client.readMessages({ user_id: id, limit: want });
        if (!out || !Array.isArray(out.messages)) throw unavailable('user history');
        const rows = offset ? out.messages.slice(offset, offset + limit) : out.messages.slice(0, limit);
        // Chat's read API answers a page, not a count; a lower bound keeps "load more" honest.
        return { messages: rows, total: rows.length + offset };
    }, () => local().getUserChatHistory(id, limit, offset), { strict: true });
}

// A relay row's username is stored prefixed: "[Label] name". The labels are the ones the relay
// services write (PLATFORM_LABELS in chat-relay-service.js, "[RS] " in robotstreamer-service.js).
const RELAY_LABELS = { twitch: 'Twitch', kick: 'Kick', youtube: 'YT', rs: 'RS' };
function relayUsername(platform, username) {
    const label = RELAY_LABELS[String(platform || '').toLowerCase()] || platform;
    return `[${label}] ${username}`;
}

/** A relayed (external-platform) chatter's history page: { messages, total }. */
function relayHistory(platform, username, { limit = 50, offset = 0, query = '' } = {}) {
    if (!platform || !username) return Promise.resolve({ messages: [], total: 0 });
    const key = `rh:${platform}:${username}:${limit}:${offset}:${query}`;
    return load(key, async () => {
        if (query) throw unsupported('Text search over relay history is not available while OpenVibe.Chat serves chat.');
        const out = await client.readMessages({ username: relayUsername(platform, username), limit: Math.min(500, limit + offset) });
        if (!out || !Array.isArray(out.messages)) throw unavailable('relay history');
        const rows = out.messages.filter((m) => (m.source_platform || '') === String(platform).toLowerCase());
        const page = offset ? rows.slice(offset, offset + limit) : rows.slice(0, limit);
        return { messages: page, total: rows.length + offset };
    }, () => local().getRelayUserChatHistory(platform, username, { limit, offset, query }));
}

/** A chatter's recent messages in ONE channel (an AI-viewer clone source); relay matches by handle. */
function channelSamples(channelUserId, { userId = null, relay = null, limit = 30 } = {}) {
    const key = `cs:${channelUserId}:${userId || ''}:${relay ? `${relay.platform}:${relay.rawUsername}` : ''}:${limit}`;
    return load(key, async () => {
        // Chat's message read takes exactly one filter. Chat owns the relay flag (source_platform),
        // so a relay sample is by the exact stored username and re-filtered to the platform here.
        if (relay) {
            const out = await client.readMessages({ username: relayUsername(relay.platform, relay.rawUsername), limit: Math.min(500, limit * 4) });
            if (!out || !Array.isArray(out.messages)) throw unavailable('channel samples');
            return out.messages.filter((m) => (m.source_platform || '') === String(relay.platform).toLowerCase() && Number(m.channel_user_id) === Number(channelUserId)).slice(0, limit);
        }
        const out = await client.readMessages({ user_id: Number(userId), limit: Math.min(500, limit * 4) });
        if (!out || !Array.isArray(out.messages)) throw unavailable('channel samples');
        return out.messages.filter((m) => Number(m.channel_user_id) === Number(channelUserId)).slice(0, limit);
    }, () => local().getChatSamplesInChannel(channelUserId, { userId, relay, limit }));
}

/** A channel's chat volume over the last `windowSec`, in `bucketSec` buckets: [{ count, tsEpoch }]. */
function liveChatBuckets(streamId, windowSec = 150, bucketSec = 15) {
    const id = Number(streamId) || 0;
    if (!id) return Promise.resolve([]);
    const key = `lcb:${id}:${windowSec}:${bucketSec}`;
    return load(key, async () => {
        const since = Date.now() - windowSec * 1000;
        const out = await client.readTimeline({ stream_id: id, since, bucket_ms: bucketSec * 1000 });
        if (!out || !Array.isArray(out.buckets)) throw unavailable('timeline');
        return out.buckets.map((b) => ({ count: Number(b.count) || 0, tsEpoch: Math.round(Number(b.t) / 1000) }));
    }, () => local().getLiveChatBuckets(id, windowSec, bucketSec) || []);
}

/** The message texts of a stream in the last `sinceSec` seconds (AI clip confirmation), oldest→newest. */
function recentChatText(streamId, sinceSec = 120, limit = 40) {
    const id = Number(streamId) || 0;
    if (!id) return Promise.resolve([]);
    const key = `rct:${id}:${sinceSec}:${limit}`;
    return load(key, async () => {
        const out = await client.readMessages({ stream_id: id, limit });
        if (!out || !Array.isArray(out.messages)) throw unavailable('recent messages');
        const floor = Date.now() - Math.max(1, sinceSec) * 1000;
        return out.messages
            .filter((m) => m.message && Date.parse(String(m.timestamp).replace(' ', 'T') + 'Z') >= floor)
            .map((m) => String(m.message))
            .reverse();
    }, () => local().getRecentChatText(id, sinceSec, limit) || []);
}

/** The busiest `bucketSec` time-buckets of a stream, as offsets from `sinceMs`: [{ offset, count }]. */
function spikeOffsets(streamId, bucketSec = 30, topN = 8, sinceMs) {
    const id = Number(streamId) || 0;
    if (!id) return Promise.resolve([]);
    const key = `sp:${id}:${bucketSec}:${topN}:${sinceMs || 0}`;
    return load(key, async () => {
        const out = await client.readTimeline({ stream_id: id, since: sinceMs || 0, bucket_ms: bucketSec * 1000 });
        if (!out || !Array.isArray(out.buckets)) throw unavailable('timeline');
        const base = sinceMs || 0;
        return out.buckets
            .map((b) => ({ offset: Math.max(0, Math.round((Number(b.t) - base) / 1000 / bucketSec) * bucketSec), count: Number(b.count) || 0 }))
            .sort((a, b) => b.count - a.count || a.offset - b.offset)
            .slice(0, topN);
    }, () => local().getChatSpikeOffsets(id, bucketSec, topN) || []);
}

// ── Moderation queues ─────────────────────────────────────────────────────────
// These answer the console's own actions, so they are live (ttl: 0) and strict: a Chat failure is
// a 503, never a stale or empty queue (it could hide a ban the moderator just set).

/** Held IP-approval messages for a channel: [{ … }]. */
function pendingIp(channelId, { limit = 50 } = {}) {
    const id = Number(channelId) || 0;
    if (!id) return Promise.resolve([]);
    const key = `pip:${id}:${limit}`;
    return load(key, async () => {
        const out = await client.readPendingIp({ channel_id: id, limit });
        if (!out || !Array.isArray(out.pending_ip)) throw unavailable('pending IP queue');
        return out.pending_ip;
    }, () => local().getPendingIpMessages(id, { limit }) || [], { ttl: 0, strict: true });
}

/** The hidden relay users of a channel (plus the site-wide rows): [{ … }]. */
function relayUsers(channelId, { limit = 100 } = {}) {
    const id = Number(channelId) || 0;
    const key = `ru:${id}:${limit}`;
    return load(key, async () => {
        const out = await client.readRelayUsers({ channel_id: id || undefined, limit });
        if (!out || !Array.isArray(out.relay_users)) throw unavailable('hidden relay users');
        return out.relay_users;
    }, () => local().getHiddenRelayUsers(id, { limit }) || [], { ttl: 0, strict: true });
}

/** One hidden relay user by id: { id, channel_id, … } | null. */
function relayUser(id) {
    const rid = Number(id) || 0;
    if (!rid) return Promise.resolve(null);
    return load(`r1:${rid}`, async () => {
        const out = await client.readRelayUser(rid);
        if (!out) throw unavailable('hidden relay user');
        return out.relay_user || null;
    }, () => {
        const r = local().get('SELECT id, channel_id FROM hidden_relay_users WHERE id = ?', [rid]);
        return r || null;
    }, { ttl: 0, strict: true });
}

/**
 * Is this relay identity hidden (banned) in this channel or site-wide? Synchronous: the relay
 * path can carry a message per second and must not wait on an HTTP call.
 *
 * In chat mode a fresh Chat list is the authority (a cached peek, at most CACHE_TTL_MS old), so a
 * hide or unhide takes effect on the next message. Until Chat has answered (cold cache) or while it
 * is unreachable, Live's own table answers: fail OPEN, never drop a relayed line on a Chat outage.
 */
function isRelayUserHidden(channelId, platform, username) {
    if (!remote()) {
        try { return !!local().isRelayUserHidden(channelId, platform, username); } catch { return false; }
    }
    // Chat owns hidden_relay_users, so a fresh Chat list is the authority: a hide Live's mirror has
    // not applied yet (or an unhide it has not removed yet) must not win. Live's own table answers only
    // when Chat has no fresh list, and then it fails OPEN — never drop a relayed line on a Chat outage.
    const key = `hru:${Number(channelId) || 0}`;
    const hit = fresh(key);
    if (hit && Array.isArray(hit.value)) {
        return hit.value.some((r) => String(r.platform) === String(platform) && String(r.external_username) === String(username));
    }
    load(key, async () => {
        const out = await client.readRelayUsers({ channel_id: Number(channelId) || undefined, limit: 500 });
        if (!out || !Array.isArray(out.relay_users)) throw unavailable('hidden relay users');
        return out.relay_users;
    }, () => []).catch(() => { /* warms the cache for the next check */ });
    try { return !!local().isRelayUserHidden(channelId, platform, username); } catch { return false; }
}

/** A user's TTS voice override: { voice, pitch, speed, gap } | null. Live, never cached. */
function ttsOverride(identityKey) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return Promise.resolve(null);
    return load(`tts:${k}`, async () => {
        const out = await client.readTtsOverride({ identity_key: k });
        if (!out) throw unavailable('tts override');
        return out.tts_override || null;
    }, () => local().getTtsVoiceOverride(k), { ttl: 0, strict: true });
}
/**
 * The TTS engine's synchronous read: the last good override while Chat refreshes in the background.
 * On a cache miss or a Chat failure it answers Live's own mirror table (which Chat keeps current),
 * so the first line after a restart, an eviction or during a Chat outage is still spoken with the
 * override rather than the auto voice — the same fallback `isRelayUserHidden` uses.
 */
function ttsOverridePeek(identityKey) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return null;
    const localOverride = () => local().getTtsVoiceOverride(k);
    const got = peek(`ttsp:${k}`, async () => {
        const out = await client.readTtsOverride({ identity_key: k });
        if (!out) throw unavailable('tts override');
        return out.tts_override || null;
    }, localOverride);
    if (got) return got;
    if (!remote()) return null;   // peek already answered from Live's own table
    try { return localOverride(); } catch { return null; }
}

// ── Channel sounds ────────────────────────────────────────────────────────────
/** A channel's soundboard count. */
function soundCount(ownerId) {
    const id = Number(ownerId) || 0;
    if (!id) return Promise.resolve(0);
    return load(`sc:${id}`, async () => {
        const out = await client.readSounds({ channel_owner_id: id });
        if (!out || out.count == null) throw unavailable('sound count');
        return Number(out.count);
    }, () => {
        const r = local().get('SELECT COUNT(*) AS count FROM channel_sounds WHERE channel_owner_id = ?', [id]);
        return Number(r && r.count) || 0;
    });
}

/**
 * Channel sounds not yet uploaded to Media (asset-sync's work list), oldest first, paged by id.
 * Never cached: the sync must see the upload it just recorded, or it uploads the same sound twice.
 */
function pendingSounds({ channelOwnerId, afterId, limit = 100 } = {}) {
    const key = `ps:${channelOwnerId || 0}:${afterId || 0}:${limit}`;
    return load(key, async () => {
        const out = await client.readSounds({ pending_asset: true, channel_owner_id: channelOwnerId || undefined, after_id: afterId || undefined, limit });
        if (!out || !Array.isArray(out.sounds)) throw unavailable('pending sounds');
        return out.sounds;
    }, () => {
        const db = local();
        const params = [];
        let sql = 'SELECT * FROM channel_sounds WHERE media_asset_id IS NULL';
        if (channelOwnerId) { sql += ' AND channel_owner_id = ?'; params.push(Number(channelOwnerId)); }
        if (afterId) { sql += ' AND id > ?'; params.push(Number(afterId)); }
        params.push(limit);
        return db.all(`${sql} ORDER BY id LIMIT ?`, params) || [];
    }, { ttl: 0 });
}

/** Record where the asset sync put a channel sound (Chat owns the row; a repeat is a no-op). */
async function recordSoundAsset(id, mediaUrl, mediaAssetId) {
    if (!(Number(id) > 0) || !(Number(mediaAssetId) > 0) || !mediaUrl) return null;
    if (!remote()) {
        try { local().run('UPDATE channel_sounds SET media_url = ?, media_asset_id = ? WHERE id = ?', [mediaUrl, mediaAssetId, id]); return {}; } catch { return null; }
    }
    return client.soundAsset({ id: Number(id), media_url: String(mediaUrl), media_asset_id: Number(mediaAssetId) });
}

/**
 * Drop every cached answer whose key starts with `prefix`. A moderation write (a relay hide or
 * unhide) calls this so the next read re-asks Chat instead of serving the list from before it.
 */
function invalidate(prefix) {
    for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/** Drop every cached answer (tests and env flips). */
function _reset() { cache.clear(); inflight.clear(); lastLog = null; }
/** Test hook: age every cached answer by `ms` (fresh → stale, or stale → dropped when it passes the keep window). */
function _age(ms, prefix = '') { for (const [k, h] of cache) if (k.startsWith(prefix)) h.at -= ms; }
/** Test hooks: the current entry count, and the eviction cap (set to a small value to exercise it). */
function _size() { return cache.size; }
function _cacheMax(n) { if (n != null && Number(n) > 0) cacheMax = Number(n); return cacheMax; }

module.exports = {
    siteStats, siteStatsPeek, topChatters,
    windowStats, windowStatsPeek, streamStats, streamStatsPeek, channelMaxId, channelMaxIdPeek, userMessageCountPeek,
    messageById, channelMessages, channelMessagesPeek, userHistory, relayHistory, channelSamples, searchMessages,
    liveChatBuckets, recentChatText, spikeOffsets,
    pendingIp, relayUsers, relayUser, ttsOverride, ttsOverridePeek, isRelayUserHidden,
    soundCount, pendingSounds, recordSoundAsset, invalidate,
    _reset, _age, _size, _cacheMax, CACHE_TTL_MS, CACHE_KEEP_MS,
};
