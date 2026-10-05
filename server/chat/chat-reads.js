'use strict';
/**
 * The chat reads Live's own features still make, answered from OpenVibe.Chat (plan T3 J4b:
 * "Read Live's chat stats, queues and history from Chat"). Chat owns chat_messages, channel_sounds,
 * pending_ip_messages, hidden_relay_users and tts_voice_overrides now, so Live's home stats, recaps,
 * AI context, admin console and mod queues read them through Chat's internal read API
 * (server/chat/chat-client.js) instead of Live's mirror copy of the tables.
 *
 * Mode-aware: when CHAT_AUTHORITY=chat, every answer comes from Chat; otherwise Live runs chat
 * itself and the same call answers from Live's own tables (the rollback / dev path) — the caller
 * never has to know which.
 *
 * Degradation is the presence() rule: a Chat failure answers the cached value, else null (a sync
 * peek returns null and refreshes in the background); a page that only shows stats never 500s.
 * Answers are cached briefly so a burst of readers costs Chat one call. Off under LIVE_DRILL.
 *
 * Callers that can await use the async function; the few that cannot (the AI persona prompt, the
 * home-stats snapshot, the TTS engine) use the matching peek*(), which returns what is cached.
 */
const { isRemote } = require('./chat-authority');
const client = require('./chat-client');

const CACHE_TTL_MS = 15_000;

const cache = new Map();     // key → { at, value }
const inflight = new Map();  // key → Promise
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
function cached(key) { const h = cache.get(key); return h && Date.now() - h.at < CACHE_TTL_MS ? h : null; }
function remember(key, value) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
}

