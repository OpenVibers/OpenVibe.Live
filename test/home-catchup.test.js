/**
 * Catch up (2026-10-30, the owner's short-pages rule: a phone page is one or two screens): on a phone the five rails
 * after Live Now (Recently Online, Recent VODs, Recent Clips, Recent Pastes, AI Moments) share one place, a row of
 * tabs and one rail at a time. Wider screens never see the tabs and show every rail. Nothing was removed: every
 * rail is still in the page, in the same order.
 *
 *   node test/home-catchup.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const assets = require('../server/web/assets');
try { assets.setSharedDir(require('openvibe-shared/files').dir); } catch { /* */ }
const html = assets.renderRoute(assets.document('index.html').html, '/');
const home = html.slice(html.indexOf('<section id="page-home"'), html.indexOf('</section>', html.indexOf('<section id="page-home"')));
const css = fs.readFileSync(path.join(__dirname, '../public/css/features/home.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../public/js/app-home.js'), 'utf8');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

console.log('Home catch up');

const start = home.indexOf('<div class="home-catchup" id="home-catchup" data-tab="recent">');
const end = home.indexOf('</div><!-- /home-catchup -->');
const box = home.slice(start, end);
const TABS = ['recent', 'vods', 'clips', 'pastes', 'moments'];

check('the five rails sit inside one Catch up block, in their order', () => {
    assert.ok(start > 0 && end > start, 'the block opens and closes on the home page');
    const order = ['id="stream-grid-recent"', 'id="home-recent-vods-grid"', 'id="home-clips-grid"', 'id="home-pastes-list"', 'id="home-moments-row"'].map((n) => box.indexOf(n));
    assert.ok(order.every((i) => i > 0), 'every rail is inside it');
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'in the same order as before');
});

check('one tab per rail, named for screen readers, pointing at its rail; only Recently online starts shown', () => {
    assert.match(box, /<div class="home-catchup-tabs" role="tablist" aria-label="Catch up">/);
    for (const key of TABS) {
        const tab = (new RegExp(`<button type="button" role="tab" id="hc-tab-${key}" data-tab="${key}"[^>]*>`).exec(box) || [])[0];
        assert.ok(tab, `the ${key} tab`);
        const controls = (/aria-controls="([^"]+)"/.exec(tab) || [])[1];
        assert.ok(controls && box.includes(`id="${controls}"`), `${key} controls a rail inside the block`);
        assert.strictEqual(/ hidden\b/.test(tab), key !== 'recent', `${key} starts ${key === 'recent' ? 'shown' : 'hidden until its rail has something'}`);
        assert.ok(new RegExp(`data-catchup="${key}"`).test(box), `${key}'s rail is marked`);
    }
});

check('the tabs and the one-rail-at-a-time rule exist only under 760 px', () => {
    assert.match(css, /\.home-catchup-tabs \{ display: none; \}/, 'no tabs by default');
    const phone = css.slice(css.indexOf('.home-catchup-tabs { display: none; }'));
    const block = phone.slice(phone.indexOf('@media (max-width: 759px) {'));
    for (const key of TABS) assert.ok(block.includes(`.home-catchup:not([data-tab="${key}"]) [data-catchup="${key}"]`), `${key} hides when another tab is open`);
    assert.match(block, /min-height: 44px/, 'a tab is a 44 px target');
    assert.match(js, /const _narrow = typeof window !== 'undefined' && window\.matchMedia\('\(max-width: 759px\)'\)/, 'the same breakpoint as the rails\' phone sizing');
});

check('a tab shows once its rail does: the ids the script watches are the rails\' own', () => {
    const watched = /const _HOME_CATCHUP_SHOWN = \{([^}]+)\}/.exec(js);
    assert.ok(watched, 'the map of watched elements');
    for (const id of watched[1].match(/'([a-z-]+)'/g).map((s) => s.slice(1, -1))) assert.ok(box.includes(`id="${id}"`), `${id} is in the block`);
    assert.match(js, /initHomeCatchup\(\);\s*\n\s*demoteHomeIntroSections\(\);/, 'loadHome starts it');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
