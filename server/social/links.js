'use strict';
/**
 * A channel's social links: the platforms it restreams to (from its OAuth platform connections), plus the links the
 * streamer adds (X, Bluesky, Instagram, TikTok, YouTube, Discord, GitHub, … or any custom https link). Stored as
 * JSON on channels.social_links; shown as pills on the offline screen and as rich cards in the About tab.
 *
 *   cleanSocialLinks(input)          → the list to store, or null when it is not a valid list
 *   channelSocialLinks(channel, db)  → what viewers see: saved links first, then connected platforms not already
 *                                      listed and not hidden (channels.social_links.hidden_auto)
 */

const MAX_LINKS = 16;
const MAX_LABEL = 40;

// kind → how to recognise, normalise and show it. `hosts` are the only hosts a link of that kind may point at.
const PLATFORMS = {
    twitch:    { name: 'Twitch',    icon: 'fa-brands fa-twitch',    color: '#9146ff', hosts: ['twitch.tv'],                       url: (h) => `https://www.twitch.tv/${h}`,       handle: /^\/([A-Za-z0-9_]{2,25})\/?$/ },
    youtube:   { name: 'YouTube',   icon: 'fa-brands fa-youtube',   color: '#ff0033', hosts: ['youtube.com', 'youtu.be'],         url: (h) => `https://www.youtube.com/${h.startsWith('@') || h.startsWith('channel/') ? h : `@${h}`}`, handle: /^\/((?:@[A-Za-z0-9._-]{3,30})|(?:channel\/UC[A-Za-z0-9_-]{22})|(?:c\/[A-Za-z0-9._-]{1,60}))\/?$/ },
    kick:      { name: 'Kick',      icon: 'fa-brands fa-kickstarter-k', color: '#53fc18', hosts: ['kick.com'],                    url: (h) => `https://kick.com/${h}`,           handle: /^\/([A-Za-z0-9_-]{2,25})\/?$/ },
    x:         { name: 'X',         icon: 'fa-brands fa-x-twitter', color: '#e7e9ea', hosts: ['x.com', 'twitter.com'],           url: (h) => `https://x.com/${h}`,              handle: /^\/([A-Za-z0-9_]{1,15})\/?$/ },
    bluesky:   { name: 'Bluesky',   icon: 'fa-brands fa-bluesky',   color: '#1185fe', hosts: ['bsky.app'],                        url: (h) => `https://bsky.app/profile/${h}`,   handle: /^\/profile\/([A-Za-z0-9.-]{3,253})\/?$/ },
    instagram: { name: 'Instagram', icon: 'fa-brands fa-instagram', color: '#e1306c', hosts: ['instagram.com'],                   url: (h) => `https://www.instagram.com/${h}`,  handle: /^\/([A-Za-z0-9._]{1,30})\/?$/ },
    tiktok:    { name: 'TikTok',    icon: 'fa-brands fa-tiktok',    color: '#25f4ee', hosts: ['tiktok.com'],                      url: (h) => `https://www.tiktok.com/@${h.replace(/^@/, '')}`, handle: /^\/@([A-Za-z0-9._]{2,24})\/?$/ },
    discord:   { name: 'Discord',   icon: 'fa-brands fa-discord',   color: '#5865f2', hosts: ['discord.gg', 'discord.com'],       url: (h) => `https://discord.gg/${h}`,         handle: /^\/(?:invite\/)?([A-Za-z0-9-]{2,32})\/?$/ },
    github:    { name: 'GitHub',    icon: 'fa-brands fa-github',    color: '#e6edf3', hosts: ['github.com'],                      url: (h) => `https://github.com/${h}`,         handle: /^\/([A-Za-z0-9-]{1,39})\/?$/ },
    reddit:    { name: 'Reddit',    icon: 'fa-brands fa-reddit-alien', color: '#ff4500', hosts: ['reddit.com'],                   url: (h) => `https://www.reddit.com/user/${h}`, handle: /^\/(?:user|u)\/([A-Za-z0-9_-]{3,20})\/?$/ },
    threads:   { name: 'Threads',   icon: 'fa-brands fa-threads',   color: '#e7e9ea', hosts: ['threads.net', 'threads.com'],      url: (h) => `https://www.threads.net/@${h.replace(/^@/, '')}`, handle: /^\/@([A-Za-z0-9._]{1,30})\/?$/ },
    facebook:  { name: 'Facebook',  icon: 'fa-brands fa-facebook',  color: '#1877f2', hosts: ['facebook.com', 'fb.com'],          url: (h) => `https://www.facebook.com/${h}`,   handle: /^\/([A-Za-z0-9.]{5,50})\/?$/ },
    rumble:    { name: 'Rumble',    icon: 'fa-solid fa-play',       color: '#85c742', hosts: ['rumble.com'],                      url: (h) => `https://rumble.com/c/${h}`,       handle: /^\/c\/([A-Za-z0-9_-]{2,50})\/?$/ },
    patreon:   { name: 'Patreon',   icon: 'fa-brands fa-patreon',   color: '#ff424d', hosts: ['patreon.com'],                     url: (h) => `https://www.patreon.com/${h}`,    handle: /^\/([A-Za-z0-9_-]{2,64})\/?$/ },
    spotify:   { name: 'Spotify',   icon: 'fa-brands fa-spotify',   color: '#1db954', hosts: ['open.spotify.com'],                url: null,                                      handle: null },
    soundcloud:{ name: 'SoundCloud',icon: 'fa-brands fa-soundcloud',color: '#ff5500', hosts: ['soundcloud.com'],                  url: (h) => `https://soundcloud.com/${h}`,     handle: /^\/([A-Za-z0-9_-]{2,64})\/?$/ },
    linkedin:  { name: 'LinkedIn',  icon: 'fa-brands fa-linkedin',  color: '#0a66c2', hosts: ['linkedin.com'],                    url: (h) => `https://www.linkedin.com/in/${h}`, handle: /^\/in\/([A-Za-z0-9-]{3,100})\/?$/ },
    mastodon:  { name: 'Mastodon',  icon: 'fa-brands fa-mastodon',  color: '#6364ff', hosts: null,                                url: null,                                      handle: /^\/@([A-Za-z0-9_]{1,30})\/?$/ },
    website:   { name: 'Website',   icon: 'fa-solid fa-globe',      color: '#60a5fa', hosts: null,                                url: null,                                      handle: null },
    custom:    { name: 'Link',      icon: 'fa-solid fa-link',       color: '#94a3b8', hosts: null,                                url: null,                                      handle: null },
};
const AUTO_KINDS = ['twitch', 'youtube', 'kick'];

