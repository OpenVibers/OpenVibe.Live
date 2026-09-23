/**
 * OpenVibe.Live — the reads that used to hit Live's frozen `vods`/`clips`/`pastes` tables, answered
 * by OpenVibe.Media (VODs, clips) and OpenVibe.Community (pastes) instead (register C-73 step 2).
 *
 * The local tables stopped at the Media split: nothing recorded, clipped or pasted since then was
 * ever in them, and Media and Community hold the old rows as well (same VOD/clip ids; pastes by
 * slug). Every lookup here is best-effort. When the upstream is down it answers "nothing" (a null
 * id, an empty list, a zero or null count), never a stale local copy.
 *
 * Privacy follows access.js. A list anyone can read carries public items only. Hidden items are
 * asked for explicitly (include_private for Media; the owner or staff for pastes), and only on
 * paths that have already checked the caller is the owner or staff.
 *
 * Media lists have no batch-by-stream or date filter yet, so a few lookups ask per stream or cut
 * windows client-side (see the notes on each). docs/vods-and-clips.md lists the API additions.
 */
'use strict';
const db = require('../db/database');
const media = require('../media-client');
const pastesClient = require('../pastes-client');

const TIMEOUT_MS = 5000;
const rowsOf = (r, key) => (r && Array.isArray(r[key]) ? r[key] : (Array.isArray(r) ? r : []));
const totalOf = (r, rows) => (r && Number.isFinite(Number(r.total)) ? Number(r.total) : rows.length);

/** Listed for everyone. A row without `visibility` is a legacy one, where is_public decides. */
function isPublic(row) {
    if (!row) return false;
    if (row.visibility) return row.visibility === 'public';
    return row.is_public === true || row.is_public === 1 || row.is_public === '1';
}
/** A finished recording (not in progress, not an ephemeral clips-only one). */
const finished = (v) => !!v && !v.is_recording && !v.clips_only;
/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO → ms. */
const ts = (s) => { const n = Date.parse(String(s || '').replace(' ', 'T').replace(/(T\d\d:\d\d:\d\d)$/, '$1Z')); return Number.isFinite(n) ? n : 0; };

/** Successful answers are kept for ttlMs. A failure is not cached, so the next caller retries. */
function ttlCache(ttlMs, max = 1000) {
    const map = new Map();
    return {
        async get(key, load) {
            const hit = map.get(key);
            if (hit && Date.now() - hit.at < ttlMs) return hit.value;
            const value = await load();
            if (map.size >= max) map.delete(map.keys().next().value);
            map.set(key, { at: Date.now(), value });
            return value;
        },
        clear() { map.clear(); },
    };
}

/** fn over items, at most n at a time. */
async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; await fn(items[i], i); }
    }));
}

function transcriptText(json) {
    try {
        const segs = JSON.parse(json || '[]');
        return Array.isArray(segs) ? segs.map((s) => String((s && s.text) || '').trim()).filter(Boolean).join(' ') : '';
    } catch { return ''; }
}
/** Live's own AI text (vod_ai_state / clip_ai_state) laid over a Media row. */
function withAiState(row, state) {
    const out = { ...row, duration_seconds: Number(row.duration_seconds ?? row.duration) || 0 };
    if (state) {
        if (state.ai_overview || state.ai_overview_short) out.ai_overview = state.ai_overview || state.ai_overview_short;
        if (state.ai_overview_short) out.ai_overview_short = state.ai_overview_short;
        const text = transcriptText(state.ai_transcript_json);
        if (text) out.ai_transcript = text;
    }
    return out;
}
const aiState = (fn, id) => { try { return fn(id) || null; } catch { return null; } };

// ── VODs ─────────────────────────────────────────────────────────────────────

const _streamVod = ttlCache(5 * 60_000);
/**
 * The public, finished VOD of each stream (the newest if there are several). Media has no batch
 * filter by stream id, so this asks per stream, six at a time, and remembers each answer (also "no
 * VOD") for five minutes. The whole lookup gets `budgetMs`: a stream not asked about by then goes
 * without its VOD this time, so a slow Media cannot hold a list for minutes. → Map(streamId → row)
 */
