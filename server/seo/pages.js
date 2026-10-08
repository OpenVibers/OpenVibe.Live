/**
 * SEO for the SPA — per-route server-side meta / Open Graph / Twitter / JSON-LD injection (tags
 * built with openvibe-shared/seo) and a no-JS crawlable content snapshot. Cached throughout.
 * The sitemap, robots.txt and llms files are in ./discovery.js.
 *
 * The app is a client-rendered SPA (server/index.js serves public/index.html for every route),
 * so crawlers/AI scrapers see an empty shell. This middleware intercepts the HTML routes we
 * care about (home, vods/clips/pastes lists, and vod/clip/paste detail pages), and rewrites the
 * <head> with route-specific machine-readable metadata + drops a <noscript> content snapshot so
 * no-JS scrapers get real content. Everything is cached so it adds ~no per-request DB cost.
 *
 * AI Moments (auto-clips, AI moment pastes, AI recaps) are labelled AI-made, credited to no
 * person, noindex,follow, canonical to their source VOD and left out of the sitemap (see
 * "AI Moments" below). People's work keeps normal, indexable pages.
 */
'use strict';
const path = require('node:path');
const seo = require('openvibe-shared/seo');
const { esc } = seo;
const db = require('../db/database');
const media = require('../media-client');
let config = null; try { config = require('../config'); } catch { /* */ }

// ── Short-cached Media content (VODs/clips/pastes live in OpenVibe.Media now) ──
const _mc = new Map(); // key → { v, at }
const MC_TTL_MS = 60_000;
async function _cached(key, fn) {
    const e = _mc.get(key);
    if (e && Date.now() - e.at < MC_TTL_MS) return e.v;
    let v;
    try { v = await fn(); } catch (err) {
        // A missing id is remembered too: otherwise every request for a dead link (the SPA fallback
        // then answers it 404, see server/web/page-status.js) is another round trip to Media.
        if (!err || (err.status !== 404 && err.status !== 410)) return e ? e.v : null;
        v = null;
    }
    _mc.set(key, { v, at: Date.now() });
    if (_mc.size > 300) _mc.delete(_mc.keys().next().value);
    return v;
}
const _vodList = async (limit, offset = 0) => await _cached(`vl:${limit}:${offset}`, async () => (await media.listVods({ limit, offset }))?.vods || []);
// People's clips and pastes: the AI's are listed on /moments (server/content/feed.js).
const _clipList = async (limit, offset = 0) => await _cached(`cl:${limit}:${offset}`, async () => (await media.listClips({ limit, offset, auto_generated: 0 }))?.clips || []);
const _pasteList = async (limit, offset = 0) => await _cached(`pl:${limit}:${offset}`, async () => (await require('../pastes-client').listPastes({ limit, offset, visibility: 'public', origin: 'user' }))?.pastes || []);
/**
 * Page `page` of the Content or Moments feed, as list-page items: { items, more }. The feed pages by
 * cursor, so page N follows N-1 `next` cursors (each page cached; at most FEED_MAX_PAGE deep), which
 * gives crawlers plain ?page=N links (roadmap D44) while the SPA keeps its infinite scroll.
 */
const FEED_MAX_PAGE = 20;
const FEED_PAGE_SIZE = 24;
const _feedPage = async (feed, page = 1) => await _cached(`feed:${feed}:${page}`, async () => {
    const f = require('../content/feed');
    let cursor = null, out = null;
    for (let n = 1; n <= page; n++) {
        out = await f.page(feed, { limit: FEED_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        if (n < page) { if (!out.next) return { items: [], more: false }; cursor = out.next; }
    }
    const kindLabel = { vod: 'VOD', clip: 'clip', paste: 'paste', recap: 'recap' };
    return {
        items: (out.items || []).map((it) => ({
            url: it.kind === 'paste' ? pasteHref(it.id) : it.href, name: it.title, by: it.channel ? it.channel.display_name : null,
            meta: [kindLabel[it.kind], it.duration_seconds ? _fmtDur(it.duration_seconds) : null].filter(Boolean).join(' · '),
            desc: it.excerpt,
        })),
        more: Boolean(out.next) && page < FEED_MAX_PAGE,
    };
});
const _feedList = async (feed) => (await _feedPage(feed, 1)).items;
const { isPrivate } = require('../media-proxy/access');
const pageStatus = require('../web/page-status');

// ── One item (VOD, clip, paste) ──
// Fetched at most once at a time per id and kept a minute (a missing id 30 s, a failure not at
// all). A page waits at most DETAIL_WAIT_MS for it, so a slow Media or Community never holds a
// page, or a crawler, for its whole timeout; the fetch keeps running and fills the cache. What a
// fresh fetch learned is handed to the SPA fallback's status check (server/web/page-status.js):
// a page this renderer passes on (missing, or private to this visitor) costs one upstream call.
const DETAIL_WAIT_MS = Math.max(0, pageStatus.LOOKUP_DEADLINE_MS - 500);
const DETAIL_FOUND_TTL_MS = 60_000;
const DETAIL_MISSING_TTL_MS = 30_000;
const _items = new Map();   // key → { at, ttl, state: 'found'|'missing'|null, row, pending }
function _detail(key, load) {
    let e = _items.get(key);
    if (e && !e.pending && e.state && Date.now() - e.at < e.ttl) return Promise.resolve({ state: e.state, row: e.row, fresh: false });
    if (!e || !e.pending) {
        const entry = { at: 0, ttl: 0, state: null, row: null, pending: null };
        entry.pending = Promise.resolve().then(load).then(
            (row) => { if (row && typeof row === 'object') { entry.state = 'found'; entry.row = row; entry.ttl = DETAIL_FOUND_TTL_MS; } else { entry.state = 'missing'; entry.ttl = DETAIL_MISSING_TTL_MS; } },
            (err) => { if (err && (err.status === 404 || err.status === 410)) { entry.state = 'missing'; entry.ttl = DETAIL_MISSING_TTL_MS; } },
        ).then(() => {
            entry.at = Date.now();
            entry.pending = null;
            if (!entry.state && _items.get(key) === entry) _items.delete(key);   // a failure is not remembered
            return { state: entry.state || 'unknown', row: entry.row, fresh: true };
        });
        _items.delete(key);
        _items.set(key, entry);
        if (_items.size > 1000) _items.delete(_items.keys().next().value);
        e = entry;
    }
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, DETAIL_WAIT_MS, { state: 'unknown', row: null, fresh: false }); });
    return Promise.race([e.pending, late]).finally(() => clearTimeout(timer));
}
// Callers may annotate the row they get (AI state overlay), so each gets its own copy.
const _copy = (r) => (r.row ? { ...r.row } : null);
async function _vodGet(id) {
    const r = await _detail(`v:${id}`, async () => await media.getVod(id));
    if (r.fresh && r.state !== 'unknown') pageStatus.primeMediaItem('vod', String(id), r.row);
    return _copy(r);
}
async function _clipGet(id) {
    const r = await _detail(`c:${id}`, async () => await media.getClip(id));
    if (r.fresh && r.state !== 'unknown') pageStatus.primeMediaItem('clip', String(id), r.row);
    return _copy(r);
}
async function _pasteGet(slug) {
    const r = await _detail(`p:${slug}`, async () => await require('../pastes-client').getPaste(slug));
    if (r.fresh && r.state !== 'unknown') pageStatus.primePaste(slug, r.state === 'found');
    return _copy(r);
}

// Lists (a channel's VODs, a VOD's clips, the home rails) are extras on a page: each waits at
// most LIST_WAIT_MS, and a page rendered without one is cached briefly so it fills in soon.
const LIST_WAIT_MS = 1500;
const SHORT_CACHE_MS = 30_000;
const _TIMED_OUT = Symbol('timed out');
function _within(promise, ms) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, _TIMED_OUT); });
    return Promise.race([Promise.resolve(promise).catch(() => null), late]).finally(() => clearTimeout(timer));
}
/** A cached list call, or null (and `partial` set on the tracker) when it did not answer in time. */
async function _listWithin(key, fn, track) {
    const r = await _within(_cached(key, fn), LIST_WAIT_MS);
    if (r === _TIMED_OUT || r == null) { if (track) track.partial = true; return null; }
    return r;
}
const _pub = (row) => row && !isPrivate(row) && Number(row.is_public) !== 0 && row.is_public !== false;

// Overlay the Live-owned AI state (vod_ai_state/clip_ai_state) onto a Media row so
// descriptions/transcripts keep enriching the crawlable snapshot.
async function _overlayAiState(row, kind) {
    try {
        const st = kind === 'clip' ? await db.getClipAiState(row.id) : await db.getVodAiState(row.id);
        if (!st) return;
        if (st.ai_overview_short) {
            row.ai_overview_short = row.ai_overview_short || st.ai_overview_short;
            row.ai_overview = row.ai_overview || st.ai_overview || st.ai_overview_short;
        }
        if (st.ai_transcript_json && !row.ai_transcript) {
            try { row.ai_transcript = JSON.parse(st.ai_transcript_json).map(s => s.text).join(' ').trim(); } catch { /* */ }
        }
    } catch { /* */ }
}

