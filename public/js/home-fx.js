/**
 * home-fx.js — home page effects layer.
 *
 * Purely decorative and fully additive: nothing here is required for the page to work.
 *   - hero sparks: a lightweight canvas of drifting embers / orbs behind the hero
 *   - cursor spotlight: a soft radial glow that follows the pointer over the hero
  *   - scroll reveal: section headers, cards and grids slide/fade in as they enter the viewport
 *   - count-up: hero stat numbers tick up from 0 when first painted
 *   - card tilt: stream cards tilt slightly toward the pointer
 * Everything is disabled under prefers-reduced-motion, paused when the tab is hidden, and
 * skips the canvas on coarse-pointer / narrow screens to keep phones cool.
 */
(function () {
    'use strict';
    const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (REDUCED) return;
    // Phones, coarse pointers and low-memory devices run in "lite" mode: no particle canvas, no
    // pointer spotlight, no tilt. They still get the cheap IntersectionObserver work, because the
    // viewport gate below is the only thing that starts the hero button wave — bailing out of the
    // whole module here is why those buttons sat frozen on a phone.
    const LITE = COARSE || window.innerWidth <= 820 || (navigator.deviceMemory && navigator.deviceMemory <= 4);
    if (LITE) document.documentElement.classList.add('rs-lite');

    const onHome = () => { const p = document.getElementById('page-home'); return !!(p && p.classList.contains('active')); };

    // ── Hero sparks canvas ─────────────────────────────────────
    let sparksStop = null;
    function startSparks() {
        if (sparksStop || LITE || window.innerWidth < 720) return;
        const hero = document.querySelector('#page-home .hero');
        if (!hero) return;
        const canvas = document.createElement('canvas');
        canvas.className = 'hfx-sparks';
        canvas.setAttribute('aria-hidden', 'true');
        hero.insertBefore(canvas, hero.firstChild);
        const ctx = canvas.getContext('2d');
        let w = 0, h = 0, raf = 0, running = true, last = 0;
        const parts = [];
        const COLORS = ['139,92,246', '167,139,250', '125,211,252', '251,191,36', '244,114,182'];
        function resize() { const r = hero.getBoundingClientRect(); w = canvas.width = Math.max(1, Math.round(r.width)); h = canvas.height = Math.max(1, Math.round(r.height)); }
        function spawn() { return { x: Math.random() * w, y: h + 10 + Math.random() * 40, r: 1 + Math.random() * 2.4, vy: 12 + Math.random() * 26, vx: (Math.random() - 0.5) * 10, sw: Math.random() * Math.PI * 2, c: COLORS[(Math.random() * COLORS.length) | 0], a: 0.25 + Math.random() * 0.5, life: 0 }; }
        resize();
        const N = Math.min(70, Math.max(30, Math.round(w / 18)));
        for (let i = 0; i < N; i++) { const p = spawn(); p.y = Math.random() * h; parts.push(p); }
        function tick(now) {
            if (!running) return;
            const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
            ctx.clearRect(0, 0, w, h);
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                p.sw += dt * 1.2; p.x += (p.vx + Math.sin(p.sw) * 8) * dt; p.y -= p.vy * dt;
                if (p.y < -10 || p.x < -10 || p.x > w + 10) parts[i] = spawn();
                const fade = Math.min(1, p.y / 80) * Math.min(1, (h - p.y) / 120);
                ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${p.c},${(p.a * Math.max(0, fade)).toFixed(3)})`;
                ctx.shadowBlur = 8; ctx.shadowColor = `rgba(${p.c},0.8)`;
                ctx.fill();
            }
            ctx.shadowBlur = 0;
            raf = requestAnimationFrame(tick);
        }
        const onVis = () => { if (document.hidden) { running = false; cancelAnimationFrame(raf); } else if (!running) { running = true; last = 0; raf = requestAnimationFrame(tick); } };
        window.addEventListener('resize', resize);
        document.addEventListener('visibilitychange', onVis);
        raf = requestAnimationFrame(tick);
        sparksStop = () => { running = false; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', onVis); canvas.remove(); sparksStop = null; };
    }

    // ── Cursor spotlight + magnetic buttons ─────────────────────
    function attachHeroPointer() {
        if (LITE) return;
        const hero = document.querySelector('#page-home .hero');
        if (!hero || hero.dataset.hfx) return;
        hero.dataset.hfx = '1';
        const spot = document.createElement('div'); spot.className = 'hfx-spot'; spot.setAttribute('aria-hidden', 'true'); hero.appendChild(spot);
        let raf = 0;
        hero.addEventListener('pointermove', (e) => {
            if (COARSE) return;
            const r = hero.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                spot.style.setProperty('--x', `${x}px`); spot.style.setProperty('--y', `${y}px`); spot.style.opacity = '1';
            });
        });
        hero.addEventListener('pointerleave', () => { spot.style.opacity = '0'; });
    }

    // ── Scroll reveal ──────────────────────────────────────────
    let io = null, revealSafety = 0, revealPasses = 0, firstRevealPass = true;
    /**
     * Failsafe for the reveal animation.
     *
     * A revealed element starts at opacity 0, so anything the observer never reports on stays
     * invisible — which is a broken page, not a missing animation. The first version of this
     * cleared and rescheduled its timer inside attachReveal(), and attachReveal runs on every
     * container mutation; the home page mutates constantly (the live grid alone refreshes every
     * 12 seconds), so the timer was cancelled forever and never ran once. Hence a "Live Now"
     * heading sitting at opacity 0 with nothing wrong with it.
     *
     * It is now a standalone schedule that cannot be starved, and it sweeps a few times to catch
     * sections that mount late.
     */
    function startRevealSafety() {
        if (revealSafety) return;
        const sweep = () => {
            document.querySelectorAll('.hfx-reveal:not(.is-in)').forEach(el => {
                const r = el.getBoundingClientRect();
                if (r.height && r.top < window.innerHeight && r.bottom > 0) el.classList.add('is-in');
            });
            revealPasses++;
            revealSafety = revealPasses < 5 ? setTimeout(sweep, 2000) : 0;
        };
        revealSafety = setTimeout(sweep, 1200);
    }

    function attachReveal() {
        if (!('IntersectionObserver' in window)) return;
        if (!io) io = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
        const sel = '#page-home .section-header, #page-home .stream-card, #page-home .home-cta-banner, #page-home .home-star-section, #page-home .rs-hero-mount, #page-home .pulse-grid > *, #page-home .moments-row > *, #page-home .home-digest';
        document.querySelectorAll(sel).forEach((el, i) => {
            if (el.classList.contains('hfx-reveal')) return;
            // Anything already on screen after the first pass is NOT new to the reader — it is a
            // card the 60-second section refresh just rebuilt underneath them. Fading it out and
            // back in made the whole home page flash once a minute, collapsing expanded AI
            // overviews and destroying text selection on the way. Show it and move on.
            if (!firstRevealPass) {
                const r = el.getBoundingClientRect();
                if (r.height && r.top < window.innerHeight && r.bottom > 0) { el.classList.add('hfx-reveal', 'is-in'); return; }
            }
            el.classList.add('hfx-reveal');
            el.style.setProperty('--d', `${(i % 6) * 60}ms`);
            io.observe(el);
        });
        firstRevealPass = false;
        startRevealSafety();
    }

    // ── Count-up on the hero stats ─────────────────────────────
    function countUp(el) {
        // Numbers owned by the odometer render as a stack of digit strips; rewriting textContent
        // here would flatten that into the literal string "0123456789" and break every later
        // update. The odometer does its own entrance and its own rolling.
        if (el.classList.contains('ovnum') || el.closest('.ovnum')) return;
        const raw = String(el.textContent || '').trim();
        const m = raw.match(/^([\d,]+)(\.\d+)?([kKmM]?)$/);
        if (!m || el.dataset.hfxCounted) return;
        el.dataset.hfxCounted = '1';
        const target = parseFloat(m[1].replace(/,/g, '') + (m[2] || ''));
        if (!Number.isFinite(target) || target === 0) return;
        const suffix = m[3] || '', decimals = m[2] ? m[2].length - 1 : 0, hasComma = m[1].includes(',');
        const t0 = performance.now(), dur = 900 + Math.min(900, target);
        const ease = (t) => 1 - Math.pow(1 - t, 3);
        const fmt = (n) => { const s = n.toFixed(decimals); return (hasComma ? Number(s).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : s) + suffix; };
        (function frame(now) { const t = Math.min(1, (now - t0) / dur); el.textContent = fmt(ease(t) * target); if (t < 1) requestAnimationFrame(frame); else el.textContent = raw; })(t0);
    }
    function attachCountUp() {
        const stats = document.getElementById('hero-stats');
        if (!stats) return;
        const run = () => stats.querySelectorAll('b, strong, .hero-stat-value, .hero-stat-num').forEach(countUp);
        run();
        new MutationObserver(() => run()).observe(stats, { childList: true, subtree: true });
    }

    // ── Stream card tilt ───────────────────────────────────────
    function attachTilt() {
        if (LITE) return;
        document.addEventListener('pointermove', (e) => {
            const card = e.target.closest && e.target.closest('#page-home .stream-card');
            if (!card) return;
            const r = card.getBoundingClientRect();
            const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
            card.style.transform = `perspective(700px) rotateY(${(px * 6).toFixed(2)}deg) rotateX(${(-py * 6).toFixed(2)}deg) translateY(-3px)`;
            card.classList.add('hfx-tilting');
        });
        document.addEventListener('pointerout', (e) => { const card = e.target.closest && e.target.closest('#page-home .stream-card'); if (card && !card.contains(e.relatedTarget)) { card.style.transform = ''; card.classList.remove('hfx-tilting'); } });
    }

    // ── Headline shimmer ───────────────────────────────────────
    function attachHeadline() {
        if (LITE) return;   // an infinite gradient sweep over text is a real battery cost on a phone
        const h1 = document.querySelector('#page-home .hero h1');
        if (h1) h1.classList.add('hfx-shimmer');
        const rot = document.getElementById('hero-rotate');
        if (rot) rot.classList.add('hfx-glow');
    }

    /**
     * Run expensive idle animations only while they are actually visible.
     *
     * Two problems this solves. First, the hero button wave is on a page-load clock: scroll down
     * on a phone, come back, and you land in the quiet part of the cycle having seen nothing.
     * Restarting it on entry means the wave always plays when someone arrives at it. Second,
     * animating off-screen costs battery and main-thread time for something nobody can see.
     */
    function attachViewportAnimations() {
        if (!('IntersectionObserver' in window)) {
            document.querySelectorAll('[data-fx-viewport]').forEach(el => el.classList.add('fx-live'));
            return;
        }
        const io = new IntersectionObserver((entries) => {
            for (const en of entries) {
                const el = en.target;
                if (en.isIntersecting) {
                    // Re-trigger from the top so the effect is seen, not joined mid-cycle.
                    el.classList.remove('fx-live');
                    void el.offsetWidth;
                    el.classList.add('fx-live');
                } else {
                    el.classList.remove('fx-live');
                }
            }
        }, { rootMargin: '0px 0px 0px 0px', threshold: 0.2 });
        const watch = () => document.querySelectorAll('[data-fx-viewport]:not([data-fx-bound])').forEach(el => {
            el.setAttribute('data-fx-bound', '1');
            io.observe(el);
        });
        watch();
        // Sections mount asynchronously, so pick up anything that arrives later.
        try {
            let pending = 0;
            const queue = () => { if (pending) return; pending = requestAnimationFrame(() => { pending = 0; watch(); }); };
            new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
        } catch { /* */ }
    }

    function boot() {
        attachHeroPointer();
        attachViewportAnimations(); attachHeadline(); attachCountUp(); attachTilt();
        const apply = () => { if (onHome()) { startSparks(); attachReveal(); } else if (sparksStop) sparksStop(); };
        apply();
        const page = document.getElementById('page-home');
        if (page && 'MutationObserver' in window) new MutationObserver(apply).observe(page, { attributes: true, attributeFilter: ['class'] });
        // New cards arrive as sections load — reveal them too.
        const container = page && page.querySelector('.container');
        if (container) {
            // Coalesce to one pass per frame. Unthrottled, this ran an eight-selector
            // querySelectorAll over the whole document on every single DOM mutation — every chat
            // message, every grid tick, every activity row.
            let pending = 0;
            const queue = () => { if (pending) return; pending = requestAnimationFrame(() => { pending = 0; if (onHome()) attachReveal(); }); };
            new MutationObserver(queue).observe(container, { childList: true, subtree: true });
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
