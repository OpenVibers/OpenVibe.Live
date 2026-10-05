'use strict';
/**
 * The chat reads Live's own features still make, answered from OpenVibe.Chat (plan T3 J4b:
 * "Read Live's chat stats, queues and history from Chat"). Chat owns chat_messages, channel_sounds,
 * pending_ip_messages, hidden_relay_users, tts_voice_overrides and dm_blocks, so Live's home stats,
 * recaps, AI context, admin console, mod queues and the call-invite gate read them through Chat's
 * internal read API (server/chat/chat-client.js). Live keeps no copy of any of them since 2026-10-05
 * (the read mirror was retired on both sides; the tables themselves are dropped at boot by
 * migration 007_drop_chat_tables), so outside chat mode every one of these answers null / empty.
 *
 * Mode-aware: when CHAT_AUTHORITY=chat, every answer comes from Chat; otherwise (dev, drills) the
 * same call answers null / empty — the caller never has to know which. Unsetting CHAT_AUTHORITY is
 * not a rollback lever: Live runs no chat server any more either way.
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
/** Run a Live-table read for a synchronous caller, answering `dflt` if it throws. Still used for
 *  the non-chat home metrics (users, follows, …), which Live owns. */
function safeLocal(fn, dflt) { try { const v = fn(); return v == null ? dflt : v; } catch { return dflt; } }

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

/** A fresh entry: within its own ttl when it set one (first-chat caches false longer than true), else the default. */
function fresh(key) { const h = cache.get(key); if (!h || h.failed) return null; const ttl = h.ttl != null ? h.ttl : CACHE_TTL_MS; return Date.now() - h.at < ttl ? h : null; }
function kept(key) { const h = cache.get(key); return h && !h.failed && Date.now() - h.at < CACHE_KEEP_MS ? h : null; }
function cooling(key) { const h = cache.get(key); const at = h && (h.failedAt || (h.failed && h.at)); return !!at && Date.now() - at < FAIL_TTL_MS; }
/** Keep the cache bounded: drop entries past the keep window first, then the oldest. */
function evict() {
    if (cache.size <= cacheMax) return;
    for (const [k, h] of cache) if (Date.now() - h.at >= CACHE_KEEP_MS) cache.delete(k);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
}
function remember(key, value, ttl) {
    const h = { at: Date.now(), value };
    if (ttl != null) h.ttl = ttl;
    cache.set(key, h);
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
 * Async answer: Chat when it is the authority, else the (empty) local answer, cached. A failure
 * answers the last good value, else null; with `strict` it throws `Chat unavailable` instead (the
 * moderation console). `ttl: 0` always reads live and never caches. An error carrying a `status` (a
 * deliberate "not supported") is handed to the caller as it is.
 */
function load(key, remoteFn, localFn, { ttl = CACHE_TTL_MS, strict = false, ttlFor = null } = {}) {
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
        if (ttl > 0) remember(key, value, ttlFor ? ttlFor(value) : undefined);
        return value;
    })().finally(() => inflight.delete(key));
    if (ttl > 0) inflight.set(key, p);
    return p;
}

