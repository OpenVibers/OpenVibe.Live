/**
 * Home tabs: there are none any more (2026-11-07, the owner's rule: never hide content behind tabs).
 *
 * The explainer at the foot (New here?: the restream tour and the About banner) shows both, one after the other, and
 * the OpenVibe network is its own section with every site. The content blocks are never tabbed again (the owner, 2026-10-31: "now I can't see the videos and clips on the homepage…
 * don't reduce size by removing features"): Around OpenVibe (the digest, the star spotlight, the pulse) shows every
 * section on every screen, and test/home-catchup.test.js holds the rails. Wider screens never see the tabs. The
 * block is real here, not a string: the test opens the rendered home page in a DOM and drives it.
 *
 *   node test/home-tabs.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// linkedom is a declared dependency of openvibe-shared (it parses pages there too); resolve it through
// that package so the test does not depend on npm hoisting it into this repo's node_modules.
function loadLinkedom() {
    try { return require('linkedom'); }
    catch { return require(require.resolve('linkedom', { paths: [path.dirname(require.resolve('openvibe-shared/package.json'))] })); }
}
const { parseHTML } = loadLinkedom();

const assets = require('../server/web/assets');
try { assets.setSharedDir(require('openvibe-shared/files').dir); } catch { /* */ }
const html = assets.renderRoute(assets.document('index.html').html, '/');
// The home page runs to the next page's shell (its phone tabs are <section>s of their own, so not to the first </section>).
const home = html.slice(html.indexOf('<section id="page-home"'), html.indexOf('<section id="page-', html.indexOf('<section id="page-home"') + 10));
const css = fs.readFileSync(path.join(__dirname, '../public/css/features/home.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../public/js/app-home.js'), 'utf8');

let failures = 0;
function check(name, fn) {
    try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => console.log('  \u2713', name), (e) => { failures++; console.log('  \u2717', name, '\n     ', e.message); }); }
    catch (e) { failures++; console.log('  \u2717', name, '\n     ', e.message); return; }
    console.log('  \u2713', name);
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// The loaders hide a section with el.style.display = 'none' and show it with ''. A browser turns that into
// a mutation of the style attribute, which is what the controller watches; linkedom only reports attribute
// writes, so the test writes the same attribute.
const hide = (el) => el.setAttribute('style', 'display:none');
const show = (el) => el.setAttribute('style', '');

// ── the rendered home page in a DOM ────────────────────────────────────────────────────────────────
/**
 * The home page as the browser gets it, with the few globals the script needs, and the app-home.js
 * functions loaded into it. views is how many times the reader has seen the introductions: at 18 the
 * block moves to the end of the page.
 */
function openHome({ views = 0 } = {}) {
    const { window } = parseHTML(`<!doctype html><html><body><section id="page-home">${home}</section></body></html>`);
    const store = new Map();
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: (k) => { store.delete(k); },
            clear: () => store.clear(),
            key: (i) => [...store.keys()][i] ?? null,
            get length() { return store.size; },
        },
    });
    if (views) store.set('ov_home_intro_seen', String(views));
    window.matchMedia = () => ({ matches: true, addEventListener() { }, removeEventListener() { } });
    // Motion off: the page writes its numbers at once (the frame stub below passes no time to count with). Since
    // openvibe-shared 4.183.0 a device that asks for less motion still counts up; only Off does not.
    window.document.documentElement.setAttribute('data-ov-motion', 'off');
    window.requestAnimationFrame = (f) => setTimeout(f, 0);
    window.cancelAnimationFrame = () => { };
    window.scrollTo = () => { };
    window.currentUser = null;
    // The tour feature is loaded through the site's own loader; the test watches what it was asked for.
    const loaded = [];
    window.ov = { load: (name) => { loaded.push(name); return Promise.resolve(); } };
    // Nothing scrolls into view in a test page, so the observers never fire on their own.
    window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() { } unobserve() { } disconnect() { } };
    window.Element.prototype.scrollIntoView = function () { };
    const ctx = vm.createContext(window);
    vm.runInContext(js, ctx, { filename: 'app-home.js' });
    const api = {
        window, ctx, store, loaded,
        el: (id) => window.document.getElementById(id),
        run: (code) => vm.runInContext(code, ctx),
        click: (id) => window.document.getElementById(id).dispatchEvent(new window.Event('click', { bubbles: true })),
    };
    return api;
}