// Pastes live on openvibe.community: /p/<slug> is a redirect there (server/web/paste-handover.js,
// mounted before this middleware), and every paste link Live renders, here and in the SPA (which
// reads the base from the ov-pastes-base meta on every shell), points straight at Community, the
// paste's one canonical page. Live's sitemap never lists /p/ (roadmap 32.2).
const PASTES_BASE = (process.env.OV_COMMUNITY_URL || 'https://openvibe.community').replace(/\/$/, '');
const PASTES_META = `<meta name="ov-pastes-base" content="${esc(PASTES_BASE)}">`;
const pasteHref = (slug) => `${PASTES_BASE}/p/${encodeURIComponent(slug)}`;

const SITE_NAME = 'OpenVibe.Live';
const DEFAULT_OG_IMAGE = '/og-image.png';

function baseUrl() {
    let b = (config && config.baseUrl) || 'https://openvibe.live';
    if (/localhost|127\.0\.0\.1/.test(b)) b = 'https://openvibe.live'; // never emit localhost in public meta
    return b.replace(/\/+$/, '');
}
function abs(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return baseUrl() + (url.startsWith('/') ? url : '/' + url);
}
// Collapse to a clean single-line meta-description-safe string.
function clean(s, max) {
    let t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (max && t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
    return t;
}
function isoDate(dt) {
    try {
        if (!dt) return null;
        const d = new Date(String(dt).includes('T') ? dt : String(dt).replace(' ', 'T') + 'Z');
        return isNaN(d.getTime()) ? null : d.toISOString();
    } catch { return null; }
}
// Seconds → ISO-8601 duration (PT#H#M#S) for VideoObject.
function iso8601Duration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s || (!h && !m) ? s + 'S' : '');
}

// ── Build the per-route metadata object ────────────────────────────────────────────────────
// Returns { title, description, canonicalPath, image, ogType, robots, jsonLd:[...], snapshot }
// or null to fall through (unknown / private / not found).

async function _pageMeta(routePath, { page = 1 } = {}) {
    const p = routePath.replace(/\/+$/, '') || '/';
    const bu = baseUrl();

    // Home
    if (p === '/') return await _homeMeta();
    // List pages (content sourced from OpenVibe.Media, canonical URLs stay on openvibe.live)
    if (p === '/vods') return await _listMeta('vods', 'VODs', 'Browse recorded live streams (VODs) on OpenVibe.Live — auto-recorded broadcasts with AI overviews and searchable transcripts.', async () => (await _vodList(30) || []).map(v => ({ url: `/vod/${v.id}`, name: v.title || 'VOD', by: v.display_name || v.username, meta: _fmtDur(v.duration_seconds || v.duration), desc: v.ai_overview_short })));
    if (p === '/clips') return await _listMeta('clips', 'Clips', 'Watch the best clips from OpenVibe.Live live streams — the moments viewers clipped.', async () => (await _clipList(30) || []).map(c => ({ url: `/clip/${c.id}`, name: c.title || 'Clip', by: c.display_name || c.username || c.streamer_username, meta: _fmtDur(c.duration_seconds || c.duration), desc: c.ai_overview_short })));
    if (p === '/content') return await _listMeta('content', 'Content', 'VODs, clips and pastes made by the people of OpenVibe.Live — recorded streams, the moments viewers clipped, and the code, notes and screenshots they shared.', async () => await _feedPage('content', page), { page });
    if (p === '/moments') return await _listMeta('moments', 'AI Moments', 'AI-made highlights from OpenVibe.Live streams: auto-clips of the moments chat erupted, standout frames the AI picked, and AI-written after-show recaps. Everything listed here is AI-generated.', async () => await _feedPage('moments', page), { page });
    if (p === '/pastes') return await _listMeta('pastes', 'Pastes', 'Code, text and screenshot pastes shared on OpenVibe.Live — a Pastebin built into the streaming network, with AI summaries.', async () => (await _pasteList(30) || []).map(x => ({ url: pasteHref(x.slug), name: x.title || 'Paste', by: x.username || 'anon', meta: x.type === 'screenshot' ? 'image' : (x.language || 'text'), desc: x.ai_summary })));

    // Detail pages
    let m;
    if ((m = p.match(/^\/vod\/(\d+)$/))) return await _vodMeta(parseInt(m[1], 10));
    if ((m = p.match(/^\/clip\/(\d+)$/))) return await _clipMeta(parseInt(m[1], 10));
    if ((m = p.match(/^\/p\/([A-Za-z0-9_-]+)$/))) return await _pasteMeta(m[1]);
    if ((m = p.match(CHANNEL_PATH_RE))) return await _channelMeta(m[1], page);
    if ((m = p.match(/^\/recap\/(\d+)$/))) return await _recapMeta(parseInt(m[1], 10));
    if (p === '/arena') return await _arenaMeta();
    // Search results (public/js/app-search.js) are never indexed; the page itself is findable.
    if (p === '/search') return { title: `Search | ${SITE_NAME}`, description: 'Search channels, VODs and clips on OpenVibe.Live.', canonicalPath: '/search', ogType: 'website', robots: 'noindex,follow', jsonLd: [] };
    // The global chat room: its own title and canonical (the shell left it with neither; browser check, WS-Q task 3).
    if (p === '/chat') return { title: `Chat | ${SITE_NAME}`, description: 'The global chat room of OpenVibe.Live, open to everyone on the network.', canonicalPath: '/chat', ogType: 'website', robots: 'index,follow', jsonLd: [] };

    return null;
    void bu;
}

// ── Channel page: /@<username>, with ?page=N over the channel's videos ─────────────────────
// The client's channel-name rule (CHANNEL_USERNAME_RE in public/js/app.js, CHANNEL_RE in
// server/web/page-status.js): anything else is never a channel.
const CHANNEL_PATH_RE = /^\/@([A-Za-z0-9_]{3,24})$/;
const CHANNEL_PAGE_SIZE = 12;
const CHANNEL_MAX_PAGE = 500;
const CHANNEL_CACHE_MS = 60_000;   // the page says who is live, so it is kept a minute, not five

/** The account behind /@<name>: its channel row, or just the account when it has none yet. */
async function _channelAccount(username) {
    let ch = null;
    try { ch = await db.getChannelByUsername(username); } catch { ch = null; }
    let user = null;
    try { user = await db.getUserById(ch ? ch.user_id : (await db.getUserByUsername(username) || {}).id); } catch { user = null; }
    if (!ch && !user) return null;
    return {
        userId: ch ? ch.user_id : user.id,
        username: (ch && ch.username) || user.username,
        displayName: (ch && ch.display_name) || (user && user.display_name) || (ch && ch.username) || user.username,
        avatarUrl: (ch && ch.avatar_url) || (user && user.avatar_url) || null,
        bio: (ch && ch.bio) || (user && user.bio) || '',
        banned: !!(user && (user.is_banned === 1 || user.is_banned === true)),
    };
}

