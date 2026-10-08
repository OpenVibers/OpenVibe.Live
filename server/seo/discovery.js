/**
 * Discovery files: /sitemap.xml, /robots.txt, /llms.txt and /llms-full.txt, built with
 * openvibe-shared/seo from what Live knows (the VODs and clips Media holds, the docs folder).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const db = require('../db/database');
const media = require('../media-client');
const { SITE_NAME, baseUrl, isAiClip, isoDate } = require('./pages');

const DOCS_DIR = process.env.OV_APP_ROOT ? path.join(process.env.OV_APP_ROOT, 'docs') : path.join(__dirname, '../../docs');
const DISCOVERY_MAX_AGE = 3600;   // seconds, for every file here

// ── Dynamic sitemap.xml (cached ~1h) ────────────────────────────────────────────────────────
let _sitemap = null, _sitemapAt = 0;
const SITEMAP_TTL_MS = 60 * 60 * 1000;
const SITEMAP_CAP = 5000; // per content type
async function buildSitemap() {
    const b = baseUrl();
    const urls = [];
    const entry = (loc, lastmod, changefreq, priority) => urls.push({ loc: b + loc, lastmod: lastmod || undefined, changefreq, priority });
    const seenChannels = new Set();
    // Media rows carry Live user ids, not names: a channel is named from Live's accounts (banned
    // accounts are left out).
    const names = new Map();
    const channelOf = async (row, id) => {
        if (row.username) return row.username;
        if (id == null) return null;
        if (!names.has(id)) {
            let u = null;
            try { u = await db.getUserById(Number(id)); } catch { u = null; }
            names.set(id, u && !(u.is_banned === 1 || u.is_banned === true) ? u.username : null);
        }
        return names.get(id);
    };
    const statics = [['/', 'daily', 1.0], ['/content', 'hourly', 0.9], ['/moments', 'hourly', 0.7], ['/vods', 'hourly', 0.8], ['/clips', 'hourly', 0.8], ['/pastes', 'hourly', 0.7], ['/chat', 'daily', 0.5], ['/arena', 'hourly', 0.6]];
    // Rendered docs (server/docs/routes.js): /docs is the index (README.md), the rest by file name.
    try {
        for (const f of fs.readdirSync(DOCS_DIR)) {
            if (!f.endsWith('.md')) continue;
            statics.push([f === 'README.md' ? '/docs' : `/docs/${f.slice(0, -3)}`, 'weekly', 0.5]);
        }
    } catch { /* docs folder absent in some deploys */ }
    for (const [u, cf, pr] of statics) entry(u, null, cf, pr);
    const page = async (fetch, per, cap, emit) => {
        let off = 0;
        while (off < cap) {
            let rows = [];
            try { rows = (await fetch(per, off)) || []; } catch { break; }
            for (const r of rows) await emit(r);
            if (rows.length < per) break;
            off += per;
        }
    };
    await page((l, o) => media.listVods({ limit: l, offset: o }).then(r => r?.vods || []), 200, SITEMAP_CAP, async (v) => {
        entry(`/vod/${v.id}`, isoDate(v.created_at), 'weekly', 0.6);
        const ch = await channelOf(v, v.user_id);
        if (ch) seenChannels.add(ch);
    });
    // People's clips only: AI Moments are noindex and never listed (the /moments
    // collection above is their indexable form). The filter is checked again per row, so an
    // upstream that ignores it still cannot put an AI item here.
    await page((l, o) => media.listClips({ limit: l, offset: o, auto_generated: 0 }).then(r => r?.clips || []), 200, SITEMAP_CAP, async (c) => {
        if (isAiClip(c)) return;
        entry(`/clip/${c.id}`, isoDate(c.created_at), 'weekly', 0.6);
        const ch = await channelOf({}, c.channel_user_id != null ? c.channel_user_id : c.user_id);
        if (ch) seenChannels.add(ch);
    });
    // No /p/ here: pastes are OpenVibe.Community's, and its sitemap lists them under their canonical URL.
    for (const u of seenChannels) if (u) entry(`/@${u}`, null, 'daily', 0.6);
    return seo.sitemapXml(urls);
}
async function sitemapHandler(req, res) {
    if (!_sitemap || (Date.now() - _sitemapAt) > SITEMAP_TTL_MS) {
        try { _sitemap = await buildSitemap(); _sitemapAt = Date.now(); }
        catch (e) { console.warn('[SEO] sitemap build failed:', e.message); if (!_sitemap) return res.status(500).end(); }
    }
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', cache.htmlHeaders({ maxAge: DISCOVERY_MAX_AGE }));
    res.send(_sitemap);
}