console.log('Home tabs');

const aroundStart = home.indexOf('<div class="home-around" id="home-around"');
const aroundEnd = home.indexOf('</div><!-- /home-around -->');
const around = home.slice(aroundStart, aroundEnd);
const introStart = home.indexOf('<div class="home-intro" id="home-intro"');
const introEnd = home.indexOf('</div><!-- /home-intro -->');
const intro = home.slice(introStart, introEnd);

check('Around OpenVibe shows its three sections, in their order, with the egg where it was, and no tabs', () => {
    assert.ok(aroundStart > 0 && aroundEnd > aroundStart, 'the block opens and closes on the home page');
    const order = ['id="home-digest"', 'id="home-star-section"', 'id="home-daily-quest"', 'id="home-pulse-section"'].map((n) => around.indexOf(n));
    assert.ok(order.every((i) => i > 0), 'every section is inside it');
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'in the same order as before');
    assert.ok(home.indexOf('id="home-around"') < home.indexOf('id="home-catchup"'), 'the block sits where the digest was');
    assert.ok(!around.includes('role="tablist"') && !/data-panel="(lately|star|happening)"/.test(around), 'no tab row and no panels');
    assert.ok(!/\[data-panel="(lately|star|happening)"\]/.test(css), 'no CSS hides one of them');
});

