/**
 * openvibe-shared/ov-icons.js — the OpenVibe animated icon family.
 *
 *   <span class="ov-icon" data-icon="youtube" data-size="40"></span>
 *   <span class="ov-icon" data-icon="pdf" data-state="busy" data-progress="0.4" data-fx="orbit"></span>
 *
 * One construction for every icon so the network reads as one brand: the OV ring (with its comet)
 * around a glyph drawn in the theme accent. The ring is also a progress meter (data-progress 0–1)
 * and a status light (data-state idle|busy|ok|error), so the same icon that names a tool can show
 * what the tool is doing. Glyphs are 24×24 stroke paths centred in the ring.
 *
 *   OpenVibeIcons.names()                          every registered icon
 *   OpenVibeIcons.register(name, { glyph, fx?, accent? })
 *   OpenVibeIcons.mount(root?)                     (re)scan; new nodes are picked up automatically
 *   OpenVibeIcons.set(el, { progress, state, icon })
 *   OpenVibeIcons.svg(name, size)                  markup string, for server-side / templates
 *
 * Effects (data-fx): orbit (default) · pulse · draw · bounce · none. Motion is transform/opacity/
 * stroke only and stops under prefers-reduced-motion. Unknown names fall back to the OV mark "V".
 */
(function (root) {
    'use strict';
    if (root.OpenVibeIcons) return;

    const P = (d) => `<path d="${d}"/>`;
    // Glyphs: stroke-only, 24×24 box, designed to sit inside the ring.
    const GLYPHS = {
        ov: P('M6.5 7.5 12 17.5l5.5-10'),
        network: '<circle cx="12" cy="6" r="2"/><circle cx="5.5" cy="17" r="2"/><circle cx="18.5" cy="17" r="2"/>' + P('M12 8v3.5M12 11.5 6.8 15.4M12 11.5l5.2 3.9'),
        live: '<circle cx="12" cy="12" r="2.2"/>' + P('M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.8 5a10 10 0 0 0 0 14M19.2 5a10 10 0 0 1 0 14'),
        tools: P('M14.5 5.5a4 4 0 0 0-5.2 5.2L4.5 15.5a1.8 1.8 0 0 0 2.5 2.5l4.8-4.8a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.1-.5-.5-2.1z'),
        media: '<rect x="4" y="6" width="16" height="12" rx="2"/>' + P('M10 9.5v5l4.5-2.5z'),
        games: P('M7 9h10a4 4 0 0 1 3.9 4.9l-.6 2.6a2 2 0 0 1-3.5.8L15.5 16h-7l-1.3 1.3a2 2 0 0 1-3.5-.8l-.6-2.6A4 4 0 0 1 7 9zM8 11.5v3M6.5 13h3') + '<circle cx="15.5" cy="12" r=".6"/><circle cx="17.5" cy="14" r=".6"/>',
        community: '<circle cx="9" cy="9" r="2.6"/><circle cx="16.5" cy="10" r="2"/>' + P('M3.8 18.5a5.2 5.2 0 0 1 10.4 0M14.6 14.2a4 4 0 0 1 5.6 3.8'),
        chat: P('M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 19 16.5h-7l-4 3v-3H5A1.5 1.5 0 0 1 3.5 15V8A1.5 1.5 0 0 1 5 6.5zM8 10.5h8M8 13h5'),
        codes: P('M9 8 4.5 12 9 16M15 8l4.5 4-4.5 4M13.2 6l-2.4 12'),
        code: P('M9 8 4.5 12 9 16M15 8l4.5 4-4.5 4M13.2 6l-2.4 12'),
        blog: P('M5 19l1.2-4.2L16 5l3 3-9.8 9.8zM14 7l3 3'),
        wiki: P('M5 5.5h6a2 2 0 0 1 2 2V19a2 2 0 0 0-2-2H5zM19 5.5h-4a2 2 0 0 0-2 2V19a2 2 0 0 1 2-2h4z'),
        news: '<rect x="4" y="5.5" width="13" height="13" rx="1.5"/>' + P('M17 9h3v8a1.5 1.5 0 0 1-3 0M7 9h7M7 12h7M7 15h4'),
        reviews: P('M12 4.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.8l5-.7z'),
        tips: P('M12 19s-6.5-3.8-6.5-8.6A3.6 3.6 0 0 1 12 8a3.6 3.6 0 0 1 6.5 2.4C18.5 15.2 12 19 12 19z'),
        vip: P('M4.5 16.5 6 8l3.8 3.5L12 6.5l2.2 5L18 8l1.5 8.5zM5 19h14'),
        trade: P('M4.5 18.5h15M6.5 15l3.5-4 3 2.5 4.5-6M17.5 7.5h-3M17.5 7.5v3'),
        host: '<rect x="4.5" y="5" width="15" height="5.5" rx="1.2"/><rect x="4.5" y="13.5" width="15" height="5.5" rx="1.2"/><circle cx="7.5" cy="7.75" r=".6"/><circle cx="7.5" cy="16.25" r=".6"/>',
        deals: P('M4.5 12.5V5.5h7l8 8-7 7zM8.2 9.2h.01'),
        coupons: P('M4 8.5h16v2.5a1.5 1.5 0 0 0 0 3v2.5H4V14a1.5 1.5 0 0 0 0-3zM10 8.5v8') ,
        stream: P('M5 17.5 12 6l7 11.5M8 13h8') + '<circle cx="12" cy="6" r="1.4"/>',
        youtube: '<rect x="3.5" y="6.5" width="17" height="11" rx="3"/>' + P('M10.5 9.8v4.4l3.8-2.2z'),
        video: '<rect x="3.5" y="6.5" width="17" height="11" rx="3"/>' + P('M10.5 9.8v4.4l3.8-2.2z'),
        download: P('M12 4.5v10M8 11l4 4 4-4M5 19h14'),
        upload: P('M12 15.5v-10M8 9l4-4 4 4M5 19h14'),
        image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/>' + P('M4.5 17l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5'),
        audio: P('M9 17V7.5l9-2V15') + '<circle cx="6.8" cy="17" r="2.2"/><circle cx="15.8" cy="15" r="2.2"/>',
        pdf: P('M7 4.5h7l4 4V19a.5.5 0 0 1-.5.5h-10.5A.5.5 0 0 1 6.5 19V5a.5.5 0 0 1 .5-.5zM14 4.5v4h4M9 13h6M9 16h4'),
        docs: P('M7 4.5h7l4 4V19a.5.5 0 0 1-.5.5h-10.5A.5.5 0 0 1 6.5 19V5a.5.5 0 0 1 .5-.5zM14 4.5v4h4M9 13h6M9 16h4'),
        text: P('M5.5 7V5.5h13V7M12 5.5v13M9.5 18.5h5'),
        logo: P('M12 4.5l1.8 4.2 4.2 1.8-4.2 1.8L12 16.5l-1.8-4.2L6 10.5l4.2-1.8zM18 15.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z'),
        json: P('M9 5.5c-2 0-2 1.5-2 3s0 3.5-2 3.5c2 0 2 2 2 3.5s0 3 2 3M15 5.5c2 0 2 1.5 2 3s0 3.5 2 3.5c-2 0-2 2-2 3.5s0 3-2 3'),
        dns: '<circle cx="12" cy="12" r="7.5"/>' + P('M4.5 12h15M12 4.5c2.5 2 2.5 13 0 15M12 4.5c-2.5 2-2.5 13 0 15'),
        ip: P('M12 20s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z') + '<circle cx="12" cy="10" r="2.2"/>',
        ssl: '<rect x="6" y="11" width="12" height="8.5" rx="1.8"/>' + P('M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11M12 14.5v2'),
        ping: P('M3.5 12h4l2-5 3.5 10 2.5-7 1.5 2h3.5'),
        whois: '<circle cx="11" cy="11" r="5.5"/>' + P('M15.2 15.2 19.5 19.5M9 10a2 2 0 0 1 4 0c0 1.5-2 1.6-2 3M11 15h.01'),
        search: '<circle cx="11" cy="11" r="5.5"/>' + P('M15.2 15.2 19.5 19.5'),
        map: P('M4.5 7l5-2 5 2 5-2v12l-5 2-5-2-5 2zM9.5 5v12M14.5 7v12'),
        food: P('M7 4.5v6a2 2 0 0 0 4 0v-6M9 4.5v15M16.5 4.5c-2 1.5-2.5 4-2.5 6.5h2.5zM16.5 11v8.5'),
        paste: '<rect x="6" y="6" width="12" height="14" rx="1.8"/>' + P('M9.5 6V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1M9 11h6M9 14h6M9 17h3'),
        account: '<circle cx="12" cy="9" r="3.2"/>' + P('M5.5 19a6.5 6.5 0 0 1 13 0'),
        bell: P('M6.5 16.5h11l-1.2-2V11a4.3 4.3 0 0 0-8.6 0v3.5zM10.5 19a1.6 1.6 0 0 0 3 0'),
        history: '<circle cx="12" cy="12" r="7.5"/>' + P('M12 8v4.2l2.8 1.8'),
        theme: P('M12 4.5a7.5 7.5 0 1 0 0 15c1 0 1.6-.8 1.2-1.7-.5-1.1.3-2.3 1.5-2.3h1.6a3.2 3.2 0 0 0 3.2-3.2C19.5 8 16.2 4.5 12 4.5z') + '<circle cx="8.5" cy="11" r=".7"/><circle cx="11.5" cy="8" r=".7"/><circle cx="15" cy="9" r=".7"/>',
        check: P('M6 12.5l4 4 8-9'),
        error: P('M12 7v6M12 16.5h.01'),
        clip: P('M6 6l12 12M6 18L18 6') ,
    };
    // [dx, dy] in glyph units that move each glyph's drawn bounds onto the centre of the ring. Generated.
    const OFFSETS = {"ov":[0,-0.5],"network":[0,0.5],"tools":[1.26,0.24],"games":[0,-1.52],"community":[0,-0.45],"chat":[0,-1],"wiki":[0,-0.25],"reviews":[0,0.6],"tips":[0,-0.76],"vip":[0,-0.75],"trade":[0,-1],"deals":[0,-1],"coupons":[0,-0.5],"stream":[0,0.95],"download":[0,0.25],"audio":[0.7,-0.35],"pdf":[-0.25,0],"docs":[-0.25,0],"logo":[-1.25,-0.5],"ssl":[0,-0.25],"whois":[-0.5,-0.5],"search":[-0.5,-0.5],"food":[0.25,0],"account":[0,-0.4],"bell":[0,-1.37],"error":[-0.01,0.25]};
    const ALIASES = { yt: 'youtube', net: 'dns', dev: 'code', img: 'image', sound: 'audio', document: 'pdf', pastes: 'paste', openre: 'stream', maps: 'map', user: 'account', notifications: 'bell' };
    const registry = Object.create(null);
    for (const [k, g] of Object.entries(GLYPHS)) registry[k] = { glyph: g };

    const CSS = `
.ov-icon{--ovi-size:32px;display:inline-grid;place-items:center;width:var(--ovi-size);height:var(--ovi-size);flex:none;vertical-align:middle;line-height:0;color:var(--ovi-accent,var(--accent,#3b82f6));position:relative}
.ov-icon svg{width:100%;height:100%;overflow:visible;display:block}
.ov-icon .ovi-bg{fill:currentColor;opacity:.1;transition:opacity .25s}
.ov-icon .ovi-ring{fill:none;stroke:currentColor;stroke-width:2.4;opacity:.26}
.ov-icon .ovi-comet{fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-dasharray:26 100;transform-origin:24px 24px;animation:oviSpin 3.6s linear infinite}
.ov-icon .ovi-prog{fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;transform:rotate(-90deg);transform-origin:24px 24px;stroke-dasharray:125.7;stroke-dashoffset:125.7;transition:stroke-dashoffset .35s cubic-bezier(.2,.8,.2,1),opacity .2s;opacity:0}
.ov-icon .ovi-glyph{fill:none;stroke:var(--ovi-glyph,var(--text-primary,#e6edf7));stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;transform-box:view-box;transform-origin:12px 12px;transition:transform .25s cubic-bezier(.2,1.4,.3,1),stroke .2s}
.ov-icon .ovi-glyph circle[r=".6"],.ov-icon .ovi-glyph circle[r=".7"]{fill:currentColor;stroke:none}
.ov-icon[style*="--ovi-size:2"] .ovi-glyph,.ov-icon[data-size^="2"] .ovi-glyph{stroke-width:2.3}
.ov-icon[style*="--ovi-size:2"] .ovi-ring,.ov-icon[data-size^="2"] .ovi-ring{stroke-width:3;opacity:.34}
.ov-icon:hover .ovi-glyph,a:hover>.ov-icon .ovi-glyph,button:hover>.ov-icon .ovi-glyph{transform:scale(1.1)}
.ov-icon:hover .ovi-bg,a:hover>.ov-icon .ovi-bg{opacity:.18}
.ov-icon[data-fx=none] .ovi-comet{display:none}
.ov-icon[data-fx=pulse] .ovi-comet{display:none}
.ov-icon[data-fx=pulse] .ovi-bg{animation:oviPulse 2s ease-in-out infinite;transform-origin:24px 24px}
.ov-icon[data-fx=draw] .ovi-glyph path{stroke-dasharray:80;animation:oviDraw 1.2s cubic-bezier(.2,.8,.2,1) both}
.ov-icon[data-fx=bounce] svg{animation:oviBounce 1.8s cubic-bezier(.3,1.4,.4,1) infinite}
.ov-icon[data-progress] .ovi-prog{opacity:1}
.ov-icon[data-progress] .ovi-comet{opacity:0}
.ov-icon[data-state=busy] .ovi-comet{animation-duration:1.1s;opacity:1;stroke-dasharray:40 86}
.ov-icon[data-state=busy][data-progress] .ovi-comet{opacity:.35}
.ov-icon[data-state=ok]{--ovi-accent:var(--success,#22c55e)}
.ov-icon[data-state=error]{--ovi-accent:var(--danger,#ef4444)}
.ov-icon[data-state=ok] .ovi-comet,.ov-icon[data-state=error] .ovi-comet{display:none}
.ov-icon[data-state=ok] .ovi-ring,.ov-icon[data-state=error] .ovi-ring{opacity:.9}
.ov-icon[data-state=ok] svg{animation:oviPop .5s cubic-bezier(.2,1.6,.3,1)}
.ov-icon[data-state=error] svg{animation:oviShake .4s ease}
@keyframes oviSpin{to{transform:rotate(360deg)}}
@keyframes oviPulse{0%,100%{transform:scale(.9);opacity:.08}50%{transform:scale(1.06);opacity:.22}}
@keyframes oviDraw{from{stroke-dashoffset:80}to{stroke-dashoffset:0}}
@keyframes oviBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6%)}}
@keyframes oviPop{0%{transform:scale(.8)}60%{transform:scale(1.12)}100%{transform:scale(1)}}
@keyframes oviShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6%)}75%{transform:translateX(6%)}}
@media (prefers-reduced-motion:reduce){.ov-icon *, .ov-icon svg{animation:none!important;transition:none!important}.ov-icon .ovi-comet{display:none}}`;

    function resolve(name) {
        const n = String(name || 'ov').toLowerCase();
        return registry[n] ? n : (registry[ALIASES[n]] ? ALIASES[n] : 'ov');
    }

    /** Markup for one icon (usable server-side: no DOM needed). Glyph is scaled 24→22 and centred in the 48 box. */
    function svg(name, size) {
        const key = resolve(name); const def = registry[key];
        const off = def.offset || OFFSETS[key] || [0, 0];   // measured optical centring, see scripts/measure-icons.js
        const s = size ? ` width="${size}" height="${size}"` : '';
        return `<svg viewBox="0 0 48 48"${s} aria-hidden="true" focusable="false"><circle class="ovi-bg" cx="24" cy="24" r="21"/><circle class="ovi-ring" cx="24" cy="24" r="20"/><circle class="ovi-comet" cx="24" cy="24" r="20"/><circle class="ovi-prog" cx="24" cy="24" r="20"/><g transform="translate(${(13 + off[0] * .9167).toFixed(2)} ${(13 + off[1] * .9167).toFixed(2)}) scale(.9167)"><g class="ovi-glyph">${def.glyph}</g></g></svg>`;
    }

    function applyProgress(el) {
        const raw = el.getAttribute('data-progress');
        const prog = el.querySelector('.ovi-prog');
        if (!prog) return;
        if (raw == null || raw === '') { prog.style.strokeDashoffset = ''; return; }
        const p = Math.max(0, Math.min(1, parseFloat(raw) || 0));
        prog.style.strokeDashoffset = String(125.7 * (1 - p));
    }

    function mountOne(el) {
        const name = resolve(el.getAttribute('data-icon'));
        if (el.getAttribute('data-ovi') === name) { applyProgress(el); return; }
        el.setAttribute('data-ovi', name);
        const size = parseInt(el.getAttribute('data-size'), 10);
        if (size) el.style.setProperty('--ovi-size', size + 'px');
        const def = registry[name];
        if (def.accent) el.style.setProperty('--ovi-accent', def.accent);
        if (def.fx && !el.hasAttribute('data-fx')) el.setAttribute('data-fx', def.fx);
        el.innerHTML = svg(name);
        if (!el.hasAttribute('role')) el.setAttribute('aria-hidden', 'true');
        applyProgress(el);
    }

    function mount(rootEl) { (rootEl || document).querySelectorAll('.ov-icon').forEach(mountOne); }

    function set(el, patch) {
        if (!el || !patch) return;
        if (patch.icon) el.setAttribute('data-icon', patch.icon);
        if ('state' in patch) { if (patch.state) el.setAttribute('data-state', patch.state); else el.removeAttribute('data-state'); }
        if ('progress' in patch) { if (patch.progress == null) el.removeAttribute('data-progress'); else el.setAttribute('data-progress', String(patch.progress)); }
        mountOne(el);
    }

    function register(name, def) {
        if (!name || !def || !def.glyph) return;
        registry[String(name).toLowerCase()] = { glyph: def.glyph, fx: def.fx || null, accent: def.accent || null, offset: Array.isArray(def.offset) ? def.offset : null };
        if (typeof document !== 'undefined') document.querySelectorAll(`.ov-icon[data-icon="${name}"]`).forEach((el) => { el.removeAttribute('data-ovi'); mountOne(el); });
    }

    const api = { names: () => Object.keys(registry), register, mount, set, svg, resolve, CSS };
    root.OpenVibeIcons = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return;

    function init() {
        if (!document.getElementById('ov-icons-css')) { const st = document.createElement('style'); st.id = 'ov-icons-css'; st.textContent = CSS; document.head.appendChild(st); }
        mount();
        try {
            new MutationObserver((muts) => {
                for (const m of muts) {
                    if (m.type === 'attributes') { if (m.target.classList && m.target.classList.contains('ov-icon')) mountOne(m.target); continue; }
                    m.addedNodes.forEach((n) => { if (n.nodeType !== 1) return; if (n.classList.contains('ov-icon')) mountOne(n); else if (n.querySelector) n.querySelectorAll('.ov-icon').forEach(mountOne); });
                }
            }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-icon', 'data-progress'] });
        } catch { /* */ }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
