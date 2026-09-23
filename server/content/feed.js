'use strict';
/**
 * The Content and Moments feeds: one scrolling list merged from several services.
 *
 *   Content (/content, GET /api/content/feed)     what people made: VODs, clips people cut, pastes
 *                                                  people wrote
 *   Moments (/moments, GET /api/content/moments)  what the AI made: auto-clips, AI moment pastes
 *                                                  (from VODs and caught live), AI after-show recaps
 *
 * Who made it is decided by the service that stores it, never by guessing here:
 *   - clips: OpenVibe.Media's `auto_generated` (set when Live's auto-clip job cuts one; Media's
 *     ?auto_generated=1|0 filters by it). Clips made before Media kept the flag are corrected from
 *     Live's own auto-clip log (auto-clip-job.js syncAutoClipFlags).
 *   - pastes: OpenVibe.Community's `origin` ('ai' for Live's AI jobs, which post with X-OV-Origin: ai;
 *     ?origin=user|ai filters by it).
 *   - VODs are recordings of people streaming: always Content.
 *   - recaps: Live's own stream_recaps rows whose write-up the AI produced (ai = 1); template
 *     recaps are stats, not generated content, and are listed nowhere.
 * Every source filters server-side, so a page is never a full page with the other kind taken out.
 *
 * Privacy: public items only. Media lists without include_private (is_public = 1), Community lists
 * for an anonymous service call (public, not burn-after-read), and each row is checked again here
 * (lookups.isPublic) before it is shown. Items of banned accounts are left out.
 *
 * Paging: `cursor` carries each source's offset (and, for Top, the window's start, so a window
 * does not slide while someone scrolls). A page fetches the next `limit + SLACK` rows of every
 * source, merges them by the sort (newest first, or score: views, a paste like worth five views, a
 * recap's peak viewers), and stops when a source that has more upstream runs out of fetched rows,
 * so the order across pages is exact. A new item arriving between pages can repeat one card (the
 * client drops repeated keys); none is skipped.
 *
 * Cost: every source page is cached (30 s for New, 2 min for Top) and shared by concurrent
 * requests. A page waits at most DEADLINE_MS for Media and Community; a source that has not
 * answered by then is left out of this page (its offset stays, so the next page asks again) and
 * the answer says which (`sources`, `partial`). Its fetch keeps running and fills the cache.
 */
const db = require('../db/database');
const media = require('../media-client');
const pastesClient = require('../pastes-client');
const lookups = require('../media-proxy/lookups');
const { publicFeedItem } = require('../web/serializers');

const DEADLINE_MS = 4000;
const SOURCE_TIMEOUT_MS = 3500;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
const SLACK = 4;                 // rows fetched beyond the page, so a skipped row rarely shortens it
const MAX_OFFSET = 10_000;       // per source; deeper than anyone scrolls, and bounds crafted cursors
const TTL_NEW_MS = 30_000;
const TTL_TOP_MS = 120_000;
const CACHE_MAX = 400;

const WINDOWS = { week: 7, month: 30, all: null };
const DEFAULT_WINDOW = 'month';