/** Sync answer for a caller that cannot await: fresh value, else the last good value + a background refresh, else null. */
function peek(key, remoteFn, localFn, opts) {
    if (!remote()) { try { return localFn(); } catch (err) { note(key, err); return null; } }
    const hit = fresh(key);
    if (hit) return hit.value;
    load(key, remoteFn, localFn, opts).catch(() => { /* logged in load() */ });   // floating-ok: refreshes for the next peek
    const last = kept(key);
    return last ? last.value : null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
// Live keeps no chat_messages: outside chat mode these reads answer zero/empty. The named local*
// functions stay so load()/peek() keep one shape and the answers are explicit, not absent.
function localSiteStats() { return { messages: 0, chatters: 0 }; }
async function remoteSiteStats() {
    const out = await client.readStats({ kind: 'site' });
    if (!out) throw unavailable('site stats');
    return { messages: Number(out.messages) || 0, chatters: Number(out.chatters) || 0 };
}
/** { messages, chatters } across the whole site. */
function siteStats() { return load('site', remoteSiteStats, localSiteStats); }
/** The home-stats snapshot's shape: outside chat mode there is no count to answer. */
function localSiteStatsMessages() { return { messages: 0 }; }
function siteStatsPeek() { return peek('site', remoteSiteStats, localSiteStatsMessages); }

// ── Home daily series (the hero charts) ──────────────────────────────────────
// Live's home `messages`/`active` charts are Chat's site-wide per-day series. One peek serves the
// whole envelope getHomeStatSeries returns: the per-day counts come from Chat's site-daily read, and
// `before`/`prev_total` keep Live's window-wide semantics (a COUNT / COUNT(DISTINCT) over the whole
// range), so they are Chat's `site` stats over [epoch, window start) and over the window just before
// it. The peek key is coarse (per UTC day) so every compute within a day hits the same cached answer.
const DAY_MS = 86_400_000;
const utcDayStart = (t) => Math.floor(t / DAY_MS) * DAY_MS;
const clampSeriesDays = (days) => Math.max(1, Math.min(365, parseInt(days, 10) || 30));

async function remoteHomeSeries(metric, days) {
    const until = utcDayStart(Date.now()) + DAY_MS;   // exclusive: tomorrow 00:00 UTC
    const since = until - days * DAY_MS;
    const out = await client.readStats({ kind: 'site-daily', since, until });
    if (!out || !Array.isArray(out.days)) throw unavailable('home series');
    const field = metric === 'active' ? 'chatters' : 'messages';
    const byDay = new Map(out.days.map((d) => [String(d.day), Number(d[field]) || 0]));
    const points = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = new Date(until - (i + 1) * DAY_MS).toISOString().slice(0, 10);
        points.push({ day, value: Number((byDay.get(day) || 0).toFixed(2)) });
    }
    const total = Number(points.reduce((a, p) => a + p.value, 0).toFixed(2));
    const [beforeOut, prevOut] = await Promise.all([
        client.readStats({ kind: 'site', until: since }),
        client.readStats({ kind: 'site', since: since - days * DAY_MS, until: since }),
    ]);
    if (!beforeOut || !prevOut) throw unavailable('home series totals');
    const pick = (o) => Number(metric === 'active' ? o.chatters : o.messages) || 0;
    return { metric, kind: 'count', days, points, total, peak: Math.max(0, ...points.map((p) => p.value)), before: pick(beforeOut), prev_total: pick(prevOut) };
}

/**
 * The daily series behind a hero stat, from Chat (remote) or Live's own tables (local), cached.
 * Only the two chat metrics come through here; outside chat mode they answer null (Live keeps no
 * chat_messages — homeSeriesLocal has no entry for them).
 */
function homeSeries(metric, days) {
    const d = clampSeriesDays(days);
    const key = `hs:${metric}:${d}:${utcDayStart(Date.now())}`;
    const localFn = () => local().homeSeriesLocal(metric, d);
    return load(key, () => remoteHomeSeries(metric, d), localFn).then((v) => v || safeLocal(localFn, null));
}
/**
 * The same for the synchronous home-stats series route: the last good answer while Chat refreshes
 * in the background — never zeros just because Chat has not answered yet. Outside chat mode there
 * is nothing to answer from: null.
 */
function homeSeriesPeek(metric, days) {
    const d = clampSeriesDays(days);
    const key = `hs:${metric}:${d}:${utcDayStart(Date.now())}`;
    const localFn = () => local().homeSeriesLocal(metric, d);
    const v = peek(key, () => remoteHomeSeries(metric, d), localFn);
    if (v) return v;
    if (!remote()) return null;          // outside chat mode Live keeps no chat series
    return safeLocal(localFn, null);     // cold / Chat unreachable
}

