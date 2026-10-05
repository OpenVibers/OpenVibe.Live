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
 * line, a peek per tick) into a retry per call. Reads the moderation console acts on (queues, one message, a voice override) are never
 * cached (ttl: 0) and throw a `Chat unavailable` error (`.unavailable`) on a Chat failure, so those
 * routes answer 503 instead of stale or empty queue data. Off under LIVE_DRILL.
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
let lastLog = null;

function drill() { try { return require('../drill').enabled; } catch { return false; } }
function remote() { return isRemote() && !drill(); }
function local() { return require('../db/database'); }

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
function remember(key, value) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 2000) {
        for (const [k, h] of cache) if (Date.now() - h.at >= CACHE_KEEP_MS) cache.delete(k);
        while (cache.size > 2000) cache.delete(cache.keys().next().value);
    }
}

/** Record that this key just failed without overwriting its last good value. */
function rememberFailure(key) {
    const h = cache.get(key);
    if (h && !h.failed) { h.failedAt = Date.now(); return; }
    cache.set(key, { at: Date.now(), value: null, failed: true });
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
    if (cooling(key)) {   // a read just failed: answer what we have, don't retry every call
        if (strict) return Promise.reject(unavailable(key));
        const last = kept(key);
        return Promise.resolve(last ? last.value : null);
    }
    if (inflight.has(key)) return inflight.get(key);
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
    inflight.set(key, p);
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
function siteStatsPeek() { return peek('site', remoteSiteStats, localSiteStats); }

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

// ── Messages / history ────────────────────────────────────────────────────────
/**
 * The admin console's chat search: { messages, total }. Chat's message read takes exactly one
 * exact filter, so the first of user/anon/stream/username that is given is the one asked for and
 * the rest are applied as a local post-filter. A username is matched EXACTLY (Chat's filter; it
 * used to be a substring) — searching "bob" finds bob, not bob2. Chat offers no free-text search,
 * so a search with only `query` answers 501 with a clear message rather than an empty page.
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
        if (query) rows = rows.filter((m) => String(m.message || '').includes(query));
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
 * Live's own table answers first — Chat's mirror keeps it current, so a hide takes effect on the
 * very next message. In chat mode Chat's queue (a cached peek, at most CACHE_TTL_MS old) is also
 * consulted. Chat unreachable, or not cached yet, answers from Live's own table: fail OPEN, never
 * drop a relayed line on a Chat outage.
 */
function isRelayUserHidden(channelId, platform, username) {
    let localHidden = false;
    try { localHidden = !!local().isRelayUserHidden(channelId, platform, username); } catch { /* not hidden */ }
    if (localHidden) return true;
    if (!remote()) return false;
    const key = `hru:${Number(channelId) || 0}`;
    const hit = fresh(key);   // only a fresh answer is used: an unhide must not leave an old list in force
    if (hit && Array.isArray(hit.value)) {
        return hit.value.some((r) => String(r.platform) === String(platform) && String(r.external_username) === String(username));
    }
    load(key, async () => {
        const out = await client.readRelayUsers({ channel_id: Number(channelId) || undefined, limit: 500 });
        if (!out || !Array.isArray(out.relay_users)) throw unavailable('hidden relay users');
        return out.relay_users;
    }, () => []).catch(() => { /* warms the cache for the next check */ });
    return false;
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
/** The TTS engine's synchronous read: the last good override while Chat refreshes in the background. */
function ttsOverridePeek(identityKey) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return null;
    return peek(`ttsp:${k}`, async () => {
        const out = await client.readTtsOverride({ identity_key: k });
        if (!out) throw unavailable('tts override');
        return out.tts_override || null;
    }, () => local().getTtsVoiceOverride(k));
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

/** Drop every cached answer (tests and env flips). */
function _reset() { cache.clear(); inflight.clear(); lastLog = null; }
/** Test hook: age every cached answer by `ms` (fresh → stale, or stale → dropped when it passes the keep window). */
function _age(ms, prefix = '') { for (const [k, h] of cache) if (k.startsWith(prefix)) h.at -= ms; }

module.exports = {
    siteStats, siteStatsPeek, topChatters,
    messageById, channelMessages, channelMessagesPeek, userHistory, relayHistory, channelSamples, searchMessages,
    liveChatBuckets, recentChatText, spikeOffsets,
    pendingIp, relayUsers, relayUser, ttsOverride, ttsOverridePeek, isRelayUserHidden,
    soundCount, pendingSounds, recordSoundAsset,
    _reset, _age, CACHE_TTL_MS, CACHE_KEEP_MS,
};
