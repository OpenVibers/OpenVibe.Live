/**
 * Home tabs (2026-10-30, the owner's short-pages rule: a phone page is one or two screens).
 *
 * Part 1 shipped Catch up: the five rails after Live Now share one place, a row of tabs and one rail at a time.
 * This is the other two blocks, built on the same controller (initHomeTabs in public/js/app-home.js):
 *
 *   Around OpenVibe  the digest (Lately), the star spotlight (Star) and the pulse (Happening)
 *   New here?        the restream tour (How it works), the About banner (About), the network hub (The network)
 *
 * Wider screens never see the tabs and show every section. Nothing was removed: every section is still in the
 * page. The block is real here, not a string: the test opens the rendered home page in a DOM and drives it.
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
const home = html.slice(html.indexOf('<section id="page-home"'), html.indexOf('</section>', html.indexOf('<section id="page-home"')));
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

const AROUND = ['lately', 'star', 'happening'];
const INTRO = ['tour', 'about', 'network'];
const aroundStart = home.indexOf('<div class="home-tabbox" id="home-around"');
const aroundEnd = home.indexOf('</div><!-- /home-around -->');
const around = home.slice(aroundStart, aroundEnd);
const introStart = home.indexOf('<div class="home-tabbox home-intro" id="home-intro"');
const introEnd = home.indexOf('</div><!-- /home-intro -->');
const intro = home.slice(introStart, introEnd);

check('the three sections of Around OpenVibe share one block, in their order, with the egg where it was', () => {
    assert.ok(aroundStart > 0 && aroundEnd > aroundStart, 'the block opens and closes on the home page');
    const order = ['id="home-digest"', 'id="home-star-section"', 'id="hero-egg"', 'id="home-pulse-section"'].map((n) => around.indexOf(n));
    assert.ok(order.every((i) => i > 0), 'every section is inside it');
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'in the same order as before');
    assert.ok(home.indexOf('id="home-around"') < home.indexOf('id="home-catchup"'), 'the block sits where the digest was');
});

check('one tab per section, named for screen readers, pointing at its section', () => {
    assert.match(around, /<div class="home-tabs" role="tablist" aria-label="Around OpenVibe">/);
    assert.ok(intro.includes('<div class="home-tabs" role="tablist" aria-label="New here?">'), 'the New here? tab list');
    for (const [key, block, box] of [['lately', around, 'home-digest'], ['star', around, 'home-star-section'], ['happening', around, 'home-pulse-section'],
        ['tour', intro, 'home-tour-mount'], ['about', intro, 'home-cta-banner'], ['network', intro, 'home-network-hub']]) {
        const tab = (new RegExp(`<button type="button" role="tab" id="[a-z]+-tab-${key}" data-tab="${key}"[^>]*>`).exec(block) || [])[0];
        assert.ok(tab, `the ${key} tab`);
        const controls = (/aria-controls="([^"]+)"/.exec(tab) || [])[1];
        assert.strictEqual(controls, box, `${key} controls its section`);
        assert.ok(block.includes(`id="${controls}"`), `${controls} is inside the block`);
    }
});

check('How it works is the default tab of New here? and Lately the default of Around OpenVibe', () => {
    assert.match(intro, /id="hi-tab-tour" data-tab="tour" aria-selected="true"/);
    assert.match(around, /id="ha-tab-lately" data-tab="lately" aria-selected="true"/);
    assert.match(intro, /<div class="home-tabbox home-intro" id="home-intro" data-tab="tour">/);
    assert.match(around, /<div class="home-tabbox" id="home-around" data-tab="lately">/);
});

check('the tabs and the one-section-at-a-time rule exist only under 760 px', () => {
    assert.match(css, /\.home-tabs \{ display: none; \}/, 'no tabs by default');
    const phone = css.slice(css.indexOf('.home-tabs { display: none; }'));
    const block = phone.slice(phone.indexOf('@media (max-width: 759px) {'));
    for (const key of [...AROUND, ...INTRO]) assert.ok(block.includes(`.home-tabbox:not([data-tab="${key}"]) [data-panel="${key}"]`), `${key} hides when another tab is open`);
    assert.match(block, /min-height: 44px/, 'a tab is a 44 px target');
    assert.match(js, /const _narrow = typeof window !== 'undefined' && window\.matchMedia\('\(max-width: 759px\)'\)/, 'the same breakpoint as the rails\' phone sizing');
});

check('the section\'s own heading goes while its tab names it, and the header keeps what it does', () => {
    assert.ok(css.includes('[data-panel="star"] > .section-header > h2'), 'the star heading goes');
    assert.ok(css.includes('[data-panel="lately"] .digest-title'), 'the digest title goes');
    assert.ok(css.includes('[data-panel="network"] .network-hub-header h3'), 'the network heading goes');
    assert.ok(css.includes('[data-panel="happening"] > .section-header { display: none; }'), 'the pulse header is only its heading');
    assert.ok(css.includes('[data-panel="star"] > .section-header { margin: 6px 0 10px; min-height: 0; }'), 'the star header keeps its note');
});

check('a tab shows once its section does: the ids the script watches are the sections\' own', () => {
    const aroundIds = /const _HOME_AROUND_SHOWN = \{([^}]+)\}/.exec(js);
    const introIds = /const _HOME_INTRO_SHOWN = \{([^}]+)\}/.exec(js);
    assert.ok(aroundIds && introIds, 'the maps of watched sections');
    for (const id of aroundIds[1].match(/'([a-z-]+)'/g).map((s) => s.slice(1, -1))) assert.ok(around.includes(`id="${id}"`), `${id} is in the block`);
    for (const id of introIds[1].match(/'([a-z-]+)'/g).map((s) => s.slice(1, -1))) assert.ok(intro.includes(`id="${id}"`), `${id} is in the block`);
});

check('the demotion moves the whole block, not the sections one by one', () => {
    const demote = /function demoteHomeIntroSections\(\) \{([\s\S]*?)\n\}/.exec(js);
    assert.ok(demote, 'the function');
    assert.match(demote[1], /getElementById\('home-intro'\)/, 'it moves the block');
    assert.match(demote[1], /last\.appendChild\(block\)/, 'it appends the block');
    assert.ok(!/"home-tour-mount", "home-cta-banner"/.test(js), 'the two sections are no longer moved on their own');
});

check('the tour loads when its tab opens, not only when the mount nears the viewport', () => {
    assert.match(js, /if \(key === 'tour'\) _lazyHomeTour\(true\);/, 'opening the tab loads the tour');
    assert.match(js, /function _lazyHomeTour\(force\)/, 'the loader can be forced');
});

(async () => {
    await check('a tab appears once its section has something (the loader shows the pulse)', async () => {
        const p = openHome();
        p.run('initHomeAround(); initHomeIntro();');
        await tick();
        assert.strictEqual(p.el('ha-tab-happening').hidden, true, 'the pulse has nothing yet, so its tab is hidden');
        show(p.el('home-pulse-section'));
        await tick();
        assert.strictEqual(p.el('ha-tab-happening').hidden, false, 'the pulse arrived, so its tab is there');
        assert.strictEqual(p.el('ha-tab-lately').hidden, false, 'the digest is there all along');
    });

    await check('a tab that is shown is one the reader can open, and it is remembered', async () => {
        const p = openHome();
        p.run('initHomeAround();');
        await tick();
        p.click('ha-tab-star');
        await tick();
        assert.strictEqual(p.el('home-around').dataset.tab, 'star', 'the block shows the star');
        assert.strictEqual(p.el('ha-tab-star').getAttribute('aria-selected'), 'true', 'the tab says so');
        assert.strictEqual(p.el('ha-tab-lately').getAttribute('aria-selected'), 'false', 'the other one does not');
        assert.strictEqual(p.store.get('ov_home_around'), 'star', 'the reader keeps it for next time');
    });

    await check('a section that empties out falls back, and a block with nothing drops its tab row', async () => {
        const p = openHome();
        p.run('initHomeAround();');
        await tick();
        p.click('ha-tab-star');
        await tick();
        show(p.el('home-pulse-section'));   // the pulse arrives
        await tick();
        hide(p.el('home-digest'));   // the loader found nothing
        hide(p.el('home-star-section'));
        await tick();
        assert.strictEqual(p.el('home-around').dataset.tab, 'happening', 'it fell back to the pulse');
        hide(p.el('home-pulse-section'));
        await tick();
        assert.strictEqual(p.el('home-around').querySelector('[role="tablist"]').hidden, true, 'nothing left to show, so no tab row');
    });

    await check('the tour loads when its tab opens', async () => {
        const p = openHome();
        p.run('initHomeIntro();');
        await tick();
        assert.deepStrictEqual(p.loaded, [], 'nothing loads on its own in a page that never scrolls');
        p.click('hi-tab-tour');
        await tick();
        assert.deepStrictEqual(p.loaded, ['homeTour'], 'opening the tab loads the tour');
    });

    await check('a first visit leaves the block where it is', async () => {
        const p = openHome();
        p.run('initHomeIntro(); demoteHomeIntroSections();');
        await tick();
        const block = p.el('home-intro');
        assert.strictEqual(block.dataset.ovDemoted, undefined, 'it was not demoted');
        const kids = [...block.parentElement.children];
        assert.ok(kids.indexOf(p.el('home-catchup')) < kids.indexOf(block), 'it still comes after Catch up');
        assert.notStrictEqual(block.parentElement, p.el('home-changelog-wrapper').parentElement, 'and before the changelog');
    });

    await check('after enough visits the whole block moves to the end of the page, and still works there', async () => {
        const p = openHome({ views: 18 });
        p.run('initHomeIntro(); demoteHomeIntroSections();');
        await tick();
        const block = p.el('home-intro');
        assert.strictEqual(block.dataset.ovDemoted, '1', 'it was demoted');
        assert.ok(block.classList.contains('home-intro-demoted'), 'and marked as such');
        const container = p.el('home-changelog-wrapper').parentElement;
        assert.strictEqual(block.parentElement, container, 'it moved into the changelog\'s container');
        assert.strictEqual(container.lastElementChild, block, 'and to the end of it');
        for (const id of ['home-tour-mount', 'home-cta-banner', 'home-network-hub']) {
            assert.ok(block.contains(p.el(id)), `${id} travelled with it`);
        }
        // The tabs still work where it landed.
        p.click('hi-tab-network');
        await tick();
        assert.strictEqual(block.dataset.tab, 'network', 'the tab opened its section');
        assert.strictEqual(p.el('hi-tab-network').getAttribute('aria-selected'), 'true', 'and says so');
        p.click('hi-tab-tour');
        await tick();
        assert.deepStrictEqual(p.loaded, ['homeTour'], 'the tour loads from its new place too');
    });

    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})();
