/**
 * SEO for the SPA — per-route server-side meta / Open Graph / Twitter / JSON-LD injection,
 * a no-JS crawlable content snapshot, and a dynamic sitemap. Cached throughout.
 *
 * The app is a client-rendered SPA (server/index.js serves public/index.html for every route),
 * so crawlers/AI scrapers see an empty shell. This middleware intercepts the HTML routes we
 * care about (home, vods/clips/pastes lists, and vod/clip/paste detail pages), and rewrites the
 * <head> with route-specific machine-readable metadata + drops a <noscript> content snapshot so
 * no-JS scrapers get real content. Everything is cached so it adds ~no per-request DB cost.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const media = require('../media-client');
let config = null; try { config = require('../config'); } catch { /* */ }

// ── Short-cached Media content (VODs/clips/pastes live in OpenVibe.Media now) ──
const _mc = new Map(); // key → { v, at }
const MC_TTL_MS = 60_000;
async function _cached(key, fn) {
    const e = _mc.get(key);
    if (e && Date.now() - e.at < MC_TTL_MS) return e.v;
    try {
        const v = await fn();
        _mc.set(key, { v, at: Date.now() });
        if (_mc.size > 300) _mc.delete(_mc.keys().next().value);
        return v;
    } catch { return e ? e.v : null; }
}
const _vodList = (limit, offset = 0) => _cached(`vl:${limit}:${offset}`, async () => (await media.listVods({ limit, offset }))?.vods || []);
const _clipList = (limit, offset = 0) => _cached(`cl:${limit}:${offset}`, async () => (await media.listClips({ limit, offset }))?.clips || []);
const _pasteList = (limit, offset = 0) => _cached(`pl:${limit}:${offset}`, async () => (await media.listPastes({ limit, offset, visibility: 'public' }))?.pastes || []);
const _vodGet = (id) => _cached(`v:${id}`, () => media.getVod(id));
const _clipGet = (id) => _cached(`c:${id}`, () => media.getClip(id));
const _pasteGet = (slug) => _cached(`p:${slug}`, () => media.getPaste(slug));

// Overlay the Live-owned AI state (vod_ai_state/clip_ai_state) onto a Media row so
// descriptions/transcripts keep enriching the crawlable snapshot.
function _overlayAiState(row, kind) {
    try {
        const st = kind === 'clip' ? db.getClipAiState(row.id) : db.getVodAiState(row.id);
        if (!st) return;
        if (st.ai_overview_short) {
            row.ai_overview_short = row.ai_overview_short || st.ai_overview_short;
            row.ai_overview = row.ai_overview || st.ai_overview_short;
        }
        if (st.ai_transcript_json && !row.ai_transcript) {
            try { row.ai_transcript = JSON.parse(st.ai_transcript_json).map(s => s.text).join(' ').trim(); } catch { /* */ }
        }
    } catch { /* */ }
}