const hostMatches = (host, hosts) => hosts.some((h) => host === h || host.endsWith(`.${h}`));

/** Which platform a URL belongs to (by host), or null. */
function kindOfUrl(u) {
    let url; try { url = new URL(u); } catch { return null; }
    const host = url.hostname.toLowerCase();
    for (const [kind, p] of Object.entries(PLATFORMS)) if (p.hosts && hostMatches(host, p.hosts)) return kind;
    return null;
}

/**
 * One link, validated: { kind, url, handle, label, preview }. Accepts a URL, or a handle for a platform with a
 * handle pattern ("@name", "name"). https only; a platform link must point at that platform's hosts; custom and
 * website take any public https URL (the preview fetch checks the address, server/net/egress.js).
 */
function cleanLink(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let kind = String(raw.kind || '').toLowerCase();
    let value = String(raw.url || raw.handle || '').trim().slice(0, 300);
    if (!value) return null;
    // A federated handle (@user@instance.social) is a Mastodon profile wherever it is typed.
    const fed = /^@?([A-Za-z0-9_]{1,30})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.exec(value);
    if (fed && (kind === 'mastodon' || kind === 'custom' || kind === 'website' || !kind)) { kind = 'mastodon'; value = `https://${fed[2].toLowerCase()}/@${fed[1]}`; }
    if (!/^https?:\/\//i.test(value)) {
        const p = PLATFORMS[kind];
        if (!p || !p.url) {
            if (kind === 'custom' || kind === 'website' || !kind) value = `https://${value.replace(/^\/+/, '')}`;
            else return null;
        } else value = p.url(value.replace(/^@/, kind === 'youtube' ? '@' : ''));
    }
    let url; try { url = new URL(value.replace(/^http:\/\//i, 'https://')); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
    const detected = kindOfUrl(url.href);
    if (!PLATFORMS[kind] || kind === 'custom' || kind === 'website') kind = detected || (kind === 'website' ? 'website' : 'custom');
    else if (PLATFORMS[kind].hosts && detected !== kind) return null;
    const p = PLATFORMS[kind];
    const m = p.handle && p.handle.exec(url.pathname);
    const handle = kind === 'mastodon' ? (m ? `@${m[1]}@${url.hostname}` : null) : m ? m[1] : null;
    const label = raw.label ? String(raw.label).replace(/[<>]/g, '').trim().slice(0, MAX_LABEL) : '';
    return { kind, url: url.href.replace(/\/$/, ''), handle, label, preview: raw.preview !== false };
}

/** The list to store: { links: [...], hidden_auto: [...] } as JSON, or null when invalid. */
function cleanSocialLinks(input) {
    if (input == null) return JSON.stringify({ links: [], hidden_auto: [] });
    const obj = Array.isArray(input) ? { links: input } : typeof input === 'object' ? input : null;
    if (!obj || !Array.isArray(obj.links || [])) return null;
    const links = [];
    const seen = new Set();
    for (const raw of (obj.links || []).slice(0, MAX_LINKS * 2)) {
        const l = cleanLink(raw);
        if (!l || seen.has(l.url.toLowerCase())) continue;
        seen.add(l.url.toLowerCase());
        links.push(l);
        if (links.length >= MAX_LINKS) break;
    }
    const hidden = Array.isArray(obj.hidden_auto) ? obj.hidden_auto.map(String).filter((k) => AUTO_KINDS.includes(k)) : [];
    return JSON.stringify({ links, hidden_auto: [...new Set(hidden)] });
}

function parseStored(s) {
    try { const o = typeof s === 'string' ? JSON.parse(s) : s; return { links: Array.isArray(o && o.links) ? o.links : [], hidden_auto: Array.isArray(o && o.hidden_auto) ? o.hidden_auto : [] }; } catch { return { links: [], hidden_auto: [] }; }
}

/** The platform's display fields for a link (name, icon, color). */
function decorate(l, extra = {}) {
    const p = PLATFORMS[l.kind] || PLATFORMS.custom;
    return { ...l, name: p.name, icon: p.icon, color: p.color, ...extra };
}

/**
 * What viewers see: saved links (in the streamer's order), then the platforms the channel is connected to for
 * restreaming (Twitch, YouTube, Kick) that are not already listed and not hidden. `restreamsTo` (owner view only)
 * lists restream platforms that have no public channel URL yet, so the editor can ask for it.
 */
function channelSocialLinks(channel, db, { owner = false } = {}) {
    const stored = parseStored(channel && channel.social_links);
    const out = stored.links.map((l) => decorate(l));
    const kinds = new Set(out.map((l) => l.kind));
    let conns = [];
    try { conns = db.all('SELECT platform, platform_username, channel_url FROM platform_connections WHERE user_id = ?', [channel.user_id]) || []; } catch { conns = []; }
    const auto = [];
    for (const c of conns) {
        if (!AUTO_KINDS.includes(c.platform) || kinds.has(c.platform)) continue;
        const l = cleanLink({ kind: c.platform, url: c.channel_url || '', handle: c.platform_username || '' });
        if (!l) continue;
        const d = decorate(l, { auto: true, hidden: stored.hidden_auto.includes(c.platform) });
        auto.push(d);
        if (!d.hidden) { out.push(d); kinds.add(c.platform); }
    }
    const result = { links: out };
    if (owner) {
        let dests = [];
        try { dests = db.all("SELECT DISTINCT platform FROM restream_destinations WHERE user_id = ? AND platform IN ('twitch', 'youtube', 'kick')", [channel.user_id]) || []; } catch { dests = []; }
        result.connected = auto;
        result.restreams_without_link = dests.map((d) => d.platform).filter((p) => !kinds.has(p) && !auto.some((a) => a.kind === p));
        result.hidden_auto = stored.hidden_auto;
    }
    return result;
}

function catalog() {
    return Object.entries(PLATFORMS).map(([kind, p]) => ({ kind, name: p.name, icon: p.icon, color: p.color, handle: !!p.handle && !!p.url }));
}

module.exports = { PLATFORMS, cleanLink, cleanSocialLinks, channelSocialLinks, parseStored, kindOfUrl, catalog, MAX_LINKS };
