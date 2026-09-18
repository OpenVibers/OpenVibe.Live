/**
 * ov-mark.js — the OpenVibe "OV" brand mark as a drop-in.
 *   <span class="ov-mark"></span>            → 32px animated mark
 *   <span class="ov-mark" data-size="56">    → any size; add data-static="1" for no motion
 *   <span class="ov-mark" data-variant="live">  → the site's own twist on the motion (see VARIANTS)
 * Self-contained: injects its own CSS once, works on any page (Live, Network, static pages).
 * The O is a ring with a comet arc running around it, the V is drawn inside with a light
 * sweep, and a dot orbits the ring. Transform/opacity/stroke motion only.
 */
(function () {
    'use strict';
    if (window.__ovMark) return; window.__ovMark = true;
    let n = 0;
    const CSS = `
.ov-mark{display:inline-grid;place-items:center;width:32px;height:32px;color:var(--accent,#8b5cf6);flex:none;vertical-align:middle;line-height:0}
.ov-mark svg{width:100%;height:100%;overflow:visible;transform-origin:50% 50%;animation:ovmFloat 5s ease-in-out infinite}
.ov-mark .g{fill:currentColor;opacity:.1;transform-box:fill-box;transform-origin:center;animation:ovmGlow 3.4s ease-in-out infinite}
.ov-mark .r{fill:none;stroke:currentColor;stroke-width:4;opacity:.28}
.ov-mark .c{fill:none;stroke-width:4;stroke-linecap:round;stroke-dasharray:34 79;transform-box:fill-box;transform-origin:center;animation:ovmComet 3.6s linear infinite}
.ov-mark .v{fill:none;stroke-width:4.6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:46;animation:ovmDraw 1.1s cubic-bezier(.2,.8,.2,1) both}
.ov-mark .d{fill:var(--ovm-dot,#fff);transform-box:fill-box;transform-origin:center;animation:ovmDot 2.4s ease-in-out infinite}
/* Per-site variants: one family, each site with its own motion so the network reads as one brand
   with many rooms. Colours stay with the theme (currentColor); only the dot and the rhythm change. */
.ov-mark[data-variant=live]{--ovm-dot:#ef4444}
.ov-mark[data-variant=live] .d{animation:ovmOnAir 1.4s ease-in-out infinite}
.ov-mark[data-variant=tools] .c{animation-duration:2.2s;stroke-dasharray:22 91}
.ov-mark[data-variant=tools] .o2{display:none}
.ov-mark[data-variant=media] .c{stroke-dasharray:14 14 14 71;animation-duration:4.4s}
.ov-mark[data-variant=games] svg{animation:ovmBounce 1.6s cubic-bezier(.3,1.4,.4,1) infinite}
.ov-mark[data-variant=games] .d{animation-duration:1.6s}
.ov-mark[data-variant=community] .o2{opacity:.9;r:1.8}
.ov-mark[data-variant=community] .c{animation-direction:reverse}
.ov-mark[data-variant=network] .g{animation-duration:2.4s}
.ov-mark[data-variant=chat] .d{animation:ovmDot 1s ease-in-out infinite}
.ov-mark[data-variant=stream] .c{stroke-dasharray:60 53;animation-duration:2.8s}
.ov-mark[data-variant=codes] .v{animation:ovmDraw 1.1s cubic-bezier(.2,.8,.2,1) infinite alternate}
.ov-mark[data-variant=blog] .c,.ov-mark[data-variant=wiki] .c,.ov-mark[data-variant=news] .c{animation-duration:6s}
.ov-mark[data-variant=vip]{--ovm-dot:#facc15}
.ov-mark[data-variant=tips]{--ovm-dot:#22c55e}
.ov-mark[data-variant=deals],.ov-mark[data-variant=coupons]{--ovm-dot:#f59e0b}
.ov-mark[data-variant=trade] .c{animation-timing-function:cubic-bezier(.4,0,.2,1)}
.ov-mark[data-variant=host] svg{animation:none}
@keyframes ovmOnAir{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.7);opacity:1}}
@keyframes ovmBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.5px)}}
.ov-mark .o{fill:#fff;filter:drop-shadow(0 0 3px currentColor)}
.ov-mark .o2{opacity:.5}
.ov-mark:hover svg,a:hover>.ov-mark svg,button:hover>.ov-mark svg{animation:ovmSpin .9s cubic-bezier(.2,1.5,.3,1) 1}
.ov-mark:hover .c{animation-duration:.9s}
.ov-mark[data-static] svg,.ov-mark[data-static] .g,.ov-mark[data-static] .c,.ov-mark[data-static] .v,.ov-mark[data-static] .d{animation:none!important}
.ov-mark[data-static] .o{display:none}
@keyframes ovmFloat{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-1px) rotate(2deg)}}
@keyframes ovmGlow{0%,100%{opacity:.08;transform:scale(.92)}50%{opacity:.2;transform:scale(1.06)}}
@keyframes ovmComet{to{transform:rotate(360deg)}}
@keyframes ovmDraw{from{stroke-dashoffset:46}to{stroke-dashoffset:0}}
@keyframes ovmDot{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.5);opacity:1}}
@keyframes ovmSpin{from{transform:rotate(0deg) scale(1)}40%{transform:rotate(200deg) scale(1.18)}to{transform:rotate(360deg) scale(1)}}
@media (prefers-reduced-motion:reduce){.ov-mark svg,.ov-mark .g,.ov-mark .c,.ov-mark .v,.ov-mark .d{animation:none!important}.ov-mark .o{display:none}.ov-mark .c{stroke-dasharray:none;opacity:.9}}`;
    function svg(id) {
        return `<svg viewBox="0 0 48 48" aria-hidden="true"><defs>
<linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0.45"/></linearGradient>
<linearGradient id="${id}v" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="0.5" stop-color="currentColor"/><stop offset="1" stop-color="#fff" stop-opacity="0.9"/><animateTransform attributeName="gradientTransform" type="translate" from="-1 0" to="1 0" dur="3.2s" repeatCount="indefinite"/></linearGradient>
<path id="${id}p" d="M24,6 A18,18 0 1,1 23.99,6 Z"/></defs>
<circle class="g" cx="24" cy="24" r="21"/><circle class="r" cx="24" cy="24" r="18"/><circle class="c" cx="24" cy="24" r="18" stroke="url(#${id}g)"/>
<path class="v" d="M14.5,17 L24,34 L33.5,17" stroke="url(#${id}v)"/><circle class="d" cx="24" cy="34" r="2.6"/>
<circle class="o" r="2"><animateMotion dur="3.6s" repeatCount="indefinite"><mpath href="#${id}p"/></animateMotion></circle>
<circle class="o o2" r="1.4"><animateMotion dur="3.6s" begin="0.14s" repeatCount="indefinite"><mpath href="#${id}p"/></animateMotion></circle></svg>`;
    }
    function mount(root) {
        (root || document).querySelectorAll('.ov-mark:not([data-ov])').forEach(el => {
            el.setAttribute('data-ov', '1');
            const size = parseInt(el.getAttribute('data-size'), 10);
            if (size) { el.style.width = size + 'px'; el.style.height = size + 'px'; }
            el.innerHTML = svg('ovm' + (++n) + '_');
        });
    }
    function init() {
        if (!document.getElementById('ov-mark-css')) { const st = document.createElement('style'); st.id = 'ov-mark-css'; st.textContent = CSS; document.head.appendChild(st); }
        mount();
        try { new MutationObserver(() => mount()).observe(document.body, { childList: true, subtree: true }); } catch { /* */ }
    }
    window.ovMarkMount = mount;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