async function publicVodsForStreams(streamIds, { budgetMs = 4000 } = {}) {
    const ids = [...new Set((streamIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    const out = new Map();
    const deadline = Date.now() + budgetMs;
    await pool(ids, 6, async (sid) => {
        const left = deadline - Date.now();
        if (left <= 0) return;
        try {
            const vod = await _streamVod.get(sid, async () => {
                const r = await media.listVods({ stream_id: sid, limit: 10 }, { timeoutMs: Math.min(TIMEOUT_MS, left) });
                return rowsOf(r, 'vods').filter((v) => isPublic(v) && finished(v))
                    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
            });
            if (vod) out.set(sid, vod);
        } catch { /* Media down: no VOD for this stream */ }
    });
    return out;
}

/**
 * The recently-ended list's VOD fields (vod_id, vod_is_public, vod_thumbnail_url, vod_duration),
 * which getRecentStreams used to join from the local table. A public VOD or nothing: never the id
 * or thumbnail of a private or unlisted one.
 */
async function attachPublicVods(streams) {
    const list = Array.isArray(streams) ? streams : [];
    const vods = await publicVodsForStreams(list.map((s) => s && s.id));
    for (const s of list) {
        const v = vods.get(Number(s.id)) || null;
        s.vod_id = v ? v.id : null;
        s.vod_is_public = v ? 1 : null;
        s.vod_thumbnail_url = v ? media.publicUrl(v.thumbnail_url) : null;
        s.vod_duration = v ? (Number(v.duration_seconds ?? v.duration) || 0) : null;
    }
    return list;
}

/**
 * stream id → public VOD id for one streamer (the AI timeline's links), newest VOD per stream.
 * Pages through Media's list, 500 at a time, up to 2,000 VODs. `complete` is false when Media did
 * not answer, so the caller does not cache a timeline with every link missing.
 */
async function publicVodIdsByStream(userId) {
    const byStream = new Map();
    const PAGE = 500;
    try {
        for (let offset = 0; offset < 2000; offset += PAGE) {
            const rows = rowsOf(await media.listVods({ user_id: userId, limit: PAGE, offset }, { timeoutMs: TIMEOUT_MS }), 'vods');
            for (const v of rows) {
                if (!v || !v.stream_id || !isPublic(v) || !finished(v)) continue;
                const sid = Number(v.stream_id);
                if (!byStream.has(sid) || Number(v.id) > byStream.get(sid)) byStream.set(sid, Number(v.id));
            }
            if (rows.length < PAGE) break;
        }
        return { byStream, complete: true };
    } catch {
        return { byStream, complete: false };
    }
}

/**
 * stream id → VOD for one slot's sessions (its owner's workspace history), newest VOD per stream.
 * Private VODs and recordings in progress are included: only the slot's owner reads this.
 */
async function vodsForManagedStream(managedStreamId) {
    const out = new Map();
    try {
        const r = await media.listVods({ managed_stream_id: managedStreamId, include_private: 1, include_recording: 1, limit: 200 }, { timeoutMs: TIMEOUT_MS });
        for (const v of rowsOf(r, 'vods')) {
            if (!v || !v.stream_id) continue;
            const sid = Number(v.stream_id);
            const cur = out.get(sid);
            if (!cur || Number(v.id) > Number(cur.id)) out.set(sid, v);
        }
    } catch { /* Media down: the sessions show without a VOD link */ }
    return out;
}

/**
 * A streamer's finished VODs, newest first, with Live's AI text (ai_overview, ai_transcript) laid
 * over Media's row. includePrivate is for staff tools only.
 */
async function userVods(userId, { includePrivate = false, limit = 20 } = {}) {
    let rows;
    try { rows = rowsOf(await media.listVods({ user_id: userId, include_private: includePrivate ? 1 : undefined, limit }, { timeoutMs: TIMEOUT_MS }), 'vods'); }
    catch { return []; }
    return rows.filter((v) => finished(v) && (includePrivate || isPublic(v))).map((v) => withAiState(v, aiState(db.getVodAiState, v.id)));
}

/** Every finished VOD, and the public ones (the admin dashboard). null when Media did not answer. */
async function vodCounts() {
    const [all, pub] = await Promise.all([
        media.listVods({ include_private: 1, limit: 1 }, { timeoutMs: TIMEOUT_MS }).catch(() => null),
        media.listVods({ limit: 1 }, { timeoutMs: TIMEOUT_MS }).catch(() => null),
    ]);
    const n = (r) => (r && Number.isFinite(Number(r.total)) ? Number(r.total) : null);
    return { total: n(all), public: n(pub) };
}

// ── Clips ────────────────────────────────────────────────────────────────────

/** Clips a user made, newest first, with Live's AI text. includePrivate is for staff tools only. */
async function userClips(userId, { includePrivate = false, limit = 20 } = {}) {
    let rows;
    try { rows = rowsOf(await media.listClips({ user_id: userId, include_private: includePrivate ? 1 : undefined, limit }, { timeoutMs: TIMEOUT_MS }), 'clips'); }
    catch { return []; }
    return rows.filter((c) => includePrivate || isPublic(c)).map((c) => withAiState(c, aiState(db.getClipAiState, c.id)));
}

/** Clips this user took of other streamers: the Clips Taken tab badge, counted like the tab lists them. */
async function countClipsTaken(userId, { includePrivate = false } = {}) {
    try {
        const r = await media.listClips({ user_id: userId, include_private: includePrivate ? 1 : undefined, hide_self: 1, limit: 1 }, { timeoutMs: TIMEOUT_MS });
        return totalOf(r, rowsOf(r, 'clips'));
    } catch { return 0; }
}

/** Every clip of one stream (by the stream or by its VOD), any visibility. An internal signal, never listed. */
async function streamClips(streamId, vodId) {
    const asks = [];
    if (streamId) asks.push(media.listClips({ stream_id: streamId, include_private: 1, limit: 500 }, { timeoutMs: TIMEOUT_MS }));
    if (vodId) asks.push(media.listClips({ vod_id: vodId, include_private: 1, limit: 500 }, { timeoutMs: TIMEOUT_MS }));
    const byId = new Map();
    for (const r of await Promise.all(asks.map((p) => p.catch(() => null)))) {
        for (const c of rowsOf(r, 'clips')) if (c && c.id != null) byId.set(c.id, c);
    }
    return [...byId.values()];
}

/** Seconds into the VOD where viewers clipped (the AI moment picker's strongest signal). */
async function clipStartTimes(streamId, vodId) {
    return (await streamClips(streamId, vodId))
        .map((c) => Number(c.start_time)).filter((t) => t > 0).map(Math.floor).sort((a, b) => a - b);
}

/**
 * stream_analytics.clips_created from Media. computeAndCacheStreamAnalytics (database.js) keeps the
 * last value it has and calls this, since it runs synchronously when a stream ends.
 */
async function refreshStreamClipCount(streamId) {
    try {
        const r = await media.listClips({ stream_id: streamId, include_private: 1, limit: 1 }, { timeoutMs: TIMEOUT_MS });
        const n = totalOf(r, rowsOf(r, 'clips'));
        db.setStreamAnalyticsClipCount(streamId, n);
        return n;
    } catch { return null; }
}

/**
 * The most-viewed public VOD and clip of a streamer for this week, this month and all time (the
 * offline screen's cycler). Media lists have no date filter, so the week and month are cut from the
 * newest 100 VODs and clips (more than 100 in a month loses only that month's oldest), and all time
 * also asks Media for its most-viewed. The streamer's name rides along on each row as it used to.
 */
async function topContentRanges(user) {
    const ask = (fn, query) => fn(query, { timeoutMs: TIMEOUT_MS }).then((r) => r, () => null);
    const [vNew, vTop, cNew, cTop] = await Promise.all([
        ask(media.listVods, { user_id: user.id, order: 'newest', limit: 100 }),
        ask(media.listVods, { user_id: user.id, order: 'views', limit: 1 }),
        ask(media.listClips, { channel_user_id: user.id, order: 'newest', limit: 100 }),
        ask(media.listClips, { channel_user_id: user.id, order: 'views', limit: 1 }),
    ]);
    const who = { username: user.username, display_name: user.display_name, avatar_url: user.avatar_url, profile_color: user.profile_color };
    const top = (rows, since) => {
        const best = rows.filter((r) => r && isPublic(r) && finished(r) && (since == null || ts(r.created_at) >= since))
            .sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0) || ts(b.created_at) - ts(a.created_at))[0];
        return best ? { ...best, ...who } : null;
    };
    const vods = rowsOf(vNew, 'vods'), clips = rowsOf(cNew, 'clips');
    const week = Date.now() - 7 * 86400_000;
    const month = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1); return d.getTime(); })();
    return {
        week: { vod: top(vods, week), clip: top(clips, week) },
        month: { vod: top(vods, month), clip: top(clips, month) },
        all: { vod: top([...rowsOf(vTop, 'vods'), ...vods], null), clip: top([...rowsOf(cTop, 'clips'), ...clips], null) },
    };
}

