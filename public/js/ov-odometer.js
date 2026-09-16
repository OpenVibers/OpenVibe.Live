/**
 * ov-odometer.js — numbers that roll to their new value instead of snapping to it.
 *
 * Live counters that change under you are easy to miss and easy to distrust: a number that was
 * 41 and is now 42 looks identical to a number nobody updated. Rolling the digit makes the change
 * impossible to miss and tells you which way it moved, without a flash or a colour change that
 * pulls the eye away from whatever you were reading.
 *
 * Each digit is a vertical strip of 0-9 translated to show one of them, so only the digits that
 * actually changed move — 1,299 → 1,300 rolls three digits and leaves the leading 1 alone. Commas
 * and suffixes are plain cells that never animate.
 *
 *   OVNum.mount(el, value)   — render (no animation the first time)
 *   OVNum.set(el, value)     — roll to a new value
 *
 * Layout-stable by construction: the element's width only changes when the digit COUNT changes,
 * and a rolling digit never reflows because the strip is transformed, not re-laid-out.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || window.OVNum) return;

    const CSS = `
/* --ovnum-h is the height of one digit cell. It has to clear the font's ascenders and
   descenders, or the clipping window shaves the tops off the numerals — 1em is the em square,
   not the line box, and digits overflow it. */
.ovnum{--ovnum-h:1.25em;display:inline-flex;align-items:center;line-height:var(--ovnum-h);font-variant-numeric:tabular-nums}
.ovnum-cell{display:inline-block;line-height:var(--ovnum-h)}
.ovnum-digit{display:inline-block;overflow:hidden;height:var(--ovnum-h);width:1ch;position:relative}
.ovnum-track{display:block;transition:transform var(--ovnum-dur,.62s) cubic-bezier(.22,1,.28,1)}
.ovnum-track span{display:block;height:var(--ovnum-h);line-height:var(--ovnum-h);text-align:center}
.ovnum.is-up .ovnum-digit.changed{animation:ovnumUp .62s ease-out}
.ovnum.is-down .ovnum-digit.changed{animation:ovnumDown .62s ease-out}
@keyframes ovnumUp{0%{filter:none}35%{filter:brightness(1.55)}100%{filter:none}}
@keyframes ovnumDown{0%{filter:none}35%{filter:brightness(.72)}100%{filter:none}}
@media (prefers-reduced-motion:reduce){.ovnum-track{transition:none}.ovnum .ovnum-digit.changed{animation:none}}`;

    function ensure() {
        if (document.getElementById('ovnum-css')) return;
        const st = document.createElement('style'); st.id = 'ovnum-css'; st.textContent = CSS;
        document.head.appendChild(st);
    }

    /** 12345 → "12,345"; big numbers keep the compact form the rest of the site uses. */
    function format(n) {
        n = Number(n) || 0;
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
        if (n >= 100_000) return Math.round(n / 1000) + 'k';
        return n.toLocaleString('en-US');
    }

    const digitTrack = () => {
        const t = document.createElement('span'); t.className = 'ovnum-track';
        for (let i = 0; i <= 9; i++) { const d = document.createElement('span'); d.textContent = String(i); t.appendChild(d); }
        return t;
    };

    function render(el, text, animate) {
        const chars = [...text];
        // Rebuild only when the shape changes; otherwise reuse the cells so digits can roll.
        if (el.dataset.shape !== chars.map(c => (/\d/.test(c) ? '#' : c)).join('')) {
            el.textContent = '';
            for (const ch of chars) {
                if (/\d/.test(ch)) {
                    const d = document.createElement('span'); d.className = 'ovnum-digit';
                    d.appendChild(digitTrack()); el.appendChild(d);
                } else {
                    const c = document.createElement('span'); c.className = 'ovnum-cell'; c.textContent = ch; el.appendChild(c);
                }
            }
            el.dataset.shape = chars.map(c => (/\d/.test(c) ? '#' : c)).join('');
            animate = false;   // a freshly built shape has nothing to roll from
        }
        const digits = el.querySelectorAll('.ovnum-digit');
        let di = 0;
        for (const ch of chars) {
            if (!/\d/.test(ch)) continue;
            const d = digits[di++]; if (!d) break;
            const track = d.firstElementChild;
            const want = Number(ch);
            const had = d.dataset.v === undefined ? null : Number(d.dataset.v);
            d.classList.toggle('changed', animate && had !== null && had !== want);
            if (!animate) track.style.transition = 'none';
            track.style.transform = `translateY(calc(${-want} * var(--ovnum-h)))`;
            if (!animate) { void track.offsetHeight; track.style.transition = ''; }
            d.dataset.v = String(want);
        }
    }

    function apply(el, value, animate) {
        if (!el) return;
        ensure();
        el.classList.add('ovnum');
        const prev = el.dataset.n === undefined ? null : Number(el.dataset.n);
        const next = Number(value) || 0;
        el.dataset.n = String(next);
        if (animate && prev !== null && prev !== next) {
            el.classList.toggle('is-up', next > prev);
            el.classList.toggle('is-down', next < prev);
            setTimeout(() => el.classList.remove('is-up', 'is-down'), 700);
        }
        render(el, format(next), animate);
    }

    window.OVNum = {
        mount: (el, v) => apply(el, v, false),
        set: (el, v) => apply(el, v, true),
        format,
    };
})();
