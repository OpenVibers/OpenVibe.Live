'use strict';
// Icons drawn on the server (plan L49 step 2, L54 K4: Font Awesome out of Live). Live's own HTML arrives with the
// OpenVibe glyphs already drawn, exactly as ov-glyphs.js draws them, so the first paint has the network's icons; what
// the browser must handle (brands, moving icons, unknown names, icons with content) is left to it.
const assert = require('assert');
const glyphs = require('openvibe-shared/glyphs');
const { render, STYLE } = require('../server/web/glyphs-html');

const one = (html) => render(html);

// A known name becomes its glyph, line and (where it has one) solid, keeping its classes and safe attributes.
const live = one('<i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i>');
assert.ok(live.startsWith('<i class="fa-solid fa-tower-broadcast ovg" data-ovg="live" data-ovg-fa="fa-tower-broadcast" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"'), live);
assert.ok(live.includes(glyphs.path('live')), 'the line drawing');
if (glyphs.solid('live')) assert.ok(live.includes('class="has-s"') && live.includes('<g class="ovg-s">'), 'and the solid one');
assert.ok(live.endsWith('</svg></i>'));

// An icon without aria-hidden gets it (it is decoration beside its label).
assert.match(one('<i class="fa-solid fa-house"></i>'), /data-ovg-fa="fa-house" aria-hidden="true">/);

// Left to the browser: brands, moving icons, unknown names, two names, icons already drawn, icons with content.
for (const keep of [
    '<i class="fa-brands fa-discord"></i>',
    '<i class="fa-solid fa-spinner fa-spin"></i>',
    '<i class="fa-solid fa-not-a-glyph-name"></i>',
    '<i class="fa-solid fa-house fa-video"></i>',
    '<i class="fa-solid fa-house ovg" data-ovg="home"></i>',
    '<i class="fa-solid fa-house">x</i>',
    '<i class="fa-solid fa-house" title="Home"></i>',
]) assert.strictEqual(one(keep), keep, keep);

// Idempotent: drawing twice changes nothing.
const page = '<p><i class="fa-solid fa-scissors"></i> Clips</p><p><i class="fa-solid fa-video"></i> VODs</p>';
assert.strictEqual(render(render(page)), render(page));
assert.strictEqual((render(page).match(/ ovg" data-ovg=/g) || []).length, 2);

// Text with no icon is returned as it is.
assert.strictEqual(render('<p>no icons</p>'), '<p>no icons</p>');

// The first-paint rules: the size, the optical switch, and the person's icon style (openvibe-shared 4.71.0).
assert.ok(STYLE.includes('.ovg::before,.ovg::after{content:none!important'), 'Font Awesome\'s glyph never shows');
assert.ok(STYLE.includes('html[data-ov-icons=solid]{--ovg-pref:99999px}html[data-ov-icons=line]{--ovg-pref:0px}'), 'the person\'s preference');
assert.ok(STYLE.includes('var(--ovg-pref, var(--ovg-solid-below, 18.4px))'), 'wins over the switch point');

// assets.rewriteHtml draws them and adds the rules once.
const assets = require('../server/web/assets');
if (typeof assets.rewriteHtml === 'function') {
    const out = assets.rewriteHtml('<html><head><title>t</title></head><body><i class="fa-solid fa-house"></i></body></html>');
    assert.ok(out.includes(' ovg" data-ovg="home"'), 'the page\'s icons are drawn');
    assert.strictEqual((out.match(/id="ov-glyphs-first"/g) || []).length, 1, 'the first-paint rules, once');
}

console.log('glyphs-html: known names drawn on the server (line and solid), the rest left to the browser, idempotent, first-paint rules');