check('New here? has no tab row: the tour and the About banner both show, and no CSS hides one', () => {
    assert.ok(introStart > 0 && introEnd > introStart, 'the block opens and closes on the home page');
    assert.ok(!home.includes('role="tablist"') && !home.includes('role="tab"'), 'no tab row anywhere on the home');
    assert.ok(!/data-panel=/.test(home), 'no panels');
    assert.ok(!/home-tabbox|\[data-panel|\.home-tabs/.test(css), 'no tab CSS left');
    assert.ok(intro.includes('id="home-tour-mount"') && intro.includes('id="home-cta-banner"'), 'both introductions are in the block');
    assert.ok(!/function initHomeTabs|function initHomeIntro/.test(js), 'the tab controller is gone');
});

const net = home.slice(home.indexOf('<div class="ovnet" id="home-network"'), home.indexOf('<!--/ov:network-->'));
check('the OpenVibe network is its own section: every site a real link, by group, for crawlers too', () => {
    assert.ok(home.indexOf('id="home-network"') > introEnd, 'after New here?, outside it');
    assert.match(net, /<h2 id="ovnet-title">One account\. <span class="ovnet-count" data-count="(\d+)">\1<\/span> sites\.<\/h2>/, 'the headline counts the sites in the page');
    const sites = [...net.matchAll(/<a class="ovnet-site" href="([^"]+)" data-site="([a-z0-9-]+)"/g)];
    assert.ok(sites.length >= 40, `every site of the network (${sites.length})`);
    for (const [, href] of sites) {
        const u = new URL(href);
        assert.strictEqual(u.protocol, 'https:', href);
        assert.ok(/(^|\.)(openvibe\.[a-z]+|open\.shoes|openre\.stream)$/.test(u.hostname), `an OpenVibe address: ${href}`);
        assert.ok(!/(^|\.)(openvibe\.(fund|ai|recipes|page)|openvalve\.games|therecipelist\.com)$/i.test(u.hostname), `never a private name: ${href}`);
    }
    const groups = [...net.matchAll(/<div class="ovnet-group" id="ovnet-g-([a-z0-9-]+)" role="group" aria-labelledby="ovnet-gh-\1"/g)].map((m) => m[1]);
    assert.ok(groups.length >= 5, 'grouped by what people come to do');
    for (const g of groups) assert.ok(net.includes(`<a href="#ovnet-g-${g}"`), `a jump link to ${g}`);
    assert.ok(/<span class="ov-icon" data-icon="[a-z0-9-]+" data-size="40" aria-hidden="true"><\/span>/.test(net), 'ring icons are drawn later, not inlined');
    assert.ok(net.includes('data-ovnet-switcher') && net.includes('data-ovnet-signin'), 'the switcher button and the sign-up');
    assert.ok(/data-ovnet-switcher><span class="ovnet-orb" aria-hidden="true"><svg class="ovmb"[^>]*><rect class="ovmb-bar"/.test(net) && net.includes('<b>Every site is in the menu</b>') && !/one tap away in the/.test(net), 'the line about the menu carries the menu button as the bar draws it now, and says where it is');
});

check('on a phone the rest of the home is three parts as tabs (For you, Catch up, OpenVibe), every one in the HTML', () => {
    // The owner, 2026-11-11: "consolidate these into tabs, self-contained tabs, so the page isn't so freaking huge … at
    // least on mobile". openvibe-shared ov-parts.css draws it (radios and :has(), no script); wide screens stack them.
    const start = home.indexOf('<div class="ov-parts ov-parts--front home-parts" data-parts="3">');
    assert.ok(start > home.indexOf('id="stream-grid-live"'), 'below Live Now');
    const parts = [...home.slice(start).matchAll(/<section class="ov-part" data-part="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(parts, ['foryou', 'catchup', 'openvibe']);
    for (const [id, label] of [['foryou', 'For you'], ['catchup', 'Catch up'], ['openvibe', 'OpenVibe']]) {
        assert.ok(home.includes(`<input type="radio" class="ov-parts-r" name="ovp-home" id="ovp-home-${id}" value="${id}"`), `${id}: its radio`);
        assert.ok(home.includes(`<label for="ovp-home-${id}">${label}</label>`), `${id}: its tab`);
    }
    const at = (needle) => home.indexOf(needle);
    const sec = (id) => at(`data-part="${id}"`);
    assert.ok(sec('foryou') < at('id="home-around"') && at('id="home-around"') < sec('catchup'), 'For you holds Around OpenVibe');
    assert.ok(sec('catchup') < at('id="home-catchup"') && at('id="home-catchup"') < sec('openvibe'), 'Catch up holds the rails');
    assert.ok(sec('openvibe') < at('id="home-intro"') && at('id="home-intro"') < at('id="home-network"'), 'OpenVibe holds New here? and the network');
    const features = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/features.json'), 'utf8'));
    assert.ok(JSON.stringify(features).includes('/shared/ov-parts.css'), 'the home links the tabs\' stylesheet (blocking, so nothing jumps)');
    assert.ok(/function openHomePartFor\(hash\)/.test(js) && /closest\('\.ov-part'\)/.test(js), 'a link into a closed tab opens it; a returning reader\'s New here? stays inside its tab');
});

check('the network section is built by its script, between its markers, and nothing in it is a tab', () => {
    const frag = fs.readFileSync(path.join(__dirname, '../public/fragments/home.html'), 'utf8');
    assert.strictEqual(frag.split('<!--ov:network-->').length, 2, 'one start marker');
    assert.strictEqual(frag.split('<!--/ov:network-->').length, 2, 'one end marker');
    const build = require('../scripts/build-network-section');
    const out = build.render({ groups: [{ id: 'streams', name: 'Streams & places' }], nav: [
        { id: 'live', name: 'Live', url: 'https://openvibe.live/', icon: 'live', tagline: 'Go live <b>now</b>', group: 'streams' },
        { id: 'x', name: 'Bad', url: 'https://openvibe.fund/', group: 'streams' },
        { id: 'y', name: 'Plain', url: 'http://openvibe.food/', group: 'streams' },
        { id: 'z', name: 'Elsewhere', url: 'https://example.com/', group: 'streams' },
        { id: 'w', name: 'Wanderer', url: 'https://openvibe.wiki/', group: 'nowhere' },
    ] });
    assert.ok(out.includes('href="https://openvibe.live/"') && out.includes('Go live &lt;b&gt;now&lt;/b&gt;'), 'escaped');
    assert.ok(!/openvibe\.fund|http:\/\/openvibe\.food|example\.com/.test(out), 'only https OpenVibe addresses, never a private name');
    assert.ok(out.includes('id="ovnet-g-more"') && out.includes('openvibe.wiki'), 'a site in no known group goes to More');
    assert.ok(!/role="tab/.test(out));
});

check('the tour still loads when its mount nears the viewport', () => {
    assert.match(js, /function _lazyHomeTour\(force\)/, 'the loader');
});

(async () => {
    await check('initHomeNetwork adds a site that opened since the page was built, and only an OpenVibe one', async () => {
        const p = openHome();
        const before = p.window.document.querySelectorAll('.ovnet-site').length;
        p.window.OpenVibeFrame = { get: () => ({ groups: [], nav: [
            { id: 'brandnew', name: 'Brand New', url: 'https://openvibe.brandnew/', icon: 'ov', tagline: 'Just opened', group: 'games' },
            { id: 'evil', name: 'Evil', url: 'https://evil.example/', group: 'games' },
            { id: 'secret', name: 'Secret', url: 'https://openvibe.recipes/', group: 'games' },
            { id: 'live', name: 'Live', url: 'https://openvibe.live/', group: 'streams' },
        ] }) };
        p.run('initHomeNetwork();');
        await tick();
        const sites = [...p.window.document.querySelectorAll('.ovnet-site')];
        assert.strictEqual(sites.length, before + 1, 'one new site, the rest refused or already there');
        const added = sites.find((a) => a.dataset.site === 'brandnew');
        assert.ok(added && added.closest('.ovnet-group').dataset.group === 'games', 'in its group');
        assert.strictEqual(added.querySelector('b').textContent, 'Brand New');
        assert.strictEqual(p.window.document.querySelector('.ovnet-count').textContent, String(before + 1), 'the count follows');
    });

    await check('the sign-up is only for a reader who is not signed in', async () => {
        const p = openHome();
        p.window.currentUser = { id: 1, username: 'a' };
        p.run('initHomeNetwork();');
        await tick();
        assert.strictEqual(p.window.document.querySelector('[data-ovnet-signin]').hidden, true);
    });

    await check('a first visit leaves the block where it is', async () => {
        const p = openHome();
        p.run('initHomeNetwork(); demoteHomeIntroSections();');
        await tick();
        const block = p.el('home-intro');
        assert.strictEqual(block.dataset.ovDemoted, undefined, 'it was not demoted');
        const kids = [...block.parentElement.children];
        assert.ok(kids.indexOf(p.el('home-catchup')) < kids.indexOf(block), 'it still comes after Catch up');
        assert.notStrictEqual(block.parentElement, p.el('home-changelog-wrapper').parentElement, 'and before the changelog');
    });

    await check('after enough visits the whole block moves to the end of its OpenVibe tab, and still works there', async () => {
        const p = openHome({ views: 18 });
        p.run('initHomeNetwork(); demoteHomeIntroSections();');
        await tick();
        const block = p.el('home-intro');
        assert.strictEqual(block.dataset.ovDemoted, '1', 'it was demoted');
        assert.ok(block.classList.contains('home-intro-demoted'), 'and marked as such');
        const part = block.parentElement;
        assert.strictEqual(part && part.getAttribute('data-part'), 'openvibe', 'it stays inside its phone tab, never out of it');
        assert.strictEqual(part.lastElementChild, block, 'at the end of it, after the network');
        assert.ok(part.contains(p.el('home-network')), 'the network stays in the same tab');
        for (const id of ['home-tour-mount', 'home-cta-banner']) {
            assert.ok(block.contains(p.el(id)), `${id} travelled with it`);
        }
        assert.ok(!block.contains(p.el('home-network')), 'the network section stays where it is');
    });

    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})();
