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

    window.OVSkeleton = { cards, block, clear, clearAll, ensure };
})();
