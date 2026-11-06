/**
 * ov-skeleton.js — placeholder shapes while a section is loading.
 *
 * Every feed on this site used to be `display:none` until its fetch came back, so the page
 * arrived as a short column that grew in jumps as each request landed. That reads as slow even
 * when it isn't, and every late section shoves the page around under the reader's thumb.
 *
 * A skeleton fixes both: the space a section is about to occupy is claimed immediately with
 * shimmering blocks in roughly the shape of the real thing, so the layout stops moving and the
 * page looks like it is filling in rather than stalling.
 *
 * Deliberately small and dependency-free:
 *   OVSkeleton.cards('stream-grid-live')   — a responsive row of stream-card placeholders
 *   OVSkeleton.block(el, { rows, height }) — a generic panel placeholder
 *   OVSkeleton.clear(el)                   — remove placeholders from a container
 *
 * Counts follow the container's real width, so a phone gets two placeholders and a wide desktop
 * gets six. There is no point rendering eight shimmering cards into a 400px column.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || window.OVSkeleton) return;

    const CSS = `
.ovsk { position: relative; overflow: hidden; background: var(--bg-card, #171826);
    border: 1px solid var(--border, rgba(255,255,255,.08)); border-radius: 14px; }
.ovsk-bar { background: color-mix(in srgb, var(--text-muted, #8b93ad) 14%, transparent); border-radius: 6px; }
/* One sweep definition, shared by every placeholder, so a screen full of them moves as one. */
.ovsk::after, .ovsk-bar::after { content: ''; position: absolute; inset: 0;
    background: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--text-primary, #f1f4fb) 7%, transparent) 50%, transparent 80%);
    transform: translateX(-100%); animation: ovskSweep 1.5s ease-in-out infinite; }
