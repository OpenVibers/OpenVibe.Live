'use strict';
// The first-paint subset of style.css (server/web/critical-css.js) and the shell swap (server/web/assets.js): a public
// route's first paint blocks only on the subset, the full style.css follows without blocking in the same place (so the
// final cascade is unchanged), every other route keeps style.css blocking, and the subset is a fraction of the file.
const assert = require('assert');
const fs = require('fs');
const critical = require('../server/web/critical-css');
const assets = require('../server/web/assets');

let pass = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };

// ── The parser and the extraction ──
{
    const css = `/* a comment { with braces } */
:root { --x: 1; }
html { color: red; }
.keep, .other:is(.a, .b) { color: blue; animation: spin 1s linear; }
.drop { color: green; animation: fade 1s; }
@media (max-width: 600px) { .keep { padding: 1px; } .drop { padding: 2px; } }
@media print { .drop { display: none; } }
@supports (display: grid) { .keep { display: grid; } }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(1turn); } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
.str::after { content: "}{"; }`;
    assert.deepStrictEqual(critical.splitSelectors('.keep, .other:is(.a, .b), [x=","] y'), ['.keep', '.other:is(.a, .b)', '[x=","] y']);
    const nodes = critical.parse(css);
    assert.strictEqual(nodes.filter((n) => n.type === 'rule').length, 5, 'top-level rules, a string with braces included');
    const out = critical.extract(css, ['.keep', '.str::after']);
    assert.ok(out.includes(':root { --x: 1; }') && out.includes('html { color: red; }'), 'document-level rules always');
    assert.ok(out.includes('.keep, .other:is(.a, .b) { color: blue;'), 'a rule naming a wanted selector, whole');
    assert.ok(!out.includes('.drop'), 'nothing else');
    assert.match(out, /@media \(max-width: 600px\) \{\n\.keep \{ padding: 1px; \}\n\}/, 'inside its @media, only the kept rule');
    assert.ok(!out.includes('@media print'), 'an @media left empty is dropped');
    assert.ok(out.includes('@supports (display: grid)'), '@supports kept with its rule');
    assert.ok(out.includes('@keyframes spin') && !out.includes('@keyframes fade'), 'only the keyframes kept rules animate with');
    assert.ok(out.includes('content: "}{"'), 'strings survive');
    ok('extract keeps wanted and document-level rules in their @media/@supports, and only their keyframes');
}

// ── The real style.css ──
const core = critical.core();
assert.ok(core && core.css.length > 1000, 'a subset is built from the committed selector list');
assert.ok(core.bytes < core.from * 0.3, `the subset is a fraction of style.css (${core.bytes} of ${core.from})`);
assert.match(core.hash, /^[0-9a-f]{12}$/);
assert.ok(core.css.includes(':root'), 'the theme variables are in it');
{
    const listed = JSON.parse(fs.readFileSync(critical.SELECTORS, 'utf8')).selectors;
    const inFile = new Set();
    const walk = (list) => { for (const n of list) { if (n.type === 'rule') critical.splitSelectors(n.selector).forEach((s) => inFile.add(s)); else if (n.type === 'block') walk(n.children); } };
    walk(critical.parse(fs.readFileSync(critical.STYLE, 'utf8')));
    const stale = listed.filter((s) => !inFile.has(s));
    // A renamed or removed rule leaves its selector behind: harmless, but a list this stale should be regenerated.
    assert.ok(stale.length <= listed.length * 0.1, `critical-selectors.json is stale (${stale.length} of ${listed.length} no longer in style.css): run node scripts/perf/critical-css.js`);
}
ok(`the subset of the real style.css is ${(100 * core.bytes / core.from).toFixed(0)}% of it, from a current selector list`);

// ── The shell ──
const doc = assets.document('index.html').html;
const blockingLinks = (html) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"(?![^>]*media="print")[^>]*>/g)].map((m) => m[1]).filter((h) => !/noscript/.test(h));
for (const url of ['/', '/content', '/vods', '/clips', '/chat', '/search?q=x', '/@someone', '/vod/12', '/clip/7', '/arena']) {
    const html = assets.renderRoute(doc, url);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.includes(`<link rel="stylesheet" href="/css/style.core.css?v=${core.hash}" data-ov-first-paint>`), `${url}: the subset blocks the first paint`);
    const full = /<link rel="stylesheet" href="(\/css\/style\.css\?v=[^"]+)" media="print" onload="this\.media='all';this\.onload=null">/.exec(head);
    assert.ok(full, `${url}: the full style.css follows without blocking`);
    assert.ok(head.indexOf('style.core.css') < head.indexOf(full[1]) && head.indexOf(full[1]) < head.indexOf('<meta name="ov-css-anchor">'), `${url}: in style.css's place in the cascade, before the feature stylesheets`);
    assert.ok(head.includes(`<noscript><link rel="stylesheet" href="${full[1]}"></noscript>`), `${url}: a no-JS copy`);
    assert.ok(!blockingLinks(head.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')).some((h) => h.startsWith('/css/style.css')), `${url}: style.css itself no longer blocks`);
}
for (const url of ['/dashboard', '/broadcast', '/settings', '/admin', '/documentation', '/vod/12/edit', '/@someone/videos']) {
    const html = assets.renderRoute(doc, url);
    assert.ok(!html.includes('style.core.css'), `${url}: no subset`);
    assert.match(html, /<link rel="stylesheet" href="\/css\/style\.css\?v=[^"]+">/, `${url}: style.css blocks as before`);
}
ok('public routes block on the subset and load style.css after it in the same place; every other route is unchanged');

assert.strictEqual(assets.hashOf(assets.CORE_CSS), core.hash, 'the subset is versioned by its content');
ok('the subset is versioned by its content');

console.log(`critical-css: ${pass} checks passed`);
