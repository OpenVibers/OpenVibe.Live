'use strict';
/**
 * Icons drawn on the server (plan L49 step 2; the owner, 2026-11-01: "why Font Awesome? We should be using OpenVibe
 * Design's icon system for all our icons"). Every <i class="fa-solid fa-…"></i> in Live's own HTML (index.html and the
 * fragments, through assets.rewriteHtml) arrives as the OpenVibe glyph itself, exactly as openvibe-shared's
 * ov-glyphs.js would have drawn it in the browser: same classes (`ovg`), same data-ovg and data-ovg-fa, same SVG. So
 * the first paint has the network's icons (no Font Awesome glyph flashing first, no wait for a script or a font), and
 * ov-glyphs.js, when it arrives, sees each one is already drawn and leaves it alone. Markup built in the browser is
 * still swapped there.
 *
 * Left to the browser: brand logos (fa-brands), animated icons (fa-spin, fa-beat… and the busy dots), an icon with a
 * title or a transform, anything with content of its own, and a name the glyphs do not have.
 *
 *   render(html) → html with the icons drawn
 *   STYLE        the few rules that size and stroke a drawn icon before ov-glyphs.js's own stylesheet arrives
 */
const glyphs = require('openvibe-shared/glyphs');

// An empty <i class="…fa-…"></i>, with only attributes that are safe to keep as they are.
const ICON_RE = /<i class="([^"<>]*\bfa-[a-z0-9-]+[^"<>]*)"((?:\s+(?:aria-hidden="true"|id="[a-z0-9_-]+"|style="[^"<>]*"))*)\s*><\/i>/g;
// Font Awesome's style and size classes: not names.
const MOD = /^fa-(solid|regular|light|thin|duotone|sharp|sharp-duotone|classic|fw|lg|xl|xs|sm|2xs|2xl|[0-9]+x|li|ul|border|inverse|pull-left|pull-right|rotate-90|rotate-180|rotate-270|rotate-by|flip-horizontal|flip-vertical|flip-both|width-auto)$/;
// Moving icons stay with the browser's swap, which knows how each one moves (and that nothing spins).
const MOVES = /^fa-(spin|spin-pulse|spin-reverse|pulse|beat|beat-fade|bounce|fade|flip|shake|stack|stack-1x|stack-2x|layers|layers-text|layers-counter)$/;

function render(html) {
    if (!html || html.indexOf('fa-') === -1) return html;
    return html.replace(ICON_RE, (whole, cls, attrs) => {
        const classes = cls.trim().split(/\s+/);
        if (classes.includes('ovg') || classes.includes('fa-brands') || classes.includes('fab')) return whole;
        if (classes.some((c) => MOVES.test(c))) return whole;
        const names = classes.filter((c) => /^fa-/.test(c) && !MOD.test(c));
        if (names.length !== 1) return whole;
        const g = glyphs.fromFa(names[0]);
        if (!g || g === 'busy') return whole;
        const hidden = /aria-hidden=/.test(attrs) ? '' : ' aria-hidden="true"';
        // The line drawing, and the solid one for small sizes when the glyph has one (openvibe-shared 4.69.0).
        const solid = typeof glyphs.solid === 'function' && glyphs.solid(g);
        const inner = typeof glyphs.inner === 'function' ? glyphs.inner(g) : glyphs.path(g);
        return `<i class="${cls.trim()} ovg" data-ovg="${g}" data-ovg-fa="${names[0]}"${attrs}${hidden}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"${solid ? ' class="has-s"' : ''}>${inner}</svg></i>`;
    });
}

// ov-glyphs.js's own first rules (it adds the rest, sizes and motion, when it runs).
const STYLE = '.ovg::before,.ovg::after{content:none!important;display:none!important}'
    + '.ovg{display:inline-block;width:1.15em;height:1.15em;line-height:1;vertical-align:-.18em;font-style:normal!important}'
    // Optical sizes, as ov-glyphs.js 4.69.0: heavier lines when small, and the solid drawing at 18 px and under.
    + '.ovg>svg{display:block;width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:calc(var(--ovg-stroke,2) * 1px + max(0px, (18.4px - 1.15em) * .25));stroke-linecap:round;stroke-linejoin:round;overflow:visible}'
    // The person's icon style (openvibe-shared 4.71.0, plan L56: Auto, Line or Solid, <html data-ov-icons>) wins over the
    // switch point, as in ov-glyphs.js.
    + 'html[data-ov-icons=solid]{--ovg-pref:99999px}html[data-ov-icons=line]{--ovg-pref:0px}'
    + '.ovg>svg.has-s{stroke-width:min(var(--ovg-stroke,2) * 1px + max(0px, (18.4px - 1.15em) * .25), max(0px, (1.15em - var(--ovg-pref, var(--ovg-solid-below, 18.4px))) * 999))}'
    + '.ovg>svg>.ovg-s{fill:currentColor;stroke:none;clip-path:inset(max(0px, (1.15em - var(--ovg-pref, var(--ovg-solid-below, 18.4px))) * 999))}'
    + '.ovg>svg>.ovg-s .ln{fill:none;stroke:currentColor;stroke-width:2.6px}'
    + '.ovg.fa-fw{width:1.25em;text-align:center}'
    // The weights and sizes, as ov-glyphs.js (2026-11-28): a server-drawn fa-3x icon painted at 1em until that sheet
    // arrived, then tripled (the home's "No one is streaming" tower grew 18 -> 55 px and moved the page under it), and
    // a fa-solid one painted as lines first. test/glyphs-html.test.js checks these against openvibe-shared's copy.
    + '.ovg.fa-thin{--ovg-stroke:1}.ovg.fa-light{--ovg-stroke:1.5}.ovg.fa-solid{--ovg-solid-below:99999px}'
    + '.ovg.fa-2xs{font-size:.625em}.ovg.fa-xs{font-size:.75em}.ovg.fa-sm{font-size:.875em}.ovg.fa-lg{font-size:1.25em}.ovg.fa-xl{font-size:1.5em}.ovg.fa-2xl{font-size:2em}.ovg.fa-1x{font-size:1em}.ovg.fa-2x{font-size:2em}.ovg.fa-3x{font-size:3em}.ovg.fa-4x{font-size:4em}.ovg.fa-5x{font-size:5em}.ovg.fa-6x{font-size:6em}.ovg.fa-7x{font-size:7em}.ovg.fa-8x{font-size:8em}.ovg.fa-9x{font-size:9em}.ovg.fa-10x{font-size:10em}';

module.exports = { render, STYLE };
