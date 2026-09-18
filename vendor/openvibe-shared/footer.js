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
        { name: 'Terms of Service', path: '/tos', fallback: 'https://openvibe.live/tos' },
        { name: 'Privacy Policy', path: '/privacy', fallback: 'https://openvibe.live/privacy' },
        { name: 'DMCA', path: '/dmca', fallback: 'https://openvibe.live/dmca' },
    ];

    const SOCIAL = [
        { name: 'GitHub', icon: 'fa-brands fa-github', url: 'https://github.com/OpenVibers' },
        { name: 'Discord', icon: 'fa-brands fa-discord', url: 'https://discord.gg/M6MuRUaeJj' },
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
        // Policies live on whichever site owns them; a tool subdomain links out rather than 404ing.
        if (cfg.legalBase) return cfg.legalBase.replace(/\/$/, '') + item.path;
        if (typeof location !== 'undefined' && location.hostname.endsWith('openvibe.live')) return item.path;
        return item.fallback;
    }

    // ── Markup ─────────────────────────────────────────────────
    function linkTag(item) {
        const rel = /^https?:\/\//.test(item.url) ? ' target="_blank" rel="noopener"' : '';
        const onclick = item.onclick ? ` onclick="${esc(item.onclick)}"` : '';
        const title = item.desc ? ` title="${esc(item.desc)}"` : '';
        return `<a href="${esc(item.url)}"${rel}${onclick}${title}>${esc(item.name)}</a>`;
    }

    function buildHTML(cfg) {
        const c = { ...DEFAULTS, ...(cfg || {}) };
        const service = c.service || detectService();
        const brand = c.brandName || brandFor(service);
        const network = NETWORK.filter(n => n.id !== service);
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
                    <p class="ovf-tagline">${esc(c.tagline)}</p>
                    <div class="ovf-social">
                        ${SOCIAL.map(s => `<a href="${s.url}" target="_blank" rel="noopener" aria-label="${s.name}" title="${s.name}"><i class="${s.icon}"></i></a>`).join('')}
                        <a href="${esc(c.sitemap)}" aria-label="Sitemap" title="Sitemap"><i class="fa-solid fa-sitemap"></i></a>
                    </div>
                </div>
                ${cols}
                ${c.showNetwork ? `<nav class="ovf-col" aria-label="The OpenVibe network">
                    <h3>Network</h3>
                    ${network.slice(0, 6).map(linkTag).join('')}
                    <a class="ovf-more" href="${NETWORK_URL}" target="_blank" rel="noopener">Everything else <i class="fa-solid fa-arrow-right"></i></a>
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
            service !== 'live' ? { name: 'My channel', url: `https://openvibe.live/@${esc(user.username || '')}`, icon: 'fa-tower-broadcast' } : { name: 'My dashboard', url: '/dashboard', icon: 'fa-gauge-high' },
            { name: 'Account', url: `${NETWORK_URL}/my`, icon: 'fa-user' },
            { name: 'Themes', url: `${NETWORK_URL}/themes`, icon: 'fa-palette' },
            { name: 'Tools', url: 'https://openvibe.tools', icon: 'fa-screwdriver-wrench' },
        ];
        return `<span class="ovf-account-who"><span class="ovf-avatar">${avatar}</span> Signed in as <strong>${name}</strong> across OpenVibe</span>
            <span class="ovf-account-links">${quick.map(q => `<a href="${esc(q.url)}"${/^https?:/.test(q.url) ? ' target="_blank" rel="noopener"' : ''}><i class="fa-solid ${q.icon}"></i> ${esc(q.name)}</a>`).join('')}</span>`;
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
.ovf-col a:hover{color:var(--accent,#a78bfa);transform:translateX(2px)}
.ovf-more{font-weight:600;opacity:.85}.ovf-more i{font-size:.7rem;transition:transform .15s}.ovf-more:hover i{transform:translateX(3px)}
.ovf-brand{display:inline-flex;align-items:center;gap:9px;color:var(--text-primary,#f1f4fb);font-size:1.05rem;font-weight:700;text-decoration:none}
.ovf-brand--sm{font-size:.9rem}
.ovf-tagline{margin:0;font-size:.82rem;line-height:1.55;color:var(--text-muted,#8b93ad);max-width:46ch}
.ovf-social{display:flex;gap:8px;margin-top:4px}
.ovf-social a{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;color:var(--text-secondary,#b6bdd2);
  background:var(--bg-tertiary,#1a1b28);border:1px solid var(--border,rgba(255,255,255,.08));font-size:.95rem;transition:color .15s,border-color .15s,transform .15s}
.ovf-social a:hover{color:var(--accent,#a78bfa);border-color:var(--accent,#a78bfa);transform:translateY(-2px)}
.ovf-account{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 18px;
  margin-top:clamp(18px,2.5vw,26px);padding:10px 14px;border-radius:14px;
  background:color-mix(in srgb, var(--accent,#a78bfa) 8%, var(--bg-tertiary,#1a1b28));
  border:1px solid color-mix(in srgb, var(--accent,#a78bfa) 26%, var(--border,rgba(255,255,255,.08)));
  animation:ovfIn .4s ease-out both}
@keyframes ovfIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ovf-account-who{display:inline-flex;align-items:center;gap:8px;font-size:.84rem;color:var(--text-secondary,#b6bdd2)}
.ovf-account-who strong{color:var(--text-primary,#f1f4fb)}
.ovf-avatar{width:24px;height:24px;border-radius:50%;overflow:hidden;display:grid;place-items:center;
  background:var(--accent,#a78bfa);color:#fff;font-size:.7rem;font-weight:800;flex:none}
.ovf-avatar img{width:100%;height:100%;object-fit:cover}
.ovf-account-links{display:flex;flex-wrap:wrap;gap:6px}
.ovf-account-links a{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:.78rem;font-weight:600;
  color:var(--text-secondary,#b6bdd2);background:var(--bg-secondary,#12131c);border:1px solid var(--border,rgba(255,255,255,.08));
  text-decoration:none;transition:color .15s,border-color .15s,transform .15s}
.ovf-account-links a:hover{color:var(--accent,#a78bfa);border-color:var(--accent,#a78bfa);transform:translateY(-1px)}
.ovf-account-links i{font-size:.72rem;opacity:.8}
.ovf-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;
  margin-top:clamp(20px,3vw,30px);padding-top:16px;border-top:1px solid var(--border,rgba(255,255,255,.08));
  padding-inline:clamp(0px, calc(84px - (100vw - 1240px) / 2), 84px)}
.ovf-copy{color:var(--text-muted,#8b93ad);font-size:.78rem}
.ovf-legal-inline,.ovf-compact-links{display:flex;flex-wrap:wrap;gap:14px}
.ovf-legal-inline a,.ovf-compact-links a{color:var(--text-muted,#8b93ad);font-size:.78rem;text-decoration:none;transition:color .15s}
.ovf-legal-inline a:hover,.ovf-compact-links a:hover{color:var(--accent,#a78bfa)}
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
