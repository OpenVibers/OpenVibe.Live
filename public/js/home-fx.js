/**
 * home-fx.js — home page effects layer.
 *
 * Purely decorative and fully additive: nothing here is required for the page to work.
 *   - hero sparks: a lightweight canvas of drifting embers / orbs behind the hero
 *   - cursor spotlight: a soft radial glow that follows the pointer over the hero
 *   - magnetic buttons: the hero CTA buttons lean toward the cursor
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
    if (COARSE || window.innerWidth <= 820 || (navigator.deviceMemory && navigator.deviceMemory <= 4)) { document.documentElement.classList.add('rs-lite'); return; }

    const onHome = () => { const p = document.getElementById('page-home'); return !!(p && p.classList.contains('active')); };

    // ── Hero sparks canvas ─────────────────────────────────────
    let sparksStop = null;
    function startSparks() {
        if (sparksStop || COARSE || window.innerWidth < 720) return;
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
                hero.querySelectorAll('.hero-cta .btn').forEach(btn => {
                    const b = btn.getBoundingClientRect();
                    const dx = e.clientX - (b.left + b.width / 2), dy = e.clientY - (b.top + b.height / 2);
                    const dist = Math.hypot(dx, dy);
                    if (dist < 140) { const k = (1 - dist / 140) * 10; btn.style.transform = `translate(${(dx / dist) * k}px, ${(dy / dist) * k}px)`; }
                    else btn.style.transform = '';
                });
            });
        });
        hero.addEventListener('pointerleave', () => { spot.style.opacity = '0'; hero.querySelectorAll('.hero-cta .btn').forEach(btn => { btn.style.transform = ''; }); });
    }

    // ── Scroll reveal ──────────────────────────────────────────
    let io = null;
    function attachReveal() {
        if (!('IntersectionObserver' in window)) return;
        if (!io) io = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
        const sel = '#page-home .section-header, #page-home .stream-card, #page-home .home-cta-banner, #page-home .home-star-section, #page-home .rs-hero-mount, #page-home .pulse-grid > *, #page-home .moments-row > *, #page-home .home-digest';
        document.querySelectorAll(sel).forEach((el, i) => { if (el.classList.contains('hfx-reveal')) return; el.classList.add('hfx-reveal'); el.style.setProperty('--d', `${(i % 6) * 60}ms`); io.observe(el); });
    }

    // ── Count-up on the hero stats ─────────────────────────────
    function countUp(el) {
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
        if (COARSE) return;
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
        const h1 = document.querySelector('#page-home .hero h1');
        if (h1) h1.classList.add('hfx-shimmer');
        const rot = document.getElementById('hero-rotate');
        if (rot) rot.classList.add('hfx-glow');
    }

    function boot() {
        attachHeroPointer(); attachHeadline(); attachCountUp(); attachTilt();
        const apply = () => { if (onHome()) { startSparks(); attachReveal(); } else if (sparksStop) sparksStop(); };
        apply();
        const page = document.getElementById('page-home');
        if (page && 'MutationObserver' in window) new MutationObserver(apply).observe(page, { attributes: true, attributeFilter: ['class'] });
        // New cards arrive as sections load — reveal them too.
        const container = page && page.querySelector('.container');
        if (container) new MutationObserver(() => { if (onHome()) attachReveal(); }).observe(container, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
