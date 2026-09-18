/**
 * openvibe-shared/island.js — the activity island.
 *
 * A page tells the navbar what it is doing. The brand mark becomes the indicator (progress ring,
 * state colour) and a pill grows out of the brand; hover, focus or tap expands it into a rich card
 * (image, title, subtitle, progress bar, detail line, actions).
 *
 *   OpenVibeIsland.start({ id, title, subtitle, icon, image, progress, state, detail, actions })
 *   OpenVibeIsland.update(id, patch)     progress: 0–1 | null (indeterminate)
 *   OpenVibeIsland.finish(id, { state: 'ok', title, actions, ttl })
 *   OpenVibeIsland.fail(id, { title, detail })
 *   OpenVibeIsland.remove(id) · .list()
 *
 * Works without the navbar (fixed pill, top centre). All text goes through textContent; links are
 * http(s) or same-origin paths only. Motion respects prefers-reduced-motion.
 */
(function (root) {
    'use strict';
    if (root.OpenVibeIsland) return;
    if (typeof document === 'undefined') { const n = () => {}; const stub = { start: () => ({ update: n, finish: n, fail: n, remove: n }), update: n, finish: n, fail: n, remove: n, list: () => [] }; if (typeof module !== 'undefined') module.exports = stub; return; }

    const CSS = `
.ov-island{position:relative;display:inline-flex;align-items:center;margin-left:10px;z-index:60;font:500 12.5px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--text-primary,#e6edf7)}
.ov-island.is-floating{position:fixed;top:10px;left:50%;transform:translateX(-50%);margin:0;z-index:2147482000}
.ov-island[hidden]{display:none}
.ovi-pill{appearance:none;border:1px solid color-mix(in srgb,var(--ovis-c) 45%,transparent);background:color-mix(in srgb,var(--ovis-c) 12%,var(--bg-elevated,var(--bg-secondary,#0d131d)));color:inherit;font:inherit;display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px 0 5px;border-radius:999px;cursor:pointer;max-width:min(300px,46vw);animation:ovisGrow .4s cubic-bezier(.2,1.3,.3,1);box-shadow:0 4px 18px rgba(0,0,0,.28)}
.ov-island{--ovis-c:var(--accent,#3b82f6)}
.ov-island[data-state=ok]{--ovis-c:var(--success,#22c55e)}
.ov-island[data-state=error]{--ovis-c:var(--danger,#ef4444)}
.ovi-pill .ov-icon{--ovi-size:22px;--ovi-accent:var(--ovis-c)}
.ovi-pill-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}
.ovi-pill-pct{font-variant-numeric:tabular-nums;color:var(--text-secondary,#a8b3c4)}
.ovi-count{background:var(--ovis-c);color:var(--on-accent,#fff);border-radius:999px;font-size:10.5px;font-weight:800;padding:1px 6px}
.ovi-card{position:absolute;top:calc(100% + 8px);left:0;width:min(340px,calc(100vw - 24px));background:var(--bg-elevated,var(--bg-secondary,#111826));border:1px solid var(--border,rgba(255,255,255,.12));border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.5);padding:8px;opacity:0;transform:translateY(-6px) scale(.97);transform-origin:top left;pointer-events:none;transition:opacity .18s,transform .22s cubic-bezier(.2,1.2,.3,1)}
.ov-island.is-floating .ovi-card{left:50%;translate:-50% 0;transform-origin:top center}
.ov-island.is-open .ovi-card{opacity:1;transform:none;pointer-events:auto}
.ovi-item{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:8px;border-radius:12px;--ovis-c:var(--accent,#3b82f6)}
.ovi-item[data-state=ok]{--ovis-c:var(--success,#22c55e)}
.ovi-item[data-state=error]{--ovis-c:var(--danger,#ef4444)}
.ovi-item+.ovi-item{border-top:1px solid var(--border,rgba(255,255,255,.08));border-radius:0}
.ovi-thumb{width:64px;height:44px;border-radius:8px;object-fit:cover;background:#0006}
.ovi-item .ov-icon{--ovi-size:40px;--ovi-accent:var(--ovis-c)}
.ovi-t{font-weight:700;font-size:13.5px}
.ovi-s{color:var(--text-secondary,#a8b3c4);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ovi-body{min-width:0}
.ovi-bar{height:4px;border-radius:4px;background:color-mix(in srgb,var(--ovis-c) 18%,transparent);margin-top:8px;overflow:hidden}
.ovi-bar i{display:block;height:100%;width:0;background:var(--ovis-c);border-radius:4px;transition:width .35s cubic-bezier(.2,.8,.2,1)}
.ovi-bar.is-ind i{width:35%;animation:ovisInd 1.2s ease-in-out infinite}
.ovi-d{color:var(--text-muted,#7d8aa0);font-size:11.5px;margin-top:6px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ovi-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.ovi-act{appearance:none;border:0;cursor:pointer;text-decoration:none;font:700 12px/1 system-ui,sans-serif;padding:7px 11px;border-radius:8px;color:var(--ovis-c);background:color-mix(in srgb,var(--ovis-c) 14%,transparent)}
.ovi-act:first-child{background:var(--ovis-c);color:var(--on-accent,#fff)}
.ovi-act:focus-visible,.ovi-pill:focus-visible{outline:2px solid var(--ovis-c);outline-offset:2px}
@keyframes ovisGrow{from{max-width:30px;opacity:0}to{opacity:1}}
@keyframes ovisInd{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}
@media (max-width:640px){.ov-island{margin-left:6px}.ovi-pill{max-width:40vw;padding-right:9px}.ovi-pill-pct{display:none}.ovi-card{position:fixed;top:56px;left:12px;right:12px;width:auto}}
@media (prefers-reduced-motion:reduce){.ovi-pill,.ovi-bar.is-ind i{animation:none}.ovi-card,.ovi-bar i{transition:none}}`;

    const items = new Map();   // id → activity (insertion order = age)
    const timers = new Map();
    let host = null, pill = null, card = null, seq = 0;

    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
    const safeUrl = (u) => { try { const x = new URL(u, location.href); return /^(https?|blob):$/.test(x.protocol) ? x.href : null; } catch { return null; } };
    const clamp = (p) => (typeof p === 'number' && isFinite(p) ? Math.max(0, Math.min(1, p)) : null);

    function ensure() {
        if (host && host.isConnected) return;
        if (!document.getElementById('ov-island-css')) { const s = el('style'); s.id = 'ov-island-css'; s.textContent = CSS; document.head.appendChild(s); }
        if (!root.OpenVibeIcons && !document.getElementById('ov-icons-loader')) { const sc = el('script'); sc.id = 'ov-icons-loader'; sc.src = 'https://openvibe.network/shared/ov-icons.js'; sc.async = true; document.head.appendChild(sc); }
        host = el('div', 'ov-island'); host.hidden = true;
        pill = el('button', 'ovi-pill'); pill.type = 'button'; pill.setAttribute('aria-haspopup', 'true'); pill.setAttribute('aria-expanded', 'false');
        card = el('div', 'ovi-card'); card.setAttribute('role', 'region'); card.setAttribute('aria-label', 'Activity');
        host.append(pill, card);
        // Dock after the brand (and its launcher button); sites with their own navbar mark the spot with [data-ov-island].
        const brand = document.querySelector('[data-ov-island], .openvibe-navbar #openvibe-launcher-btn, .openvibe-navbar .openvibe-navbar-brand, .navbar .nav-brand');
        if (brand && brand.parentNode) brand.parentNode.insertBefore(host, brand.nextSibling);
        else { host.classList.add('is-floating'); document.body.appendChild(host); }
        const open = (v) => { host.classList.toggle('is-open', v); pill.setAttribute('aria-expanded', String(v)); };
        pill.addEventListener('click', () => open(!host.classList.contains('is-open')));
        if (matchMedia('(hover:hover)').matches) { host.addEventListener('mouseenter', () => open(true)); host.addEventListener('mouseleave', () => open(false)); }
        document.addEventListener('click', (e) => { if (!host.contains(e.target)) open(false); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
    }

    function top() { let t = null; for (const a of items.values()) t = a; return t; }

    function brandMark(a) {
        // The navbar's own mark mirrors the top activity: progress ring + state colour.
        document.querySelectorAll('.openvibe-navbar-brand .ov-mark, .navbar .nav-brand .ov-mark').forEach((m) => {
            if (m.closest('.openvibe-network-badge')) return;
            if (!a) { m.removeAttribute('data-state'); m.removeAttribute('data-progress'); m.style.removeProperty('--ovm-p'); return; }
            m.setAttribute('data-state', a.state === 'info' ? 'idle' : a.state);
            if (a.progress == null || a.state !== 'busy') m.removeAttribute('data-progress'); else { m.setAttribute('data-progress', String(a.progress)); m.style.setProperty('--ovm-p', String(a.progress)); }
        });
        try { root.dispatchEvent(new CustomEvent('ov:activity', { detail: a ? { id: a.id, state: a.state, progress: a.progress, title: a.title } : null })); } catch { /* */ }
    }

    function iconEl(a, size) { const i = el('span', 'ov-icon'); i.dataset.icon = a.icon || 'ov'; i.dataset.size = String(size); i.dataset.state = a.state === 'info' ? 'idle' : a.state; if (a.progress != null && a.state === 'busy') i.dataset.progress = String(a.progress); i.dataset.fx = a.state === 'busy' ? 'orbit' : 'none'; return i; }

    function render() {
        ensure();
        const a = top();
        brandMark(a);
        if (!a) { host.hidden = true; host.classList.remove('is-open'); return; }
        host.hidden = false; host.dataset.state = a.state;
        pill.replaceChildren(iconEl(a, 22), el('span', 'ovi-pill-text', a.title || 'Working'));
        if (a.state === 'busy' && a.progress != null) pill.appendChild(el('span', 'ovi-pill-pct', Math.round(a.progress * 100) + '%'));
        if (items.size > 1) pill.appendChild(el('span', 'ovi-count', items.size));
        pill.setAttribute('aria-label', `${a.title || 'Activity'}${a.progress != null ? ', ' + Math.round(a.progress * 100) + ' percent' : ''}`);

        card.replaceChildren(...[...items.values()].reverse().map((it) => {
            const row = el('div', 'ovi-item'); row.dataset.state = it.state;
            const img = it.image && safeUrl(it.image);
            if (img) { const im = el('img', 'ovi-thumb'); im.src = img; im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; row.appendChild(im); } else row.appendChild(iconEl(it, 40));
            const body = el('div', 'ovi-body'); body.appendChild(el('div', 'ovi-t', it.title || ''));
            if (it.subtitle) body.appendChild(el('div', 'ovi-s', it.subtitle));
            if (it.state === 'busy') { const bar = el('div', 'ovi-bar' + (it.progress == null ? ' is-ind' : '')); const fill = el('i'); if (it.progress != null) fill.style.width = (it.progress * 100).toFixed(1) + '%'; bar.appendChild(fill); bar.setAttribute('role', 'progressbar'); if (it.progress != null) bar.setAttribute('aria-valuenow', String(Math.round(it.progress * 100))); body.appendChild(bar); }
            if (it.detail) body.appendChild(el('div', 'ovi-d', it.detail));
            if (it.actions && it.actions.length) {
                const acts = el('div', 'ovi-acts');
                it.actions.slice(0, 3).forEach((ac) => {
                    if (!ac || !ac.label) return;
                    const href = ac.href && safeUrl(ac.href);
                    const b = el(href ? 'a' : 'button', 'ovi-act', ac.label);
                    if (href) { b.href = href; if (ac.download) b.setAttribute('download', typeof ac.download === 'string' ? ac.download : ''); } else b.type = 'button';
                    if (ac.onClick) b.addEventListener('click', (ev) => { try { ac.onClick(ev); } catch { /* */ } });
                    acts.appendChild(b);
                });
                body.appendChild(acts);
            }
            row.appendChild(body);
            return row;
        }));
    }

    function put(id, patch, defaults) {
        const prev = items.get(id) || Object.assign({ id, title: '', subtitle: '', icon: 'ov', image: '', progress: null, state: 'busy', detail: '', actions: [] }, defaults);
        const next = Object.assign({}, prev, patch || {});
        if (patch && 'progress' in patch) next.progress = clamp(patch.progress);
        if (!['busy', 'ok', 'error', 'info'].includes(next.state)) next.state = 'busy';
        items.set(id, next);
        clearTimeout(timers.get(id));
        if (next.ttl) timers.set(id, setTimeout(() => remove(id), next.ttl));
        render();
        return next;
    }

    function handle(id) { return { id, update: (p) => update(id, p), finish: (p) => finish(id, p), fail: (p) => fail(id, p), remove: () => remove(id) }; }
    function start(o) { const id = (o && o.id) || 'act-' + (++seq); items.delete(id); put(id, Object.assign({ state: 'busy' }, o, { id })); return handle(id); }
    function update(id, patch) { if (!items.has(id)) return; const p = Object.assign({}, patch); delete p.id; put(id, p); }
    function finish(id, patch) { if (!items.has(id)) return; put(id, Object.assign({ state: 'ok', progress: 1, actions: [], ttl: 8000 }, patch)); if (host && top() && top().id === id && (patch && patch.actions && patch.actions.length)) { host.classList.add('is-open'); pill.setAttribute('aria-expanded', 'true'); setTimeout(() => { if (host && !host.matches(':hover')) host.classList.remove('is-open'); }, 5000); } }
    function fail(id, patch) { if (!items.has(id)) return; put(id, Object.assign({ state: 'error', progress: null, actions: [], ttl: 12000 }, patch)); }
    function remove(id) { clearTimeout(timers.get(id)); timers.delete(id); if (items.delete(id)) render(); }

    const api = { start, update, finish, fail, remove, list: () => [...items.values()] };
    root.OpenVibeIsland = api;
    // The navbar exposes the same thing as OpenVibeNavbar.activity, whichever loads first.
    const bind = () => { if (root.OpenVibeNavbar && !root.OpenVibeNavbar.activity) { try { root.OpenVibeNavbar.activity = api; } catch { /* */ } } };
    bind(); root.addEventListener('load', bind);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
