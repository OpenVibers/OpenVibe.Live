/**
 * Catch up: the five rails after Live Now (Recently Online, Recent VODs, Recent Clips, Recent Pastes, AI Moments)
 * show on every screen, each with its own heading. For a day they were phone tabs (2026-10-30), and the owner could
 * no longer see the videos and clips on the home page (2026-10-31: "don't reduce size by removing features"). On a
 * phone each rail is one row of cards that scrolls sideways, so the page stays short without hiding anything.
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
const style = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../public/js/app-home.js'), 'utf8');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

console.log('Home catch up');

const start = home.indexOf('<div class="home-catchup" id="home-catchup">');
const end = home.indexOf('</div><!-- /home-catchup -->');
const block = home.slice(start, end);

check('every rail is in the block, in its order, with its own heading', () => {
    assert.ok(start > 0 && end > start, 'the block opens and closes on the home page');
    const order = ['Recently Online', 'Recent VODs', 'Recent Clips', 'Recent Pastes', 'AI Moments'].map((h) => block.indexOf(h));
    assert.ok(order.every((i) => i > 0), 'every heading is there');
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'in the same order');
    for (const id of ['stream-grid-recent', 'home-recent-vods-grid', 'home-clips-grid', 'home-pastes-list', 'home-moments-row']) {
        assert.ok(block.includes(`id="${id}"`), `${id} is in the block`);
    }
});

check('no tabs and nothing that hides a rail on a phone', () => {
    assert.ok(!block.includes('role="tablist"') && !block.includes('data-catchup'), 'no tab row and no per-rail switch');
    assert.ok(!/home-catchup-tabs|data-catchup|\.home-catchup:not\(/.test(css), 'no CSS hides a rail');
    assert.ok(!/initHomeCatchup|_HOME_CATCHUP_SHOWN/.test(js), 'no script sets tabs up');
});

check('on a phone each rail is one row that scrolls sideways', () => {
    const phone = css.slice(css.indexOf('/* Catch up on a phone'));
    assert.match(phone, /#home-catchup \.stream-grid \{[^}]*grid-auto-flow: column;[^}]*overflow-x: auto;[^}]*scroll-snap-type: x mandatory;/);
    assert.match(phone, /#home-catchup \.stream-grid > \* \{ scroll-snap-align: start; min-width: 0; \}/);
});

check('the changelog preview keeps its full height on a phone', () => {
    assert.ok(!/\.home-changelog-wrapper\.collapsed \{ max-height: 200px; \}/.test(style), 'the newest-day-only cut is gone');
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nAll home catch up checks passed');
