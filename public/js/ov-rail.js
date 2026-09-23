/**
 * ov-rail.js — one treatment for every horizontal card rail (styles: .ov-rail in css/style.css).
 * Replaces the browser's grey scrollbar with: snapping cards (native swipe on touch), a fade on
 * the edge that has more, a thin accent position bar, and prev/next buttons for mouse users that
 * disappear at the ends. The rail is focusable (arrow keys scroll it); the buttons are real buttons.
 *
 *   OVRail.attach(trackElement, { label: 'AI Moments' })
 *
 * Idempotent; the track keeps its id and children, and re-measures when they change.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || window.OVRail) return;

    let seq = 0;
    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    function button(dir, track, label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `ov-rail-btn ov-rail-${dir}`;
        b.setAttribute('aria-label', `${dir === 'prev' ? 'Scroll back' : 'Scroll forward'}${label ? ` in ${label}` : ''}`);
        b.setAttribute('aria-controls', track.id);
        b.disabled = true;
        b.innerHTML = `<i class="fa-solid fa-chevron-${dir === 'prev' ? 'left' : 'right'}" aria-hidden="true"></i>`;
        return b;
    }

    function attach(track, opts = {}) {
        if (!track) return null;
        if (track._ovRail) { track._ovRail.refresh(); return track._ovRail; }

        let rail = track.parentElement;
        if (!rail || !rail.classList.contains('ov-rail')) {
            rail = document.createElement('div');
            rail.className = 'ov-rail';
            track.before(rail);
            rail.appendChild(track);
        }
        if (!track.id) track.id = `ov-rail-${++seq}`;
        track.classList.add('ov-rail-track');
        if (!track.hasAttribute('tabindex')) track.tabIndex = 0;
        if (opts.label) {
            track.setAttribute('role', 'region');
            track.setAttribute('aria-label', opts.label);
        }

        const prev = button('prev', track, opts.label);
        const next = button('next', track, opts.label);
        const bar = document.createElement('div');
        bar.className = 'ov-rail-bar';
        bar.setAttribute('aria-hidden', 'true');
        bar.hidden = true;
        const thumb = document.createElement('span');
        bar.appendChild(thumb);
        track.before(prev);
        track.after(next);
        rail.appendChild(bar);

        const page = (dir) => {
            // Most of a screen at a time; snap settles it on a card edge.
            const step = Math.max(160, track.clientWidth * 0.85);
            track.scrollBy({ left: dir * step, behavior: reducedMotion() ? 'auto' : 'smooth' });
        };
        prev.addEventListener('click', () => page(-1));
        next.addEventListener('click', () => page(1));

        let raf = 0;
        const setDisabled = (b, off) => {
            // A focused button that disables itself would drop keyboard focus onto <body>.
            if (off && document.activeElement === b) track.focus({ preventScroll: true });
            b.disabled = off;
        };
        const update = () => {
            raf = 0;
            const max = track.scrollWidth - track.clientWidth;
            const scrollable = max > 2;
            const x = Math.min(max, Math.max(0, track.scrollLeft));
            // A few pixels of slack: snapping to the first card can leave scrollLeft at 2-4px.
            const atStart = !scrollable || x <= 8;
            const atEnd = !scrollable || x >= max - 8;
            rail.classList.toggle('is-scrollable', scrollable);
            rail.classList.toggle('is-start', atStart);
            rail.classList.toggle('is-end', atEnd);
            setDisabled(prev, atStart);
            setDisabled(next, atEnd);
            bar.hidden = !scrollable;
            if (scrollable) {
                const size = Math.max(10, Math.min(100, (track.clientWidth / track.scrollWidth) * 100));
                thumb.style.width = `${size}%`;
                // translateX(%) is relative to the thumb itself: travel = (100 - size)% of the bar.
                thumb.style.transform = `translateX(${((x / max) * (100 - size) / size) * 100}%)`;
            }
        };
        const refresh = () => { if (!raf) raf = requestAnimationFrame(update); };
        track.addEventListener('scroll', refresh, { passive: true });
        if (window.ResizeObserver) new ResizeObserver(refresh).observe(track);
        if (window.MutationObserver) new MutationObserver(refresh).observe(track, { childList: true });
        refresh();

        track._ovRail = { rail, track, refresh };
        return track._ovRail;
    }

    window.OVRail = { attach };
})();