// ── Pastes (OpenVibe.Community; OpenVibe.Media while PASTES_AUTHORITY is unset) ──────────────

/** Throws when the upstream fails (so a count cache never keeps a failure as zero). */
async function _listUserPastes(user, { limit = 30, type, hidden = false }) {
    let out;
    if (pastesClient.onCommunity()) {
        // Community lists one person's pastes by username. Hidden ones only for the owner (act as
        // them) or staff (X-OV-Staff): Live says which, after its own check of the caller.
        const act = hidden === 'owner' ? { liveUserId: user.id } : (hidden === 'staff' ? { staff: true } : {});
        out = await pastesClient.request('GET', '', { query: { username: user.username, include_unlisted: hidden ? 1 : undefined, type, limit }, act, timeoutMs: TIMEOUT_MS });
    } else {
        out = await media.listPastes({ user_id: user.id, include_unlisted: hidden ? 1 : undefined, type, limit }, { timeoutMs: TIMEOUT_MS });
    }
    let pastes = rowsOf(out, 'pastes');
    if (!hidden) pastes = pastes.filter((p) => p && p.visibility === 'public');
    return { pastes, total: totalOf(out, pastes) };
}

/**
 * One person's pastes, newest first (pinned first, as the upstream lists them). `hidden`: false
 * (public only), 'owner' or 'staff'. Pass 'owner'/'staff' only once the caller has been checked to
 * be that. `type`: 'paste' | 'screenshot'. → { pastes, total }, empty when the upstream is down.
 */