/** The busiest chatters of a room (or the site, when neither stream nor channel is given), newest window first. */
function topChatters({ since, streamId, channelUserId, limit = 10 } = {}) {
    const key = `top:${since || 0}:${streamId || 0}:${channelUserId || 0}:${limit}`;
    return load(key, async () => {
        const out = await client.readStats({ kind: 'channel-top', since, stream_id: streamId, channel_user_id: channelUserId, limit });
        if (!out || !Array.isArray(out.top_chatters)) throw unavailable('top chatters');
        return out.top_chatters;
    }, () => []);
}

// ── Stats over a window / one room ───────────────────────────────────────────
// Chat's stats read takes since/until plus at most one of stream_id / channel_user_id and answers
// { messages, chatters } for that window (kind 'stream' also answers the soundboard count). The
// home-stats snapshot and the digest ask site-wide, the recap and stream analytics ask per stream,
// the star picker per channel. Outside chat mode the answer is zero (Live keeps no chat table); a
// peek answers the last good value while Chat refreshes in the background.
function localWindowStats() { return { messages: 0, chatters: 0 }; }
async function remoteWindowStats({ since, until, streamId, channelUserId } = {}) {
    const out = await client.readStats({ kind: 'site', since, until, stream_id: streamId, channel_user_id: channelUserId });
    if (!out) throw unavailable('window stats');
    return { messages: Number(out.messages) || 0, chatters: Number(out.chatters) || 0 };
}
const MIN_BUCKET_MS = 60_000;              // sub-day windows snap to the minute
const HOUR_BUCKET_MS = 60 * 60_000;        // a 7/14/30-day window snaps to the hour
/**
 * Snap a window's since/until to a stable bucket BEFORE both the cache key and the request use them.
 * Callers build these from Date.now(), which changes on every compute, so an exact key is cold on
 * every call: Chat is never actually consulted (the peek answers a stale value instead), each call
 * mints a new cache entry, and the request it sends is thrown away. A minute — or an hour once the
 * window spans a day or more — is far finer than these coarse counts need and keeps the key stable
 * well past CACHE_TTL_MS. The request is sent with the bucketed values so it matches its own key.
 */
function bucketWindow({ since, until, streamId, channelUserId } = {}) {
    const span = (until != null ? Number(until) : Date.now()) - (since != null ? Number(since) : 0);
    const g = span >= 24 * 60 * 60_000 ? HOUR_BUCKET_MS : MIN_BUCKET_MS;
    const snap = (t) => (t == null ? undefined : Math.floor(Number(t) / g) * g);
    return { since: snap(since), until: snap(until), streamId, channelUserId };
}
const windowKey = (o) => `win:${o.since || 0}:${o.until || 0}:${o.streamId || 0}:${o.channelUserId || 0}`;
/** Message/chatter counts over [since, until), site-wide or scoped to one stream/channel (async). */
function windowStats(o = {}) {
    const b = bucketWindow(o);
    return load(windowKey(b), () => remoteWindowStats(b), () => localWindowStats(b))
        .then((v) => v || safeLocal(() => localWindowStats(b), { messages: 0, chatters: 0 }));
}
/**
 * The same, for a caller that cannot await (the home-stats snapshot, the digest). Answers the last
 * good value, else null — never a synchronous local scan, so the hero never presents a local
 * count as Chat's; the caller decides what an unknown window means.
 */
function windowStatsPeek(o = {}) {
    const b = bucketWindow(o);
    return peek(windowKey(b), () => remoteWindowStats(b), () => localWindowStats(b));
}

function localStreamStats() { return { messages: 0, chatters: 0, sounds: 0 }; }
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
/** The same, for a caller that cannot await. */
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
 * for the caller that cannot await and answers the last good id, else 0 (Live keeps no table).
 */
function channelMaxId(channelUserId) {
    const id = Number(channelUserId) || 0;
    if (!id) return Promise.resolve(0);
    return load(`cmid:${id}`, () => remoteChannelMaxId(id), () => 0)
        .then((v) => (v != null ? Number(v) || 0 : 0));
}
function channelMaxIdPeek(channelUserId) {
    const id = Number(channelUserId) || 0;
    if (!id) return 0;
    const v = peek(`cmid:${id}`, () => remoteChannelMaxId(id), () => 0);
    return v != null ? Number(v) || 0 : 0;
}