const INDEX_HTML_PATH = path.join(__dirname, '../../public/index.html');
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
// HTML-escape for text nodes / attribute values.
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
function jsonLd(obj) {
    // Escape "<" so a value can never break out of the <script> block.
    return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

// ── Build the per-route metadata object ────────────────────────────────────────────────────
// Returns { title, description, canonicalPath, image, ogType, robots, jsonLd:[...], snapshot }
// or null to fall through (unknown / private / not found).

async function _pageMeta(routePath) {
    const p = routePath.replace(/\/+$/, '') || '/';
    const bu = baseUrl();

    // Home
    if (p === '/') return _homeMeta();
    // List pages (content sourced from OpenVibe.Media, canonical URLs stay on openvibe.live)
    if (p === '/vods') return _listMeta('vods', 'VODs', 'Browse recorded live streams (VODs) on OpenVibe.Live — auto-recorded broadcasts with AI overviews and searchable transcripts.', async () => (await _vodList(30) || []).map(v => ({ url: `/vod/${v.id}`, name: v.title || 'VOD', by: v.display_name || v.username, meta: _fmtDur(v.duration_seconds || v.duration), desc: v.ai_overview_short })));
    if (p === '/clips') return _listMeta('clips', 'Clips', 'Watch the best clips from OpenVibe.Live live streams — highlights clipped by viewers and auto-generated by AI.', async () => (await _clipList(30) || []).map(c => ({ url: `/clip/${c.id}`, name: c.title || 'Clip', by: c.display_name || c.username || c.streamer_username, meta: _fmtDur(c.duration_seconds || c.duration), desc: c.ai_overview_short })));
    if (p === '/pastes') return _listMeta('pastes', 'Pastes', 'Code, text and screenshot pastes shared on OpenVibe.Live — a Pastebin built into the streaming network, with AI summaries.', async () => (await _pasteList(30) || []).map(x => ({ url: `/p/${x.slug}`, name: x.title || 'Paste', by: x.username || 'anon', meta: x.type === 'screenshot' ? 'image' : (x.language || 'text'), desc: x.ai_summary })));

    // Detail pages
    let m;
    if ((m = p.match(/^\/vod\/(\d+)$/))) return _vodMeta(parseInt(m[1], 10));
    if ((m = p.match(/^\/clip\/(\d+)$/))) return _clipMeta(parseInt(m[1], 10));
    if ((m = p.match(/^\/p\/([A-Za-z0-9_-]+)$/))) return _pasteMeta(m[1]);
    if ((m = p.match(/^\/@([A-Za-z0-9_.-]+)$/))) return _channelMeta(m[1]);

    return null;
    void bu;
}

function _channelMeta(username) {
    let ch; try { ch = db.getChannelByUsername(username); } catch { ch = null; }
    if (!ch) return null;
    const name = ch.display_name || ch.username || username;
    const handle = '@' + (ch.username || username);
    let ov = null;
    try { ov = db.getStreamerOverview ? db.getStreamerOverview(ch.user_id) : null; } catch { /* */ }
    let followers = 0;
    try { followers = db.getFollowerCount ? (db.getFollowerCount(ch.user_id) || 0) : 0; } catch { /* */ }
    const bio = clean(ch.bio || '', 300);
    const aiShort = clean((ov && (ov.overview_short || ov.overview)) || '', 220);
    const desc = clean(bio || aiShort || `${name} (${handle}) streams live on ${SITE_NAME}. Watch their live streams, VODs and clips.`, 200);
    const image = ch.avatar_url ? abs(ch.avatar_url) : DEFAULT_OG_IMAGE;
    const canonicalPath = `/${handle}`;
    const person = {
        '@type': 'Person', name: clean(name, 80), alternateName: handle, url: abs(canonicalPath),
        image: image !== DEFAULT_OG_IMAGE ? image : undefined,
        description: desc,
        interactionStatistic: followers ? { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: followers } : undefined,
    };
    const profile = { '@context': 'https://schema.org', '@type': 'ProfilePage', name: `${name} (${handle})`, url: abs(canonicalPath), mainEntity: person };
    const snapshot = _detailSnapshot({
        title: `${name} (${handle})`, byline: followers ? `${followers} follower${followers === 1 ? '' : 's'} on ${SITE_NAME}` : null,
        desc: bio || null, overview: (ov && ov.overview) || null, transcript: null,
        canonicalPath, watchLabel: `Visit ${name}'s channel`,
    });
    return {
        title: `${name} (${handle}) — ${SITE_NAME}`, description: desc,
        canonicalPath, image, ogType: 'profile', robots: 'index,follow',
        jsonLd: [profile, _breadcrumb([{ name: 'Home', url: '/' }, { name: name, url: canonicalPath }])],
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
function _fmtDur(sec) { sec = Math.floor(Number(sec) || 0); const m = Math.floor(sec / 60), s = sec % 60; return sec ? `${m}:${String(s).padStart(2, '0')}` : ''; }

async function _homeMeta() {
    const title = 'OpenVibe.Live — Free Open-Source Live Streaming Platform';
    const description = 'Free, open-source live streaming with sub-second WebRTC, OBS/RTMP & CLI ingest, auto VODs & AI clips, restreaming to Twitch/YouTube/Kick, global chat, viewer-controlled robots, and the whole OpenVibe network behind it.';

    // Pull the actual live content so the source has real, crawlable text.
    let live = [], vods = [], clips = [], pastes = [], stats = null;
    try { live = (db.getLiveStreams() || []).slice(0, 12); } catch { /* */ }
    try { vods = (await _vodList(12)) || []; } catch { /* */ }
    try { clips = (await _clipList(12)) || []; } catch { /* */ }
    try { pastes = (await _pasteList(12)) || []; } catch { /* */ }
    try { stats = db.getHomeStats(); } catch { /* */ }

    const liveItems = live.map(s => ({ url: `/@${s.username}`, name: s.title || `${s.display_name || s.username} live`, by: s.display_name || s.username, meta: s.category || 'live' }));
    const vodItems = vods.map(v => ({ url: `/vod/${v.id}`, name: v.title || 'VOD', by: v.display_name || v.username, meta: _fmtDur(v.duration_seconds || v.duration), desc: v.ai_overview_short }));
    const clipItems = clips.map(c => ({ url: `/clip/${c.id}`, name: c.title || 'Clip', by: c.display_name || c.username || c.streamer_username, meta: _fmtDur(c.duration_seconds || c.duration) }));
    const pasteItems = pastes.map(x => ({ url: `/p/${x.slug}`, name: x.title || 'Paste', by: x.username || 'anon', meta: x.type === 'screenshot' ? 'image' : (x.language || 'text') }));

    const statLine = stats ? `<p>${SITE_NAME} hosts ${stats.streamers || 0} streamers, ${stats.vods || 0} VODs, ${stats.clips || 0} clips, ${stats.pastes || 0} pastes and ${stats.chatMessages || 0} chat messages.</p>` : '';
    const snapshot =
        `<h1>${SITE_NAME} — free, open-source live streaming</h1>` +
        `<p>${esc(description)}</p>` + statLine +
        (liveItems.length ? _mediaSection('Live now', liveItems) : '<section><h2>Live now</h2><p>No one is streaming right now — be the first to go live.</p></section>') +
        _mediaSection('Recent VODs', vodItems) +
        _mediaSection('Recent clips', clipItems) +
        _mediaSection('Recent pastes', pasteItems);

    // Rich JSON-LD: WebSite + an ItemList of what's live/recent right now.
    const listEls = [...liveItems, ...vodItems, ...clipItems].slice(0, 20)
        .map((it, i) => ({ '@type': 'ListItem', position: i + 1, url: abs(it.url), name: clean(it.name, 110) }));
    const jsonLd = [
        { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Live & recent on OpenVibe.Live', itemListElement: listEls },
    ];
    return { title, description, canonicalPath: '/', image: DEFAULT_OG_IMAGE, ogType: 'website', robots: 'index,follow', jsonLd, snapshot };
}

async function _listMeta(slug, label, description, itemsFn) {
    let items = [];
    try { items = ((await itemsFn()) || []).slice(0, 24); } catch { /* */ }
    const canonical = abs('/' + slug);
    const list = {
        '@context': 'https://schema.org', '@type': 'CollectionPage',
        name: `${label} — ${SITE_NAME}`, url: canonical, description,
        mainEntity: {
            '@type': 'ItemList',
            itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, url: abs(it.url), name: clean(it.name, 110) })),
        },
    };
    const snapshot = `<h1>${esc(label)} on ${SITE_NAME}</h1><p>${esc(description)}</p>` +
        _mediaSection(`Latest ${label.toLowerCase()}`, items);
    return {
        title: `${label} — ${SITE_NAME}`, description, canonicalPath: '/' + slug,
        image: DEFAULT_OG_IMAGE, ogType: 'website', robots: 'index,follow',
        jsonLd: [list, _breadcrumb([{ name: 'Home', url: '/' }, { name: label, url: '/' + slug }])],
        snapshot,
    };
}

function _authorLd(name) { return name ? { '@type': 'Person', name: clean(name, 80) } : undefined; }

async function _vodMeta(id) {
    let v; try { v = await _vodGet(id); } catch { v = null; }
    if (!v) return null;
    if (v.duration_seconds == null && v.duration != null) v.duration_seconds = v.duration;
    _overlayAiState(v, 'vod');
    const indexable = Number(v.is_public) === 1 && (!v.visibility || v.visibility === 'public');
    const author = v.display_name || v.username;
    const title = clean(v.title || `${author ? author + "'s " : ''}stream VOD`, 80);
    const desc = clean(v.ai_overview_short || v.ai_overview || v.description || `Recorded live stream${author ? ' by ' + author : ''} on ${SITE_NAME}.`, 200);
    const image = v.thumbnail_url ? media.publicUrl(v.thumbnail_url) : media.thumbUrl(`vod-${id}`);
    const canonicalPath = `/vod/${id}`;
    const vo = {
        '@context': 'https://schema.org', '@type': 'VideoObject',
        name: title, description: desc, thumbnailUrl: [image],
        uploadDate: isoDate(v.created_at) || undefined,
        duration: iso8601Duration(v.duration_seconds),
        contentUrl: abs(canonicalPath), embedUrl: abs(canonicalPath),
        interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/WatchAction', userInteractionCount: Number(v.view_count) || 0 },
        author: _authorLd(author), publisher: { '@type': 'Organization', name: SITE_NAME, url: baseUrl() },
    };
    const snapshot = _detailSnapshot({
        title, byline: author ? `Streamed by ${author}` : null, desc,
        overview: v.ai_overview, transcript: v.ai_transcript, canonicalPath, watchLabel: 'Watch this VOD',
    });
    return {
        title: `${title}${author ? ' — ' + author : ''} | ${SITE_NAME}`, description: desc,
        canonicalPath, image, ogType: 'video.other', robots: indexable ? 'index,follow' : 'noindex,follow',
        video: { duration: Math.floor(Number(v.duration_seconds) || 0) },
        jsonLd: [vo, _breadcrumb([{ name: 'Home', url: '/' }, { name: 'VODs', url: '/vods' }, { name: title, url: canonicalPath }])],
        snapshot,
    };
}

async function _clipMeta(id) {
    let c; try { c = await _clipGet(id); } catch { c = null; }
    if (!c) return null;
    if (c.duration_seconds == null && c.duration != null) c.duration_seconds = c.duration;
    _overlayAiState(c, 'clip');
    const indexable = Number(c.is_public) === 1 && (!c.visibility || c.visibility === 'public');
    const creator = c.display_name || c.username;
    const title = clean(c.title || 'Clip', 80);
    const desc = clean(c.ai_overview_short || c.ai_overview || c.description || `A clip from a live stream on ${SITE_NAME}${creator ? ', clipped by ' + creator : ''}.`, 200);
    const image = c.thumbnail_url ? media.publicUrl(c.thumbnail_url) : media.thumbUrl(`clip-${id}`);
    const canonicalPath = `/clip/${id}`;
    const vo = {
        '@context': 'https://schema.org', '@type': 'VideoObject',
        name: title, description: desc, thumbnailUrl: [image],
        uploadDate: isoDate(c.created_at) || undefined,
        duration: iso8601Duration(c.duration_seconds),
        contentUrl: abs(canonicalPath), embedUrl: abs(canonicalPath),
        interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/WatchAction', userInteractionCount: Number(c.view_count) || 0 },
        author: _authorLd(creator), publisher: { '@type': 'Organization', name: SITE_NAME, url: baseUrl() },
    };
    const snapshot = _detailSnapshot({
        title, byline: creator ? `Clipped by ${creator}` : null, desc,
        overview: c.ai_overview, transcript: c.ai_transcript, canonicalPath, watchLabel: 'Watch this clip',
    });
    return {
        title: `${title} — clip | ${SITE_NAME}`, description: desc,
        canonicalPath, image, ogType: 'video.other', robots: indexable ? 'index,follow' : 'noindex,follow',
        video: { duration: Math.floor(Number(c.duration_seconds) || 0) },
        jsonLd: [vo, _breadcrumb([{ name: 'Home', url: '/' }, { name: 'Clips', url: '/clips' }, { name: title, url: canonicalPath }])],
        snapshot,
    };
}

async function _pasteMeta(slug) {
    let p; try { p = await _pasteGet(slug); } catch { p = null; }
    if (!p) return null;
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

function _breadcrumb(items) {
    return {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: clean(it.name, 90), item: abs(it.url) })),
    };
}
function _detailSnapshot({ title, byline, desc, overview, transcript, canonicalPath, watchLabel }) {
    let html = `<article><h1>${esc(title)}</h1>`;
    if (byline) html += `<p class="byline">${esc(byline)}</p>`;
    if (desc) html += `<p>${esc(desc)}</p>`;
    if (overview && String(overview).trim()) html += `<section><h2>AI overview</h2><p>${esc(clean(overview, 1200))}</p></section>`;
    if (transcript && String(transcript).trim()) html += `<section><h2>Transcript</h2><p>${esc(clean(transcript, 1500))}</p></section>`;
    html += `<p><a href="${esc(abs(canonicalPath))}">${esc(watchLabel || 'Open')}</a> on ${SITE_NAME}.</p></article>`;
    return html;
}

