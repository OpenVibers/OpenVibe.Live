/**
 * ov-guide.js — OpenVibe's shared guidance engine. One shell, many journeys.
 *
 *   OVGuide.register(id, journey)     journey = { title, kicker, icon, steps: [step…], onFinish }
 *   OVGuide.open(id, { step, ctx })   open a journey (optionally at a step), OVGuide.close(finished)
 *   OVGuide.next() / back() / goTo(stepId)
 *   OVGuide.spotlight({ target, title, text, actions, step, total })   point at a real element on the page
 *   OVGuide.progress(id)              { seen, finished, at } remembered per browser
 *   OVGuide.configure({ api, toast, me, navigate })                   host bindings (Live sets these)
 *
 * A step: { id, title, icon, kicker?, optional?, hidden?(ctx),
 *           render(ctx) → html | Promise<html>       the panel body (ctx.ui helpers available)
 *           mount?(el, ctx)                          wire events after render
 *           validate?(ctx) → true | string           gate "Next" (string = error toast)
 *           next?: stepId | (ctx)=>stepId            where Next goes (default: following step)
 *           footer?(ctx) → html | null               custom footer; null = default Back/Next
 *           nextLabel?, backLabel?, skipLabel?       button copy }
 *
 * The shell: a centered card on desktop, a bottom sheet on phones; progress dots you can click to go
 * back to any step you have visited; animated step transitions; Escape/scrim to close. Journeys
 * can chain (a step's action can OVGuide.open another journey). Everything is host-agnostic: the
 * engine only needs api()/toast()/me()/navigate() which the host page provides.
 */
