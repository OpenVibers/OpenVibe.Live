'use strict';
// The home's sideways rails load by themselves (the owner, 2026-11-01: "load more is really dumb because it's like
// horizontal, so you can't even see it load in … make it automatic, lazy load"). On a phone Catch up's grids scroll
// sideways (features/home.css); there a rail has no "Load more" button: two placeholder cards sit at its end, and when
// the reader swipes to within about a card of them the next batch loads in their place. When none are left, the rail
// ends with a "View all" card. A grid that wraps (a wide screen) keeps its button.
//   node test/home-rail-autoload.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'home.css'), 'utf8');

/** One top-level function's source, by name (app-home.js is a browser script with no exports). */
function fn(name) {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} is in app-home.js`);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}
const batch = /const HOME_RAIL_BATCH = (\d+);/.exec(src);
assert.ok(batch, 'the batch size is named');

function page(overflowX) {
    const { window, document } = parseHTML(`<!doctype html><html><body>
<div class="section-header" id="vods-header"><h2>Recent VODs</h2><a href="/content?type=vods" class="section-action">View all</a></div>
<div class="stream-grid" id="grid"><a class="stream-card">1</a><a class="stream-card">2</a><a class="stream-card">3</a><a class="stream-card">4</a></div>
<div id="pager" style="display:none"></div></body></html>`);
    const observed = [];
    class IO {
        constructor(cb, opts) { this.cb = cb; this.opts = opts; observed.push(this); }
        observe(el) { this.el = el; }
        disconnect() { this.off = true; }
        fire() { this.cb([{ isIntersecting: true, target: this.el }]); }
    }
    const calls = [];
    const ctx = {
        window, document, IntersectionObserver: IO, Promise, Math, Number, String,
        getComputedStyle: () => ({ overflowX }),
        handleLinkClick: () => false,
        _homeRailCols: () => 1,
        _narrow: true,
    };
    ctx.window.loadHomeRecentVods = (o) => { calls.push(o); return Promise.resolve(); };
    vm.createContext(ctx);
    vm.runInContext(`const HOME_RAIL_BATCH = ${batch[1]};\n${fn('homeRailSideways')}\n${fn('homeRailTail')}\n${fn('renderHomePagination')}\nthis.renderHomePagination = renderHomePagination;`, ctx);
    const rail = { grid: document.getElementById('grid'), loader: 'loadHomeRecentVods', shown: 4, total: 852 };
    return { ctx, document, rail, observed, calls };
}

(async () => {
    // A sideways rail: no button, two placeholders, and the next batch when the reader nears them.
    {
        const { ctx, document, rail, observed, calls } = page('auto');
        ctx.renderHomePagination('pager', rail);
        const pager = document.getElementById('pager');
        assert.strictEqual(pager.style.display, 'none', 'a sideways rail has no Load more button');
        assert.strictEqual(pager.innerHTML, '');
        const skel = document.querySelectorAll('#grid > .home-rail-skel');
        assert.strictEqual(skel.length, 2, 'two placeholder cards at the end');
        assert.strictEqual(skel[0].getAttribute('aria-hidden'), 'true', 'placeholders are not read out');
        assert.strictEqual(document.querySelector('#grid').lastElementChild.className, 'home-rail-tail home-rail-skel', 'they come after the cards');
        const io = observed[observed.length - 1];
        assert.strictEqual(io.opts.root, rail.grid, 'watched against the rail itself, not the page');
        assert.match(io.opts.rootMargin, /^0px \d+% 0px 0px$/, 'a little ahead of the reader');
        assert.strictEqual(io.el, skel[0]);
        io.fire();
        io.fire();   // a second sighting while the first batch loads asks for nothing more
        assert.deepStrictEqual(calls.map((c) => c.more), [Number(batch[1])], 'one batch at a time');
        await Promise.resolve(); await Promise.resolve();
        // The loader appended its cards and rendered the pager again: the old tail goes, a new one follows the new cards.
        rail.shown = 10;
        ctx.renderHomePagination('pager', rail);
        assert.strictEqual(document.querySelectorAll('#grid > .home-rail-tail').length, 2, 'one tail, never two');
        assert.ok(observed[observed.length - 2].off, 'the old watcher stops');
        // The last few: a batch never asks for more than are left.
        rail.shown = 850;
        ctx.renderHomePagination('pager', rail);
        observed[observed.length - 1].fire();
        assert.strictEqual(calls[calls.length - 1].more, 2);
        assert.strictEqual(document.querySelectorAll('#grid > .home-rail-skel').length, 2);
        // All in: no placeholders, and the rail ends with "View all" to the section's own page.
        rail.shown = 852;
        ctx.renderHomePagination('pager', rail);
        assert.strictEqual(document.querySelectorAll('#grid > .home-rail-skel').length, 0);
        const end = document.querySelector('#grid > .home-rail-end');
        assert.ok(end && end.getAttribute('href') === '/content?type=vods' && /View all/.test(end.textContent), 'the end card is View all');
    }
    // A grid that wraps (a wide screen) keeps its button and gets no tail.
    {
        const { ctx, document, rail } = page('visible');
        ctx.renderHomePagination('pager', rail);
        assert.strictEqual(document.getElementById('pager').style.display, 'block');
        assert.match(document.getElementById('pager').innerHTML, /class="home-load-more"/);
        assert.strictEqual(document.querySelectorAll('#grid > .home-rail-tail').length, 0);
    }
    // The styles: the tail shows only in a sideways rail, the placeholders keep still for reduced motion, and the density
    // control's column clamp never squeezes a rail's cards.
    assert.match(css, /\.home-rail-tail \{ display: none; \}/);
    assert.match(css, /#home-catchup \.stream-grid > \.home-rail-tail \{ display: flex; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.home-rail-skel \{ animation: none; \} \}/);
    assert.match(css, /#home-catchup \.stream-grid\[data-ovd-cols\] \{ grid-template-columns: none !important; \}/);
    console.log('home rail autoload: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