// ── /robots.txt: every crawler welcome, search and AI alike, pointed at the sitemap ────────
function robotsTxt() {
    return seo.robotsTxt({ sitemaps: [`${baseUrl()}/sitemap.xml`] });
}

// ── /llms.txt: what this site is, for language models and other automated readers ─────────
// (llmstxt.org). It names the public pages, the JSON behind them, the API docs, and how people's
// work is kept apart from what the AI derived from it (roadmap 32.4, 33.8).
const LLMS_DOCS = [
    ['go-live-in-your-browser', 'Go live from a browser: no OBS, no downloads, no follower minimum (how, devices, questions)'],
    ['whip', 'WHIP ingest API: publish to a channel from a browser or any WHIP client'],
    ['broadcasting', 'Going live: WebRTC, WHIP, RTMP (OBS) and the JSMPEG/CLI path'],
    ['api-tokens', 'Bot and integration tokens (hbt_...) for the API'],
    ['chat-system', 'Chat features and moderation'],
    ['vods-and-clips', 'How VODs and clips are recorded and cut'],
    ['architecture', 'System design and how Live fits the OpenVibe network'],
];
const LLMS_SUMMARY = 'Open-source, community-run live streaming. Anyone can go live straight from a web browser, with no OBS, no downloads and no follower, subscriber or equipment requirement: press Go Live, allow camera and microphone, and the stream is live (WebRTC, under a second of delay; Chromebooks, laptops and phones). OBS (RTMP), WHIP and command-line ingest are there for produced shows. Every stream can be recorded as a VOD, clipped and discussed. Part of the OpenVibe network: one account across openvibe.network, openvibe.media, openvibe.community, openvibe.tools and the other OpenVibe sites.';
const _docsPresent = () => LLMS_DOCS.filter(([name]) => { try { return fs.existsSync(path.join(DOCS_DIR, `${name}.md`)); } catch { return false; } });