async function _channelMeta(username, page = 1) {
    const acct = await _channelAccount(username);
    if (!acct) return null;
    page = Math.min(CHANNEL_MAX_PAGE, Math.max(1, Math.floor(Number(page) || 1)));
    const name = acct.displayName;
    const handle = '@' + acct.username;
    const basePath = `/${handle}`;
    let ov = null;
    try { ov = db.getStreamerOverview ? await db.getStreamerOverview(acct.userId) : null; } catch { /* */ }
    let followers = 0;
    try { followers = (await require('../social/network-follows').followerCount(acct.userId)) || 0; } catch { /* */ }
    let live = [];
    try { live = acct.banned ? [] : (await db.getLiveStreamsByUserId(acct.userId) || []); } catch { live = []; }
    const bio = clean(acct.bio || '', 300);
    const aiShort = clean((ov && (ov.overview_short || ov.overview)) || '', 220);

    // What the channel has made: its videos (this page of them), the clips people took of its
    // streams, then what the AI cut from them, labelled (roadmap 33.6: made, then derived).
    const track = { partial: false };
    const offset = (page - 1) * CHANNEL_PAGE_SIZE;
    const [vr, cr, ar] = acct.banned ? [null, null, null] : await Promise.all([
        _listWithin(`chv:${acct.userId}:${offset}`, async () => await media.listVods({ user_id: acct.userId, order: 'newest', limit: CHANNEL_PAGE_SIZE, offset }, { timeoutMs: 5000 }), track),
        page === 1 ? _listWithin(`chc:${acct.userId}`, async () => await media.listClips({ channel_user_id: acct.userId, auto_generated: 0, limit: 8 }, { timeoutMs: 5000 }), track) : null,
        page === 1 ? _listWithin(`cha:${acct.userId}`, async () => await media.listClips({ channel_user_id: acct.userId, auto_generated: 1, limit: 6 }, { timeoutMs: 5000 }), track) : null,
    ]);
    const vods = ((vr && vr.vods) || []).filter((v) => _pub(v) && !v.is_recording && v.status !== 'failed');
    const vodTotal = vr && Number.isFinite(Number(vr.total)) ? Number(vr.total) : null;
    const pages = vodTotal != null ? Math.max(1, Math.ceil(vodTotal / CHANNEL_PAGE_SIZE)) : null;
    const clips = ((cr && cr.clips) || []).filter((c) => _pub(c) && !isAiClip(c));
    const aiClips = ((ar && ar.clips) || []).filter((c) => _pub(c) && isAiClip(c));
    // A page past the end has nothing on it: not a page to index, and its canonical is page 1.
    const pastEnd = page > 1 && !track.partial && (!vods.length || (pages != null && page > pages));
    const canonicalPath = page > 1 && !pastEnd ? `${basePath}?page=${page}` : basePath;
    const pageLabel = page > 1 ? ` — videos, page ${page}` : '';

    const desc = clean(bio || aiShort || `${name} (${handle}) streams live on ${SITE_NAME}. Watch their live streams, VODs and clips.`, 200);
    const image = acct.avatarUrl ? abs(acct.avatarUrl) : DEFAULT_OG_IMAGE;
    const person = {
        '@type': 'Person', name: clean(name, 80), alternateName: handle, url: abs(basePath),
        image: image !== DEFAULT_OG_IMAGE ? image : undefined,
        description: desc,
        interactionStatistic: followers ? { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: followers } : undefined,
    };
    const profile = { ...seo.jsonLd.webPage({ type: 'ProfilePage', name: `${name} (${handle})`, url: abs(canonicalPath) }), mainEntity: person };
    const ld = [profile];
    if (vods.length) {
        ld.push({
            '@context': 'https://schema.org', '@type': 'ItemList', name: `${name}'s videos${page > 1 ? `, page ${page}` : ''}`,
            itemListElement: vods.map((v, i) => ({ '@type': 'ListItem', position: offset + i + 1, url: abs(`/vod/${Number(v.id)}`), name: clean(v.title || 'Stream recording', 110) })),
        });
    }
    ld.push(_breadcrumb([{ name: 'Home', url: '/' }, { name, url: basePath }, ...(page > 1 ? [{ name: `Videos, page ${page}`, url: canonicalPath }] : [])]));

    // The page body, for crawlers and for anyone reading without JavaScript.
    let body = `<article><h1>${esc(`${name} (${handle})`)}</h1>`;
    const facts = [followers ? `${followers} follower${followers === 1 ? '' : 's'} on ${SITE_NAME}` : null];
    if (live.length) facts.push(`Live now: ${clean(live[0].title || 'streaming', 100)}`);
    if (facts.filter(Boolean).length) body += `<p class="byline">${esc(facts.filter(Boolean).join(' · '))}</p>`;
    if (acct.banned) body += '<p>This account is suspended.</p>';
    if (bio) body += `<p>${esc(bio)}</p>`;
    if (page === 1 && ov && ov.overview && String(ov.overview).trim()) {
        body += `<section><h2>AI overview</h2><p class="ai-disclosure">Written by OpenVibe's AI from ${esc(name)}'s past streams.</p><p>${esc(clean(ov.overview, 1200))}</p></section>`;
    }
    body += _itemSection(page > 1 ? `Videos, page ${page}` : 'Videos', vods.map((v) => ({
        url: `/vod/${Number(v.id)}`, name: v.title || 'Stream recording',
        meta: [_fmtDur(v.duration_seconds ?? v.duration), _day(v.created_at)].filter(Boolean).join(' · '),
    })), vods.length || page > 1 ? null : (track.partial ? null : 'No videos yet.'));
    if (vods.length || page > 1) body += _pager(basePath, page, pages, vods.length === CHANNEL_PAGE_SIZE, 'videos');
    if (clips.length) body += _itemSection('Clips', (await Promise.all(clips.map(async (c) => ({ url: `/clip/${Number(c.id)}`, name: c.title || 'Clip', meta: [await _clipperOf(c) ? `clipped by ${await _clipperOf(c)}` : null, _fmtDur(c.duration_seconds ?? c.duration)].filter(Boolean).join(' · ') })))));
    if (aiClips.length) {
        body += _itemSection('AI Moments', aiClips.map((c) => ({ url: `/clip/${Number(c.id)}`, name: c.title || 'AI clip', meta: ['AI clip', _fmtDur(c.duration_seconds ?? c.duration)].filter(Boolean).join(' · ') })),
            null, `<p class="ai-disclosure">Clips OpenVibe's AI cut from ${esc(name)}'s streams when chat reacted. No one clipped these.</p>`);
    }
    body += `<p><a href="${esc(abs(basePath))}">Visit ${esc(name)}'s channel</a> on ${SITE_NAME}.</p></article>`;

    return {
        title: `${name} (${handle})${pageLabel} — ${SITE_NAME}`, description: desc,
        canonicalPath, image, ogType: 'profile',
        robots: acct.banned || pastEnd ? 'noindex,follow' : 'index,follow',
        jsonLd: ld, snapshot: body,
        cacheTtlMs: track.partial ? SHORT_CACHE_MS : CHANNEL_CACHE_MS,
    };
}

/** "Page 2 of 5" with newer/older links (?page=N), the crawlable form of the channel's video list. */
function _pager(basePath, page, pages, maybeMore, noun) {
    const href = (n) => esc(abs(n > 1 ? `${basePath}?page=${n}` : basePath));
    const parts = [];
    if (page > 1) parts.push(`<a rel="prev" href="${href(page - 1)}">Newer ${noun}</a>`);
    parts.push(`Page ${page}${pages ? ` of ${pages}` : ''}`);
    if (pages ? page < pages : maybeMore) parts.push(`<a rel="next" href="${href(page + 1)}">Older ${noun}</a>`);
    return `<nav class="pagination" aria-label="Pages">${parts.join(' · ')}</nav>`;
}
/** A heading and a list of links with their details; `empty` when there is nothing, `intro` above. */
function _itemSection(heading, items, empty = null, intro = '') {
    if (!items.length && !empty) return '';
    const li = items.map((it) => `<li><a href="${esc(abs(it.url))}">${esc(clean(it.name, 120))}</a>${it.meta ? ` — ${esc(it.meta)}` : ''}</li>`).join('');
    return `<section><h2>${esc(heading)}</h2>${intro}${items.length ? `<ul>${li}</ul>` : `<p>${esc(empty)}</p>`}</section>`;
}
const _day = (dt) => { const d = isoDate(dt); return d ? d.slice(0, 10) : null; };
/** A person's clip's clipper, from Live's accounts (Media rows carry ids only). */
async function _clipperOf(c) { return c.display_name || c.username || _nameOf(await _channelOwner(c.user_id)); }

// The Arena: a real content page (mic-judged trash talk), so give it real metadata.
async function _arenaMeta() {
    let fighters = [], moments = [];
    try { fighters = (await require('../arena/arena-service').loadRoster() || {}).order || []; } catch { fighters = []; }
    try { moments = await require('../arena/mic').feed({ limit: 10 }) || []; } catch { moments = []; }
    const nameOf = async (id) => { try { return await require('../arena/mic').nameOf(id); } catch { return null; } };
    const names = (await Promise.all(fighters.slice(0, 8).map(nameOf))).filter(Boolean);
    const title = 'The Arena — Mic-Judged Trash Talk Between Streamers';
    const desc = clean(`Every callout streamers make on mic, judged and ranked. ${names.length ? 'Fighters right now: ' + names.slice(0, 5).join(', ') + '. ' : ''}Chat can hype a beef but never write one.`, 200);
    const items = moments.slice(0, 10).map((mo) => ({ name: clean(mo.text || 'Mic moment', 110) }));
    const snapshot = _detailSnapshot({
        title: 'The Arena', byline: names.length ? `Fighters: ${names.join(', ')}` : null,
        desc, overview: moments.slice(0, 8).map(mo => mo.text).filter(Boolean).join(' · ') || null,
        transcript: null, canonicalPath: '/arena', watchLabel: 'Open the Arena',
    });
    return {
        title: `${title} | ${SITE_NAME}`, description: desc, canonicalPath: '/arena',
        image: DEFAULT_OG_IMAGE, ogType: 'website', robots: 'index,follow',
        jsonLd: [
            seo.jsonLd.webPage({ type: 'CollectionPage', name: title, url: abs('/arena'), description: desc }),
            ...(items.length ? [seo.jsonLd.itemList('Latest mic moments', items)] : []),
            _breadcrumb([{ name: 'Home', url: '/' }, { name: 'The Arena', url: '/arena' }]),
        ],
        snapshot,
    };
}

