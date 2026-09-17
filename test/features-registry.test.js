/**
 * public/features.json is the contract between the server (first paint) and js/ov-loader.js
 * (navigation). A typo there is a blank page on one route, so it is checked here:
 *   - every script, stylesheet and fragment it names exists;
 *   - every stub is a function one of the feature's scripts actually defines;
 *   - every fragment has an empty shell section in index.html, and no section is both inline and a fragment;
 *   - dependencies exist and do not cycle;
 *   - no feature script is also loaded eagerly by index.html;
 *   - the server renders each route with its feature assets and inlines its fragment.
 *
 *   node test/features-registry.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const reg = JSON.parse(fs.readFileSync(path.join(PUB, 'features.json'), 'utf8'));
const index = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
let pass = 0;
const ok = (m) => { pass++; console.log('  ok -', m); };
const fileFor = (url) => url.startsWith('/shared/') ? path.join(ROOT, 'vendor/openvibe-shared', path.basename(url)) : path.join(PUB, url);

for (const [name, f] of Object.entries(reg.features)) {
    for (const url of [...(f.js || []), ...(f.css || [])]) assert.ok(fs.existsSync(fileFor(url)), `${name}: ${url} does not exist`);
    if (f.fragment) {
        assert.ok(fs.existsSync(path.join(PUB, 'fragments', `${f.fragment}.html`)), `${name}: fragment ${f.fragment} missing`);
        const section = f.section || `page-${f.fragment}`;
        const m = index.match(new RegExp(`<section id="${section}"[^>]*data-fragment="${f.fragment}"[^>]*>([\\s\\S]*?)</section>`));
        assert.ok(m, `${name}: index.html needs an empty <section id="${section}" data-fragment="${f.fragment}"> shell`);
        assert.ok(m[1].includes(`<!--ov:fragment:${f.fragment}-->`), `${name}: shell must carry the fragment marker for server inlining`);
    }
    for (const d of f.deps || []) assert.ok(reg.features[d], `${name}: unknown dependency ${d}`);
    for (const i of f.idle || []) assert.ok(reg.features[i], `${name}: unknown idle feature ${i}`);
    if (f.stubs || f.after) {
        // Look through the feature's own scripts and its dependencies' scripts.
        const scripts = [];
        const collect = (n, seen = new Set()) => { if (seen.has(n)) return; seen.add(n); const x = reg.features[n]; (x.js || []).forEach((j) => scripts.push(fs.readFileSync(fileFor(j), 'utf8'))); (x.deps || []).forEach((d) => collect(d, seen)); };
        collect(name);
        const src = scripts.join('\n');
        for (const fn of [...(f.stubs || []), ...(f.after ? [f.after] : [])]) {
            const defined = new RegExp(`function\\s+${fn}\\s*\\(|window\\.${fn}\\s*=|\\b${fn}\\s*=\\s*(async\\s+)?(function|\\()`).test(src);
            assert.ok(defined, `${name}: stub/after ${fn} is not defined by the feature's scripts`);
        }
    }
}
ok(`${Object.keys(reg.features).length} features: files, fragments, shells, deps and stubs resolve`);

// No dependency cycles.
const visiting = new Set(), done = new Set();
const visit = (n, trail) => {
    if (done.has(n)) return;
    assert.ok(!visiting.has(n), `dependency cycle: ${[...trail, n].join(' → ')}`);
    visiting.add(n);
    for (const d of reg.features[n].deps || []) visit(d, [...trail, n]);
    visiting.delete(n); done.add(n);
};
Object.keys(reg.features).forEach((n) => visit(n, []));
ok('no dependency cycles');

// A feature script must not also be an eager tag (it would run twice).
const eager = [...index.matchAll(/<script src="([^"?]+)/g)].map((m) => m[1]);
for (const f of Object.values(reg.features)) for (const j of f.js || []) assert.ok(!eager.includes(j), `${j} is both eager in index.html and in a feature`);
ok('no feature script is also loaded eagerly');

for (const r of reg.routes) {
    assert.doesNotThrow(() => new RegExp(r.path), `bad route pattern ${r.path}`);
    for (const f of r.features) assert.ok(reg.features[f], `route ${r.path}: unknown feature ${f}`);
}
ok(`${reg.routes.length} routes reference known features`);

// Server rendering.
const assets = require('../server/web/assets');
const doc = assets.document('index.html').html;
const cases = [['/', ['/js/app-home.js', '/css/features/home.css'], null], ['/broadcast', ['/js/broadcast.js', '/css/features/broadcast.css'], 'broadcast'], ['/@someone', ['/js/app-channel.js', '/js/stream-player.js'], 'channel'], ['/vod/12', ['/js/app-media.js'], 'vod-player'], ['/documentation', ['/js/app-docs.js'], 'documentation']];
for (const [url, expectAssets, frag] of cases) {
    const html = assets.renderRoute(doc, url);
    for (const a of expectAssets) assert.ok(html.includes(a.endsWith('.css') ? `<link rel="stylesheet" href="${a}?v=` : `<script src="${a}?v=`), `${url} should include ${a}`);
    if (frag) {
        assert.ok(html.includes(`data-fragment="${frag}" data-fragment-loaded="1"`), `${url} should inline the ${frag} fragment`);
        assert.ok(!html.includes(`<!--ov:fragment:${frag}-->`), `${url}: fragment marker should be replaced`);
    }
    assert.ok(!html.includes('<!--ov:route-js-->') && !html.includes('<!--ov:route-css-->'), `${url}: placeholders left behind`);
}
const home = assets.renderRoute(doc, '/');
for (const notOnHome of ['/js/broadcast.js', '/js/stream-player.js', '/js/call.js', '/js/dashboard.js', '/css/features/broadcast.css']) {
    // The inline registry names every asset, so check tags, not substrings.
    const tag = notOnHome.endsWith('.css') ? `<link rel="stylesheet" href="${notOnHome}` : `<script src="${notOnHome}`;
    assert.ok(!home.includes(tag), `home page must not ship ${notOnHome}`);
}
ok('server renders each route with its own assets and fragment, and the home page without the others');

console.log(`${pass} checks passed`);