async function userPastes(user, opts = {}) {
    if (!user || !user.id || !user.username) return { pastes: [], total: 0 };
    try { return await _listUserPastes(user, opts); } catch { return { pastes: [], total: 0 }; }
}

const _pasteCounts = ttlCache(60_000);
/** How many pastes a person has (tab badges, the setup hub). Cached for a minute. */
async function countUserPastes(user, { hidden = false } = {}) {
    if (!user || !user.id || !user.username) return 0;
    try {
        return await _pasteCounts.get(`${user.id}:${hidden || 'public'}`, async () => (await _listUserPastes(user, { hidden, limit: 1 })).total);
    } catch { return 0; }
}

/** A streamer's pastes with their AI fields, any visibility: the staff-side overview and AI explorer. */
async function userPastesForAi(user, limit = 30) {
    const { pastes } = await userPastes(user, { hidden: 'staff', limit });
    return pastes.map((p) => ({
        id: p.id, slug: p.slug, type: p.type, title: p.title,
        ai_summary: p.ai_summary || null, ai_tags: p.ai_tags || null, ai_analyzed_at: p.ai_analyzed_at || null,
        created_at: p.created_at,
    }));
}

/** The person's avatar uploads: their screenshot pastes tagged metadata.kind = 'avatar'. */
async function avatarPastes(user, limit = 60) {
    const { pastes } = await userPastes(user, { type: 'screenshot', hidden: 'owner', limit: 200 });
    const kind = (p) => {
        let m = p && p.metadata;
        if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = null; } }
        return m && typeof m === 'object' ? m.kind : null;
    };
    return pastes.filter((p) => kind(p) === 'avatar').slice(0, limit);
}