function llmsTxt() {
    const b = baseUrl();
    return seo.llmsTxt({
        name: SITE_NAME,
        summary: LLMS_SUMMARY,
        details: 'People\'s work and AI-made material are kept apart everywhere on this site. The Content pages list what people made; AI Moments list what the platform\'s AI derived from streams. Every AI item is labelled AI-generated, credited to no person, marked noindex,follow and made canonical to the source VOD at the moment it came from (/vod/<id>?t=<seconds>). In the JSON feeds, AI items carry "ai": true and an "ai_label".',
        sections: [
            { title: 'Going live from a browser (no OBS)', links: [
                { title: 'How to go live in your browser', url: `${b}/docs/go-live-in-your-browser`, note: `open ${b}, sign in, press Go Live, allow camera and microphone, start. No software, no follower minimum.` },
                { title: 'The broadcaster', url: `${b}/broadcast`, note: 'camera switching, screen/window/tab sharing with a camera picture-in-picture, live stats, chat beside the stream.' },
                { title: 'Browser publishing for other sites', url: `${b}/docs/whip#publishing-from-a-browser`, note: 'any web page can publish to a channel over WHIP.' },
            ] },
            { title: 'What people made', links: [
                { title: 'Home', url: `${b}/`, note: 'who is live now, recent VODs and clips' },
                { title: 'Content', url: `${b}/content`, note: `VODs, the clips people took, and pastes people wrote. JSON: ${b}/api/content/feed (cursor paging; ?type=vods|clips|pastes, ?sort=new|top)` },
                { title: 'Channel pages', url: `${b}/@<username>`, note: `the channel's videos in pages (${b}/@<username>?page=2)` },
                { title: 'VOD pages', url: `${b}/vod/<id>`, note: `a moment in a VOD: ${b}/vod/<id>?t=<seconds>` },
                { title: 'Clip pages', url: `${b}/clip/<id>` },
                { title: 'Pastes', url: 'https://openvibe.community/p/<slug>', note: 'pastes live on OpenVibe.Community (Live\'s /p/<slug> redirects there)' },
                { title: 'Chat', url: `${b}/chat` },
                { title: 'The Arena', url: `${b}/arena`, note: 'mic-judged streamer callouts' },
            ] },
            { title: 'What the AI made (AI Moments)', links: [
                { title: 'AI Moments', url: `${b}/moments`, note: `auto-clips cut when chat reacted, frames the AI picked from streams, and AI-written after-show recaps. JSON: ${b}/api/content/moments. AI Moments pages are noindex; the /moments collection is their indexable form. They are never listed in the sitemap. An AI clip says "AI clip · from <streamer>'s stream"; it is never presented as something the streamer or a viewer clipped. A streamer can turn AI Moments off for their channel; the AI then makes no new ones from their streams.` },
            ] },
            { title: 'API and docs', links: [
                { title: 'API docs', url: `${b}/documentation`, note: 'every feature has an open API (chat, streams, clips, overlays, robots, sound commands)' },
                { title: 'Docs index', url: `${b}/docs` },
                ..._docsPresent().map(([name, what]) => ({ title: name, url: `${b}/docs/${name}`, note: what })),
                { title: 'Source code', url: 'https://github.com/OpenVibers/OpenVibe.Live' },
            ] },
            { title: 'Discovery', links: [
                { title: 'Sitemap', url: `${b}/sitemap.xml`, note: 'people\'s work only' },
                { title: 'robots.txt', url: `${b}/robots.txt` },
                { title: 'llms-full.txt', url: `${b}/llms-full.txt`, note: 'the docs above in full, as plain text' },
                { title: 'OpenVibe platform descriptor', url: 'https://openvibe.network/.well-known/openvibe', note: 'the OpenVibe network\'s descriptor' },
            ] },
        ],
    });
}

// ── /llms-full.txt: the same header, then the docs themselves ──────────────────────────────
const LLMS_FULL_DOC_CHARS = 40_000;
const LLMS_FULL_TOTAL_CHARS = 400_000;
let _llmsFull = null, _llmsFullAt = 0;
function llmsFullTxt() {
    if (_llmsFull && Date.now() - _llmsFullAt < DISCOVERY_MAX_AGE * 1000) return _llmsFull;
    const sections = [];
    for (const [name, what] of _docsPresent()) {
        let body = '';
        try { body = fs.readFileSync(path.join(DOCS_DIR, `${name}.md`), 'utf8'); } catch { continue; }
        sections.push({ title: what, url: `/docs/${name}`, body });
    }
    _llmsFull = seo.llmsFull({ site: { name: SITE_NAME, url: baseUrl() }, summary: LLMS_SUMMARY, sections, maxChars: LLMS_FULL_DOC_CHARS, maxTotal: LLMS_FULL_TOTAL_CHARS });
    _llmsFullAt = Date.now();
    return _llmsFull;
}

const textHandler = (build) => (req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', cache.htmlHeaders({ maxAge: DISCOVERY_MAX_AGE }));
    res.send(build());
};

/** Mounted before express.static, so /robots.txt here wins over any file in public/. */
function register(app) {
    app.get('/sitemap.xml', sitemapHandler);
    app.get('/robots.txt', textHandler(robotsTxt));
    app.get('/llms.txt', textHandler(llmsTxt));
    app.get('/llms-full.txt', textHandler(llmsFullTxt));
}

module.exports = { register, sitemapHandler, buildSitemap, robotsTxt, llmsTxt, llmsFullTxt };
