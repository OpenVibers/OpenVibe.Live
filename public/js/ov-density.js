/**
 * ov-density.js — per-section "how many cards per row" control.
 *
 * The number of columns a feed should use is not a fixed design decision; it depends on the
 * viewport, the reader's eyesight and what they are doing. So rather than hard-coding counts per
 * breakpoint, this measures the container and offers every column count that still leaves a card
 * wide enough to be worth looking at.
 *
 * The range is computed, not guessed:
 *   max columns = floor(containerWidth / MIN_CARD) capped at HARD_MAX
 *   min columns = 1
 * MIN_CARD is the narrowest a 16:9 card can be and still show a legible title and avatar. On a
 * 412px phone that yields 1-2 columns; at 1400px it yields up to 6. Nobody is offered a choice
 * that would produce unreadable cards, which is why there is no separate mobile special case.
 *
 * The choice is remembered per section. If the viewport later cannot honour it — rotate to
 * portrait, shrink the window — the applied value is clamped to what fits while the stored
 * preference is kept, so rotating back restores it.
 *
 *   OVDensity.attach(grid, { key: 'vods', header: headerEl })
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || window.OVDensity) return;

    const MIN_CARD = 148;   // px — below this a 16:9 card's title is unreadable
    const HARD_MAX = 6;     // more than six across stops being a grid and starts being a filmstrip
    const STORE = 'ov_density_v1';

    const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; } };
    const writeStore = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* */ } };

    const CSS = `
.ovd {
    display: inline-flex; align-items: center; gap: 3px; padding: 3px;
    border-radius: 10px; flex: none; order: 2; margin-left: auto;
    background: color-mix(in srgb, var(--sc-on, var(--accent)) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--sc-on, var(--accent)) 20%, transparent);
}
.ovd-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 2px;
    width: 26px; height: 24px; padding: 0; cursor: pointer; border: 0; border-radius: 7px;
    background: none; color: var(--text-muted); font: inherit; line-height: 1;
    transition: background .16s, color .16s, transform .16s;
}
.ovd-btn:hover { color: var(--text-primary); background: color-mix(in srgb, var(--sc-on, var(--accent)) 16%, transparent); }
.ovd-btn:active { transform: scale(.93); }
.ovd-btn[aria-pressed="true"] {
    color: color-mix(in srgb, var(--sc-on, var(--accent)) 92%, #fff);
    background: color-mix(in srgb, var(--sc-on, var(--accent)) 24%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sc-on, var(--accent)) 42%, transparent);
}
.ovd-btn:focus-visible { outline: 2px solid var(--sc-on, var(--accent)); outline-offset: 2px; }
/* Each button draws its own count as bars, so it reads at a glance without a legend. */
.ovd-bar { display: block; width: 2.5px; border-radius: 1px; background: currentColor; height: 11px; }
.ovd-btn[data-n="1"] .ovd-bar { width: 9px; }
.ovd-btn[data-n="2"] .ovd-bar { width: 5px; }
@media (prefers-reduced-motion: reduce) { .ovd-btn { transition: none; } }
/* The grid honours the chosen count; without a choice it keeps its own auto-fit behaviour. */
[data-ovd-cols] { grid-template-columns: repeat(var(--ovd-cols), minmax(0, 1fr)) !important; }
`;

    function ensureCss() {
        if (document.getElementById('ovd-css')) return;
        const st = document.createElement('style'); st.id = 'ovd-css'; st.textContent = CSS;
        document.head.appendChild(st);
    }

    /**
     * How many columns this container can hold without cards becoming unreadable.
     *
     * Sections can raise the floor: a "Recently online" card carries an avatar, a name and a
     * "streamed 2h ago" line side by side, so it needs more width than a VOD thumbnail before it
     * stops looking cramped. attach() stores that per grid.
     */
    function maxColumns(el) {
        const w = el.getBoundingClientRect().width || el.clientWidth || 0;
        if (!w) return 1;
        const min = Number(el.dataset.ovdMin) || MIN_CARD;
        return Math.max(1, Math.min(HARD_MAX, Math.floor(w / min)));
    }

    function attach(grid, { key, header, minCard } = {}) {
        if (!grid || !key) return;
        if (minCard) grid.dataset.ovdMin = String(minCard);
        if (grid.dataset.ovdBound) { apply(grid, key); return; }
        grid.dataset.ovdBound = '1';
        ensureCss();

        const host = header || grid.previousElementSibling;
        let ctrl = host && host.querySelector(`.ovd[data-key="${key}"]`);
        if (host && !ctrl) {
            ctrl = document.createElement('div');
            ctrl.className = 'ovd';
            ctrl.dataset.key = key;
            ctrl.setAttribute('role', 'group');
            ctrl.setAttribute('aria-label', 'Cards per row');
            host.appendChild(ctrl);
        }

        const render = () => {
            const max = maxColumns(grid);
            const store = readStore();
            const wanted = Number(store[key]) || 0;

            // Drop an override this function applied on a previous pass before measuring. The
            // stylesheet's natural column count has to be read with our own clamp *off*: reading
            // it with the clamp on returns the clamp, the comparison below then goes false, the
            // clamp is removed, the next pass re-applies it — the grid flickers between one and
            // two columns forever. A preference-driven override is not ours to remove.
            if (grid.dataset.ovdAuto === '1') {
                delete grid.dataset.ovdAuto;
                delete grid.dataset.ovdCols;
                grid.style.removeProperty('--ovd-cols');
            }
            const natural = autoColumns(grid, HARD_MAX);

            // Honour the preference where possible, clamp where not, and keep it either way.
            let active = wanted ? Math.min(wanted, max) : 0;
            let auto = false;
            // With no preference the stylesheet decides — but it picked its column count from a
            // media query, not from this container's actual width. Where that lands above what
            // fits legibly, override it down; otherwise leave the CSS alone.
            if (!active && natural > max) { active = max; auto = true; }

            if (active) {
                grid.dataset.ovdCols = String(active);
                if (auto) grid.dataset.ovdAuto = '1';
                grid.style.setProperty('--ovd-cols', String(active));
            } else {
                delete grid.dataset.ovdCols;
                delete grid.dataset.ovdAuto;
                grid.style.removeProperty('--ovd-cols');
            }
            if (!ctrl) return;

            // One button per achievable count. A container that only fits one column offers no
            // choice at all, so the control hides rather than showing a single dead button.
            if (max < 2) { ctrl.hidden = true; return; }
            ctrl.hidden = false;
            const want = [];
            for (let n = 1; n <= max; n++) want.push(n);
            const have = [...ctrl.querySelectorAll('.ovd-btn')].map(b => Number(b.dataset.n));
            if (have.join(',') !== want.join(',')) {
                ctrl.textContent = '';
                for (const n of want) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'ovd-btn';
                    b.dataset.n = String(n);
                    b.title = `${n} per row`;
                    b.setAttribute('aria-label', `${n} per row`);
                    for (let i = 0; i < Math.min(n, 3); i++) {
                        const bar = document.createElement('span'); bar.className = 'ovd-bar'; b.appendChild(bar);
                    }
                    b.addEventListener('click', () => {
                        const s = readStore();
                        // Clicking the active count clears the preference and returns to auto.
                        s[key] = (Number(s[key]) === n) ? 0 : n;
                        writeStore(s);
                        render();
                    });
                    ctrl.appendChild(b);
                }
            }
            const effective = active || Math.min(natural, max);
            for (const b of ctrl.querySelectorAll('.ovd-btn')) {
                b.setAttribute('aria-pressed', String(Number(b.dataset.n) === effective));
            }
        };

        // Follow the container, not the window: a resize, an orientation change and a sidebar
        // opening are all the same event as far as "how many cards fit" is concerned.
        try { new ResizeObserver(() => render()).observe(grid); } catch { window.addEventListener('resize', render, { passive: true }); }
        render();
        grid._ovdRender = render;
    }

    /** What the browser's own auto-fit is currently producing, so the control can show it. */
    function autoColumns(grid, max) {
        const cs = getComputedStyle(grid);
        const n = (cs.gridTemplateColumns || '').split(' ').filter(Boolean).length;
        return Math.max(1, Math.min(max, n || 1));
    }

    /** Re-apply after a re-render replaced the grid's children. */
    function apply(grid, key) { if (grid && typeof grid._ovdRender === 'function') grid._ovdRender(); }

    window.OVDensity = { attach, apply, MIN_CARD, HARD_MAX };
})();
