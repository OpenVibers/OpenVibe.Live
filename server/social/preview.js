'use strict';
/**
 * Rich previews for a channel's social links: live status, latest posts or videos, and page metadata, fetched on
 * the server through the egress guard (server/net/egress.js: public addresses only, redirects re-checked, size and
 * time caps) and cached ten minutes (errors one minute), so a busy channel page costs each upstream one request per
 * link per ten minutes.
 *
 *   preview(link) → { kind, title, subtitle, image, live: { live, title, viewers, thumbnail }?, items: [{ text, url, at, image }] }
 *
 * Sources, all public and keyless: Bluesky (public.api.bsky.app), Mastodon (the instance's public API), GitHub
 * (api.github.com), YouTube (the channel's RSS feed), Twitch (the preview image redirects to a placeholder when the
 * channel is offline), Kick (its public channel API, best effort), the streamer's OpenVibe profile (the Network's
 * /api/v1/profiles, on loopback), and OpenGraph for everything else. X has no
 * usable free API: its card links out, and the channel page offers X's own timeline embed on click (isolated
 * frame, /embed/x-timeline).
 */
const egress = require('../net/egress');

const TTL = 10 * 60 * 1000;
const ERROR_TTL = 60 * 1000;
const MAX_ENTRIES = 2000;
const UA = 'OpenVibe.Live/1.0 (+https://openvibe.live; channel link previews)';
const cache = new Map();   // url → { at, ttl, value }

