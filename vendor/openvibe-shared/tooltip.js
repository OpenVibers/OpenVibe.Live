/**
 * openvibe-shared/tooltip.js — rich tooltips for every OpenVibe property.
 *
 * Markup-driven, so a site never writes tooltip code:
 *
 *   <a data-ovtip="Plain text tip">…</a>
 *   <a data-ovtip-title="API docs"
 *      data-ovtip="<b>Vibe code it.</b> Point an AI at these docs…"
 *      data-ovtip-icon="fa-wand-magic-sparkles"
 *      data-ovtip-place="top"
 *      data-ovtip-accent="#f472b6">…</a>
 *
 * One floating element is reused for every tooltip, positioned with fixed coordinates so it is
 * never clipped by an overflow:hidden ancestor — the usual reason CSS-only tooltips get cut off
 * inside cards and scroll containers. It flips to stay on screen, follows the trigger while the
 * page scrolls, opens on hover, focus and long-press, and closes on Escape, scroll-away or tap
 * elsewhere. Touch devices get a tap-to-open behaviour instead of hover, which is what makes
 * these usable on a phone at all.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || window.OpenVibeTooltip) return;

    const CSS = `
.ovtip{position:fixed;z-index:30000;max-width:min(330px,calc(100vw - 24px));padding:12px 14px;border-radius:14px;
  background:linear-gradient(165deg,var(--bg-card,#171826) 0%,var(--bg-secondary,#12131c) 100%);
  border:1px solid color-mix(in srgb, var(--ovtip-accent,var(--accent,#a78bfa)) 45%, var(--border,rgba(255,255,255,.1)));
  box-shadow:0 20px 50px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04),0 0 30px color-mix(in srgb, var(--ovtip-accent,var(--accent,#a78bfa)) 22%, transparent);
  color:var(--text-secondary,#b6bdd2);font-size:.83rem;line-height:1.55;pointer-events:none;opacity:0;
  transform:translateY(6px) scale(.97);transition:opacity .18s ease,transform .22s cubic-bezier(.2,1.3,.3,1);
  overflow:hidden}
.ovtip.is-on{opacity:1;transform:none}
.ovtip.is-interactive{pointer-events:auto}
.ovtip::before{content:'';position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--ovtip-accent,var(--accent,#a78bfa)) 16%, transparent), transparent 60%)}
/* A light sweep on open — draws the eye without moving anything around it. */
.ovtip::after{content:'';position:absolute;top:0;bottom:0;left:-60%;width:45%;pointer-events:none;
  background:linear-gradient(100deg,transparent,color-mix(in srgb, var(--ovtip-accent,var(--accent,#a78bfa)) 26%, transparent),transparent)}
.ovtip.is-on::after{animation:ovtipSweep .9s cubic-bezier(.3,.7,.3,1) .1s 1}
@keyframes ovtipSweep{to{transform:translateX(420%)}}
.ovtip-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;position:relative}
.ovtip-ico{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex:none;font-size:.78rem;color:#fff;
  background:linear-gradient(135deg,var(--ovtip-accent,var(--accent,#a78bfa)),color-mix(in srgb,var(--ovtip-accent,var(--accent,#a78bfa)) 55%,#000));
  box-shadow:0 4px 12px color-mix(in srgb, var(--ovtip-accent,var(--accent,#a78bfa)) 45%, transparent)}
.ovtip-title{font-size:.9rem;font-weight:800;color:var(--text-primary,#f1f4fb);letter-spacing:-.01em}
.ovtip-body{position:relative}
.ovtip-body b,.ovtip-body strong{color:var(--text-primary,#f1f4fb);font-weight:700}
.ovtip-body em{color:var(--ovtip-accent,var(--accent,#a78bfa));font-style:normal;font-weight:600}
.ovtip-body code{background:var(--bg-tertiary,#1a1b28);padding:1px 6px;border-radius:5px;font-size:.78rem}
.ovtip-foot{margin-top:8px;padding-top:8px;border-top:1px dashed var(--border,rgba(255,255,255,.1));
  font-size:.74rem;color:var(--text-muted,#8b93ad);display:flex;align-items:center;gap:6px;position:relative}
.ovtip-arrow{position:fixed;z-index:30001;width:10px;height:10px;transform:rotate(45deg);opacity:0;transition:opacity .18s;
  background:var(--bg-card,#171826);border:1px solid color-mix(in srgb, var(--ovtip-accent,var(--accent,#a78bfa)) 45%, var(--border,rgba(255,255,255,.1)))}
.ovtip-arrow.is-on{opacity:1}
.ovtip-arrow.from-top{border-top:0;border-left:0}
.ovtip-arrow.from-bottom{border-bottom:0;border-right:0}
.ovtip-actions{display:flex;gap:8px;margin-top:11px;padding-top:10px;border-top:1px solid var(--border,rgba(255,255,255,.1))}
.ovtip-go,.ovtip-dismiss{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;
  padding:9px 12px;border-radius:10px;font:inherit;font-size:.8rem;font-weight:750;cursor:pointer;
  transition:transform .15s,filter .15s}
.ovtip-go{color:#fff;border:0;
  background:linear-gradient(135deg,var(--ovtip-accent,var(--accent,#a78bfa)),color-mix(in srgb,var(--ovtip-accent,var(--accent,#a78bfa)) 60%,#000));
  box-shadow:0 6px 16px color-mix(in srgb,var(--ovtip-accent,var(--accent,#a78bfa)) 40%,transparent)}
.ovtip-dismiss{flex:0 0 auto;color:var(--text-muted,#8b93ad);background:none;border:1px solid var(--border,rgba(255,255,255,.12))}
.ovtip-go:active,.ovtip-dismiss:active{transform:scale(.975)}
.ovtip-go i{font-size:.72rem}
/* On a phone a 330px tip pinned beside a button is unreadable and often half off-screen. Dock it
   to the bottom of the viewport as a full-width card instead. */
@media (hover:none){
  .ovtip{position:fixed;left:12px!important;right:12px;top:auto!important;bottom:calc(14px + env(safe-area-inset-bottom,0px));
    max-width:none;width:auto;padding:14px 16px;border-radius:18px;font-size:.88rem;
    transform:translateY(14px) scale(1);box-shadow:0 -10px 40px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.05)}
  .ovtip.is-on{transform:none}
  .ovtip-arrow{display:none}
  .ovtip-title{font-size:1rem}
}
@media (prefers-reduced-motion:reduce){.ovtip{transition:opacity .12s}.ovtip.is-on::after{animation:none}}`;

    let tip = null, arrow = null, current = null, raf = 0, hideTimer = 0;
    const isTouch = () => window.matchMedia('(hover: none)').matches;

    function ensure() {
        if (tip) return;
        const st = document.createElement('style'); st.id = 'ovtip-css'; st.textContent = CSS; document.head.appendChild(st);
        tip = document.createElement('div'); tip.className = 'ovtip'; tip.setAttribute('role', 'tooltip');
        arrow = document.createElement('div'); arrow.className = 'ovtip-arrow';
        document.body.append(arrow, tip);
        tip.addEventListener('pointerenter', () => clearTimeout(hideTimer));
        tip.addEventListener('pointerleave', () => hide());
    }

    function content(el) {
        const title = el.getAttribute('data-ovtip-title');
        const icon = el.getAttribute('data-ovtip-icon');
        const body = el.getAttribute('data-ovtip') || '';
        const foot = el.getAttribute('data-ovtip-foot');
        // On touch the first tap opens the tip and swallows the click, so without an explicit
        // action the visitor is left tapping a button that appears to do nothing. Give them the
        // destination as a real button inside the tip — and a way out that isn't "tap elsewhere".
        const act = isTouch() ? `<div class="ovtip-actions">
                <button type="button" class="ovtip-dismiss" data-ovtip-dismiss>Got it</button>
                <button type="button" class="ovtip-go" data-ovtip-go>${esc(el.getAttribute('data-ovtip-go') || 'Open')}<i class="fa-solid fa-arrow-right"></i></button>
            </div>` : '';
        return `${title ? `<div class="ovtip-head">${icon ? `<span class="ovtip-ico"><i class="fa-solid ${icon}"></i></span>` : ''}<span class="ovtip-title">${title}</span></div>` : ''}
            <div class="ovtip-body">${body}</div>
            ${foot ? `<div class="ovtip-foot">${foot}</div>` : ''}${act}`;
    }
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function place() {
        if (!current || !tip) return;
        if (!current.isConnected) return hide();
        // Docked to the bottom on touch — CSS owns the position, and following the trigger would
        // fight it (and hide the tip the moment the page scrolls a little).
        if (isTouch()) { arrow.classList.remove('is-on'); return; }
        const r = current.getBoundingClientRect();
        // Off-screen trigger: nothing to point at.
        if (r.bottom < -40 || r.top > window.innerHeight + 40) return hide();
        const tw = tip.offsetWidth, th = tip.offsetHeight, gap = 12;
        const prefer = current.getAttribute('data-ovtip-place') || 'top';
        let top, from;
        const fitsAbove = r.top - th - gap > 8;
        const fitsBelow = r.bottom + th + gap < window.innerHeight - 8;
        if ((prefer === 'top' && fitsAbove) || (!fitsBelow && fitsAbove)) { top = r.top - th - gap; from = 'from-bottom'; }
        else { top = r.bottom + gap; from = 'from-top'; }
        let left = r.left + r.width / 2 - tw / 2;
        left = Math.max(12, Math.min(left, window.innerWidth - tw - 12));
        tip.style.top = `${Math.round(top)}px`;
        tip.style.left = `${Math.round(left)}px`;
        const ax = Math.max(left + 14, Math.min(r.left + r.width / 2 - 5, left + tw - 24));
        arrow.className = `ovtip-arrow is-on ${from}`;
        arrow.style.left = `${Math.round(ax)}px`;
        arrow.style.top = `${Math.round(from === 'from-top' ? top - 5 : top + th - 5)}px`;
        raf = requestAnimationFrame(place);
    }

    function show(el) {
        ensure();
        clearTimeout(hideTimer);
        if (current === el && tip.classList.contains('is-on')) return;
        current = el;
        tip.style.setProperty('--ovtip-accent', el.getAttribute('data-ovtip-accent') || '');
        arrow.style.setProperty('--ovtip-accent', el.getAttribute('data-ovtip-accent') || '');
        tip.innerHTML = content(el);
        tip.classList.toggle('is-interactive', el.hasAttribute('data-ovtip-interactive') || isTouch());
        tip.classList.remove('is-on'); arrow.classList.remove('is-on');
        cancelAnimationFrame(raf);
        place();
        requestAnimationFrame(() => { tip.classList.add('is-on'); arrow.classList.add('is-on'); });
        el.setAttribute('aria-describedby', 'ovtip');
    }

    function hide() {
        if (!tip) return;
        cancelAnimationFrame(raf);
        tip.classList.remove('is-on'); arrow.classList.remove('is-on');
        if (current) current.removeAttribute('aria-describedby');
        current = null;
    }
    const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 120); };

    function trigger(e) { return e.target.closest && e.target.closest('[data-ovtip]'); }

    function bind() {
        const fromTouch = (e) => e.pointerType === 'touch' || (!e.pointerType && isTouch());
        document.addEventListener('pointerover', (e) => { if (fromTouch(e)) return; const t = trigger(e); if (t) show(t); });
        document.addEventListener('pointerout', (e) => { if (fromTouch(e)) return; if (trigger(e)) hideSoon(); });
        document.addEventListener('focusin', (e) => { const t = trigger(e); if (t) show(t); });
        document.addEventListener('focusout', (e) => { if (trigger(e)) hideSoon(); });
        // Touch: first tap opens the tip, a tap elsewhere closes it. The trigger still works —
        // we never swallow the click, so a tap on an already-open tip follows the link.
        document.addEventListener('click', (e) => {
            const t = trigger(e);
            if (!t) return hide();
            // On touch the first tap opens the tip; a second tap follows the link.
            if (isTouch() && current !== t) { e.preventDefault(); show(t); }
        }, true);
        // The touch action buttons.
        document.addEventListener('click', (e) => {
            const dismiss = e.target.closest && e.target.closest('[data-ovtip-dismiss]');
            if (dismiss) { e.preventDefault(); e.stopPropagation(); hide(); return; }
            const go = e.target.closest && e.target.closest('[data-ovtip-go]');
            if (go && current) {
                e.preventDefault(); e.stopPropagation();
                const target = current;
                hide();
                // Replay the trigger's own behaviour: its click handler, then its href.
                if (typeof target.click === 'function') target.click();
            }
        }, true);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
        window.addEventListener('scroll', () => { if (current && isTouch()) hide(); }, { passive: true });
        window.addEventListener('resize', hide, { passive: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
    window.OpenVibeTooltip = { show, hide, ensure };
})();
