'use strict';
// The home's Live Now grid is the size it will be from the first paint (2026-11-28: tablets' field CLS p75 was 0.345;
// the four placeholder cards, two rows on a tablet, gave way to the 209 px "No one is streaming" panel about a second
// in and moved everything under them up by 340 px). The server renders as many placeholders as streams are live (at
// most four) or the panel itself, app-home.js adds none of its own over a sized grid, and the panel's go-live pill has
// its size in the home's first-paint stylesheet (home-tour.css, which styles it, loads without blocking).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pages = require('../server/seo/pages');
const critical = require('../server/web/critical-css');

const meta = (liveNow) => ({ title: 'OpenVibe.Live', description: 'Go live from your browser.', canonicalPath: '/', robots: 'index,follow', ogType: 'website', jsonLd: [], liveNow });
const grid = (html) => {
    const open = html.indexOf('id="stream-grid-live"');
    assert.ok(open !== -1, 'the home carries the live grid');
    const end = html.indexOf('id="no-live-streams"', open);
    const tag = html.slice(html.lastIndexOf('<div', open), html.indexOf('>', open) + 1);
    const panel = html.slice(html.lastIndexOf('<div', end), html.indexOf('>', end) + 1);
    return { tag, cards: (html.slice(open, end).match(/ovsk-card/g) || []).length, panel };
};

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); } };

check('no one live: no placeholders, the "No one is streaming" panel shows from the first paint', () => {
    const g = grid(pages.render(meta(0), '/'));
    assert.strictEqual(g.cards, 0);
    assert.ok(g.tag.includes('data-live-now="0"'), g.tag);
    assert.ok(!g.panel.includes('display:none'), g.panel);
});

check('two live: two placeholders and the panel hidden; nine live: four placeholders at most', () => {
    const two = grid(pages.render(meta(2), '/'));
    assert.strictEqual(two.cards, 2);
    assert.ok(two.tag.includes('data-live-now="2"'));
    assert.ok(two.panel.includes('display:none'));
    assert.strictEqual(grid(pages.render(meta(9), '/')).cards, 4);
});

check('a page whose meta says nothing about live streams keeps the fragment as it is', () => {
    const html = pages.render({ ...meta(0), liveNow: undefined }, '/');
    const g = grid(html);
    assert.strictEqual(g.cards, 4);
    assert.ok(!g.tag.includes('data-live-now'));
});

check('app-home.js adds no placeholders over a grid the server sized', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
    const at = src.indexOf("OVSkeleton.cards('stream-grid-live')");
    assert.ok(at !== -1);
    assert.match(src.slice(at - 200, at), /hasAttribute\('data-live-now'\)/);
});

check('the go-live pill\'s size is in the home\'s first-paint stylesheet, the phone size too', () => {
    const sub = critical.subset('/css/features/home.core.css');
    assert.ok(sub && sub.css, 'the home has a first-paint subset');
    assert.match(sub.css, /\.empty-state \.ovg-firstlive \{[^}]*padding: 9px 16px 9px 10px/);
    assert.match(sub.css, /\.empty-state \.ovg-firstlive > i:first-of-type \{[^}]*width: 32px/);
    assert.match(sub.css, /@media \(max-width: 420px\) \{[^@]*\.empty-state \.ovg-firstlive \{[^}]*padding: 8px 13px 8px 8px/);
});

check('a re-run of the selector generator keeps the pill whoever is live during it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'perf', 'critical-home-css.js'), 'utf8');
    assert.match(src, /SERVER_DRAWN = \{ 'features\/home\.css': \[[^\]]*'\.empty-state \.ovg-firstlive'/);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