async function getJson(url, { timeoutMs = 6000 } = {}) {
    const r = await egress.fetchText(url, { timeoutMs, maxBytes: 768 * 1024, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return JSON.parse(r.text);
}
async function getText(url, { timeoutMs = 6000, accept = 'text/html,application/xhtml+xml' } = {}) {
    const r = await egress.fetchText(url, { timeoutMs, maxBytes: 768 * 1024, headers: { 'User-Agent': UA, Accept: accept } });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return r;
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const clip = (s, n = 280) => { const t = decode(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const RARITY = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

/** OpenGraph / meta tags of a page. */
async function openGraph(url) {
    const r = await getText(url);
    const head = r.text.slice(0, 200000);
    const meta = (prop) => {
        const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
        const tag = re.exec(head);
        const c = tag && /content=["']([^"']*)["']/i.exec(tag[0]);
        return c ? decode(c[1]) : null;
    };
    const title = meta('og:title') || meta('twitter:title') || clip((/<title[^>]*>([^<]*)<\/title>/i.exec(head) || [])[1], 120);
    let image = meta('og:image') || meta('twitter:image');
    try { if (image) image = new URL(image, r.url).href; } catch { image = null; }
    return { title: title || null, subtitle: clip(meta('og:description') || meta('description') || meta('twitter:description'), 200) || null, image: httpsOnly(image) };
}

const ADAPTERS = {
    async bluesky(l) {
        const actor = encodeURIComponent(l.handle);
        const [p, feed] = await Promise.all([
            getJson(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${actor}`),
            getJson(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${actor}&limit=6&filter=posts_no_replies`),
        ]);
        const items = (feed.feed || []).filter((f) => !f.reason).slice(0, 3).map((f) => {
            const rkey = String(f.post.uri || '').split('/').pop();
            const img = f.post.embed && f.post.embed.images && f.post.embed.images[0];
            return { text: clip(f.post.record && f.post.record.text), url: `https://bsky.app/profile/${l.handle}/post/${rkey}`, at: f.post.indexedAt || null, image: httpsOnly(img && img.thumb) };
        });
        return { title: p.displayName || p.handle, subtitle: `${Number(p.followersCount || 0).toLocaleString('en-US')} followers · ${Number(p.postsCount || 0).toLocaleString('en-US')} posts`, image: httpsOnly(p.avatar), items };
    },
    async mastodon(l) {
        const u = new URL(l.url);
        const acct = String(l.handle || '').replace(/^@/, '').split('@')[0];
        const a = await getJson(`https://${u.hostname}/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
        const statuses = await getJson(`https://${u.hostname}/api/v1/accounts/${encodeURIComponent(a.id)}/statuses?limit=3&exclude_replies=true&exclude_reblogs=true`);
        return {
            title: a.display_name || a.username, subtitle: `${Number(a.followers_count || 0).toLocaleString('en-US')} followers`, image: httpsOnly(a.avatar),
            items: (statuses || []).slice(0, 3).map((s) => ({ text: clip(s.content), url: httpsOnly(s.url), at: s.created_at || null, image: httpsOnly(s.media_attachments && s.media_attachments[0] && s.media_attachments[0].preview_url) })),
        };
    },
    async github(l) {
        const [u, repos] = await Promise.all([
            getJson(`https://api.github.com/users/${encodeURIComponent(l.handle)}`),
            getJson(`https://api.github.com/users/${encodeURIComponent(l.handle)}/repos?sort=pushed&per_page=3`),
        ]);
        return {
            title: u.name || u.login, subtitle: `${Number(u.public_repos || 0)} repositories · ${Number(u.followers || 0).toLocaleString('en-US')} followers`, image: httpsOnly(u.avatar_url),
            items: (repos || []).slice(0, 3).map((r) => ({ text: `${r.name}${r.description ? ` — ${clip(r.description, 140)}` : ''}${r.stargazers_count ? ` · ★ ${r.stargazers_count}` : ''}`, url: httpsOnly(r.html_url), at: r.pushed_at || null })),
        };
    },
    async youtube(l) {
        let channelId = (/\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(l.url) || [])[1];
        let og = null;
        if (!channelId) {
            const r = await getText(l.url);
            channelId = (/"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(r.text) || /channel\/(UC[A-Za-z0-9_-]{22})/.exec(r.text) || [])[1];
            og = null;
        }
        if (!channelId) throw new Error('no channel id');
        const feed = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { accept: 'application/atom+xml,application/xml' });
        const entries = feed.text.split('<entry>').slice(1, 4);
        const title = clip((/<title>([^<]*)<\/title>/.exec(feed.text) || [])[1], 80);
        const items = entries.map((e) => {
            const vid = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e) || [])[1];
            return { text: clip((/<title>([^<]*)<\/title>/.exec(e) || [])[1], 140), url: vid ? `https://www.youtube.com/watch?v=${vid}` : null, at: (/<published>([^<]+)<\/published>/.exec(e) || [])[1] || null, image: vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : null };
        });
        return { title: title || (og && og.title), subtitle: 'Latest videos', image: null, items };
    },
    async twitch(l) {
        const login = String(l.handle || '').toLowerCase();
        const thumb = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-440x248.jpg`;
        // Offline channels' preview image redirects to a placeholder: follow it and look where it lands.
        const r = await egress.fetchBuffer(thumb, { timeoutMs: 5000, maxBytes: 256 * 1024, headers: { 'User-Agent': UA } });
        const live = r.status === 200 && !/404_preview/i.test(r.url);
        let og = {};
        try { og = await openGraph(l.url); } catch { og = {}; }
        return { title: og.title || login, subtitle: og.subtitle || null, image: og.image || null, live: { live, thumbnail: live ? `${thumb}?t=${Math.floor(Date.now() / 60000)}` : null }, items: [] };
    },
    async kick(l) {
        const c = await getJson(`https://kick.com/api/v2/channels/${encodeURIComponent(String(l.handle || '').toLowerCase())}`);
        const ls = c.livestream;
        return {
            title: (c.user && c.user.username) || l.handle, subtitle: c.followers_count != null ? `${Number(c.followers_count).toLocaleString('en-US')} followers` : null,
            image: httpsOnly(c.user && c.user.profile_pic),
            live: { live: !!(ls && ls.is_live), title: ls ? clip(ls.session_title, 140) : null, viewers: ls ? Number(ls.viewer_count || 0) : null, thumbnail: httpsOnly(ls && ls.thumbnail && ls.thumbnail.url) },
            items: [],
        };
    },
    async openvibe(l) {
        // The streamer's OpenVibe profile, from the Network's public profile API (ours, on loopback; the handle is a
        // checked username): their picture, how many items they own and what they wear.
        const base = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
        const r = await fetch(`${base}/api/v1/profiles/${encodeURIComponent(l.handle)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        const p = (await r.json()).profile || {};
        const title = clip(p.display_name || `@${l.handle}`, 80);
        if (p.private) return { title, subtitle: 'Profile on OpenVibe', image: httpsOnly(p.avatar_url), items: [] };
        const n = p.items && !p.items.unavailable ? Number(p.items.count) || 0 : null;
        const since = /^\d{4}/.test(String(p.member_since || '')) ? `on OpenVibe since ${String(p.member_since).slice(0, 4)}` : null;
        return {
            title,
            subtitle: [n === null ? null : `${n.toLocaleString('en-US')}${p.items.more ? '+' : ''} item${n === 1 ? '' : 's'}`, since].filter(Boolean).join(' · ') || 'Profile on OpenVibe',
            image: httpsOnly(p.avatar_url),
            items: (Array.isArray(p.showcase) ? p.showcase : []).slice(0, 3).map((s) => ({
                text: clip(`${s.art && s.art.emoji ? `${String(s.art.emoji).slice(0, 8)} ` : ''}Wearing ${s.name} (${RARITY[s.rarity] || 'Common'} ${String(s.kind_name || '').toLowerCase()})`, 120),
                url: httpsOnly(s.url),
            })),
        };
    },
    async x(l) {
        // No free API: the card links out; the page offers X's own embed on click.
        return { title: `@${l.handle}`, subtitle: 'Posts on X', image: null, items: [], embed: l.handle ? `/embed/x-timeline?h=${encodeURIComponent(l.handle)}` : null };
    },
};

/** A preview for one cleaned link (server/social/links.js cleanLink). Never throws: failures give { error }. */
async function preview(l) {
    const key = l.url;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
    let value;
    try {
        const fn = ADAPTERS[l.kind] || (async (x) => await openGraph(x.url));
        const needsHandle = ['bluesky', 'github', 'twitch', 'kick', 'mastodon', 'x', 'openvibe'].includes(l.kind);
        value = needsHandle && !l.handle ? await openGraph(l.url) : await fn(l);
        value = { kind: l.kind, url: l.url, items: [], ...value };
        remember(key, value, TTL);
    } catch (err) {
        // Platform APIs refuse sometimes: fall back to the page's own metadata, else a bare link.
        try { value = { kind: l.kind, url: l.url, items: [], ...(await openGraph(l.url)) }; remember(key, value, TTL); } catch {
            value = { kind: l.kind, url: l.url, items: [], error: err instanceof egress.EgressDenied ? 'not allowed' : 'unavailable' };
            remember(key, value, ERROR_TTL);
        }
    }
    return value;
}

function remember(key, value, ttl) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), ttl, value });
}

module.exports = { preview, openGraph, ADAPTERS, _cache: cache };
