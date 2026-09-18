/**
 * openvibe-shared/ui.js — one toast / confirm / alert implementation for every OpenVibe site.
 *
 *   OpenVibeUI.toast('Saved', { type: 'success' })
 *   OpenVibeUI.toast('Upload failed', { type: 'error', title: 'Images', action: { label: 'Retry', onClick } })
 *   if (await OpenVibeUI.confirm({ title: 'Delete paste?', message: 'This cannot be undone.', danger: true })) …
 *   await OpenVibeUI.alert({ title: 'Heads up', message: '…' })
 *   OpenVibeUI.notice({ id: 'yt-upstream', type: 'warning', title: '…', message: '…', links: [{ label, href }], dismissible: true })
 *       a page-level notice that always sits directly BELOW the site's navbar (never above it), one
 *       design for service status, maintenance, read-only mode and similar. Returns { close, update }.
 *
 * Themed from the site's CSS variables, stacked bottom-right (bottom-centre on phones), announced
 * to assistive tech (role=status, role=alert for errors), pause-on-hover, Escape closes dialogs,
 * focus is trapped in dialogs and restored afterwards. Text is always set with textContent.
 */
(function (root) {
    'use strict';
    if (root.OpenVibeUI) return;
    if (typeof document === 'undefined') { const noop = { toast() { return { close() {} }; }, notice() { return { close() {}, update() {} }; }, confirm: async () => false, alert: async () => {} }; if (typeof module !== 'undefined') module.exports = noop; return; }

    const CSS = `
.ovui-toasts{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 24px));pointer-events:none}
.ovui-toast{pointer-events:auto;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;padding:11px 12px;border-radius:12px;background:var(--bg-elevated,var(--bg-secondary,#131a26));color:var(--text-primary,#e6edf7);border:1px solid var(--border,rgba(255,255,255,.1));box-shadow:0 10px 30px rgba(0,0,0,.35);font:500 13.5px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:ovuiIn .28s cubic-bezier(.2,1.2,.3,1);border-left:3px solid var(--ovui-c,var(--accent,#3b82f6))}
.ovui-toast[data-type=success]{--ovui-c:var(--success,#22c55e)}
.ovui-toast[data-type=error]{--ovui-c:var(--danger,#ef4444)}
.ovui-toast[data-type=warning]{--ovui-c:var(--warning,#f59e0b)}
.ovui-toast.is-out{animation:ovuiOut .2s ease forwards}
.ovui-dot{width:8px;height:8px;border-radius:50%;background:var(--ovui-c,var(--accent,#3b82f6));margin-top:6px}
.ovui-title{font-weight:700;margin-bottom:1px}
.ovui-msg{color:var(--text-secondary,#a8b3c4);overflow-wrap:anywhere}
.ovui-title+.ovui-msg{font-weight:400}
.ovui-toast .ovui-msg:first-child{color:inherit}
.ovui-x,.ovui-act{appearance:none;border:0;background:none;color:inherit;font:inherit;cursor:pointer;border-radius:8px}
.ovui-x{opacity:.55;padding:2px 6px;line-height:1;font-size:16px}
.ovui-x:hover{opacity:1}
.ovui-act{margin-top:6px;padding:4px 10px;font-weight:700;color:var(--accent,#3b82f6);background:color-mix(in srgb,var(--accent,#3b82f6) 14%,transparent);text-decoration:none;display:inline-block}
.ovui-back{position:fixed;inset:0;z-index:2147483100;background:rgba(3,6,12,.6);backdrop-filter:blur(3px);display:grid;place-items:center;padding:16px;animation:ovuiFade .15s ease}
.ovui-dialog{width:min(420px,100%);background:var(--bg-elevated,var(--bg-secondary,#131a26));color:var(--text-primary,#e6edf7);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:16px;padding:20px;box-shadow:0 24px 60px rgba(0,0,0,.5);font:400 14.5px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:ovuiIn .22s cubic-bezier(.2,1.2,.3,1)}
.ovui-dialog h2{margin:0 0 6px;font-size:17px;font-weight:700}
.ovui-dialog p{margin:0;color:var(--text-secondary,#a8b3c4);white-space:pre-wrap;overflow-wrap:anywhere}
.ovui-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.ovui-btn{appearance:none;border:1px solid var(--border,rgba(255,255,255,.14));background:transparent;color:inherit;font:600 14px/1 system-ui,sans-serif;padding:10px 16px;border-radius:10px;cursor:pointer}
.ovui-btn:hover{background:rgba(127,127,127,.12)}
.ovui-btn.is-primary{background:var(--accent,#3b82f6);border-color:transparent;color:var(--on-accent,#fff)}
.ovui-btn.is-danger{background:var(--danger,#ef4444);border-color:transparent;color:#fff}
.ovui-btn:focus-visible,.ovui-x:focus-visible,.ovui-act:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
.ovui-notices{display:flex;flex-direction:column;gap:8px;max-width:1080px;margin:14px auto 0;padding:0 16px;box-sizing:border-box;width:100%}
.ovui-notices:empty{display:none}
.ovui-notice{--ovui-c:var(--accent,#3b82f6);display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:start;padding:12px 14px;border-radius:14px;border:1px solid color-mix(in srgb,var(--ovui-c) 40%,transparent);background:color-mix(in srgb,var(--ovui-c) 9%,var(--bg-secondary,#111826));color:var(--text-primary,#e6edf7);font:400 14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:ovuiIn .28s cubic-bezier(.2,1.2,.3,1)}
.ovui-notice[data-type=success]{--ovui-c:var(--success,#22c55e)}.ovui-notice[data-type=error]{--ovui-c:var(--danger,#ef4444)}.ovui-notice[data-type=warning]{--ovui-c:var(--warning,#f59e0b)}
.ovui-notice-ic{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--ovui-c);color:#0b1220;font:800 13px/1 system-ui,sans-serif;margin-top:1px}
.ovui-notice b{font-weight:700}.ovui-notice-msg{color:var(--text-secondary,#a8b3c4)}
.ovui-notice-links{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px}.ovui-notice-links a{color:var(--accent-light,var(--accent,#60a5fa));font-weight:600;text-decoration:none}.ovui-notice-links a:hover{text-decoration:underline}
@media (max-width:560px){.ovui-notices{margin-top:10px;padding:0 12px}}
@keyframes ovuiIn{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes ovuiOut{to{opacity:0;transform:translateX(16px)}}
@keyframes ovuiFade{from{opacity:0}to{opacity:1}}
@media (max-width:560px){.ovui-toasts{left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));max-width:none}}
@media (prefers-reduced-motion:reduce){.ovui-toast,.ovui-dialog,.ovui-back{animation:none!important}}`;

    function css() { if (document.getElementById('ovui-css')) return; const s = document.createElement('style'); s.id = 'ovui-css'; s.textContent = CSS; document.head.appendChild(s); }
    function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
    function safeHref(h) { try { const u = new URL(h, location.href); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } }

    let stack = null;
    const MAX = 4;

    function toast(message, opts) {
        const o = opts || {};
        css();
        if (!stack || !stack.isConnected) { stack = el('div', 'ovui-toasts'); stack.setAttribute('aria-live', 'polite'); document.body.appendChild(stack); }
        const type = ['info', 'success', 'error', 'warning'].includes(o.type) ? o.type : 'info';
        const t = el('div', 'ovui-toast'); t.dataset.type = type; t.setAttribute('role', type === 'error' ? 'alert' : 'status');
        t.appendChild(el('span', 'ovui-dot'));
        const body = el('div');
        if (o.title) body.appendChild(el('div', 'ovui-title', o.title));
        body.appendChild(el('div', 'ovui-msg', message));
        if (o.action && o.action.label) {
            const href = o.action.href && safeHref(o.action.href);
            const a = el(href ? 'a' : 'button', 'ovui-act', o.action.label);
            if (href) a.href = href; else a.type = 'button';
            a.addEventListener('click', (ev) => { try { o.action.onClick && o.action.onClick(ev); } finally { close(); } });
            body.appendChild(a);
        }
        t.appendChild(body);
        const x = el('button', 'ovui-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.addEventListener('click', () => close()); t.appendChild(x);
        stack.appendChild(t);
        while (stack.children.length > MAX) stack.firstChild.remove();

        const ttl = o.ttl === 0 ? 0 : (o.ttl || (type === 'error' ? 8000 : 4500));
        let timer = null, closed = false;
        const arm = () => { if (ttl) timer = setTimeout(close, ttl); };
        function close() { if (closed) return; closed = true; clearTimeout(timer); t.classList.add('is-out'); setTimeout(() => t.remove(), 220); }
        t.addEventListener('mouseenter', () => clearTimeout(timer)); t.addEventListener('mouseleave', arm);
        arm();
        return { close, el: t };
    }

    function dialog(o, withCancel) {
        css();
        return new Promise((resolve) => {
            const prev = document.activeElement;
            const back = el('div', 'ovui-back');
            const d = el('div', 'ovui-dialog'); d.setAttribute('role', withCancel ? 'alertdialog' : 'dialog'); d.setAttribute('aria-modal', 'true');
            const h = el('h2', null, o.title || (withCancel ? 'Are you sure?' : 'Notice')); h.id = 'ovui-h-' + Date.now(); d.setAttribute('aria-labelledby', h.id); d.appendChild(h);
            if (o.message) d.appendChild(el('p', null, o.message));
            const btns = el('div', 'ovui-btns');
            let cancel = null;
            if (withCancel) { cancel = el('button', 'ovui-btn', o.cancelLabel || 'Cancel'); cancel.type = 'button'; btns.appendChild(cancel); }
            const ok = el('button', 'ovui-btn ' + (o.danger ? 'is-danger' : 'is-primary'), o.confirmLabel || (withCancel ? 'Confirm' : 'OK')); ok.type = 'button'; btns.appendChild(ok);
            d.appendChild(btns); back.appendChild(d); document.body.appendChild(back);
            function done(v) { document.removeEventListener('keydown', onKey, true); back.remove(); try { prev && prev.focus && prev.focus(); } catch { /* */ } resolve(v); }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); done(false); }
                else if (e.key === 'Tab') { const f = [cancel, ok].filter(Boolean); const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus(); }
            }
            document.addEventListener('keydown', onKey, true);
            back.addEventListener('mousedown', (e) => { if (e.target === back) done(false); });
            ok.addEventListener('click', () => done(true));
            if (cancel) cancel.addEventListener('click', () => done(false));
            (o.danger && cancel ? cancel : ok).focus();
        });
    }

    // ── Page notices ─────────────────────────────────────────
    const notices = new Map();
    let noticeHost = null;
    function placeNoticeHost() {
        if (!noticeHost) { noticeHost = el('div', 'ovui-notices'); noticeHost.setAttribute('aria-live', 'polite'); }
        // Directly after the navbar, whichever flavour the site uses; otherwise at the top of the content.
        const nav = document.querySelector('nav.openvibe-navbar, #navbar-mount, .navbar, header[role="banner"]');
        const anchor = nav ? (nav.id === 'navbar-mount' || nav.parentNode === document.body ? nav : nav) : null;
        if (anchor && anchor.parentNode) { if (anchor.nextSibling !== noticeHost) anchor.parentNode.insertBefore(noticeHost, anchor.nextSibling); return true; }
        const main = document.querySelector('main') || document.body.firstElementChild;
        if (!noticeHost.isConnected && main && main.parentNode) main.parentNode.insertBefore(noticeHost, main);
        return false;
    }
    function notice(o) {
        o = o || {}; css();
        const id = String(o.id || 'n' + Date.now());
        try { if (o.dismissible !== false && sessionStorage.getItem('ovui_notice_' + id) === '1') return { close() {}, update() {} }; } catch { /* */ }
        if (notices.has(id)) notices.get(id).close(true);
        const type = ['info', 'success', 'error', 'warning'].includes(o.type) ? o.type : 'info';
        const n = el('div', 'ovui-notice'); n.dataset.type = type; n.setAttribute('role', type === 'error' ? 'alert' : 'status');
        n.appendChild(el('span', 'ovui-notice-ic', type === 'success' ? '✓' : type === 'info' ? 'i' : '!'));
        const body = el('div');
        const fill = (p) => {
            body.replaceChildren();
            const line = el('div'); if (p.title) { line.appendChild(el('b', null, p.title)); line.appendChild(document.createTextNode(' ')); }
            if (p.message) line.appendChild(el('span', 'ovui-notice-msg', p.message)); body.appendChild(line);
            const links = (p.links || []).map((l) => { const h = l && l.label && safeHref(l.href); if (!h) return null; const a = el('a', null, l.label); a.href = h; return a; }).filter(Boolean);
            if (links.length) { const row = el('div', 'ovui-notice-links'); links.forEach((a) => row.appendChild(a)); body.appendChild(row); }
        };
        fill(o); n.appendChild(body);
        const close = (silent) => { n.remove(); notices.delete(id); if (!silent && o.dismissible !== false) { try { sessionStorage.setItem('ovui_notice_' + id, '1'); } catch { /* */ } } };
        if (o.dismissible !== false) { const x = el('button', 'ovui-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.addEventListener('click', () => close(false)); n.appendChild(x); }
        // The navbar may mount after us: keep trying briefly until the notice sits under it.
        let tries = 0; const settle = () => { const ok = placeNoticeHost(); if (!ok && ++tries < 40) setTimeout(settle, 150); }; settle();
        noticeHost.appendChild(n);
        const handle = { close: () => close(true), update: (p) => fill(Object.assign({}, o, p)), el: n };
        notices.set(id, handle);
        return handle;
    }

    const api = {
        toast, notice,
        success: (m, o) => toast(m, Object.assign({}, o, { type: 'success' })),
        error: (m, o) => toast(m, Object.assign({}, o, { type: 'error' })),
        warning: (m, o) => toast(m, Object.assign({}, o, { type: 'warning' })),
        confirm: (o) => dialog(typeof o === 'string' ? { message: o } : (o || {}), true),
        alert: (o) => dialog(typeof o === 'string' ? { message: o } : (o || {}), false).then(() => undefined),
    };
    root.OpenVibeUI = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
