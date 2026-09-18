/**
 * openvibe-shared/footer.js — the cross-site footer, the counterpart to navbar.js.
 *
 *   OpenVibeFooter.init({ service, variant, links, apiBase, mount })
 *   OpenVibeFooter.setVariant('full' | 'compact')      switch at runtime (SPA route changes)
 *   OpenVibeFooter.buildHTML(cfg)                      markup only — usable from Node for SSR
 *
 * Why this exists: every property was hand-rolling its own footer, so the network links, the
 * legal links and the styling drifted apart, and a site that gained a new sibling had to be
 * edited by hand. Here the site passes only the links that are *its own*; the Network column,
 * the Legal column, the signed-in row and all the styling come from this module, so adding a
 * property or changing a policy link updates every site at once.
 *
 * Variants:
 *   full     the multi-column footer, for home and browse pages
 *   compact  one quiet line, for pages where the footer is not the point — a streamer's
 *            channel, a player, a tool someone is mid-task in
 *
 * Signed-in visitors get a cross-site row: their account, their channel, themes and the tools
 * hub, so the network behaves like one product instead of a ring of separate sites. It reads
 * the shared ov_token the same way navbar.js does and never blocks rendering on it.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;   // Node (SSR)
    if (typeof window !== 'undefined') window.OpenVibeFooter = api;           // browser
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
    // ── Shared chrome data (https://openvibe.network/api/chrome) ─────────────────────────────
    // Sites ordered by real use, footer copy and per-site legal links. Cached per host for 30
    // minutes in localStorage and refreshed in the background, so pages paint from cache and the
    // order never jumps while someone is looking at it. Defined once, shared by navbar + footer.
    const OVChrome = root.OpenVibeChrome || (root.OpenVibeChrome = (function () {
        const KEY = 'ov_chrome_v1', TTL = 30 * 60000;
        let inflight = null;
        const host = () => (typeof location !== 'undefined' ? location.hostname : '');
        const https = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
        function clean(d) {
            if (!d || !Array.isArray(d.nav)) return null;
            const link = (l) => (l && typeof l.name === 'string' && https(l.url) ? { id: String(l.id || ''), name: l.name.slice(0, 60), url: l.url, icon: String(l.icon || ''), tagline: String(l.tagline || '').slice(0, 80) } : null);
            const f = d.footer || {}, lg = f.legal || {};
            return { nav: d.nav.map(link).filter(Boolean).slice(0, 12), soon: (d.soon || []).map(link).filter(Boolean).slice(0, 24),
                footer: { blurb: String(f.blurb || '').slice(0, 200), discover: (f.discover || []).map(link).filter(Boolean).slice(0, 6), popular: (f.popular || []).map(link).filter(Boolean).slice(0, 10),
                    legal: https(lg.terms) && https(lg.privacy) && https(lg.dmca) ? { terms: lg.terms, privacy: lg.privacy, dmca: lg.dmca } : null } };
        }
        function cached() { try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); return c && c.host === host() && c.data ? c : null; } catch { return null; } }
        function refresh() {
            if (inflight || typeof fetch === 'undefined') return inflight || Promise.resolve(null);
            inflight = fetch('https://openvibe.network/api/chrome?host=' + encodeURIComponent(host()), { credentials: 'omit' })
                .then(r => (r.ok ? r.json() : null)).then(clean)
                .then(d => { if (d) { try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), host: host(), data: d })); } catch { /* */ } } return d; })
                .catch(() => null);
            return inflight;
        }
        /** Cached data now (or null); `onFirst` fires once when a first-ever fetch lands. */
        function get(onFirst) {
            const c = cached();
            if (!c || Date.now() - c.at > TTL) { const p = refresh(); if (!c && onFirst) p.then(d => { if (d) onFirst(d); }); }
            return c ? c.data : null;
        }
        return { get, refresh };
    })());

    const NETWORK_URL = 'https://openvibe.network';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // One place that knows what the network contains. Adding a property here gives every site
    // the link, with no edit anywhere else.
    const NETWORK = [
        { id: 'live', name: 'Live streaming', url: 'https://openvibe.live', desc: 'Go live, restream and clip' },
        { id: 'tools', name: 'Online tools', url: 'https://openvibe.tools', desc: 'The whole toolbox' },
        { id: 'dev', name: 'Developer tools', url: 'https://dev.openvibe.tools', desc: 'Formatters, encoders, validators' },
        { id: 'net', name: 'Network diagnostics', url: 'https://net.openvibe.tools', desc: 'Ping, DNS, Whois, SSL' },
        { id: 'img', name: 'Image converter', url: 'https://img.openvibe.tools', desc: 'Convert, resize, compress' },
        { id: 'audio', name: 'Audio converter', url: 'https://audio.openvibe.tools', desc: 'Convert, trim, pitch-shift' },
        { id: 'docs', name: 'PDF & document tools', url: 'https://docs.openvibe.tools', desc: 'Merge, split, compress' },
        { id: 'text', name: 'Text tools', url: 'https://text.openvibe.tools', desc: 'Fancy text, case, ASCII' },
        { id: 'yt', name: 'YouTube downloader', url: 'https://yt.openvibe.tools', desc: 'Video and audio' },
        { id: 'community', name: 'Community & pastes', url: 'https://openvibe.community', desc: 'Pastes, posts and the people of OpenVibe' },
        { id: 'games', name: 'Games', url: 'https://openvibe.games', desc: 'Scraplandia and browser games' },
        { id: 'media', name: 'Media', url: 'https://openvibe.media', desc: 'VODs, clips and files for every site' },
        { id: 'network', name: 'Account & themes', url: NETWORK_URL, desc: 'One account, every site' },
        { id: 'more', name: 'The whole network →', url: NETWORK_URL + '/#network', desc: 'Every OpenVibe site, live and upcoming' },
    ];

    const LEGAL = [
        { key: 'terms', name: 'Terms of Service', path: '/tos', fallback: 'https://openvibe.live/tos' },
        { key: 'privacy', name: 'Privacy Policy', path: '/privacy', fallback: 'https://openvibe.live/privacy' },
        { key: 'dmca', name: 'DMCA', path: '/dmca', fallback: 'https://openvibe.live/dmca' },
    ];

    const SOCIAL = [
        { name: 'GitHub', icon: 'github', url: 'https://github.com/OpenVibers' },
        { name: 'Discord', icon: 'discord', url: 'https://discord.gg/M6MuRUaeJj' },
    ];

    const DEFAULTS = {
        service: null,               // 'live' | 'tools' | 'dev' | … (auto-detected when omitted)
        brandName: null,
        tagline: 'Open source and community run. Built in the open by the people using it.',
        variant: 'full',
        mount: '#ov-footer',
        links: [],                   // [{ heading, items: [{ name, url, onclick? }] }]
        legalBase: null,             // origin that hosts /tos, /privacy, /dmca for this site
        apiBase: NETWORK_URL,
        user: null,
        showNetwork: true,
        showAccount: true,
        sitemap: '/sitemap.xml',
    };

    let _cfg = { ...DEFAULTS };
    let _mounted = null;

    function detectService() {
        if (typeof location === 'undefined') return 'network';
        const h = location.hostname;
        if (h.endsWith('openvibe.live')) return 'live';
        if (h.endsWith('openvibe.network')) return 'network';
        if (h.endsWith('openvibe.games')) return 'games';
        const sub = h.replace(/\.openvibe\.tools$/, '');
        return sub === h ? 'tools' : (sub || 'tools');
    }

    const TLD_LABELS = { live: 'Live', tools: 'Tools', network: 'Network', media: 'Media', games: 'Games', community: 'Community', chat: 'Chat', codes: 'Codes', blog: 'Blog', wiki: 'Wiki', news: 'News', reviews: 'Reviews', tips: 'Tips', vip: 'VIP', trade: 'Trade', host: 'Host', deals: 'Deals', coupons: 'Coupons' };
    /** The full site name from the hostname — the same spelling the navbar uses (Pastes.OpenVibe.Tools). */
    function brandFor(service) {
        // The navbar already resolved the spelling (MergePDF, JSON, Pastes…): reuse it so the two
        // never disagree on the same page.
        try { const nb = typeof window !== 'undefined' && window.OpenVibeNavbar && window.OpenVibeNavbar.brand && window.OpenVibeNavbar.brand(); if (nb && nb.name) return nb.name; } catch { /* */ }
        const h = typeof location !== 'undefined' ? location.hostname.toLowerCase() : '';
        const cap = (w) => w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
        let m = h.match(/^(?:(.+)\.)?openvibe\.([a-z]+)$/);
        if (m) { const sub = m[1] && m[1] !== 'www' ? m[1] : null; return [sub ? (sub.length <= 4 ? sub.toUpperCase() : cap(sub)) : null, 'OpenVibe', TLD_LABELS[m[2]] || cap(m[2])].filter(Boolean).join('.'); }
        if ((m = h.match(/^(?:(.+)\.)?openre\.stream$/))) return 'OpenRe.Stream';
        const found = NETWORK.find(n => n.id === service);
        if (service && TLD_LABELS[service]) return `OpenVibe.${TLD_LABELS[service]}`;
        if (found && found.name !== 'Account & themes' && found.name !== 'The whole network →') return `${cap(service)}.OpenVibe.Tools`;
        return 'OpenVibe';
    }

    function legalHref(item, cfg) {
        // Each site answers for itself: the chrome service names this domain's own documents.
        const chrome = cfg._chrome;
        if (chrome && chrome.footer.legal && !cfg.legalBase) return chrome.footer.legal[item.key];
        // Policies live on whichever site owns them; a tool subdomain links out rather than 404ing.
        if (cfg.legalBase) return cfg.legalBase.replace(/\/$/, '') + item.path;
        if (typeof location !== 'undefined' && location.hostname.endsWith('openvibe.live')) return item.path;
        return item.fallback;
    }

    // ── Icons ──────────────────────────────────────────────────
    // The footer ships its own icons. It used to borrow the page's Font Awesome, so on pages that do not
    // load that font (the server-rendered Tools and legal pages) every icon was an empty box.
    const ICONS = {
        github: '<path fill="currentColor" stroke="none" d="M12 2.2a9.8 9.8 0 0 0-3.1 19.1c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.2-4.5-1.1-4.5-4.8 0-1.1.4-1.9 1-2.6-.1-.2-.4-1.2.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.6.6.7 1 1.5 1 2.6 0 3.7-2.3 4.6-4.5 4.8.4.3.7.9.7 1.800v2.700c0 .3.2.6.7.5A9.8 9.8 0 0 0 12 2.200z"/>',
        discord: '<path fill="currentColor" stroke="none" d="M19.3 5.300a16.5 16.5 0 0 0-4.1-1.300l-.5 1a15.3 15.3 0 0 0-5.4 0l-.5-1a16.5 16.5 0 0 0-4.1 1.300C2.1 9.2 1.4 13 1.7 16.700a16.6 16.6 0 0 0 5.1 2.600l1.1-1.800c-.6-.2-1.2-.5-1.7-.8l.4-.3a11.8 11.8 0 0 0 10.8 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.800a16.6 16.6 0 0 0 5.1-2.600c.4-4.3-.7-8.1-3-11.400zM8.7 14.400c-1 0-1.8-.9-1.8-2.100s.8-2.1 1.8-2.1 1.9 1 1.8 2.100c0 1.2-.8 2.1-1.8 2.100zm6.6 0c-1 0-1.8-.9-1.8-2.100s.8-2.1 1.8-2.1 1.9 1 1.8 2.100c0 1.2-.8 2.1-1.8 2.100z"/>',
        sitemap: '<rect x="9" y="3.5" width="6" height="4.5" rx="1"/><rect x="3" y="16" width="6" height="4.5" rx="1"/><rect x="15" y="16" width="6" height="4.5" rx="1"/><path d="M12 8v4M6 16v-2.500h12V16"/>',
        arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
        channel: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.800a6 6 0 0 0 0 8.400M16.2 7.800a6 6 0 0 1 0 8.400M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
        dashboard: '<path d="M4.5 17a8 8 0 1 1 15 0M12 13l3.5-4"/><circle cx="12" cy="13.5" r="1.3"/>',
        account: '<circle cx="12" cy="9" r="3.2"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/>',
        themes: '<path d="M12 4.500a7.5 7.5 0 1 0 0 15c1 0 1.6-.8 1.2-1.7-.5-1.1.3-2.3 1.5-2.300h1.600a3.2 3.2 0 0 0 3.2-3.200C19.5 8 16.2 4.5 12 4.500z"/><circle cx="8.5" cy="11" r=".7"/><circle cx="11.5" cy="8" r=".7"/><circle cx="15" cy="9" r=".7"/>',
        tools: '<path d="M14.5 5.500a4 4 0 0 0-5.2 5.200L4.5 15.500a1.8 1.8 0 0 0 2.5 2.500l4.8-4.800a4 4 0 0 0 5.2-5.200l-2.6 2.6-2.1-.5-.5-2.100z"/>',
    };
    const icon = (name) => `<svg class="ovf-ic" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${(ICONS[name] || ICONS.arrow)}</svg>`;

    // ── Markup ─────────────────────────────────────────────────
    function linkTag(item) {
        // Our own sites open in this tab (the sign-in hand-off follows the click); the rest of the web in a new one.
        const own = /^https:\/\/([a-z0-9-]+\.)*(openvibe\.[a-z]+|openre\.stream)(\/|$)/i.test(item.url);
        const rel = /^https?:\/\//.test(item.url) && !own ? ' target="_blank" rel="noopener"' : '';
        const onclick = item.onclick ? ` onclick="${esc(item.onclick)}"` : '';
        const title = item.desc ? ` title="${esc(item.desc)}"` : '';
        return `<a href="${esc(item.url)}"${rel}${onclick}${title}>${esc(item.name)}</a>`;
    }

    function buildHTML(cfg) {
        const c = { ...DEFAULTS, ...(cfg || {}) };
        const service = c.service || detectService();
        const brand = c.brandName || brandFor(service);
        const chrome = c._chrome = OVChrome.get(() => { try { render(); } catch { /* */ } });
        // Most used sites first when the chrome service has spoken; the built-in list otherwise.
        const network = chrome && chrome.nav.length
            ? chrome.nav.filter(n => n.id !== service && !(typeof location !== 'undefined' && new URL(n.url).hostname === location.hostname)).map(n => ({ name: 'OpenVibe.' + n.name, url: n.url, desc: n.tagline }))
            : NETWORK.filter(n => n.id !== service);
        const tagline = (cfg && cfg.tagline) || (chrome && chrome.footer.blurb) || c.tagline;
        const popular = chrome ? chrome.footer.popular : [];
        const discover = chrome ? chrome.footer.discover.filter(d => !network.slice(0, 6).some(n => n.url === d.url)) : [];
        const year = new Date().getFullYear();

        if (c.variant === 'compact') {
            return `<div class="ovf-inner ovf-inner--compact">
                <a class="ovf-brand ovf-brand--sm" href="/"><span class="ov-mark" data-size="20"></span><span>${esc(brand)}</span></a>
                <nav class="ovf-compact-links" aria-label="Site links">
                    ${(c.links[0] ? c.links[0].items.slice(0, 3) : []).map(linkTag).join('')}
                    <a href="${NETWORK_URL}" target="_blank" rel="noopener">Network</a>
                    ${LEGAL.map(l => `<a href="${esc(legalHref(l, c))}">${esc(l.name.replace(' of Service', '').replace(' Policy', ''))}</a>`).join('')}
                </nav>
                <span class="ovf-compact-meta">Open source · ${year}</span>
            </div>`;
        }

        const cols = (c.links || []).map(group => `
            <nav class="ovf-col" aria-label="${esc(group.heading)}">
                <h3>${esc(group.heading)}</h3>
                ${group.items.map(linkTag).join('')}
            </nav>`).join('');

        return `<div class="ovf-inner">
            <div class="ovf-cols">
                <div class="ovf-col ovf-col--brand">
                    <a class="ovf-brand" href="/"><span class="ov-mark" data-size="26"></span><span>${esc(brand)}</span></a>
                    <p class="ovf-tagline">${esc(tagline)}</p>
                    <div class="ovf-social">
                        ${SOCIAL.map(s => `<a href="${s.url}" target="_blank" rel="noopener" aria-label="${s.name}" title="${s.name}">${icon(s.icon)}</a>`).join('')}
                        <a href="${esc(c.sitemap)}" aria-label="Sitemap" title="Sitemap">${icon('sitemap')}</a>
                    </div>
                </div>
                ${cols}
                ${c.showNetwork ? `<nav class="ovf-col" aria-label="The OpenVibe network">
                    <h3>Network</h3>
                    ${network.slice(0, 6).map(linkTag).join('')}
                    <a class="ovf-more" href="${NETWORK_URL}" target="_blank" rel="noopener">Everything else ${icon('arrow')}</a>
                </nav>` : ''}
                ${popular.length ? `<nav class="ovf-col" aria-label="Popular tools">
                    <h3>Popular tools</h3>
                    ${popular.slice(0, 6).concat(discover.slice(0, 2)).map(linkTag).join('')}
                    <a class="ovf-more" href="https://openvibe.tools/all-tools">All tools ${icon('arrow')}</a>
                </nav>` : ''}
                <nav class="ovf-col" aria-label="Legal">
                    <h3>Legal</h3>
                    ${LEGAL.map(l => `<a href="${esc(legalHref(l, c))}">${esc(l.name)}</a>`).join('')}
                </nav>
            </div>
            <div class="ovf-account" id="ovf-account" hidden></div>
            <div class="ovf-bar">
                <span class="ovf-copy">Open source &amp; community driven · built in the open</span>
                <span class="ovf-legal-inline">
                    ${LEGAL.map(l => `<a href="${esc(legalHref(l, c))}">${esc(l.name.replace(' of Service', '').replace(' Policy', ''))}</a>`).join('')}
                </span>
            </div>
        </div>`;
    }

    // ── Signed-in row: the same account, wherever you are ──────
    function accountHTML(user, service) {
        const name = esc(user.display_name || user.username || 'you');
        const avatar = user.avatar_url
            ? `<img src="${esc(user.avatar_url)}" alt="">`
            : `<span>${esc(String(name).charAt(0).toUpperCase())}</span>`;
        const quick = [
            service !== 'live' ? { name: 'My channel', url: `https://openvibe.live/@${esc(user.username || '')}`, icon: 'channel' } : { name: 'My dashboard', url: '/dashboard', icon: 'dashboard' },
            { name: 'Account', url: `${NETWORK_URL}/my`, icon: 'account' },
            { name: 'Themes', url: `${NETWORK_URL}/themes`, icon: 'themes' },
            { name: 'Tools', url: 'https://openvibe.tools', icon: 'tools' },
        ];
        return `<span class="ovf-account-who"><span class="ovf-avatar">${avatar}</span> Signed in as <strong>${name}</strong> across OpenVibe</span>
            <span class="ovf-account-links">${quick.map(q => `<a href="${esc(q.url)}"${/^https?:/.test(q.url) ? ' target="_blank" rel="noopener"' : ''}>${icon(q.icon)} ${esc(q.name)}</a>`).join('')}</span>`;
    }

    function storedToken() {
        try {
            const m = document.cookie.match(/(?:^|; )ov_token=([^;]*)/);
            return (m && decodeURIComponent(m[1])) || localStorage.getItem('ov_token') || localStorage.getItem('token') || null;
        } catch { return null; }
    }

    async function fillAccount(cfg) {
        const host = document.getElementById('ovf-account');
        if (!host || !cfg.showAccount || cfg.variant === 'compact') return;
        let user = cfg.user;
        if (!user) {
            const token = storedToken();
            if (!token) return;
            try {
                const res = await fetch(`${cfg.apiBase}/api/auth/me`, { headers: { Authorization: 'Bearer ' + token }, credentials: 'include' });
                if (!res.ok) return;
                const data = await res.json();
                user = data.user || data;
            } catch { return; }
        }
        if (!user || !user.username) return;
        host.innerHTML = accountHTML(user, cfg.service || detectService());
        host.hidden = false;
    }

    // ── Styles (injected once) ─────────────────────────────────
    const CSS = `
.ovf{background:var(--bg-secondary,#12131c);border-top:1px solid var(--border,rgba(255,255,255,.08));margin-top:40px;
  padding:clamp(24px,4vw,40px) clamp(14px,4vw,32px) calc(clamp(20px,3vw,28px) + env(safe-area-inset-bottom,0px));}
.ovf[data-variant="compact"]{margin-top:24px;padding:14px clamp(12px,3vw,24px) calc(14px + env(safe-area-inset-bottom,0px));}
.ovf-inner{max-width:1240px;margin:0 auto}
.ovf-inner--compact{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 18px;text-align:center}
.ovf-cols{display:grid;gap:clamp(20px,3vw,36px);grid-template-columns:minmax(230px,1.6fr) repeat(auto-fit,minmax(120px,1fr));align-items:start}
.ovf-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.ovf-col h3{margin:0 0 2px;font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted,#8b93ad)}
.ovf-col a{color:var(--text-secondary,#b6bdd2);font-size:.86rem;text-decoration:none;line-height:1.4;width:fit-content;transition:color .15s,transform .15s}
.ovf-col a:hover{color:var(--accent,#60a5fa);transform:translateX(2px)}
.ovf-more{font-weight:600;opacity:.85}.ovf-ic{flex:none;vertical-align:-.14em}.ovf-more .ovf-ic{font-size:.85em;margin-left:3px;transition:transform .15s}.ovf-more:hover .ovf-ic{transform:translateX(3px)}.ovf-social .ovf-ic{font-size:17px}.ovf-account-links .ovf-ic{font-size:1.05em;opacity:.85}
.ovf-brand{display:inline-flex;align-items:center;gap:9px;color:var(--text-primary,#f1f4fb);font-size:1.05rem;font-weight:700;text-decoration:none}
.ovf-brand--sm{font-size:.9rem}
.ovf-tagline{margin:0;font-size:.82rem;line-height:1.55;color:var(--text-muted,#8b93ad);max-width:46ch}
.ovf-social{display:flex;gap:8px;margin-top:4px}
.ovf-social a{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;color:var(--text-secondary,#b6bdd2);
  background:var(--bg-tertiary,#1a1b28);border:1px solid var(--border,rgba(255,255,255,.08));font-size:.95rem;transition:color .15s,border-color .15s,transform .15s}
.ovf-social a:hover{color:var(--accent,#60a5fa);border-color:var(--accent,#60a5fa);transform:translateY(-2px)}
.ovf-account{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 18px;
  margin-top:clamp(18px,2.5vw,26px);padding:10px 14px;border-radius:14px;
  background:color-mix(in srgb, var(--accent,#60a5fa) 8%, var(--bg-tertiary,#1a1b28));
  border:1px solid color-mix(in srgb, var(--accent,#60a5fa) 26%, var(--border,rgba(255,255,255,.08)));
  animation:ovfIn .4s ease-out both}
@keyframes ovfIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ovf-account-who{display:inline-flex;align-items:center;gap:8px;font-size:.84rem;color:var(--text-secondary,#b6bdd2)}
.ovf-account-who strong{color:var(--text-primary,#f1f4fb)}
.ovf-avatar{width:24px;height:24px;border-radius:50%;overflow:hidden;display:grid;place-items:center;
  background:var(--accent,#60a5fa);color:#fff;font-size:.7rem;font-weight:800;flex:none}
.ovf-avatar img{width:100%;height:100%;object-fit:cover}
.ovf-account-links{display:flex;flex-wrap:wrap;gap:6px}
.ovf-account-links a{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:.78rem;font-weight:600;
  color:var(--text-secondary,#b6bdd2);background:var(--bg-secondary,#12131c);border:1px solid var(--border,rgba(255,255,255,.08));
  text-decoration:none;transition:color .15s,border-color .15s,transform .15s}
.ovf-account-links a:hover{color:var(--accent,#60a5fa);border-color:var(--accent,#60a5fa);transform:translateY(-1px)}
.ovf-account-links i{font-size:.72rem;opacity:.8}
.ovf-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;
  margin-top:clamp(20px,3vw,30px);padding-top:16px;border-top:1px solid var(--border,rgba(255,255,255,.08));
  padding-inline:clamp(0px, calc(84px - (100vw - 1240px) / 2), 84px)}
.ovf-copy{color:var(--text-muted,#8b93ad);font-size:.78rem}
.ovf-legal-inline,.ovf-compact-links{display:flex;flex-wrap:wrap;gap:14px}
.ovf-legal-inline a,.ovf-compact-links a{color:var(--text-muted,#8b93ad);font-size:.78rem;text-decoration:none;transition:color .15s}
.ovf-legal-inline a:hover,.ovf-compact-links a:hover{color:var(--accent,#60a5fa)}
.ovf-compact-meta{color:var(--text-muted,#8b93ad);font-size:.74rem}
@media (max-width:900px){.ovf-cols{grid-template-columns:repeat(2,minmax(0,1fr))}.ovf-col--brand{grid-column:1/-1}}
@media (max-width:560px){
  .ovf{padding-bottom:calc(96px + env(safe-area-inset-bottom,0px))}
  .ovf[data-variant="compact"]{padding-bottom:calc(84px + env(safe-area-inset-bottom,0px))}
  .ovf-cols{gap:22px 16px}
  .ovf-bar{justify-content:center;text-align:center;padding-inline:0}
  .ovf-legal-inline{justify-content:center}
  .ovf-account{flex-direction:column;align-items:flex-start}
}
@media (prefers-reduced-motion:reduce){.ovf-account{animation:none}.ovf-col a:hover,.ovf-social a:hover,.ovf-account-links a:hover{transform:none}}`;

    function injectCSS() {
        if (typeof document === 'undefined' || document.getElementById('ovf-css')) return;
        const st = document.createElement('style');
        st.id = 'ovf-css';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    // ── Mount ──────────────────────────────────────────────────
    function render() {
        if (!_mounted) return;
        _mounted.className = 'ovf ' + (_mounted.dataset.extraClass || '');
        _mounted.setAttribute('data-variant', _cfg.variant);
        _mounted.innerHTML = buildHTML(_cfg);
        try { if (typeof window !== 'undefined' && typeof window.ovMarkMount === 'function') window.ovMarkMount(_mounted); } catch { /* */ }
        fillAccount(_cfg);
    }

    function init(cfg = {}) {
        _cfg = { ...DEFAULTS, ..._cfg, ...cfg };
        _cfg.service = _cfg.service || detectService();
        injectCSS();
        const el = typeof _cfg.mount === 'string' ? document.querySelector(_cfg.mount) : _cfg.mount;
        if (!el) return null;
        _mounted = el;
        render();
        return el;
    }

    function setVariant(variant) {
        if (variant !== 'full' && variant !== 'compact') return;
        if (_cfg.variant === variant) return;
        _cfg.variant = variant;
        render();
    }

    return { init, setVariant, buildHTML, render, CSS, NETWORK, LEGAL, detectService, get config() { return { ..._cfg }; } };
});