// ── Inject metadata into the base index.html ────────────────────────────────────────────────
let _baseHtml = null;
function _base() {
    if (_baseHtml == null) {
        try { _baseHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8'); } catch { _baseHtml = ''; }
    }
    return _baseHtml;
}
function _headBlock(meta) {
    const canonical = abs(meta.canonicalPath || '/');
    const img = abs(meta.image || DEFAULT_OG_IMAGE);
    const parts = [
        `<title>${esc(meta.title)}</title>`,
        `<meta name="description" content="${esc(meta.description)}">`,
        `<meta name="robots" content="${esc(meta.robots || 'index,follow')}">`,
        `<link rel="canonical" href="${esc(canonical)}">`,
        `<meta property="og:type" content="${esc(meta.ogType || 'website')}">`,
        `<meta property="og:site_name" content="${SITE_NAME}">`,
        `<meta property="og:title" content="${esc(meta.title)}">`,
        `<meta property="og:description" content="${esc(meta.description)}">`,
        `<meta property="og:url" content="${esc(canonical)}">`,
        `<meta property="og:image" content="${esc(img)}">`,
        `<meta property="og:locale" content="en_US">`,
        `<meta name="twitter:card" content="${meta.video ? 'player' : 'summary_large_image'}">`,
        `<meta name="twitter:title" content="${esc(meta.title)}">`,
        `<meta name="twitter:description" content="${esc(meta.description)}">`,
        `<meta name="twitter:image" content="${esc(img)}">`,
    ];
    if (meta.video && meta.video.duration) {
        parts.push(`<meta property="og:video:duration" content="${meta.video.duration}">`);
        parts.push(`<meta property="video:duration" content="${meta.video.duration}">`);
    }
    for (const l of (meta.jsonLd || [])) parts.push(jsonLd(l));
    return '\n' + parts.map(x => '    ' + x).join('\n') + '\n';
}
function render(meta) {
    let html = _base();
    if (!html) return null;
    // Strip the hardcoded homepage tags we're replacing (title, description, canonical, all
    // og:/twitter:, robots) so there are no duplicates.
    html = html
        .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
        .replace(/\s*<meta\s+name=["']description["'][^>]*>/ig, '')
        .replace(/\s*<meta\s+name=["']robots["'][^>]*>/ig, '')
        .replace(/\s*<link\s+rel=["']canonical["'][^>]*>/ig, '')
        .replace(/\s*<meta\s+property=["']og:[^"']*["'][^>]*>/ig, '')
        .replace(/\s*<meta\s+name=["']twitter:[^"']*["'][^>]*>/ig, '');
    // Insert the fresh head block just before </head>.
    html = html.replace(/<\/head>/i, _headBlock(meta) + '</head>');
    // Server-rendered crawlable content, right after <body>. It's REAL content (so AI text
    // extractors read it — unlike <noscript>, which many strip), but visually-hidden so users
    // never see a flash, and the SPA removes #seo-prerender on boot (see app.js). Not cloaking:
    // it summarises the same content the SPA renders.
    if (meta.snapshot) {
        const style = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:normal;border:0;';
        html = html.replace(/(<body[^>]*>)/i, `$1\n<div id="seo-prerender" style="${style}">${meta.snapshot}</div>`);
    }
    return html;
}

// ── Cache (rendered HTML per path, short TTL) ───────────────────────────────────────────────
const _cache = new Map(); // path -> { html, at }
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
function _cacheGet(key) { const e = _cache.get(key); return e && (Date.now() - e.at) < CACHE_TTL_MS ? e.html : null; }
function _cacheSet(key, html) {
    if (_cache.size >= CACHE_MAX) { const first = _cache.keys().next().value; _cache.delete(first); }
    _cache.set(key, { html, at: Date.now() });
}

const SEO_ROUTE_RE = /^\/(?:$|vods$|clips$|pastes$|vod\/\d+$|clip\/\d+$|p\/[A-Za-z0-9_-]+$|@[A-Za-z0-9_.-]+$)/;

async function middleware(req, res, next) {
    if (req.method !== 'GET') return next();
    const p = (req.path || '/').replace(/\/+$/, '') || '/';
    if (!SEO_ROUTE_RE.test(p)) return next();
    // Only rewrite HTML navigations, not fetch()/XHR/asset probes.
    if (req.headers.accept && req.headers.accept.indexOf('text/html') === -1) return next();
    try {
        const cached = _cacheGet(p);
        if (cached) { res.set('Cache-Control', 'public, max-age=300'); res.type('html'); return res.send(cached); }
        const meta = await _pageMeta(p);
        if (!meta) return next(); // unknown / not found → let the SPA 404 client-side
        const html = render(meta);
        if (!html) return next();
        _cacheSet(p, html);
        res.set('Cache-Control', 'public, max-age=300');
        res.type('html');
        return res.send(html);
    } catch (e) {
        console.warn('[SEO] render failed for', p, '-', e.message);
        return next();
    }
}

// ── Dynamic sitemap.xml (cached ~1h) ────────────────────────────────────────────────────────
let _sitemap = null, _sitemapAt = 0;
const SITEMAP_TTL_MS = 60 * 60 * 1000;
const SITEMAP_CAP = 5000; // per content type
function _urlTag(loc, lastmod, changefreq, priority) {
    return `<url><loc>${esc(abs(loc))}</loc>` +
        (lastmod ? `<lastmod>${esc(lastmod)}</lastmod>` : '') +
        (changefreq ? `<changefreq>${changefreq}</changefreq>` : '') +
        (priority ? `<priority>${priority}</priority>` : '') + `</url>`;
}
async function buildSitemap() {
    const urls = [];
    const seenChannels = new Set();
    const statics = [['/', 'daily', '1.0'], ['/vods', 'hourly', '0.8'], ['/clips', 'hourly', '0.8'], ['/pastes', 'hourly', '0.7'], ['/chat', 'daily', '0.5']];
    for (const [u, cf, pr] of statics) urls.push(_urlTag(u, null, cf, pr));
    const page = async (fetch, per, cap, emit) => {
        let off = 0;
        while (off < cap) {
            let rows = [];
            try { rows = (await fetch(per, off)) || []; } catch { break; }
            for (const r of rows) emit(r);
            if (rows.length < per) break;
            off += per;
        }
    };
    await page((l, o) => media.listVods({ limit: l, offset: o }).then(r => r?.vods || []), 200, SITEMAP_CAP, (v) => {
        urls.push(_urlTag(`/vod/${v.id}`, isoDate(v.created_at), 'weekly', '0.6'));
        if (v.username) seenChannels.add(v.username);
    });
    await page((l, o) => media.listClips({ limit: l, offset: o }).then(r => r?.clips || []), 200, SITEMAP_CAP, (c) => {
        urls.push(_urlTag(`/clip/${c.id}`, isoDate(c.created_at), 'weekly', '0.6'));
        if (c.username) seenChannels.add(c.username);
    });
    await page((l, o) => media.listPastes({ limit: l, offset: o, visibility: 'public' }).then(r => r?.pastes || []), 200, SITEMAP_CAP, (x) => {
        if (!Number(x.is_nsfw)) urls.push(_urlTag(`/p/${x.slug}`, isoDate(x.created_at), 'monthly', '0.4'));
    });
    for (const u of seenChannels) if (u) urls.push(_urlTag(`/@${u}`, null, 'daily', '0.6'));
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
}
async function sitemapHandler(req, res) {
    if (!_sitemap || (Date.now() - _sitemapAt) > SITEMAP_TTL_MS) {
        try { _sitemap = await buildSitemap(); _sitemapAt = Date.now(); }
        catch (e) { console.warn('[SEO] sitemap build failed:', e.message); if (!_sitemap) return res.status(500).end(); }
    }
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(_sitemap);
}

// Register: dynamic sitemap first, then the meta middleware. MUST be mounted BEFORE
// express.static (so it can intercept "/") and before the SPA catch-all.
function register(app) {
    app.get('/sitemap.xml', sitemapHandler);
    app.use(middleware);
    console.log('[SEO] per-route meta + dynamic sitemap registered');
}

module.exports = { register, middleware, sitemapHandler, buildSitemap, _pageMeta, render };