(function () {
    'use strict';
    if (window.OVGuide) return;
    const J = new Map();
    const cfg = {
        api: (p, o) => (typeof api === 'function' ? api(p, o) : Promise.reject(new Error('no api'))),
        toast: (m, t) => { try { toast(m, t || 'info'); } catch { /* */ } },
        me: () => { try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch { return null; } },
        navigate: (p) => { if (typeof navigate === 'function') navigate(p); else location.href = p; },
        esc: (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))),
        loginHref: '/api/auth/sso/login',
    };
    const S = { open: false, journey: null, step: null, visited: [], ctx: null, dir: 1, spot: null };
    const $ = (sel, root) => (root || document).querySelector(sel);
    const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem('ovg:' + k) || 'null'); localStorage.setItem('ovg:' + k, JSON.stringify(v)); } catch { return null; } };

    // ── Shell ──────────────────────────────────────────────────
    function shell() {
        let root = $('#ovg');
        if (root) return root;
        root = document.createElement('div'); root.id = 'ovg'; root.className = 'ovg';
        root.innerHTML = `<div class="ovg-scrim"></div>
            <div class="ovg-card" role="dialog" aria-modal="true">
                <button type="button" class="ovg-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                <div class="ovg-head"><span class="ov-mark" data-size="30"></span><div><div class="ovg-kicker" id="ovg-kicker"></div><div class="ovg-title" id="ovg-title"></div></div></div>
                <ol class="ovg-steps" id="ovg-steps"></ol>
                <div class="ovg-body"><div class="ovg-panel" id="ovg-panel"></div></div>
                <div class="ovg-foot" id="ovg-foot"></div>
            </div>`;
        document.body.appendChild(root);
        $('.ovg-scrim', root).addEventListener('click', () => close(false));
        $('.ovg-close', root).addEventListener('click', () => close(false));
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) close(false); });
        try { if (typeof ovMarkMount === 'function') ovMarkMount(root); } catch { /* */ }
        return root;
    }
    const visibleSteps = () => (S.journey.steps || []).filter(st => !(typeof st.hidden === 'function' && st.hidden(S.ctx)));
    function renderSteps() {
        const steps = visibleSteps(); const idx = Math.max(0, steps.findIndex(st => st.id === S.step.id));
        const ol = $('#ovg-steps');
        if (steps.length < 2 || S.journey.noStepBar) { ol.innerHTML = ''; ol.style.display = 'none'; return; }
        ol.style.display = '';
        ol.style.setProperty('--n', steps.length);
        ol.innerHTML = steps.map((st, i) => {
            const state = i < idx ? 'done' : i === idx ? 'now' : '';
            const canJump = i < idx || S.visited.includes(st.id);
            return `<li class="${state} ${canJump ? 'can' : ''}" data-step="${cfg.esc(st.id)}" title="${canJump ? 'Go back to this step' : ''}"><span class="ovg-step-dot"><i class="fa-solid ${i < idx ? 'fa-check' : (st.icon || 'fa-circle')}"></i></span><span class="ovg-step-label">${cfg.esc(st.title)}</span></li>`;
        }).join('');
        ol.style.setProperty('--p', `${steps.length > 1 ? (idx / (steps.length - 1)) * 100 : 0}%`);
        ol.querySelectorAll('li.can').forEach(li => li.addEventListener('click', () => goTo(li.dataset.step, -1)));
    }
    function defaultFooter(step) {
        const steps = visibleSteps(); const idx = steps.findIndex(st => st.id === step.id);
        const first = idx <= 0, last = idx === steps.length - 1;
        return `${!first ? `<button type="button" class="btn btn-outline" data-act="back"><i class="fa-solid fa-arrow-left"></i> ${cfg.esc(step.backLabel || 'Back')}</button>` : '<span></span>'}
            <span class="ovg-foot-note">${steps.length > 1 ? `Step ${idx + 1} of ${steps.length}` : ''}</span>
            <span class="ovg-foot-right">${step.optional && !last ? `<button type="button" class="btn btn-outline" data-act="skip">${cfg.esc(step.skipLabel || 'Skip')}</button>` : ''}
            <button type="button" class="btn btn-primary btn-lg" data-act="next">${cfg.esc(step.nextLabel || (last ? 'Finish' : 'Next'))} <i class="fa-solid ${last ? 'fa-check' : 'fa-arrow-right'}"></i></button></span>`;
    }
    async function show(step, dir) {
        S.step = step; S.dir = dir || 1;
        if (!S.visited.includes(step.id)) S.visited.push(step.id);
        const panel = $('#ovg-panel');
        panel.classList.remove('in-l', 'in-r'); void panel.offsetWidth;
        $('#ovg-kicker').textContent = step.kicker || S.journey.kicker || '';
        $('#ovg-title').textContent = typeof step.title === 'function' ? step.title(S.ctx) : (step.heading || step.title);
        renderSteps();
        panel.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
        let html = '';
        try { html = await step.render(S.ctx); } catch (e) { html = `<div class="ovg-error"><i class="fa-solid fa-triangle-exclamation"></i> ${cfg.esc((e && e.message) || 'Something went wrong')}</div>`; }
        if (S.step !== step) return;                          // user moved on while we loaded
        panel.innerHTML = html;
        const f = typeof step.footer === 'function' ? step.footer(S.ctx) : undefined;
        $('#ovg-foot').innerHTML = f == null ? defaultFooter(step) : f;
        $('#ovg-foot').querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => ({ back, next, skip })[b.dataset.act]()));
        try { if (typeof step.mount === 'function') step.mount(panel, S.ctx); } catch (e) { console.warn('[OVGuide] mount:', e.message); }
        try { if (typeof ovMarkMount === 'function') ovMarkMount(panel); } catch { /* */ }
        panel.classList.add(S.dir > 0 ? 'in-r' : 'in-l');
        $('.ovg-body').scrollTop = 0;
        store(S.journey.id, { ...(store(S.journey.id) || {}), seen: true, at: step.id, when: Date.now() });
    }
    function goTo(stepId, dir) { const st = (S.journey.steps || []).find(x => x.id === stepId); if (st) show(st, dir); }
    async function next() {
        const step = S.step; if (!step) return;
        if (typeof step.validate === 'function') { const v = await step.validate(S.ctx); if (v !== true && v !== undefined) { if (typeof v === 'string') cfg.toast(v, 'error'); return; } }
        const steps = visibleSteps(); const idx = steps.findIndex(st => st.id === step.id);
        let target = typeof step.next === 'function' ? step.next(S.ctx) : step.next;
        if (target === 'close') return close(true);
        if (!target) target = steps[idx + 1] ? steps[idx + 1].id : null;
        if (!target) return close(true);
        goTo(target, 1);
    }
    function skip() { const steps = visibleSteps(); const idx = steps.findIndex(st => st.id === S.step.id); if (steps[idx + 1]) goTo(steps[idx + 1].id, 1); else close(true); }
    function back() { const steps = visibleSteps(); const idx = steps.findIndex(st => st.id === S.step.id); if (idx > 0) goTo(steps[idx - 1].id, -1); }

    async function open(id, opts = {}) {
        const journey = J.get(id);
        if (!journey) { console.warn('[OVGuide] unknown journey', id); return; }
        if (journey.requiresUser !== false && !cfg.me()) {
            for (let i = 0; i < 24 && !cfg.me(); i++) await new Promise(r => setTimeout(r, 250));
            if (!cfg.me()) { store('pending', { id, opts, when: Date.now() }); location.href = cfg.loginHref; return; }
        }
        closeSpot();
        const root = shell();
        S.open = true; S.journey = journey; S.visited = []; S.ctx = { ...(opts.ctx || {}), journey: id, ui, guide: window.OVGuide };
        root.classList.add('is-open'); document.body.classList.add('ovg-lock');
        $('.ovg-card', root).setAttribute('aria-label', journey.title || 'Guide');
        try { if (typeof journey.onOpen === 'function') await journey.onOpen(S.ctx, opts); } catch (e) { console.warn('[OVGuide] onOpen:', e.message); }
        const steps = visibleSteps();
        const start = (opts.step && steps.find(st => st.id === opts.step)) || steps[0];
        if (!start) return close(false);
        // Steps before the requested one count as visited so the dots let you go back to them.
        S.visited = steps.slice(0, steps.indexOf(start)).map(st => st.id);
        show(start, 1);
    }
    function close(finished) {
        const root = $('#ovg'); if (!root || !S.open) return;
        S.open = false; root.classList.remove('is-open'); document.body.classList.remove('ovg-lock');
        const j = S.journey;
        if (j) { store(j.id, { ...(store(j.id) || {}), seen: true, finished: !!finished || !!(store(j.id) || {}).finished, dismissed: !finished, when: Date.now() }); try { if (typeof j.onClose === 'function') j.onClose(S.ctx, !!finished); } catch { /* */ } }
        const closedId = j ? j.id : null;
        S.journey = null; S.step = null;
        // Anything that watches setup state (the home page banner, the setup hub's own counter)
        // needs to know a journey just ended — a task may have been completed inside it.
        try { document.dispatchEvent(new CustomEvent('ovguide:closed', { detail: { journey: closedId, finished: !!finished } })); } catch { /* */ }
    }

    // ── Spotlight: point at something real on the page ─────────
    let raf = 0;
    function spotlight({ target, title, text, actions = [], step, total, placement }) {
        closeSpot();
        const el = typeof target === 'string' ? $(target) : target;
        const root = document.createElement('div'); root.className = 'ovg-spot';
        root.innerHTML = `<div class="ovg-spot-hole"></div><div class="ovg-spot-card" role="dialog"><div class="ovg-spot-step">${step && total ? `Step ${step} of ${total}` : ''}</div><h4>${cfg.esc(title || '')}</h4><p>${text || ''}</p><div class="ovg-spot-actions"></div></div>`;
        document.body.appendChild(root);
        const acts = $('.ovg-spot-actions', root);
        (actions.length ? actions : [{ label: 'Got it', primary: true }]).forEach(a => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn btn-sm ${a.primary ? 'btn-primary' : 'btn-outline'}`; b.innerHTML = a.label; b.onclick = () => { const r = a.onClick ? a.onClick() : null; if (r !== false) closeSpot(); }; acts.appendChild(b); });
        S.spot = { root, el };
        const place = () => {
            if (!S.spot) return;
            const hole = $('.ovg-spot-hole', root), card = $('.ovg-spot-card', root);
            if (!el || !el.isConnected) { hole.style.opacity = '0'; card.style.top = '50%'; card.style.left = '50%'; card.style.transform = 'translate(-50%,-50%)'; }
            else {
                const r = el.getBoundingClientRect();
                hole.style.opacity = '1'; hole.style.left = `${r.left - 8}px`; hole.style.top = `${r.top - 8}px`; hole.style.width = `${r.width + 16}px`; hole.style.height = `${r.height + 16}px`;
                const cw = Math.min(380, window.innerWidth - 24), ch = card.offsetHeight || 160;
                let top = r.bottom + 16, left = Math.max(12, Math.min(r.left, window.innerWidth - cw - 12));
                if (placement === 'top' || top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 16);
                card.style.transform = 'none'; card.style.top = `${top}px`; card.style.left = `${left}px`; card.style.width = `${cw}px`;
            }
            raf = requestAnimationFrame(place);
        };
        if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* */ } }
        raf = requestAnimationFrame(place);
        requestAnimationFrame(() => root.classList.add('is-on'));
        return { close: closeSpot };
    }
    function closeSpot() { if (!S.spot) return; cancelAnimationFrame(raf); try { S.spot.root.remove(); } catch { /* */ } S.spot = null; }

    // ── Small UI helpers journeys can use inside render() ──────
    const ui = {
        esc: (s) => cfg.esc(s),
        lead: (html) => `<p class="ovg-lead">${html}</p>`,
        grid: (items, cols) => `<div class="ovg-grid ${cols === 3 ? 'ovg-grid--3' : ''}">${items.join('')}</div>`,
        pick: ({ id, icon, title, sub, tag, on, color, attrs }) => `<button type="button" class="ovg-pick ${on ? 'on' : ''}" data-pick="${cfg.esc(id)}" ${color ? `style="--c:${cfg.esc(color)}"` : ''} ${attrs || ''}><span class="ovg-pick-ico"><i class="${cfg.esc(icon)}"></i></span><span class="ovg-pick-body"><b>${title}${tag ? ` <em class="ovg-tag">${cfg.esc(tag)}</em>` : ''}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`,
        box: (head, body, icon) => `<div class="ovg-box"><div class="ovg-box-head"><i class="fa-solid ${icon || 'fa-circle-info'}"></i> ${head}</div>${body}</div>`,
        kv: (label, value, copy) => `<div class="ovg-kv"><span>${cfg.esc(label)}</span><code>${cfg.esc(value)}</code>${copy ? `<button type="button" class="ovg-copy" data-copy="${cfg.esc(value)}"><i class="fa-regular fa-copy"></i> Copy</button>` : ''}</div>`,
        secret: (label, value) => `<div class="ovg-kv"><span>${cfg.esc(label)}</span><code class="ovg-secret" data-secret="${cfg.esc(value)}">••••••••••••••••</code><button type="button" class="ovg-copy" data-copy="${cfg.esc(value)}"><i class="fa-regular fa-copy"></i> Copy</button><button type="button" class="ovg-copy" data-reveal="1"><i class="fa-regular fa-eye"></i> Show</button></div>`,
        steps: (items) => `<ol class="ovg-obs">${items.map(i => `<li>${i}</li>`).join('')}</ol>`,
        chips: (items, name) => `<div class="ovg-chips" data-chips="${cfg.esc(name || '')}">${items.map(([v, l, i]) => `<button type="button" class="ovg-chip" data-chip="${cfg.esc(v)}">${i ? `<i class="fa-solid ${i}"></i> ` : ''}${cfg.esc(l)}</button>`).join('')}</div>`,
        field: (label, inputHtml) => `<label class="ovg-field">${label}${inputHtml}</label>`,
        wire(root) {
            root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.innerHTML = '<i class="fa-solid fa-check"></i> Copied'; setTimeout(() => { b.innerHTML = '<i class="fa-regular fa-copy"></i> Copy'; }, 1500); } catch { cfg.toast('Copy failed — long-press to copy', 'error'); } }));
            root.querySelectorAll('[data-reveal]').forEach(b => b.addEventListener('click', () => { const c = b.parentElement.querySelector('.ovg-secret'); if (!c) return; const on = c.dataset.on === '1'; c.textContent = on ? '••••••••••••••••' : c.dataset.secret; c.dataset.on = on ? '' : '1'; b.innerHTML = on ? '<i class="fa-regular fa-eye"></i> Show' : '<i class="fa-regular fa-eye-slash"></i> Hide'; }));
            root.querySelectorAll('[data-chips]').forEach(g => g.addEventListener('click', (e) => { const c = e.target.closest('[data-chip]'); if (!c) return; g.querySelectorAll('.ovg-chip').forEach(x => x.classList.remove('on')); c.classList.add('on'); }));
        },
        picked: (root, name) => { const c = root.querySelector(`[data-chips="${name}"] .ovg-chip.on`); return c ? c.dataset.chip : null; },
        confetti() {
            try { const c = document.createElement('div'); c.className = 'ovg-confetti'; const colors = ['#ff5a5f', '#ffd166', '#06d6a0', '#4d96ff', '#c77dff', '#fff']; for (let i = 0; i < 140; i++) { const p = document.createElement('span'); p.style.left = (Math.random() * 100) + 'vw'; p.style.background = colors[i % colors.length]; p.style.animationDelay = (Math.random() * 0.6) + 's'; p.style.animationDuration = (1.6 + Math.random() * 1.6) + 's'; c.appendChild(p); } document.body.appendChild(c); setTimeout(() => c.remove(), 4000); } catch { /* */ }
        },
        upload: async (path, fields, file, fileField) => {
            const fd = new FormData(); Object.entries(fields || {}).forEach(([k, v]) => { if (v != null) fd.append(k, v); }); if (file) fd.append(fileField || 'file', file);
            let tok = null; try { tok = localStorage.getItem('token'); } catch { /* */ }
            const res = await fetch(`/api${path}`, { method: 'POST', body: fd, credentials: 'same-origin', headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
            let data = {}; try { data = await res.json(); } catch { /* */ }
            if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
            return data;
        },
    };

    // Resume a journey that was interrupted by sign-in.
    function resumePending() {
        const p = store('pending'); if (!p || !p.id) return;
        if (Date.now() - (p.when || 0) > 30 * 60000) { try { localStorage.removeItem('ovg:pending'); } catch { /* */ } return; }
        (async () => { for (let i = 0; i < 40 && !cfg.me(); i++) await new Promise(r => setTimeout(r, 250)); if (!cfg.me()) return; try { localStorage.removeItem('ovg:pending'); } catch { /* */ } open(p.id, p.opts || {}); })();
    }
    // ?guide=<journey>[:step] opens a journey on any page.
    function fromUrl() {
        let q = null; try { q = new URLSearchParams(location.search).get('guide'); } catch { /* */ }
        if (!q) return false;
        const [id, step] = q.split(':');
        try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* */ }
        setTimeout(() => open(id, { step }), 400);
        return true;
    }
    const _push = history.pushState;
    history.pushState = function () { const r = _push.apply(this, arguments); setTimeout(() => { if (!S.open) fromUrl(); }, 60); return r; };
    function boot() { if (!fromUrl()) resumePending(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 300)); else setTimeout(boot, 300);

    window.OVGuide = {
        register: (id, journey) => { J.set(id, { ...journey, id }); },
        has: (id) => J.has(id), list: () => [...J.keys()],
        open, close, next, back, skip, goTo, spotlight, closeSpotlight: closeSpot,
        progress: (id) => store(id) || {}, forget: (id) => { try { localStorage.removeItem('ovg:' + id); } catch { /* */ } },
        configure: (o) => Object.assign(cfg, o || {}),
        ui, state: S, cfg,
    };
})();