// After-show report: /recap/:streamId
// The AI-written report is an AI Moment: labelled, attributed to no person (the streamer did not
// write it), noindex,follow and canonical to the stream's VOD when there is one. A template report
// (stats only, no model) is not AI writing and keeps its own indexable page; it has no Person
// author either, since the streamer did not write that one.
async function _recapMeta(streamId) {
    let r; try { r = await require('../recap/recap').getRecap(streamId); } catch { r = null; }
    if (!r) return null;
    const ai = r.ai === true || Number(r.ai) === 1;
    const name = r.streamer.display_name || r.streamer.username;
    const title = clean(`${r.write.headline || r.stream.title}`, 90);
    const desc = clean(ai
        ? `AI-written after-show report on ${name}'s stream "${r.stream.title}". ${r.write.summary || ''}`
        : (r.write.summary || `After-show report for ${name}'s stream "${r.stream.title}" on ${SITE_NAME}.`), 200);
    const image = r.vod && r.vod.thumbnail_url ? media.publicUrl(r.vod.thumbnail_url) : (r.streamer.avatar_url ? abs(r.streamer.avatar_url) : DEFAULT_OG_IMAGE);
    const selfPath = `/recap/${streamId}`;
    const source = ai && r.vod ? await _sourceMoment(r.vod.id, 0) : null;
    const article = {
        ...seo.jsonLd.article({ headline: title, url: abs(selfPath), description: desc, image: [image], datePublished: isoDate(r.stream.ended_at) || undefined }),
        keywords: ai ? AI_KEYWORDS : undefined,
        isBasedOn: source ? abs(source.path) : undefined,
        publisher: { '@type': 'Organization', name: SITE_NAME, url: baseUrl() },
    };
    const byline = `${ai ? 'AI recap · from' : 'Report on'} ${name}'s stream · ${Math.round((r.stream.duration_seconds || 0) / 60)} min · grade ${r.write.grade}`;
    const extraHtml = (ai ? '<p class="ai-disclosure">Written automatically by OpenVibe\'s after-show report workflow from the stream\'s stats, chat and transcript. The streamer did not write it.</p>' : '')
        + `<p class="source">${source ? `<a href="${esc(abs(source.path))}">Watch the stream</a> · ` : ''}<a href="${esc(abs(`/@${r.streamer.username}`))}">${esc(name)}'s channel</a></p>`;
    const snapshot = _detailSnapshot({ title: `After-show report: ${r.stream.title}`, byline, desc, extraHtml, overview: r.write.summary, transcript: null, canonicalPath: selfPath, watchLabel: 'Read the report' });
    return {
        title: `${title} — ${ai ? 'AI recap of ' : ''}${name}'s stream${ai ? '' : ' report'} | ${SITE_NAME}`, description: desc,
        canonicalPath: source ? source.path : selfPath, ogUrlPath: selfPath, image, ogType: 'article',
        robots: ai ? AI_ROBOTS : 'index,follow',
        jsonLd: [article, _breadcrumb([{ name: 'Home', url: '/' }, { name, url: `/@${r.streamer.username}` }, { name: ai ? 'AI recap' : 'Report', url: selfPath }])],
        snapshot,
    };
}

// A crawlable <section> listing media items with real detail (title, streamer, meta).
function _mediaSection(heading, items) {
    if (!items || !items.length) return '';
    const li = items.map(it => {
        const bits = [];
        if (it.by) bits.push('by ' + esc(it.by));
        if (it.meta) bits.push(esc(it.meta));
        return `<li><a href="${esc(abs(it.url))}">${esc(clean(it.name, 120))}</a>${bits.length ? ' — ' + bits.join(' · ') : ''}${it.desc ? `<br><small>${esc(clean(it.desc, 160))}</small>` : ''}</li>`;
    }).join('');
    return `<section><h2>${esc(heading)}</h2><ul>${li}</ul></section>`;
}
// m:ss, or h:mm:ss from an hour up; '' for nothing.
function _fmtDur(sec) {
    sec = Math.floor(Number(sec) || 0);
    if (!sec) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

async function _homeMeta() {
    // Going live from the browser (no OBS, no downloads, no follower minimum) leads: it is what people ask
    // search engines and AI assistants for, and what they recommend OpenVibe.Live for (2026-09-28).
    const title = 'OpenVibe.Live — Go Live From Your Browser, No OBS Needed';
    const description = 'Go live instantly from your browser: no OBS, no downloads, no follower minimum. Open-source, community-run streaming with sub-second WebRTC, chat, VODs, clips and restreaming to Twitch, YouTube and Kick.';

    // Pull the actual live content so the source has real, crawlable text.
    let live = [];
    try { live = (await db.getLiveStreams() || []).slice(0, 12); } catch { /* */ }
    // Each rail waits at most LIST_WAIT_MS: a slow upstream leaves its rail out, never the page.
    // VODs, clips and pastes are counted by the services that hold them (Media, Community), not Live's frozen tables.
    let homeStats = null;
    try { homeStats = { ...await db.getHomeStats() }; } catch { homeStats = null; }
    const track = { partial: false };
    const settle = async (promise) => { const r = await _within(promise, LIST_WAIT_MS); if (r === _TIMED_OUT) { track.partial = true; return null; } return r; };
    let [vods, clips, pastes, stats] = await Promise.all([
        settle(_vodList(12)), settle(_clipList(12)), settle(_pasteList(12)),
        homeStats ? settle(require('../media-proxy/lookups').withArchiveStats(homeStats)) : null,
    ]);
    vods = vods || []; clips = clips || []; pastes = pastes || [];
    const ownerName = async (row, id) => row.display_name || row.username || _nameOf(await _channelOwner(id));

    const liveItems = live.map(s => ({ url: `/@${s.username}`, name: s.title || `${s.display_name || s.username} live`, by: s.display_name || s.username, meta: s.category || 'live' }));
    const vodItems = (await Promise.all(vods.map(async v => ({ url: `/vod/${v.id}`, name: v.title || 'VOD', by: await ownerName(v, v.user_id), meta: _fmtDur(v.duration_seconds || v.duration), desc: v.ai_overview_short }))));
    const clipItems = (await Promise.all(clips.map(async c => ({ url: `/clip/${c.id}`, name: c.title || 'Clip', by: await ownerName(c, c.user_id), meta: _fmtDur(c.duration_seconds || c.duration) }))));
    const pasteItems = pastes.map(x => ({ url: pasteHref(x.slug), name: x.title || 'Paste', by: x.username || 'anon', meta: x.type === 'screenshot' ? 'image' : (x.language || 'text') }));

    const statLine = stats ? `<p>${SITE_NAME} hosts ${stats.streamers || 0} streamers, ${stats.vods || 0} VODs, ${stats.clips || 0} clips, ${stats.pastes || 0} pastes and ${stats.chatMessages || 0} chat messages.</p>` : '';
    const snapshot =
        `<h1>${SITE_NAME} — go live from your browser, no OBS needed</h1>` +
        `<p>${esc(description)}</p>` +
        '<section><h2>Go live in your browser</h2><ol>' +
        '<li>Open openvibe.live in Chrome, Edge, Firefox or Safari — on a Chromebook, laptop or phone.</li>' +
        '<li>Sign in or make an account; your channel exists right away.</li>' +
        '<li>Press Go Live and allow your camera and microphone.</li>' +
        '<li>Add a title and start: you are live with your own channel and chat.</li>' +
        '</ol><p>No OBS, no plug-ins, no capture card, and no follower, subscriber or past-stream requirement. ' +
        `<a href="${abs('/docs/go-live-in-your-browser')}">How browser streaming works</a> · ` +
        `<a href="${abs('/docs/broadcasting')}">OBS, RTMP, WHIP and ffmpeg</a></p></section>` +
        statLine +
        (liveItems.length ? _mediaSection('Live now', liveItems) : '<section><h2>Live now</h2><p>No one is streaming right now — be the first to go live.</p></section>') +
        _mediaSection('Recent VODs', vodItems) +
        _mediaSection('Recent clips', clipItems) +
        _mediaSection('Recent pastes', pasteItems);

    // Rich JSON-LD: WebSite + one ItemList per section of the snapshot, named by that section's visible
    // heading (structured data names what a visitor sees; the browser check compares them).
    const itemList = (name, items) => seo.jsonLd.itemList(name, items.slice(0, 10).map((it) => ({ url: abs(it.url), name: clean(it.name, 110) })));
    const lists = [['Live now', liveItems], ['Recent VODs', vodItems], ['Recent clips', clipItems]].filter(([, items]) => items.length).map(([n, items]) => itemList(n, items));
    const jsonLd = [
        seo.jsonLd.website({ name: SITE_NAME, url: baseUrl(), description: clean(description, 300) }),
        {
            ...seo.jsonLd.softwareApp({ name: SITE_NAME, url: baseUrl(), category: 'MultimediaApplication',
                description: 'Live streaming you start from a web browser: no OBS, no downloads and no follower minimum.' }),
            browserRequirements: 'A current Chrome, Edge, Firefox or Safari with camera and microphone access',
            featureList: [
                'Go live from the browser with no OBS or other software (WebRTC, under one second of delay)',
                'No follower, subscriber or past-stream requirement to go live',
                'Works on Chromebooks, laptops and phones',
                'Screen, window and tab sharing with a camera picture-in-picture',
                'OBS/RTMP, WHIP and ffmpeg ingest for produced shows',
                'Live chat, VODs, clips and restreaming to Twitch, YouTube and Kick',
                'Open source and community run',
            ],
        },
        // The OpenVibe organisation every site names (openvibe-shared/seo); sameAs is how a search
        // engine learns these properties are one brand rather than unrelated sites sharing a name.
        seo.jsonLd.organization({
            description: 'An open-source network of live streaming, media and developer tools, built and run by the people who use it.',
            sameAs: ['https://github.com/OpenVibers', 'https://discord.gg/M6MuRUaeJj', 'https://openvibe.tools', 'https://openvibe.network', baseUrl()],
        }),
        ...lists,
    ];
    return { title, description, canonicalPath: '/', image: DEFAULT_OG_IMAGE, ogType: 'website', robots: 'index,follow', jsonLd, snapshot, cacheTtlMs: track.partial ? SHORT_CACHE_MS : undefined };
}

/**
 * A list page. `itemsFn` gives an array, or { items, more } for a paged list (page N of it: ?page=N,
 * self-canonical, with newer/older links; a page past the end is not rendered here).
 */
async function _listMeta(slug, label, description, itemsFn, { page = 1 } = {}) {
    let items = [], more = null;
    try {
        const got = await itemsFn();
        if (Array.isArray(got)) items = got.slice(0, 24);
        else if (got) { items = (got.items || []).slice(0, 24); more = Boolean(got.more); }
    } catch { /* */ }
    if (page > 1 && !items.length) return null;
    const basePath = '/' + slug;
    const selfPath = page > 1 ? `${basePath}?page=${page}` : basePath;
    const pageLabel = page > 1 ? `, page ${page}` : '';
    const list = {
        ...seo.jsonLd.webPage({ type: 'CollectionPage', name: `${label}${pageLabel} — ${SITE_NAME}`, url: abs(selfPath), description }),
        mainEntity: {
            '@type': 'ItemList',
            itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: (page - 1) * 24 + i + 1, url: abs(it.url), name: clean(it.name, 110) })),
        },
    };
    let snapshot = `<h1>${esc(label)} on ${SITE_NAME}${page > 1 ? ` — page ${page}` : ''}</h1><p>${esc(description)}</p>` +
        _mediaSection(page > 1 ? `${label}, page ${page}` : `Latest ${label.toLowerCase()}`, items);
    if (more !== null && (page > 1 || more)) snapshot += _pager(basePath, page, null, more, label.toLowerCase());
    return {
        title: `${label}${pageLabel} — ${SITE_NAME}`, description, canonicalPath: selfPath,
        image: DEFAULT_OG_IMAGE, ogType: 'website', robots: 'index,follow',
        jsonLd: [list, _breadcrumb([{ name: 'Home', url: '/' }, { name: label, url: basePath }, ...(page > 1 ? [{ name: `Page ${page}`, url: selfPath }] : [])])],
        snapshot,
    };
}