.ovsk-bar { position: relative; overflow: hidden; }
@keyframes ovskSweep { to { transform: translateX(100%); } }
.ovsk-card { display: flex; flex-direction: column; }
.ovsk-thumb { aspect-ratio: 16 / 9; width: 100%; background: color-mix(in srgb, var(--text-muted, #8b93ad) 10%, transparent); }
.ovsk-meta { display: flex; gap: 10px; align-items: center; padding: 10px 12px 12px; }
.ovsk-av { width: 32px; height: 32px; border-radius: 50%; flex: none; }
.ovsk-lines { flex: 1; min-width: 0; display: grid; gap: 6px; }
.ovsk-panel { padding: 14px; display: grid; gap: 10px; }
.ovsk-fade { animation: ovskFade .25s ease forwards; }
@keyframes ovskFade { to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .ovsk::after, .ovsk-bar::after { animation: none; } }`;

    function ensure() {
        if (document.getElementById('ovsk-css')) return;
        const st = document.createElement('style'); st.id = 'ovsk-css'; st.textContent = CSS;
        document.head.appendChild(st);
    }

    const el = (target) => typeof target === 'string' ? document.getElementById(target) : target;

    /** How many placeholders actually fit — never more than the container can show. */
    function fitCount(container, minWidth, max) {
        const w = container.getBoundingClientRect().width || window.innerWidth;
        const perRow = Math.max(1, Math.floor(w / minWidth));
        // Two rows on a roomy screen, one on a phone, capped so we never paint a wall of grey.
        return Math.min(max, perRow * (w >= 900 ? 2 : 1));
    }

    function cards(target, opts = {}) {
        const c = el(target);
        if (!c || c.querySelector('.ovsk-card')) return;
        ensure();
        const n = opts.count || fitCount(c, opts.minWidth || 300, opts.max || 6);
        const frag = document.createDocumentFragment();
        for (let i = 0; i < n; i++) {
            const d = document.createElement('div');
            d.className = 'ovsk ovsk-card';
            d.setAttribute('aria-hidden', 'true');
            d.innerHTML = '<div class="ovsk-thumb"></div><div class="ovsk-meta"><div class="ovsk-bar ovsk-av"></div>'
                + '<div class="ovsk-lines"><div class="ovsk-bar" style="height:11px;width:72%"></div>'
                + '<div class="ovsk-bar" style="height:9px;width:45%"></div></div></div>';
            frag.appendChild(d);
        }
        c.appendChild(frag);
    }

    /** A generic panel placeholder for sections that are not card grids. */
    function block(target, opts = {}) {
        const c = el(target);
        if (!c || c.querySelector('.ovsk-panel')) return;
        ensure();
        const rows = opts.rows || 3;
        const d = document.createElement('div');
        d.className = 'ovsk ovsk-panel';
        d.setAttribute('aria-hidden', 'true');
        if (opts.height) d.style.minHeight = typeof opts.height === 'number' ? `${opts.height}px` : opts.height;
        let html = '';
        for (let i = 0; i < rows; i++) {
            const w = [92, 68, 80, 55][i % 4];
            html += `<div class="ovsk-bar" style="height:${i === 0 ? 14 : 10}px;width:${i === 0 ? 45 : w}%"></div>`;
        }
        d.innerHTML = html;
        c.appendChild(d);
        if (opts.reveal !== false) c.style.display = '';
    }

    /** Remove placeholders. Fades so a fast response does not flash a grey block. */
    function clear(target) {
        const c = el(target);
        if (!c) return;
        c.querySelectorAll('.ovsk').forEach(n => {
            n.classList.add('ovsk-fade');
            setTimeout(() => { try { n.remove(); } catch { /* */ } }, 240);
        });
    }

    /** Placeholders that are still up after a failed load should just go away. */
    function clearAll() { document.querySelectorAll('.ovsk').forEach(n => { try { n.remove(); } catch { /* */ } }); }

    // ── Route placeholders (plan L52 step 6; the owner, 11-01: "placeholder elements while it loads, a fake thumbnail,
    //    so it is not jarring") ──
    // While a route's code loads, the web runtime keeps the section's space and hides what is in it
    // (section[data-ov-loading] > * { visibility: hidden }). That left an empty 40vh box. Now the box shows the shape of
    // the page on its way, in the network kit's shapes (kit.skeleton: card, row, tile, chat, line, stat), and only when
    // the wait is long enough to see (120 ms): a route already loaded never flashes one.
    const ROUTE_SHAPE = {
        'page-home': 'cards', 'page-content': 'cards', 'page-moments': 'cards', 'page-search': 'rows',
        'page-channel': 'player', 'page-stream': 'player', 'page-agent-stream': 'player', 'page-dashboard': 'dash', 'page-broadcast': 'panel',
        'page-chat': 'chat', 'page-updates': 'rows', 'page-recap': 'lines', 'page-rundown': 'rows',
        'page-documentation': 'lines', 'page-paste-viewer': 'lines', 'page-profile': 'rows',
    };
    const ROUTE_CSS = `
[data-ov-loading] > .ovsk-route { visibility: visible; }
.ovsk-route { position: absolute; inset: 0 0 auto 0; z-index: 1; pointer-events: none; display: grid; gap: 16px;
    padding: 20px max(16px, env(safe-area-inset-left, 0px)); max-width: 1280px; margin: 0 auto; box-sizing: border-box; }
.ovsk-route .ovsk-bar { display: block; }
.ovsk-r-cards { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); }
.ovsk-r-card { display: grid; gap: 8px; }
.ovsk-r-card .ovsk-thumb { border-radius: 12px; position: relative; overflow: hidden; }
.ovsk-r-row { display: flex; gap: 12px; align-items: center; }
.ovsk-r-row .ovsk-av { width: 40px; height: 40px; }
.ovsk-r-lines { flex: 1; min-width: 0; display: grid; gap: 7px; }
.ovsk-r-player { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 1000px) { .ovsk-r-player { grid-template-columns: minmax(0, 1fr) 340px; } }
.ovsk-r-video { aspect-ratio: 16 / 9; border-radius: 14px; }
.ovsk-r-chat { display: grid; gap: 12px; align-content: start; }
.ovsk-r-msg { display: flex; gap: 8px; align-items: center; }
.ovsk-r-msg .ovsk-av { width: 22px; height: 22px; }
.ovsk-r-stats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
.ovsk-r-stat { height: 72px; border-radius: 12px; }
.ovsk-r-field { display: grid; gap: 8px; }
.ovsk-r-input { height: 44px; border-radius: 10px; }
.ovsk-route.ovsk-out { opacity: 0; transition: opacity .18s ease; }`;

    const bar = (h, w, extra = '') => `<span class="ovsk-bar${extra}" style="height:${h}px;width:${w}%"></span>`;
    const WIDTHS = [86, 64, 78, 52, 70, 90, 58];
    function routeShape(kind) {
        const n = (k) => WIDTHS[k % WIDTHS.length];
        if (kind === 'cards') {
            const w = window.innerWidth;
            const count = w < 600 ? 3 : w < 1000 ? 4 : 8;
            let h = '';
            for (let i = 0; i < count; i++) h += `<div class="ovsk-r-card"><span class="ovsk-bar ovsk-thumb"></span>${bar(12, n(i))}${bar(10, n(i + 3) - 20)}</div>`;
            return `${bar(22, 28)}<div class="ovsk-r-cards">${h}</div>`;
        }
        if (kind === 'player') {
            let chat = '';
            for (let i = 0; i < 6; i++) chat += `<div class="ovsk-r-msg"><span class="ovsk-bar ovsk-av"></span>${bar(10, n(i))}</div>`;
            return `<div class="ovsk-r-player"><div style="display:grid;gap:12px"><span class="ovsk-bar ovsk-r-video"></span>${bar(18, 52)}${bar(11, 34)}</div><div class="ovsk-r-chat">${chat}</div></div>`;
        }
        if (kind === 'chat') {
            let chat = '';
            for (let i = 0; i < 10; i++) chat += `<div class="ovsk-r-msg"><span class="ovsk-bar ovsk-av"></span>${bar(10, n(i))}</div>`;
            return `${bar(20, 30)}<div class="ovsk-r-chat">${chat}</div>`;
        }
        if (kind === 'dash') {
            let stats = '';
            for (let i = 0; i < 4; i++) stats += '<span class="ovsk-bar ovsk-r-stat"></span>';
            return `${bar(22, 30)}<div class="ovsk-r-stats">${stats}</div>${routeShape('rows').replace(/^.*?(<div class="ovsk-r-row")/, '$1')}`;
        }
        if (kind === 'panel') {
            let f = '';
            for (let i = 0; i < 5; i++) f += `<div class="ovsk-r-field">${bar(11, 22 + (i % 3) * 8)}<span class="ovsk-bar ovsk-r-input"></span></div>`;
            return `${bar(22, 36)}${f}`;
        }
        if (kind === 'lines') {
            let l = '';
            for (let i = 0; i < 9; i++) l += bar(11, n(i));
            return `${bar(24, 44)}${l}`;
        }
        let rows = '';
        for (let i = 0; i < 7; i++) rows += `<div class="ovsk-r-row"><span class="ovsk-bar ovsk-av"></span><span class="ovsk-r-lines">${bar(12, n(i))}${bar(10, n(i + 2) - 24)}</span></div>`;
        return `${bar(22, 30)}${rows}`;
    }

    function routeOn(section) {
        if (section.querySelector(':scope > .ovsk-route')) return;
        const kind = ROUTE_SHAPE[section.id] || 'lines';
        ensure();
        if (!document.getElementById('ovsk-route-css')) {
            const st = document.createElement('style'); st.id = 'ovsk-route-css'; st.textContent = ROUTE_CSS;
            document.head.appendChild(st);
        }
        const d = document.createElement('div');
        d.className = `ovsk-route ovsk-route-${kind}`;
        d.setAttribute('role', 'status');
        d.setAttribute('aria-busy', 'true');
        d.setAttribute('aria-label', `Loading ${section.dataset.title || 'the page'}`);
        d.innerHTML = routeShape(kind);
        section.prepend(d);
    }
    function routeOff(section) {
        section.querySelectorAll(':scope > .ovsk-route').forEach((d) => {
            d.classList.add('ovsk-out');
            setTimeout(() => { try { d.remove(); } catch { /* gone */ } }, 200);
        });
    }

    const pending = new WeakMap();
    function watchRoutes() {
        if (!window.MutationObserver || watchRoutes.on) return;
        watchRoutes.on = true;
        new MutationObserver((list) => {
            for (const m of list) {
                const s = m.target;
                if (!(s instanceof HTMLElement) || !s.classList.contains('page')) continue;
                if (s.hasAttribute('data-ov-loading')) {
                    if (pending.has(s)) continue;
                    pending.set(s, setTimeout(() => { pending.delete(s); if (s.hasAttribute('data-ov-loading')) routeOn(s); }, 120));
                } else {
                    clearTimeout(pending.get(s));
                    pending.delete(s);
                    routeOff(s);
                }
            }
        }).observe(document.body || document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-ov-loading'] });
    }
    if (document.body) watchRoutes(); else document.addEventListener('DOMContentLoaded', watchRoutes, { once: true });

    window.OVSkeleton = { cards, block, clear, clearAll, ensure, routeShape, ROUTE_SHAPE };
})();