function localUserMessageCount() { return 0; }
async function remoteUserMessageCount(userId) {
    const out = await client.readStats({ kind: 'user', user_id: Number(userId) });
    if (!out) throw unavailable('user message count');
    return Number(out.messages) || 0;
}
/**
 * A user's non-deleted chat total, for a caller that cannot await (the profile card). Answers the
 * last good value, else null when Chat did not answer — the card omits the count then rather than
 * presenting a cold zero as real.
 */
function userMessageCountPeek(userId) {
    const id = Number(userId) || 0;
    if (!id) return null;
    const v = peek(`um:${id}`, () => remoteUserMessageCount(id), () => localUserMessageCount(id));
    return v == null ? null : Number(v) || 0;
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
    }, () => ({ messages: [], total: 0 }), { strict: true });
}

/** One message by id (the moderation delete path checks the row it is about). Live, never cached. */
function messageById(id) {
    if (!(Number(id) > 0)) return Promise.resolve(null);
    return load(`m:${id}`, async () => {
        const out = await client.readMessages({ id: Number(id) });
        if (!out || !Array.isArray(out.messages)) throw unavailable('message');
        return out.messages[0] || null;
    }, () => null, { ttl: 0, strict: true });
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
    }, () => []);
}
function channelMessagesPeek(channelUserId, limit = 40) {
    const id = Number(channelUserId) || 0;
    if (!id) return [];
    return peek(`ch:${id}:${limit}`, async () => {
        const out = await client.readMessages({ channel_user_id: id, limit, types: ['chat', 'donation'] });
        if (!out || !Array.isArray(out.messages)) throw unavailable('channel messages');
        return out.messages.slice().reverse();
    }, () => []) || [];
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
    }, () => ({ messages: [], total: 0 }), { strict: true });
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
    }, () => ({ messages: [], total: 0 }));
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
    }, () => []);
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
    }, () => []);
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
    }, () => []);
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
    }, () => []);
}

// ── First chat (the welcome check) ───────────────────────────────────────────
// Chat owns stream_first_chats; the AI context's "first time chatting here" flag and the relay
// welcome ask Chat's first-chat read. A false answer (they have chatted here) is stable and cached
// longer; a true answer flips the moment they chat, so it is cached only briefly. The sync caller
// uses firstChatPeek. A cold cache or a Chat outage answers false — Live keeps no copy of the table.
const FIRST_CHAT_TTL_FALSE = 5 * 60_000;   // has chatted here: stable
const FIRST_CHAT_TTL_TRUE = CACHE_TTL_MS;  // first time: flips as soon as they chat

function firstChatLocal() { return false; }
function firstChatRemote(channelUserId, identity) {
    return async () => {
        const out = await client.readFirstChat({ channel_id: channelUserId, identity });
        if (!out || typeof out.first !== 'boolean') throw unavailable('first-chat');
        return out.first;
    };
}
/** Has this identity (`user:<id>` | `anon:<anonId>` | `ext:<prefixed username>`) ever chatted here? */
function firstChat(channelUserId, identity) {
    const channelId = Number(channelUserId) || 0;
    const key = String(identity || '');
    if (!channelId || !key) return Promise.resolve(false);
    return load(`fc:${channelId}:${key}`, firstChatRemote(channelId, key), () => firstChatLocal(), {
        ttl: FIRST_CHAT_TTL_TRUE, ttlFor: (v) => (v === false ? FIRST_CHAT_TTL_FALSE : FIRST_CHAT_TTL_TRUE),
    }).then((v) => {
        if (v === true || v === false) return v;
        return false;   // Chat unreachable: not first (Live keeps no stream_first_chats)
    });
}
/** The synchronous form (the AI persona prompt): the cached Chat answer, else false. */
function firstChatPeek(channelUserId, identity) {
    const channelId = Number(channelUserId) || 0;
    const key = String(identity || '');
    if (!channelId || !key) return false;
    const v = peek(`fc:${channelId}:${key}`, firstChatRemote(channelId, key), () => firstChatLocal(), {
        ttl: FIRST_CHAT_TTL_TRUE, ttlFor: (x) => (x === false ? FIRST_CHAT_TTL_FALSE : FIRST_CHAT_TTL_TRUE),
    });
    if (v === true || v === false) return v;
    return false;   // Chat unreachable: not first (Live keeps no stream_first_chats)
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
    }, () => [], { ttl: 0, strict: true });
}

