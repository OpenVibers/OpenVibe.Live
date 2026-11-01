'use strict';
// No Font Awesome (plan L54 K4; the owner, 2026-11-01: "get rid of Font Awesome completely and just use our own
// openvibe.design system"). Live's icons are the OpenVibe glyphs (openvibe-shared/glyphs, drawn on the server by
// server/web/glyphs-html.js and in the browser by /shared/ov-glyphs.js) and brand logos from openvibe-shared/brands.
// This holds it there:
//   - no page links Font Awesome's stylesheet, and every page without the navbar loads the glyph drop-in;
//   - no stylesheet draws with Font Awesome's font;
//   - every fa- name Live uses is one the glyphs or the brands draw (a name nobody draws would show nothing).
//   node test/no-font-awesome.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const glyphs = require('openvibe-shared/glyphs');
const brands = require('openvibe-shared/brands');

const ROOT = path.join(__dirname, '..');
const walk = (dir, ok, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'vendor' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, ok, out); else if (ok.test(e.name)) out.push(p);
    }
    return out;
};
const rel = (p) => path.relative(ROOT, p);

const pages = walk(path.join(ROOT, 'public'), /\.html$/);
for (const p of pages) {
    const html = fs.readFileSync(p, 'utf8');
    assert.ok(!/fontawesome|font-awesome/i.test(html), `${rel(p)} links Font Awesome`);
    // A whole page (with a <head>; fragments are parts of index.html) that names an icon loads what draws it.
    if (/<head[\s>]/i.test(html) && /\bfa-[a-z]/.test(html) && !/\/shared\/navbar|ov-glyphs\.js/.test(html)) assert.fail(`${rel(p)} has fa- icons but loads neither the navbar nor /shared/ov-glyphs.js`);
}

for (const p of walk(path.join(ROOT, 'public'), /\.css$/)) {
    const css = fs.readFileSync(p, 'utf8');
    assert.ok(!/font-family:\s*["']?Font ?Awesome/i.test(css), `${rel(p)} draws with Font Awesome's font`);
}
for (const p of walk(path.join(ROOT, 'public'), /\.js$/)) {
    assert.ok(!/['"]\d+px FontAwesome|Font Awesome 6 Free/.test(fs.readFileSync(p, 'utf8')), `${rel(p)} draws with Font Awesome's font`);
}

// Every fa- name in Live's pages, scripts and server views is drawn by a glyph or a brand.
const MOD = /^(solid|regular|light|thin|duotone|brands|sharp|classic|fw|lg|xl|xs|sm|2xs|2xl|\d+x|li|ul|border|inverse|pull-left|pull-right|rotate-\d+|rotate-by|flip-horizontal|flip-vertical|flip-both|width-auto|spin|spin-pulse|spin-reverse|pulse|beat|beat-fade|bounce|fade|flip|shake|stack|stack-1x|stack-2x|layers|layers-text|layers-counter|swap-opacity|stack-text)$/;
// Names that only look like icons: built from parts at run time (fa-chevron-${dir} is fa-chevron-left/right).
const PARTS = new Set(['chevron']);
const files = [...walk(path.join(ROOT, 'public'), /\.(html|js)$/), ...walk(path.join(ROOT, 'server'), /\.js$/)];
const missing = new Map();
for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bfa-([a-z0-9]+(?:-[a-z0-9]+)*)\b/g)) {
        const n = m[1];
        if (MOD.test(n) || PARTS.has(n) || glyphs.fromFa(n) || brands.fromFa(n)) continue;
        if (!missing.has(n)) missing.set(n, rel(f));
    }
}
assert.deepStrictEqual([...missing].map(([n, f]) => `fa-${n} (${f})`), [], 'every icon Live names is drawn by the OpenVibe glyphs or brands');

console.log(`no font awesome: ${pages.length} pages, ${files.length} files, every fa- name drawn`);