/** Which sources each feed and each of its filters reads. */
const FEEDS = {
    content: { types: { all: ['vods', 'clips', 'pastes'], vods: ['vods'], clips: ['clips'], pastes: ['pastes'] } },
    moments: { types: { all: ['aiclips', 'aipastes', 'recaps'], clips: ['aiclips'], shots: ['aipastes'], recaps: ['recaps'] } },
};

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO → ms (0 when unreadable). */
function ts(s) {
    if (!s) return 0;
    const str = String(s);
    const n = Date.parse(/[TZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
    return Number.isFinite(n) ? n : 0;
}
const iso = (s) => { const n = ts(s); return n ? new Date(n).toISOString() : null; };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clean = (s, max) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return max && t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
};
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
function parseJson(v) {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

const _users = new Map();   // per page build: id/username → row (or null)
function userById(id) {
    if (id == null || id === '') return null;
    const key = `i:${id}`;
    if (!_users.has(key)) { let u = null; try { u = db.getUserById(Number(id)) || null; } catch { /* */ } _users.set(key, u); }
    return _users.get(key);
}
function userByName(name) {
    if (!name) return null;
    const key = `n:${String(name).toLowerCase()}`;
    if (!_users.has(key)) { let u = null; try { u = db.getUserByUsername(String(name)) || null; } catch { /* */ } _users.set(key, u); }
    return _users.get(key);
}
const banned = (u) => !!(u && (u.is_banned === 1 || u.is_banned === true));
/** The public face of a Live account, with its channel link. */
function person(u) {
    if (!u || !u.username) return null;
    return { username: u.username, display_name: u.display_name || u.username, avatar_url: u.avatar_url || null, profile_color: u.profile_color || null, href: `/@${u.username}` };
}

// ── sources ──────────────────────────────────────────────────────────────────────────────────
// Each: load(offset, n, { sort, since }) → { rows, total|null }, and item(row) → feed item or null
// (null = not shown, still consumed). `score` must follow the upstream order for Top.

const mediaRows = (r, key) => (r && Array.isArray(r[key]) ? r[key] : []);
const mediaTotal = (r) => (r && Number.isFinite(Number(r.total)) ? Number(r.total) : null);

/** A VOD row that is not worth a card: failed, still recording, or an empty shell nothing will fill. */
function unplayableVod(v) {
    if (!v || v.is_recording || v.clips_only || v.status === 'failed' || v.status === 'recording') return true;
    if (v.status !== 'pending') return false;
    if (num(v.duration_seconds ?? v.duration) > 0 || num(v.file_size) > 0 || v.thumbnail_url) return false;
    return Date.now() - ts(v.created_at) > 10 * 60 * 1000;
}

function vodItem(v) {
    if (!lookups.isPublic(v) || unplayableVod(v)) return null;
    const owner = userById(v.user_id);
    if (banned(owner)) return null;
    // Content is what people made: the card carries no AI overview (the VOD page still has it).
    return {
        kind: 'vod', id: Number(v.id), href: `/vod/${Number(v.id)}`,
        title: clean(v.title, 140) || 'Stream recording',
        created_at: iso(v.created_at), views: num(v.view_count),
        duration_seconds: Math.round(num(v.duration_seconds ?? v.duration)),
        thumbnail_url: media.publicUrl(v.thumbnail_url) || null,
        excerpt: v.description ? clean(v.description, 220) : null,
        channel: person(owner), ai: false,
    };
}

function clipItem(c, { ai }) {
    if (!lookups.isPublic(c)) return null;
    if (c.status && c.status !== 'ready') return null;
    if (!!c.auto_generated !== ai) return null;   // an upstream that ignored the filter never mixes the feeds
    const channelOwner = userById(c.channel_user_id != null ? c.channel_user_id : c.user_id);
    const creator = userById(c.user_id);
    if (banned(channelOwner) || banned(creator)) return null;
    // An AI clip's card says what the AI saw; a person's clip carries only what they wrote.
    let summary = null;
    if (ai) { try { const s = db.getClipAiState(c.id); summary = s && (s.ai_overview_short || s.ai_overview); } catch { /* */ } }
    const by = !ai && creator && channelOwner && creator.id !== channelOwner.id ? person(creator) : null;
    return {
        kind: 'clip', id: Number(c.id), href: `/clip/${Number(c.id)}`,
        title: clean(c.title, 140) || 'Clip',
        created_at: iso(c.created_at), views: num(c.view_count),
        duration_seconds: Math.round(num(c.duration_seconds ?? c.duration)),
        thumbnail_url: media.publicUrl(c.thumbnail_url) || null,
        preview_url: media.publicUrl(c.playback_url) || media.clipUrl(c.id),
        excerpt: summary ? clean(summary, 220) : (c.description ? clean(c.description, 220) : null),
        channel: person(channelOwner || creator), by, ai,
        ai_label: ai ? 'Auto-clip' : null,
    };
}

const VOD_LINK_RE = /^\/vod\/\d+(\?t=\d+(\.\d+)?)?$/;
function pasteItem(p, { ai }) {
    if (!p || p.visibility !== 'public' || p.burn_after_read) return null;
    if ((p.origin === 'ai') !== ai) return null;
    const meta = parseJson(p.metadata) || {};
    let channel = null;
    if (ai) {
        // AI pastes have no author; they belong to the stream they came from.
        let stream = null;
        try { stream = p.stream_id ? db.getStreamById(Number(p.stream_id)) : null; } catch { /* */ }
        const owner = stream ? userById(stream.user_id) : userByName(meta.username);
        if (banned(owner)) return null;
        channel = person(owner);
    } else {
        // The author is a network account: their Live channel when they have one, else just the name.
        // Community's avatar is used only as an absolute https URL (it may be relative to Community).
        const local = userByName(p.username);
        if (banned(local)) return null;
        const theirAvatar = typeof p.avatar_url === 'string' && /^https:\/\//i.test(p.avatar_url) ? p.avatar_url : null;
        channel = local ? person(local)
            : (p.username ? { username: p.username, display_name: p.display_name || p.username, avatar_url: theirAvatar, profile_color: p.profile_color || null, href: null } : null);
        if (channel && local && !channel.avatar_url) channel.avatar_url = theirAvatar;
    }
    const shot = p.type === 'screenshot';
    // People's pastes show their own words; the AI summary is shown on AI pastes only.
    const text = ai ? (p.ai_summary || p.content || null) : (shot ? null : (p.content || null));
    return {
        kind: 'paste', id: String(p.slug), href: `/p/${encodeURIComponent(p.slug)}`,
        title: clean(p.title, 140) || (shot ? 'Image' : 'Paste'),
        created_at: iso(p.created_at), views: num(p.views), likes: num(p.likes),
        paste_type: shot ? 'image' : 'text',
        language: shot ? null : (p.language || 'text'),
        image_url: shot ? (media.publicUrl(p.screenshot_url) || null) : null,
        excerpt: text ? (shot || ai ? clean(text, 260) : String(text).slice(0, 600)) : null,
        nsfw: !!p.is_nsfw,
        channel, ai,
        ai_label: ai ? (meta.live ? 'Caught live' : 'AI moment') : null,
        moment_href: ai && typeof meta.vod_link === 'string' && VOD_LINK_RE.test(meta.vod_link) ? meta.vod_link : null,
    };
}

function recapItem(r) {
    const j = parseJson(r.json);
    if (!j || !j.write || !j.stream) return null;
    const owner = userById(r.user_id);
    if (!owner || banned(owner)) return null;
    return {
        kind: 'recap', id: Number(r.stream_id), href: `/recap/${Number(r.stream_id)}`,
        title: clean(j.write.headline || j.stream.title, 140) || 'After-show report',
        created_at: iso(r.created_at), views: num(j.stream.peak_viewers),
        duration_seconds: Math.round(num(j.stream.duration_seconds)),
        thumbnail_url: j.vod && j.vod.thumbnail_url ? media.publicUrl(j.vod.thumbnail_url) : null,
        excerpt: j.write.summary ? clean(j.write.summary, 260) : null,
        grade: ['S', 'A', 'B', 'C'].includes(j.write.grade) ? j.write.grade : null,
        stream_title: clean(j.stream.title, 120) || null,
        channel: person(owner), ai: true, ai_label: 'AI recap',
    };
}

const SOURCES = {
    vods: {
        async load(offset, n, { sort, since }) {
            const r = await media.listVods({ limit: n, offset, order: sort === 'top' ? 'views' : 'newest', since: since || undefined }, { timeoutMs: SOURCE_TIMEOUT_MS });
            return { rows: mediaRows(r, 'vods'), total: mediaTotal(r) };
        },
        item: vodItem,
        score: (it) => it.views,
    },
    clips: {
        async load(offset, n, { sort, since }) {
            const r = await media.listClips({ limit: n, offset, order: sort === 'top' ? 'views' : 'newest', since: since || undefined, auto_generated: 0, status: 'ready' }, { timeoutMs: SOURCE_TIMEOUT_MS });
            return { rows: mediaRows(r, 'clips'), total: mediaTotal(r) };
        },
        item: (c) => clipItem(c, { ai: false }),
        score: (it) => it.views,
    },
    aiclips: {
        async load(offset, n, { sort, since }) {
            const r = await media.listClips({ limit: n, offset, order: sort === 'top' ? 'views' : 'newest', since: since || undefined, auto_generated: 1, status: 'ready' }, { timeoutMs: SOURCE_TIMEOUT_MS });
            return { rows: mediaRows(r, 'clips'), total: mediaTotal(r) };
        },
        item: (c) => clipItem(c, { ai: true }),
        score: (it) => it.views,
    },
    pastes: {
        load: (offset, n, opts) => communityPastes('user', offset, n, opts),
        item: (p) => pasteItem(p, { ai: false }),
        score: (it) => it.views + 5 * it.likes,
    },
    aipastes: {
        load: (offset, n, opts) => communityPastes('ai', offset, n, opts),
        item: (p) => pasteItem(p, { ai: true }),
        score: (it) => it.views + 5 * it.likes,
    },
    recaps: {
        async load(offset, n, { sort, since }) {
            try { require('../recap/recap').ensureTable(); } catch { /* */ }
            const where = ['r.ai = 1', 'COALESCE(u.is_banned, 0) = 0'];
            const params = [];
            if (since) { where.push('datetime(r.created_at) >= datetime(?)'); params.push(since); }
            const order = sort === 'top'
                ? "COALESCE(json_extract(r.json, '$.stream.peak_viewers'), 0) DESC, r.created_at DESC, r.stream_id DESC"
                : 'r.created_at DESC, r.stream_id DESC';
            const from = `FROM stream_recaps r JOIN users u ON u.id = r.user_id WHERE ${where.join(' AND ')}`;
            const rows = db.all(`SELECT r.stream_id, r.user_id, r.json, r.created_at ${from} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, n, offset]) || [];
            const total = (db.get(`SELECT COUNT(*) AS n ${from}`, params) || {}).n || 0;
            return { rows, total };
        },
        item: recapItem,
        score: (it) => it.views,
    },
};

/** People's or AI pastes from OpenVibe.Community. Pastes are only listed once Community owns them. */
async function communityPastes(origin, offset, n, { sort, since }) {
    if (!pastesClient.onCommunity()) { const e = new Error('pastes are listed from OpenVibe.Community only'); e.unavailable = true; throw e; }
    const r = await pastesClient.request('GET', '', {
        query: { origin, limit: n, offset, sort: sort === 'top' ? 'top' : 'newest', since: since || undefined, pinned_first: 0 },
        timeoutMs: SOURCE_TIMEOUT_MS,
    });
    return { rows: mediaRows(r, 'pastes'), total: mediaTotal(r) };
}

// ── cache ────────────────────────────────────────────────────────────────────────────────────

const _pages = new Map();   // key → { at, ttl, value, pending }
/** A source page, fetched at most once at a time and kept for `ttl`. Failures are not kept. */
function cachedPage(key, ttl, load) {
    const hit = _pages.get(key);
    if (hit && hit.value && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
    if (hit && hit.pending) return hit.pending;
    const entry = { at: 0, ttl, value: null, pending: null };
    entry.pending = Promise.resolve().then(load).then(
        (value) => { entry.value = value; entry.at = Date.now(); entry.pending = null; return value; },
        (err) => { if (_pages.get(key) === entry) _pages.delete(key); throw err; },
    );
    _pages.delete(key);
    _pages.set(key, entry);
    if (_pages.size > CACHE_MAX) _pages.delete(_pages.keys().next().value);
    return entry.pending;
}

// ── cursor ───────────────────────────────────────────────────────────────────────────────────

function encodeCursor(c) { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
function decodeCursor(s) {
    if (!s) return null;
    try {
        const c = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
        return c && typeof c === 'object' && c.o && typeof c.o === 'object' ? c : null;
    } catch { return null; }
}

class FeedError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/** The request's feed options, validated. Throws FeedError(400). */
function parseQuery(feed, q = {}) {
    const def = FEEDS[feed];
    if (!def) throw new FeedError(404, 'No such feed');
    const type = String(q.type || 'all').toLowerCase();
    if (!def.types[type]) throw new FeedError(400, `type must be one of: ${Object.keys(def.types).join(', ')}`);
    const sort = String(q.sort || 'new').toLowerCase();
    if (sort !== 'new' && sort !== 'top') throw new FeedError(400, 'sort must be new or top');
    let windowName = null;
    if (sort === 'top') {
        windowName = String(q.window || DEFAULT_WINDOW).toLowerCase();
        if (!(windowName in WINDOWS)) throw new FeedError(400, 'window must be week, month or all');
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q.limit, 10) || DEFAULT_LIMIT));
    const key = `${feed}|${type}|${sort}|${windowName || ''}`;
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && (!cursor || cursor.k !== key)) throw new FeedError(400, 'This cursor belongs to another feed or is damaged; start from the first page');
    // The window starts on the hour (so pages share cache entries) and stays put across pages.
    let since = null;
    if (windowName && WINDOWS[windowName]) {
        since = cursor && typeof cursor.s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cursor.s) ? cursor.s
            : sqlTime(Math.floor((Date.now() - WINDOWS[windowName] * 86400_000) / 3600_000) * 3600_000);
    }
    const offsets = {};
    for (const s of def.types[type]) {
        const o = cursor ? parseInt(cursor.o[s], 10) : 0;
        offsets[s] = Number.isFinite(o) && o > 0 ? Math.min(o, MAX_OFFSET) : 0;
    }
    return { feed, type, sort, window: windowName, limit, key, since, offsets, sources: def.types[type] };
}

/** Newest first; Top: higher score first, then newest. Ties by kind and id so the order is total. */
function comparator(sort) {
    const kindRank = { vod: 0, clip: 1, paste: 2, recap: 3 };
    return (a, b) => {
        if (sort === 'top' && b.score !== a.score) return b.score - a.score;
        const ta = ts(a.item.created_at), tb = ts(b.item.created_at);
        if (tb !== ta) return tb - ta;
        if (a.item.kind !== b.item.kind) return kindRank[a.item.kind] - kindRank[b.item.kind];
        return String(b.item.id).localeCompare(String(a.item.id), undefined, { numeric: true });
    };
}

/**
 * One page of a feed. → { feed, type, sort, window, items, next, sources, partial }
 * Never rejects for an upstream failure; throws FeedError for a bad request.
 */
async function page(feed, query = {}) {
    const q = parseQuery(feed, query);
    const n = q.limit + SLACK;
    const ttl = q.sort === 'top' ? TTL_TOP_MS : TTL_NEW_MS;

    // Every source, raced against one deadline.
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, DEADLINE_MS, { timedOut: true }); });
    const results = await Promise.all(q.sources.map((name) => {
        const offset = q.offsets[name];
        const key = `${name}|${q.sort}|${q.since || ''}|${offset}|${n}`;
        const loaded = cachedPage(key, ttl, () => SOURCES[name].load(offset, n, { sort: q.sort, since: q.since }))
            .then((value) => ({ name, value }), (err) => ({ name, error: err }));
        return Promise.race([loaded, deadline.then(() => ({ name, error: { timedOut: true } }))]);
    })).finally(() => clearTimeout(timer));

    _users.clear();
    const status = {};
    const heads = [];
    for (const r of results) {
        if (r.error) {
            status[r.name] = r.error.unavailable ? 'unavailable' : (r.error.timedOut ? 'timeout' : 'error');
            if (!r.error.unavailable && !r.error.timedOut) console.warn(`[Feed] ${q.feed}/${r.name}:`, r.error.message || r.error);
            continue;
        }
        status[r.name] = 'ok';
        const src = SOURCES[r.name];
        const rows = r.value.rows || [];
        const offset = q.offsets[r.name];
        const total = r.value.total;
        // An empty answer ends the source whatever its total says: paging could not move past it.
        const more = rows.length > 0 && (total != null ? offset + rows.length < total : rows.length >= n);
        heads.push({
            name: r.name, i: 0, more,
            entries: rows.map((row) => {
                let item = null;
                try { item = src.item(row); } catch (err) { console.warn(`[Feed] ${r.name} row skipped:`, err.message); }
                return item ? { item, score: src.score(item) } : null;
            }),
        });
    }

    // Merge. Stop as soon as a source with more upstream has no fetched row left: its next row
    // might belong before anything else still waiting, so this page ends here.
    const cmp = comparator(q.sort);
    const items = [];
    while (items.length < q.limit) {
        for (const h of heads) while (h.i < h.entries.length && !h.entries[h.i]) h.i++;
        if (heads.some((h) => h.i >= h.entries.length && h.more)) break;
        let best = null;
        for (const h of heads) if (h.i < h.entries.length && (!best || cmp(h.entries[h.i], best.entries[best.i]) < 0)) best = h;
        if (!best) break;
        items.push(best.entries[best.i].item);
        best.i++;
    }
    // Skipped rows right behind the last shown one are consumed too.
    for (const h of heads) while (h.i < h.entries.length && !h.entries[h.i]) h.i++;

    const offsets = { ...q.offsets };
    let more = false;
    const failed = [];
    for (const h of heads) {
        offsets[h.name] = q.offsets[h.name] + h.i;
        if (h.more || h.i < h.entries.length) more = true;
    }
    for (const name of q.sources) {
        if (status[name] !== 'ok' && status[name] !== 'unavailable') { failed.push(name); more = true; }
    }
    const next = more ? encodeCursor({ k: q.key, o: offsets, s: q.since || undefined, f: failed.length ? failed : undefined }) : null;
    return {
        feed: q.feed, type: q.type, sort: q.sort, window: q.window,
        items: items.map(publicFeedItem),
        next,
        sources: status,
        partial: failed.length > 0,
    };
}

function _reset() { _pages.clear(); _users.clear(); }

module.exports = { page, parseQuery, FeedError, FEEDS, WINDOWS, SOURCES, DEADLINE_MS, _reset, _items: { vodItem, clipItem, pasteItem, recapItem } };