/** Async answer: Chat (remote) or Live's own tables (local), cached; a failure answers null. */
function load(key, remoteFn, localFn) {
    if (!remote()) {
        return Promise.resolve().then(async () => { try { return await localFn(); } catch (err) { note(key, err); return null; } });
    }
    const hit = cached(key);
    if (hit) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        let value = null;
        try { value = await remoteFn(); lastLog = null; remember(key, value); }
        catch (err) { note(key, err); remember(key, null); }
        return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

/** Sync answer for a caller that cannot await: local value now, or the cache / null + a warm-up. */
function peek(key, remoteFn, localFn) {
    if (!remote()) { try { return localFn(); } catch (err) { note(key, err); return null; } }
    const hit = cached(key);
    if (hit) return hit.value;
    load(key, remoteFn, localFn).catch(() => { /* logged in load() */ });   // floating-ok: warms the cache for the next peek
    return null;
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
    return out ? { messages: Number(out.messages) || 0, chatters: Number(out.chatters) || 0 } : null;
}
/** { messages, chatters } across the whole site. */
function siteStats() { return load('site', remoteSiteStats, localSiteStats); }
function siteStatsPeek() { return peek('site', remoteSiteStats, localSiteStats); }

/** The busiest chatters of a room (or the site, when neither stream nor channel is given), newest window first. */
function topChatters({ since, streamId, channelUserId, limit = 10 } = {}) {
    const key = `top:${since || 0}:${streamId || 0}:${channelUserId || 0}:${limit}`;
    return load(key, async () => {
        const out = await client.readStats({ kind: 'channel-top', since, stream_id: streamId, channel_user_id: channelUserId, limit });
        return out && Array.isArray(out.top_chatters) ? out.top_chatters : null;
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
 * the rest are applied as a local post-filter; a free-text `query` is not something Chat's read
 * API offers, so a query-only search degrades to an empty page rather than lie.
 */
function searchMessages({ query = '', userId = null, anonId = null, username = null, streamId = null, limit = 50, offset = 0 } = {}) {
    const key = `search:${userId || ''}:${anonId || ''}:${username || ''}:${streamId || ''}:${query}:${limit}:${offset}`;
    return load(key, async () => {
        if (query && !userId && !anonId && !username && !streamId) return { messages: [], total: 0 };
        const filter = userId ? { user_id: Number(userId) }
            : anonId ? { anon_id: String(anonId) }
                : streamId ? { stream_id: Number(streamId) }
                    : { username: String(username) };
        const out = await client.readMessages({ ...filter, limit: Math.min(500, limit + offset) });
        if (!out || !Array.isArray(out.messages)) return null;
        let rows = out.messages;
        if (userId) rows = rows.filter((m) => Number(m.user_id) === Number(userId));
        if (streamId) rows = rows.filter((m) => Number(m.stream_id) === Number(streamId));
        if (anonId) rows = rows.filter((m) => String(m.anon_id) === String(anonId));
        if (username) rows = rows.filter((m) => String(m.username || '').toLowerCase().includes(String(username).toLowerCase()));
        if (query) rows = rows.filter((m) => String(m.message || '').includes(query));
        const page = offset ? rows.slice(offset, offset + limit) : rows.slice(0, limit);
        return { messages: page, total: rows.length + offset };
    }, () => local().searchChatMessages({ query, userId, anonId, username, streamId, limit, offset }));
}

/** One message by id (the moderation delete path checks the row it is about). */
function messageById(id) {
    if (!(Number(id) > 0)) return Promise.resolve(null);
    return load(`m:${id}`, async () => {
        const out = await client.readMessages({ id: Number(id) });
        return out && Array.isArray(out.messages) ? (out.messages[0] || null) : null;
    }, () => local().getChatMessageById(Number(id)) || null);
}

/** Newest `limit` messages of a channel, oldest→newest (the AI persona's chat delta reads the cache). */
function channelMessages(channelUserId, limit = 40) {
    const id = Number(channelUserId) || 0;
    if (!id) return Promise.resolve([]);
    const key = `ch:${id}:${limit}`;
    return load(key, async () => {
        const out = await client.readMessages({ channel_user_id: id, limit, types: ['chat', 'donation'] });
        const rows = out && Array.isArray(out.messages) ? out.messages : null;
        return rows ? rows.slice().reverse() : null;   // Chat answers newest-first; the caller wants oldest-first
    }, () => local().getChannelChatSince(id, 0, limit) || []);
}
function channelMessagesPeek(channelUserId, limit = 40) {
    const id = Number(channelUserId) || 0;
    if (!id) return [];
    return peek(`ch:${id}:${limit}`, async () => {
        const out = await client.readMessages({ channel_user_id: id, limit, types: ['chat', 'donation'] });
        const rows = out && Array.isArray(out.messages) ? out.messages : null;
        return rows ? rows.slice().reverse() : null;
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
        if (!out || !Array.isArray(out.messages)) return null;
        const rows = offset ? out.messages.slice(offset, offset + limit) : out.messages.slice(0, limit);
        return { messages: rows, total: Number(out.max_id) || rows.length + offset };
    }, () => local().getUserChatHistory(id, limit, offset));
}

/** A relayed (external-platform) chatter's history page: { messages, total }. */
function relayHistory(platform, username, { limit = 50, offset = 0, query = '' } = {}) {
    if (!platform || !username) return Promise.resolve({ messages: [], total: 0 });
    const key = `rh:${platform}:${username}:${limit}:${offset}:${query}`;
    return load(key, async () => {
        if (query) return null;   // Chat's message read has no free-text filter; degrade rather than lie
        const out = await client.readMessages({ username: String(username), limit: Math.min(500, limit + offset) });
        if (!out || !Array.isArray(out.messages)) return null;
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
        // so a relay sample is by exact username and re-filtered to the platform here.
        if (relay) {
            const out = await client.readMessages({ username: String(relay.rawUsername), limit: Math.min(500, limit * 4) });
            if (!out || !Array.isArray(out.messages)) return null;
            return out.messages.filter((m) => (m.source_platform || '') === String(relay.platform).toLowerCase() && Number(m.channel_user_id) === Number(channelUserId)).slice(0, limit);
        }
        const out = await client.readMessages({ user_id: Number(userId), limit: Math.min(500, limit * 4) });
        if (!out || !Array.isArray(out.messages)) return null;
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
        if (!out || !Array.isArray(out.buckets)) return null;
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
        if (!out || !Array.isArray(out.messages)) return null;
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
        if (!out || !Array.isArray(out.buckets)) return null;
        const base = sinceMs || 0;
        return out.buckets
            .map((b) => ({ offset: Math.max(0, Math.round((Number(b.t) - base) / 1000 / bucketSec) * bucketSec), count: Number(b.count) || 0 }))
            .sort((a, b) => b.count - a.count || a.offset - b.offset)
            .slice(0, topN);
    }, () => local().getChatSpikeOffsets(id, bucketSec, topN) || []);
}

// ── Moderation queues ─────────────────────────────────────────────────────────
/** Held IP-approval messages for a channel: [{ … }]. */
function pendingIp(channelId, { limit = 50 } = {}) {
    const id = Number(channelId) || 0;
    if (!id) return Promise.resolve([]);
    const key = `pip:${id}:${limit}`;
    return load(key, async () => {
        const out = await client.readPendingIp({ channel_id: id, limit });
        return out && Array.isArray(out.pending_ip) ? out.pending_ip : null;
    }, () => local().getPendingIpMessages(id, { limit }) || []);
}

/** The hidden relay users of a channel (plus the site-wide rows): [{ … }]. */
function relayUsers(channelId, { limit = 100 } = {}) {
    const id = Number(channelId) || 0;
    const key = `ru:${id}:${limit}`;
    return load(key, async () => {
        const out = await client.readRelayUsers({ channel_id: id || undefined, limit });
        return out && Array.isArray(out.relay_users) ? out.relay_users : null;
    }, () => local().getHiddenRelayUsers(id, { limit }) || []);
}

/** One hidden relay user by id: { id, channel_id, … } | null. */
function relayUser(id) {
    const rid = Number(id) || 0;
    if (!rid) return Promise.resolve(null);
    return load(`r1:${rid}`, async () => {
        const out = await client.readRelayUser(rid);
        return out ? (out.relay_user || null) : null;
    }, () => {
        const r = local().get('SELECT id, channel_id FROM hidden_relay_users WHERE id = ?', [rid]);
        return r || null;
    });
}

/** A user's TTS voice override: { voice, pitch, speed, gap } | null. */
function ttsOverride(identityKey) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return Promise.resolve(null);
    return load(`tts:${k}`, async () => {
        const out = await client.readTtsOverride({ identity_key: k });
        return out ? (out.tts_override || null) : null;
    }, () => local().getTtsVoiceOverride(k));
}
function ttsOverridePeek(identityKey) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return null;
    return peek(`tts:${k}`, async () => {
        const out = await client.readTtsOverride({ identity_key: k });
        return out ? (out.tts_override || null) : null;
    }, () => local().getTtsVoiceOverride(k));
}

// ── Channel sounds ────────────────────────────────────────────────────────────
/** A channel's soundboard count. */
function soundCount(ownerId) {
    const id = Number(ownerId) || 0;
    if (!id) return Promise.resolve(0);
    return load(`sc:${id}`, async () => {
        const out = await client.readSounds({ channel_owner_id: id });
        return out && out.count != null ? Number(out.count) : null;
    }, () => {
        const r = local().get('SELECT COUNT(*) AS count FROM channel_sounds WHERE channel_owner_id = ?', [id]);
        return Number(r && r.count) || 0;
    });
}

/** Channel sounds not yet uploaded to Media (asset-sync's work list), oldest first. */
function pendingSounds({ channelOwnerId, afterId, limit = 100 } = {}) {
    const key = `ps:${channelOwnerId || 0}:${afterId || 0}:${limit}`;
    return load(key, async () => {
        const out = await client.readSounds({ pending_asset: true, channel_owner_id: channelOwnerId || undefined, after_id: afterId || undefined, limit });
        return out && Array.isArray(out.sounds) ? out.sounds : null;
    }, () => local().all('SELECT * FROM channel_sounds WHERE media_asset_id IS NULL ORDER BY id LIMIT ?', [limit]) || []);
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

module.exports = {
    siteStats, siteStatsPeek, topChatters,
    messageById, channelMessages, channelMessagesPeek, userHistory, relayHistory, channelSamples, searchMessages,
    liveChatBuckets, recentChatText, spikeOffsets,
    pendingIp, relayUsers, relayUser, ttsOverride, ttsOverridePeek,
    soundCount, pendingSounds, recordSoundAsset,
    _reset, CACHE_TTL_MS,
};