// ── Site totals (home hero, SEO) ─────────────────────────────────────────────

let _mediaStats = { at: 0, data: null };
const SITE_STATS_TTL_MS = 5 * 60_000;
/** Media's per-app counters (VODs, clips, archived hours). Cached five minutes; retried 30 s after a failure. */
async function siteMediaStats() {
    if (Date.now() - _mediaStats.at < SITE_STATS_TTL_MS) return _mediaStats.data;
    try {
        _mediaStats = { at: Date.now(), data: await media.request('GET', '/stats', { timeoutMs: TIMEOUT_MS }) };
    } catch (err) {
        console.warn('[Home] Media stats unavailable:', err.message);
        _mediaStats.at = Date.now() - SITE_STATS_TTL_MS + 30_000;
    }
    return _mediaStats.data;
}

let _pasteStats = { at: 0, data: null };
/**
 * Paste totals from the service that owns pastes: Community's counts under PASTES_AUTHORITY=community
 * ({ pastes, pasteText, pasteImages }), else null (Media's /stats already carries them).
 */
async function sitePasteStats() {
    if (!pastesClient.onCommunity()) return null;
    if (Date.now() - _pasteStats.at < SITE_STATS_TTL_MS) return _pasteStats.data;
    try {
        const out = await pastesClient.request('GET', '/admin/stats', { act: { staff: true }, timeoutMs: TIMEOUT_MS });
        const s = (out && out.stats) || {};
        _pasteStats = { at: Date.now(), data: { pastes: Number(s.total) || 0, pasteText: Number(s.textPastes) || 0, pasteImages: Number(s.screenshots) || 0 } };
    } catch (err) {
        console.warn('[Home] Community paste stats unavailable:', err.message);
        _pasteStats.at = Date.now() - SITE_STATS_TTL_MS + 30_000;
    }
    return _pasteStats.data;
}

/**
 * The archive counters on top of Live's own stats: VODs, clips, hours from Media; pastes from
 * Community (or Media). Fields stay null when neither answered.
 */
async function withArchiveStats(stats) {
    const [m, p] = await Promise.all([siteMediaStats(), sitePasteStats()]);
    if (m) {
        stats.vods = m.vods;
        stats.clips = m.clips;
        stats.pastes = m.pastes;
        stats.pasteImages = m.pasteImages;
        stats.pasteText = m.pasteText;
        stats.streamHours = Math.round((m.durationSeconds || 0) / 3600);
        stats.recent = { ...stats.recent, vods: m.recent?.vods, clips: m.recent?.clips, hours: m.recent?.hours };
    }
    if (p) Object.assign(stats, p);
    return stats;
}

function _resetCaches() {
    _streamVod.clear(); _pasteCounts.clear();
    _mediaStats = { at: 0, data: null }; _pasteStats = { at: 0, data: null };
}

module.exports = {
    isPublic,
    publicVodsForStreams, attachPublicVods, publicVodIdsByStream, vodsForManagedStream, userVods, vodCounts,
    userClips, countClipsTaken, streamClips, clipStartTimes, refreshStreamClipCount, topContentRanges,
    userPastes, countUserPastes, userPastesForAi, avatarPastes,
    siteMediaStats, sitePasteStats, withArchiveStats,
    _resetCaches,
};