/** The hidden relay users of a channel (plus the site-wide rows): [{ … }]. */
function relayUsers(channelId, { limit = 100 } = {}) {
    const id = Number(channelId) || 0;
    const key = `ru:${id}:${limit}`;
    return load(key, async () => {
        const out = await client.readRelayUsers({ channel_id: id || undefined, limit });
        if (!out || !Array.isArray(out.relay_users)) throw unavailable('hidden relay users');
        return out.relay_users;
    }, () => [], { ttl: 0, strict: true });
}

/** One hidden relay user by id: { id, channel_id, … } | null. */
function relayUser(id) {
    const rid = Number(id) || 0;
    if (!rid) return Promise.resolve(null);
    return load(`r1:${rid}`, async () => {
        const out = await client.readRelayUser(rid);
        if (!out) throw unavailable('hidden relay user');
        return out.relay_user || null;
    }, () => null, { ttl: 0, strict: true });
}

/**
 * Is this relay identity hidden (banned) in this channel or site-wide? Synchronous: the relay
 * path can carry a message per second and must not wait on an HTTP call.
 *
 * Chat owns hidden_relay_users, so Chat's list is the only truth: the fresh answer when there is
 * one, else the last good list while a refresh runs in the background. A cold cache (Chat has never
 * answered) fails OPEN — never drop a relayed line on a Chat outage. A Live-route hide/unhide
 * invalidates the cached list, so the next check re-asks Chat. Outside chat mode: false.
 */
function isRelayUserHidden(channelId, platform, username) {
    if (!remote()) return false;   // Live keeps no hidden_relay_users
    const key = `hru:${Number(channelId) || 0}`;
    const matches = (list) => list.some((r) => String(r.platform) === String(platform) && String(r.external_username) === String(username));
    const read = async () => {
        const out = await client.readRelayUsers({ channel_id: Number(channelId) || undefined, limit: 500 });
        if (!out || !Array.isArray(out.relay_users)) throw unavailable('hidden relay users');
        return out.relay_users;
    };
    const hit = fresh(key);
    if (hit && Array.isArray(hit.value)) return matches(hit.value);
    const last = kept(key);
    if (last && Array.isArray(last.value)) {
        load(key, read, () => []).catch(() => { /* refresh for the next check */ });
        return matches(last.value);   // the last good list, while the refresh runs
    }
    load(key, read, () => []).catch(() => { /* warms the cache for the next check */ });
    return false;                     // never answered: fail open
}

/** A user's TTS voice override: { voice, pitch, speed, gap } | null. Live, never cached. */
function ttsOverride(identityKey) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return Promise.resolve(null);
    return load(`tts:${k}`, async () => {
        const out = await client.readTtsOverride({ identity_key: k });
        if (!out) throw unavailable('tts override');
        return out.tts_override || null;
    }, () => null, { ttl: 0, strict: true });
}
/**
 * The TTS engine's synchronous read: the last good override while Chat refreshes in the background.
 * A cache miss or a Chat failure answers null (the auto voice) — Live keeps no copy of the table.
 */
function ttsOverridePeek(identityKey) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return null;
    return peek(`ttsp:${k}`, async () => {
        const out = await client.readTtsOverride({ identity_key: k });
        if (!out) throw unavailable('tts override');
        return out.tts_override || null;
    }, () => null);
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
    }, () => 0);
}