function _authorLd(name) { return name ? { '@type': 'Person', name: clean(name, 80) } : undefined; }

// ── AI Moments (roadmap §33.4, §33.8) ───────────────────────────────────────────────────────
// What the AI made from a stream (auto-clips, AI moment pastes, AI after-show recaps) is labelled
// as AI-made, attributed to no person, kept out of search (noindex,follow: the page still passes
// its links on) and made canonical to its source: the VOD at the moment it came from, when that
// VOD is known and public. The store decides what is AI (Media's auto_generated, Community's
// origin, the recap's own ai flag); nothing is inferred here. People's clips and pastes keep their
// normal, indexable pages.
const AI_ROBOTS = 'noindex,follow';
const AI_KEYWORDS = 'AI-generated';
const VOD_MOMENT_RE = /^\/vod\/(\d+)(?:\?t=(\d+(?:\.\d+)?))?$/;

const isAiClip = (c) => !!c && (c.auto_generated === true || Number(c.auto_generated) === 1);
const isAiPaste = (p) => !!p && p.origin === 'ai';
function _json(v) {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
/** The Live account a stream-derived item belongs to (the channel, never a viewer). */
async function _channelOwner(userId) {
    if (userId == null || userId === '') return null;
    try { return await db.getUserById(Number(userId)) || null; } catch { return null; }
}
const _nameOf = (u) => (u ? (u.display_name || u.username) : null);

/**
 * `/vod/<id>?t=<s>` for the moment an item came from, or null when the VOD is unknown, gone or
 * not public (a canonical must never point at a page that answers 404 to the crawler).
 */
async function _sourceMoment(vodId, seconds) {
    if (vodId == null || !/^\d+$/.test(String(vodId))) return null;
    const v = await _vodGet(Number(vodId));
    if (!v || !_pub(v)) return null;
    const t = Math.max(0, Math.floor(Number(seconds) || 0));
    return { path: `/vod/${Number(vodId)}${t ? `?t=${t}` : ''}`, vod: v };
}

async function _vodMeta(id) {
    const v = await _vodGet(id);
    // Private: fall through exactly like an unknown id. This HTML is cached per id and shared by
    // every visitor, so it never carries a private VOD's title, overview or transcript.
    if (!v || isPrivate(v)) return null;
    if (v.duration_seconds == null && v.duration != null) v.duration_seconds = v.duration;
    await _overlayAiState(v, 'vod');
    const indexable = Number(v.is_public) === 1 && (!v.visibility || v.visibility === 'public');
    const owner = await _channelOwner(v.user_id);
    const author = v.display_name || v.username || _nameOf(owner);
    const title = clean(v.title || `${author ? author + "'s " : ''}stream VOD`, 80);
    const desc = clean(v.ai_overview_short || v.ai_overview || v.description || `Recorded live stream${author ? ' by ' + author : ''} on ${SITE_NAME}.`, 200);
    const image = v.thumbnail_url ? media.publicUrl(v.thumbnail_url) : media.thumbUrl(`vod-${id}`);
    const canonicalPath = `/vod/${id}`;

    // The clips of this VOD: people's, then the AI's. Every one is also a moment of this video
    // (schema.org Clip in hasPart), so the source carries its moments (roadmap 33.8).
    const track = { partial: false };
    const cr = await _listWithin(`vc:${id}`, async () => await media.listClips({ vod_id: id, limit: 30 }, { timeoutMs: 5000 }), track);
    const all = ((cr && cr.clips) || []).filter((c) => _pub(c) && (!c.status || c.status === 'ready'));
    const people = all.filter((c) => !isAiClip(c));
    const ai = all.filter(isAiClip);
    const at = (c) => Math.max(0, Math.floor(Number(c.start_time) || 0));
    const parts = all.filter((c) => Number.isFinite(Number(c.start_time))).slice(0, 20).map((c) => ({
        '@type': 'Clip', name: clean(c.title || (isAiClip(c) ? 'AI clip' : 'Clip'), 110),
        startOffset: at(c), endOffset: Number.isFinite(Number(c.end_time)) ? Math.max(at(c) + 1, Math.ceil(Number(c.end_time))) : undefined,
        url: abs(`/vod/${id}?t=${at(c)}`),
    }));
    const vo = {
        ...seo.jsonLd.video({
            name: title, url: abs(canonicalPath), description: desc, thumbnailUrl: [image],
            uploadDate: isoDate(v.created_at) || undefined, duration: iso8601Duration(v.duration_seconds),
            contentUrl: abs(canonicalPath), embedUrl: abs(canonicalPath),
        }),
        interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/WatchAction', userInteractionCount: Number(v.view_count) || 0 },
        author: _authorLd(author), publisher: { '@type': 'Organization', name: SITE_NAME, url: baseUrl() },
        hasPart: parts.length ? parts : undefined,
    };
    const moment = (c) => `/vod/${id}?t=${at(c)}`;
    let extraHtml = owner ? `<p class="source"><a href="${esc(abs(`/@${owner.username}`))}">${esc(author || owner.username)}'s channel</a></p>` : '';
    extraHtml += _itemSection('Clips from this stream', (await Promise.all(people.map(async (c) => ({ url: `/clip/${Number(c.id)}`, name: c.title || 'Clip', meta: [await _clipperOf(c) ? `clipped by ${await _clipperOf(c)}` : null, `at ${_fmtDur(at(c)) || '0:00'}`].filter(Boolean).join(' · ') })))));
    if (ai.length) {
        extraHtml += _itemSection('AI Moments from this stream', ai.map((c) => ({ url: `/clip/${Number(c.id)}`, name: c.title || 'AI clip', meta: `AI clip · at ${_fmtDur(at(c)) || '0:00'}` })),
            null, '<p class="ai-disclosure">Cut automatically by OpenVibe\'s auto-clip workflow. No one clipped these.</p>');
        extraHtml += `<p>${ai.slice(0, 6).map((c) => `<a href="${esc(abs(moment(c)))}">Jump to ${esc(_fmtDur(at(c)) || '0:00')}</a>`).join(' · ')}</p>`;
    }
    const snapshot = _detailSnapshot({
        title, byline: author ? `Streamed by ${author}` : null, desc, extraHtml,
        overview: v.ai_overview, transcript: v.ai_transcript, canonicalPath, watchLabel: 'Watch this VOD',
    });
    return {
        title: `${title}${author ? ' — ' + author : ''} | ${SITE_NAME}`, description: desc,
        canonicalPath, image, ogType: 'video.other', robots: indexable ? 'index,follow' : 'noindex,follow',
        video: { duration: Math.floor(Number(v.duration_seconds) || 0) },
        jsonLd: [vo, _breadcrumb([{ name: 'Home', url: '/' }, ...(owner ? [{ name: author || owner.username, url: `/@${owner.username}` }] : [{ name: 'VODs', url: '/vods' }]), { name: title, url: canonicalPath }])],
        snapshot,
        cacheTtlMs: track.partial ? SHORT_CACHE_MS : undefined,
    };
}

async function _clipMeta(id) {
    const c = await _clipGet(id);
    if (!c || isPrivate(c)) return null;   // private: same as unknown (see _vodMeta)
    if (c.duration_seconds == null && c.duration != null) c.duration_seconds = c.duration;
    await _overlayAiState(c, 'clip');
    if (isAiClip(c)) return await _aiClipMeta(c, id);
    const indexable = Number(c.is_public) === 1 && (!c.visibility || c.visibility === 'public');
    // Media stores ids only: the clipper's name comes from Live's accounts.
    const creator = c.display_name || c.username || _nameOf(await _channelOwner(c.user_id));
    const title = clean(c.title || 'Clip', 80);
    const desc = clean(c.ai_overview_short || c.ai_overview || c.description || `A clip from a live stream on ${SITE_NAME}${creator ? ', clipped by ' + creator : ''}.`, 200);
    const image = c.thumbnail_url ? media.publicUrl(c.thumbnail_url) : media.thumbUrl(`clip-${id}`);
    const canonicalPath = `/clip/${id}`;
    const vo = {
        ...seo.jsonLd.video({
            name: title, url: abs(canonicalPath), description: desc, thumbnailUrl: [image],
            uploadDate: isoDate(c.created_at) || undefined, duration: iso8601Duration(c.duration_seconds),
            contentUrl: abs(canonicalPath), embedUrl: abs(canonicalPath),
        }),
        interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/WatchAction', userInteractionCount: Number(c.view_count) || 0 },
        author: _authorLd(creator), publisher: { '@type': 'Organization', name: SITE_NAME, url: baseUrl() },
    };
    const channel = await _channelOwner(c.channel_user_id);
    const source = await _sourceMoment(c.vod_id, c.start_time);
    const sourceHtml = (source || channel) ? `<p class="source">${source ? `<a href="${esc(abs(source.path))}">Watch it in the full stream</a>` : ''}${source && channel ? ' · ' : ''}${channel ? `<a href="${esc(abs(`/@${channel.username}`))}">${esc(_nameOf(channel))}'s channel</a>` : ''}</p>` : '';
    const snapshot = _detailSnapshot({
        title, byline: creator ? `Clipped by ${creator}${channel && channel.id !== Number(c.user_id) ? ` from ${_nameOf(channel)}'s stream` : ''}` : null, desc,
        extraHtml: sourceHtml,
        overview: c.ai_overview, transcript: c.ai_transcript, canonicalPath, watchLabel: 'Watch this clip',
    });
    return {
        title: `${title} — clip | ${SITE_NAME}`, description: desc,
        canonicalPath, image, ogType: 'video.other', robots: indexable ? 'index,follow' : 'noindex,follow',
        video: { duration: Math.floor(Number(c.duration_seconds) || 0) },
        jsonLd: [vo, _breadcrumb([{ name: 'Home', url: '/' }, ...(channel ? [{ name: _nameOf(channel), url: `/@${channel.username}` }] : [{ name: 'Clips', url: '/clips' }]), { name: title, url: canonicalPath }])],
        snapshot,
    };
}

/** An auto-clip: "AI clip · from <streamer>'s stream", canonical to the VOD at the moment. */
async function _aiClipMeta(c, id) {
    const owner = await _channelOwner(c.channel_user_id != null ? c.channel_user_id : c.user_id);
    const streamer = _nameOf(owner);
    const from = streamer ? `${streamer}'s stream` : 'a live stream';
    const title = clean(c.title || 'AI clip', 80);
    const source = await _sourceMoment(c.vod_id, c.start_time);
    const desc = clean(`AI-generated clip from ${from} on ${SITE_NAME}. ${c.ai_overview_short || c.ai_overview || c.description || ''}`, 200);
    const image = c.thumbnail_url ? media.publicUrl(c.thumbnail_url) : media.thumbUrl(`clip-${id}`);
    const selfPath = `/clip/${id}`;
    const vo = {
        ...seo.jsonLd.video({
            name: title, url: abs(selfPath), description: desc, thumbnailUrl: [image],
            uploadDate: isoDate(c.created_at) || undefined, duration: iso8601Duration(c.duration_seconds),
            contentUrl: abs(selfPath), embedUrl: abs(selfPath),
        }),
        // No author or creator: a workflow cut this, not a person.
        keywords: AI_KEYWORDS,
        isBasedOn: source ? abs(source.path) : undefined,
        publisher: { '@type': 'Organization', name: SITE_NAME, url: baseUrl() },
    };
    const sourceLink = source
        ? `<p class="source"><a href="${esc(abs(source.path))}">Watch this moment in the full stream</a>${owner ? ` · <a href="${esc(abs(`/@${owner.username}`))}">${esc(streamer)}'s channel</a>` : ''}</p>`
        : (owner ? `<p class="source"><a href="${esc(abs(`/@${owner.username}`))}">${esc(streamer)}'s channel</a></p>` : '');
    const snapshot = _detailSnapshot({
        title, byline: `AI clip · from ${from}`, desc,
        extraHtml: `<p class="ai-disclosure">Cut automatically by OpenVibe's auto-clip workflow when chat reacted. No person clipped it.</p>${sourceLink}`,
        overview: c.ai_overview, transcript: c.ai_transcript, canonicalPath: selfPath, watchLabel: 'Watch this AI clip',
    });
    return {
        title: `${title} — AI clip from ${from} | ${SITE_NAME}`, description: desc,
        canonicalPath: source ? source.path : selfPath, ogUrlPath: selfPath, image, ogType: 'video.other', robots: AI_ROBOTS,
        video: { duration: Math.floor(Number(c.duration_seconds) || 0) },
        jsonLd: [vo, _breadcrumb([{ name: 'Home', url: '/' }, { name: 'AI Moments', url: '/moments' }, { name: title, url: selfPath }])],
        snapshot,
    };
}

async function _pasteMeta(slug) {
    const p = await _pasteGet(slug);
    if (!p) return null;
    if (isAiPaste(p)) return await _aiPasteMeta(p, slug);
    const isScreenshot = p.type === 'screenshot';
    // Only public, non-NSFW, non-burn pastes are indexable.
    const indexable = (p.visibility === 'public' || p.visibility == null) && !Number(p.is_nsfw) && !Number(p.burn_after_read);
    const author = p.display_name || p.username;
    const title = clean(p.title || (isScreenshot ? 'Screenshot' : 'Paste'), 80);
    const desc = clean(p.ai_summary || (isScreenshot ? `A screenshot shared on ${SITE_NAME}.` : String(p.content || '').slice(0, 220)) || `A paste on ${SITE_NAME}.`, 200);
    let image = DEFAULT_OG_IMAGE;
    if (isScreenshot && p.screenshot_url) image = media.publicUrl(p.screenshot_url);
    else if (isScreenshot && p.screenshot_path) image = media.screenshotUrl(path.basename(p.screenshot_path));
    const canonicalPath = `/p/${slug}`;
    let tags = [];
    try { tags = p.ai_tags ? JSON.parse(p.ai_tags) : []; } catch { tags = []; }
    const ld = isScreenshot
        ? { '@context': 'https://schema.org', '@type': 'ImageObject', name: title, description: desc, contentUrl: image, uploadDate: isoDate(p.created_at) || undefined, author: _authorLd(author) }
        : { '@context': 'https://schema.org', '@type': 'SoftwareSourceCode', name: title, description: desc, programmingLanguage: p.language && p.language !== 'text' ? p.language : undefined, dateCreated: isoDate(p.created_at) || undefined, author: _authorLd(author), keywords: (Array.isArray(tags) && tags.length) ? tags.join(', ') : undefined };
    const snapshot = _detailSnapshot({
        title, byline: author ? `Shared by ${author}` : null, desc,
        overview: p.ai_summary, transcript: (!isScreenshot ? String(p.content || '').slice(0, 1200) : null),
        canonicalPath, watchLabel: 'View this paste',
    });
    return {
        title: `${title} — paste | ${SITE_NAME}`, description: desc,
        canonicalPath, image, ogType: isScreenshot ? 'article' : 'article', robots: indexable ? 'index,follow' : 'noindex,follow',
        jsonLd: [ld, _breadcrumb([{ name: 'Home', url: '/' }, { name: 'Pastes', url: '/pastes' }, { name: title, url: canonicalPath }])],
        snapshot,
    };
}

/** The VOD recorded from a stream (the longest public one), for items that know only their stream. */
const _vodOfStream = async (streamId) => await _cached(`vs:${streamId}`, async () => {
    const r = await media.listVods({ stream_id: streamId, limit: 3 });
    const rows = (r && r.vods) || [];
    return rows.filter((v) => v && !isPrivate(v) && Number(v.is_public) !== 0)
        .sort((a, b) => (Number(b.duration_seconds ?? b.duration) || 0) - (Number(a.duration_seconds ?? a.duration) || 0))[0] || null;
});

/**
 * An AI moment paste (a frame the AI picked from a VOD, or one it "caught live"):
 * "AI note · from <stream>", canonical to the VOD at that second when the VOD is known.
 */
async function _aiPasteMeta(p, slug) {
    const meta = _json(p.metadata) || {};
    const streamId = p.stream_id || meta.stream_id || null;
    let stream = null;
    try { stream = streamId ? await db.getStreamById(Number(streamId)) : null; } catch { stream = null; }
    const owner = stream ? await _channelOwner(stream.user_id) : (meta.username ? await db.getUserByUsername(String(meta.username)).catch(() => null) : null);
    const streamer = _nameOf(owner);
    const streamTitle = stream && stream.title ? clean(stream.title, 90) : null;
    const from = streamTitle ? `"${streamTitle}"` : (streamer ? `${streamer}'s stream` : 'a live stream');
    // The source: the VOD link the job recorded, else the VOD of the stream it was caught on.
    let source = null;
    const link = typeof meta.vod_link === 'string' ? meta.vod_link.match(VOD_MOMENT_RE) : null;
    if (link) source = await _sourceMoment(link[1], link[2]);
    else if (streamId) {
        let v = null;
        try { v = await _vodOfStream(Number(streamId)); } catch { v = null; }
        if (v) source = await _sourceMoment(v.id, meta.offset);
    }
    const isScreenshot = p.type === 'screenshot';
    const title = clean(p.title || 'AI moment', 80);
    const desc = clean(`AI-generated note from ${from} on ${SITE_NAME}. ${p.ai_summary || ''}`, 200);
    let image = DEFAULT_OG_IMAGE;
    if (isScreenshot && p.screenshot_url) image = media.publicUrl(p.screenshot_url);
    const selfPath = `/p/${slug}`;
    const ld = {
        '@context': 'https://schema.org', '@type': isScreenshot ? 'ImageObject' : 'CreativeWork',
        name: title, description: desc, contentUrl: isScreenshot ? image : undefined,
        dateCreated: isoDate(p.created_at) || undefined,
        // No author: the AI wrote it, and it is not a person.
        keywords: AI_KEYWORDS,
        isBasedOn: source ? abs(source.path) : undefined,
        publisher: { '@type': 'Organization', name: SITE_NAME, url: baseUrl() },
    };
    const at = meta.offset != null && Number.isFinite(Number(meta.offset)) ? ` at ${_fmtDur(Number(meta.offset)) || '0:00'}` : '';
    const sourceLink = source
        ? `<p class="source"><a href="${esc(abs(source.path))}">Watch this moment in the full stream${esc(at)}</a>${owner ? ` · <a href="${esc(abs(`/@${owner.username}`))}">${esc(streamer)}'s channel</a>` : ''}</p>`
        : (owner ? `<p class="source"><a href="${esc(abs(`/@${owner.username}`))}">${esc(streamer)}'s channel</a></p>` : '');
    const snapshot = _detailSnapshot({
        title, byline: `AI note · from ${from}${at}`, desc,
        extraHtml: `<p class="ai-disclosure">Written automatically by OpenVibe's AI moments workflow${meta.live ? ' while the stream was live' : ' from the recording'}. No person wrote it.</p>${sourceLink}`,
        overview: null, transcript: null, canonicalPath: selfPath, watchLabel: 'View this AI note',
    });
    return {
        title: `${title} — AI note from ${from} | ${SITE_NAME}`, description: desc,
        canonicalPath: source ? source.path : selfPath, ogUrlPath: selfPath, image, ogType: 'article', robots: AI_ROBOTS,
        jsonLd: [ld, _breadcrumb([{ name: 'Home', url: '/' }, { name: 'AI Moments', url: '/moments' }, { name: title, url: selfPath }])],
        snapshot,
    };
}

function _breadcrumb(items) {
    return seo.jsonLd.breadcrumbs(items.map((it) => ({ name: clean(it.name, 90), url: abs(it.url) })));
}
// `extraHtml` is markup the caller built (and escaped) itself.
function _detailSnapshot({ title, byline, desc, extraHtml, overview, transcript, canonicalPath, watchLabel }) {
    let html = `<article><h1>${esc(title)}</h1>`;
    if (byline) html += `<p class="byline">${esc(byline)}</p>`;
    if (desc) html += `<p>${esc(desc)}</p>`;
    if (extraHtml) html += extraHtml;
    if (overview && String(overview).trim()) html += `<section><h2>AI overview</h2><p>${esc(clean(overview, 1200))}</p></section>`;
    if (transcript && String(transcript).trim()) html += `<section><h2>Transcript</h2><p>${esc(clean(transcript, 1500))}</p></section>`;
    html += `<p><a href="${esc(abs(canonicalPath))}">${esc(watchLabel || 'Open')}</a> on ${SITE_NAME}.</p></article>`;
    return html;
}

// ── Inject metadata into the base index.html ────────────────────────────────────────────────
// The base document comes from server/web/assets.js: index.html with its asset URLs rewritten to
// content hashes, re-read when index.html or any asset it references changes (checked at most
// every 2s). A change that only touches public/ therefore goes live with a git pull and no
// restart — and a restart drops every live RTMP stream, because RTMP ingest is owned by this
// process (socket activation only covers HTTP).
const assets = require('../web/assets');
let _baseVersion = null;
function _base() {
    let doc = null;
    try { doc = assets.document('index.html'); } catch { doc = null; }
    if (!doc) return '';
    if (doc.version !== _baseVersion) {
        _baseVersion = doc.version;
        // Pages rendered from the old document reference old asset versions.
        if (typeof _cache !== 'undefined') _cache.clear();
    }
    return doc.html;
}

function _headBlock(meta) {
    const canonical = abs(meta.canonicalPath || '/');
    let tags = seo.headTags({
        title: meta.title, description: meta.description, canonical,
        // One English page per URL (the SPA translates in place): the page is its own en and x-default.
        alternates: [{ hreflang: 'en', href: canonical }, { hreflang: 'x-default', href: canonical }],
        image: abs(meta.image || DEFAULT_OG_IMAGE), type: meta.ogType || 'website', siteName: SITE_NAME,
        robots: meta.robots || 'index,follow', jsonLd: meta.jsonLd || [],
    });
    // og:url is the page itself: a shared AI clip previews as that clip, while its canonical names the source.
    if (meta.ogUrlPath) tags = tags.replace(`<meta property="og:url" content="${esc(canonical)}">`, `<meta property="og:url" content="${esc(abs(meta.ogUrlPath))}">`);
    const parts = [PASTES_META, ...tags.split('\n')];
    if (meta.video && meta.video.duration) {
        parts.push(`<meta property="og:video:duration" content="${meta.video.duration}">`);
        parts.push(`<meta property="video:duration" content="${meta.video.duration}">`);
    }
    if (meta.snapshot) parts.push(NOJS_STYLE);
    return '\n' + parts.map(x => '    ' + x).join('\n') + '\n';
}

// The page body below is visually hidden while the SPA boots (it removes it, public/js/app.js).
// Without JavaScript nothing boots, so the body is shown instead of the empty app shell.
const PRERENDER_STYLE = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:normal;border:0;';
const NOJS_STYLE = '<noscript><style>#seo-prerender{position:static!important;width:auto!important;height:auto!important;margin:0 auto!important;padding:16px!important;overflow:visible!important;clip:auto!important;max-width:960px;line-height:1.5}#seo-prerender nav{margin:8px 0 16px}#app{display:none!important}</style></noscript>';
// The site's own links, for a reader without JavaScript (the navbar is built by a script).
const NOJS_NAV = `<nav aria-label="${SITE_NAME}"><a href="/">${SITE_NAME}</a> · <a href="/content">Content</a> · <a href="/moments">AI Moments</a> · <a href="/chat">Chat</a> · <a href="/documentation">API docs</a></nav>`;
function _prerender(html, snapshot) {
    return html.replace(/(<body[^>]*>)/i, `$1\n<div id="seo-prerender" style="${PRERENDER_STYLE}">${NOJS_NAV}${snapshot}</div>`);
}
// The page's one-paragraph summary (openvibe-shared/seo pageSummary): a hidden, machine-readable
// <section data-ov-summary> after the snapshot, the same on every OpenVibe site.
function _summary(meta) {
    return seo.pageSummary({ title: meta.title, summary: meta.description, url: abs(meta.ogUrlPath || meta.canonicalPath || '/') }).html;
}
function render(meta, urlPath) {
    let html = _base();
    if (!html) return null;
    html = assets.renderRoute(html, urlPath || meta.canonicalPath || '/');

    // Only the <head> is rewritten, so only the <head> is scanned.
    //
    // These six patterns used to run over the whole document. index.html is ~378KB and the head
    // is the first ~8.5KB of it, so five /ig regexes were scanning 370KB of page markup that
    // cannot contain a <title> or an og: tag — measured at 60ms of blocking CPU per uncached
    // render, against 0.73ms for the head alone. That cost lands on every cache miss, and the
    // sitemap advertises far more URLs than the 500-entry cache holds, so a crawler walking it
    // misses every time.
    const headEnd = html.search(/<\/head>/i);
    let head = headEnd === -1 ? html : html.slice(0, headEnd);
    const rest = headEnd === -1 ? '' : html.slice(headEnd);

    // Strip the hardcoded homepage tags we're replacing (title, description, canonical, all
    // og:/twitter:, robots) so there are no duplicates.
    head = head
        .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
        .replace(/\s*<meta\s+name=["']description["'][^>]*>/ig, '')
        .replace(/\s*<meta\s+name=["']robots["'][^>]*>/ig, '')
        .replace(/\s*<link\s+rel=["']canonical["'][^>]*>/ig, '')
        .replace(/\s*<meta\s+property=["']og:[^"']*["'][^>]*>/ig, '')
        .replace(/\s*<meta\s+name=["']twitter:[^"']*["'][^>]*>/ig, '');

    // Insert the fresh head block just before </head>.
    html = headEnd === -1
        ? head.replace(/<\/head>/i, _headBlock(meta) + '</head>')
        : head + _headBlock(meta) + rest;
    // Server-rendered crawlable content, right after <body>. It's REAL content (so AI text
    // extractors read it — unlike <noscript>, which many strip), but visually-hidden so users
    // never see a flash, and the SPA removes #seo-prerender on boot (see app.js). Not cloaking:
    // it summarises the same content the SPA renders.
    if (meta.snapshot) html = _prerender(html, meta.snapshot + _summary(meta));
    return html;
}

/**
 * The SPA shell the fallback sends (server/index.js, server/web/page-status.js) for a page this
 * renderer did not answer. The shell's own head describes the home page, and a page that is not
 * the home page must not claim to be it:
 *   404 → "Page not found", robots noindex, no canonical, no og:url, no structured data, and a
 *         not-found body for readers without JavaScript;
 *   200 → the home canonical and og:url dropped (a channel slot, /@user/<slot>, names /@user).
 */
async function shellHtml(urlPath, status) {
    let html = _base();
    if (!html) return null;
    const p = String(urlPath || '/');
    html = assets.renderRoute(html, p).replace(/<\/head>/i, `${PASTES_META}</head>`);
    if (p === '/' && status !== 404) return html;
    const headEnd = html.search(/<\/head>/i);
    if (headEnd === -1) return html;
    let head = html.slice(0, headEnd);
    const rest = html.slice(headEnd);
    head = head
        .replace(/\s*<link\s+rel=["']canonical["'][^>]*>/ig, '')
        .replace(/\s*<meta\s+property=["']og:url["'][^>]*>/ig, '')
        .replace(/\s*<meta\s+name=["']twitter:url["'][^>]*>/ig, '');
    if (status === 404) {
        head = head
            .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
            .replace(/\s*<meta\s+name=["']description["'][^>]*>/ig, '')
            .replace(/\s*<meta\s+name=["']robots["'][^>]*>/ig, '')
            .replace(/\s*<meta\s+property=["']og:[^"']*["'][^>]*>/ig, '')
            .replace(/\s*<meta\s+name=["']twitter:[^"']*["'][^>]*>/ig, '')
            .replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/ig, '');
        head += `\n    <title>Page not found — ${SITE_NAME}</title>\n    <meta name="description" content="There is nothing at this address on ${SITE_NAME}.">\n    <meta name="robots" content="noindex">\n    ${NOJS_STYLE}\n`;
        return _prerender(head + rest, `<h1>Page not found</h1><p>There is nothing at this address on ${SITE_NAME}. It may have been deleted or made private, or the link may be mistyped.</p><p><a href="/">Go to the home page</a></p>`);
    }
    const slot = p.match(/^\/@([A-Za-z0-9_]{3,24})\/[^/]+\/?$/);
    if (slot) {
        let user = null;
        try { user = await db.getUserByUsername(slot[1]); } catch { user = null; }
        if (user) head += `\n    <link rel="canonical" href="${esc(abs(`/@${user.username}`))}">\n`;
    }
    return head + rest;
}

// ── Cache (rendered HTML per path, short TTL) ───────────────────────────────────────────────
const _cache = new Map(); // path (with ?page=N) -> { html, at, ttl }
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
function _cacheGet(key) { const e = _cache.get(key); return e && (Date.now() - e.at) < e.ttl ? e : null; }
function _cacheSet(key, html, ttl = CACHE_TTL_MS) {
    if (_cache.size >= CACHE_MAX) { const first = _cache.keys().next().value; _cache.delete(first); }
    _cache.set(key, { html, at: Date.now(), ttl });
}

const SEO_ROUTE_RE = /^\/(?:$|content$|moments$|vods$|clips$|pastes$|arena$|chat$|search$|vod\/\d+$|clip\/\d+$|recap\/\d+$|p\/[A-Za-z0-9_-]+$|@[A-Za-z0-9_]{3,24}$)/;

/** ?page=N on a channel page (its video list); 1 everywhere else and for anything that is not a number. */
function _pageParam(p, query) {
    const feed = p === '/content' || p === '/moments';
    if (!feed && !CHANNEL_PATH_RE.test(p)) return 1;
    const raw = query && typeof query.page === 'string' ? query.page : '';
    return /^\d{1,4}$/.test(raw) ? Math.min(feed ? FEED_MAX_PAGE : CHANNEL_MAX_PAGE, Math.max(1, parseInt(raw, 10))) : 1;
}

async function middleware(req, res, next) {
    if (req.method !== 'GET') return next();
    const p = (req.path || '/').replace(/\/+$/, '') || '/';
    if (!SEO_ROUTE_RE.test(p)) return next();
    // A paste Community owns is never rendered here (the handover answers it first; this keeps it
    // so if the mount order ever changes).
    if (p.startsWith('/p/')) return next();
    // Every client gets the same page, whatever it sends as Accept: browsers, crawlers, curl and
    // monitors. (It used to be skipped unless Accept named text/html, so a crawler or tool that sent
    // */* got the home page's title and canonical for every channel, VOD and clip.) Nothing fetches
    // these paths for data: the API is under /api.
    const page = _pageParam(p, req.query);
    const key = page > 1 ? `${p}?page=${page}` : p;
    // This renderer and the SPA fallback's status check share one wait on upstreams (page-status.js).
    req.ovLookupDeadlineAt = Date.now() + pageStatus.LOOKUP_DEADLINE_MS;
    const send = (html, ttl) => {
        res.set('Cache-Control', `public, max-age=${Math.max(0, Math.round(ttl / 1000))}, must-revalidate`);
        res.set('Content-Security-Policy-Report-Only', assets.cspReportOnly(html));
        res.type('html');
        return res.send(html);
    };
    try {
        // Check for a changed index.html before trusting the page cache: a cache hit would otherwise
        // skip the check and keep serving pages that point at the previous asset versions.
        _base();
        const cached = _cacheGet(key);
        if (cached) return send(cached.html, cached.ttl);
        const meta = await _pageMeta(p, { page });
        if (!meta) return next(); // unknown, private or not found: the SPA fallback answers (404 when it names nothing)
        const html = render(meta, p);
        if (!html) return next();
        const ttl = meta.cacheTtlMs || CACHE_TTL_MS;
        _cacheSet(key, html, ttl);
        return send(html, ttl);
    } catch (e) {
        console.warn('[SEO] render failed for', p, '-', e.message);
        return next();
    }
}

module.exports = { middleware, shellHtml, _pageMeta, render, SITE_NAME, baseUrl, isAiClip, isoDate };