const normalizeCommand = (command) => String(command || '').trim().toLowerCase().replace(/^!+/, '');
async function remoteSoundByCommand(ownerId, command) {
    const out = await client.readSoundByCommand({ channel_id: ownerId, command });
    if (out == null) throw unavailable('sound by command');   // unreachable: keep the last good answer
    return out.sound || false;                                 // the sound, or Chat's definitive none
}
/** The approved sound a !command plays (or null). Chat owns the row; Live keeps no copy. */
function soundByCommand(ownerId, command) {
    const id = Number(ownerId) || 0;
    const cmd = normalizeCommand(command);
    if (!id || !cmd) return Promise.resolve(null);
    return load(`sbc:${id}:${cmd}`, () => remoteSoundByCommand(id, cmd), () => null)
        .then((v) => (v && v !== false ? v : null));   // false / null: Chat's none, or unreachable
}
/** The synchronous form (the RobotStreamer !sound lookup): the cached Chat answer, else null. */
function soundByCommandPeek(ownerId, command) {
    const id = Number(ownerId) || 0;
    const cmd = normalizeCommand(command);
    if (!id || !cmd) return null;
    const v = peek(`sbc:${id}:${cmd}`, () => remoteSoundByCommand(id, cmd), () => null);
    return v && v !== false ? v : null;
}

// ── DM blocks (the call-invite gate) ─────────────────────────────────────────
const DM_BLOCK_TTL_FALSE = 30_000;   // not blocked: blocks are rare, 30 s is plenty
const DM_BLOCK_TTL_TRUE = 5_000;     // blocked: an unblock should lift a ring quickly
/**
 * Has either of these users blocked the other? Chat owns dm_blocks, so chat mode asks Chat's
 * block-state read (chat.messages.read); outside chat mode there is no local table and the answer
 * is null. Cached briefly (30 s when not blocked, 5 s when blocked; nothing invalidates it — blocks
 * are rare).
 *
 * `strict`: past the cache and with Chat unreachable the answer is null, never the last good
 * value, and the call-invite route fails closed on it — refusing a ring is far better than ringing
 * someone who blocked the caller.
 */
function dmBlocked(a, b) {
    const x = Number(a) || 0;
    const y = Number(b) || 0;
    if (!x || !y) return Promise.resolve(null);
    const key = `dmb:${Math.min(x, y)}:${Math.max(x, y)}`;
    return load(key, async () => {
        const out = await client.readDmBlockState({ a: x, b: y });
        if (!out || typeof out.blocked !== 'boolean') throw unavailable('dm block state');
        return out.blocked;
    }, () => null, {   // Live keeps no dm_blocks; outside chat mode the gate fails closed
        strict: true,
        ttlFor: (v) => (v === true ? DM_BLOCK_TTL_TRUE : DM_BLOCK_TTL_FALSE),
    }).catch((err) => {
        if (err && err.unavailable) return null;
        throw err;
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
    }, () => [], { ttl: 0 });
}

/** Record where the asset sync put a channel sound (Chat owns the row; a repeat is a no-op). */
async function recordSoundAsset(id, mediaUrl, mediaAssetId) {
    if (!(Number(id) > 0) || !(Number(mediaAssetId) > 0) || !mediaUrl) return null;
    if (!remote()) return null;   // Live keeps no channel_sounds; nothing to record on
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
    siteStats, siteStatsPeek, topChatters, homeSeries, homeSeriesPeek,
    windowStats, windowStatsPeek, streamStats, streamStatsPeek, channelMaxId, channelMaxIdPeek, userMessageCountPeek,
    messageById, channelMessages, channelMessagesPeek, userHistory, relayHistory, channelSamples, searchMessages,
    liveChatBuckets, recentChatText, spikeOffsets, firstChat, firstChatPeek,
    pendingIp, relayUsers, relayUser, ttsOverride, ttsOverridePeek, isRelayUserHidden,
    soundCount, soundByCommand, soundByCommandPeek, dmBlocked, pendingSounds, recordSoundAsset, invalidate,
    _reset, _age, _size, _cacheMax, CACHE_TTL_MS, CACHE_KEEP_MS,
};
