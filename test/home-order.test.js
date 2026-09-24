/**
 * The home page leads with live content and creators (roadmap 32.7, critique 1): Live Now first,
 * then, above the introduction to the site (the restream tour and the collapsed About banner), what
 * people made (Recently Online, Recent VODs, Recent Clips, Recent Pastes), then what the AI made
 * (AI Moments; 33.6: made, then derived). Nothing else on the page was removed.
 *
 *   node test/home-order.test.js
 */
'use strict';
const assert = require('assert');

const assets = require('../server/web/assets');
try { assets.setSharedDir(require('openvibe-shared/files').dir); } catch { /* */ }
const html = assets.renderRoute(assets.document('index.html').html, '/');
const home = html.slice(html.indexOf('<section id="page-home"'), html.indexOf('</section>', html.indexOf('<section id="page-home"')));
const at = (needle) => {
    const i = home.indexOf(needle);
    assert.ok(i >= 0, `${needle} is on the home page`);
    return i;
};

let failures = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

console.log('Home order');

check('Live Now is the first section after the hero', () => {
    const live = at('id="stream-grid-live"');
    for (const id of ['stream-grid-recent', 'home-recent-vods-grid', 'home-clips-grid', 'home-pastes-list', 'home-moments-section', 'home-tour-mount', 'home-cta-banner', 'home-digest', 'home-star-section']) {
        assert.ok(live < at(`id="${id}"`), `Live Now before ${id}`);
    }
});

check('the creator rows sit above the introduction (tour and About banner)', () => {
    const intro = Math.min(at('id="home-tour-mount"'), at('id="home-cta-banner"'));
    for (const id of ['stream-grid-recent', 'home-recent-vods-grid', 'home-clips-grid', 'home-pastes-list']) {
        assert.ok(at(`id="${id}"`) < intro, `${id} above the introduction`);
    }
});

check("people's work comes before the AI's", () => {
    const ai = at('id="home-moments-section"');
    for (const id of ['stream-grid-recent', 'home-recent-vods-grid', 'home-clips-grid', 'home-pastes-list']) {
        assert.ok(at(`id="${id}"`) < ai, `${id} before AI Moments`);
    }
});

check('each rail keeps its header right before its grid (the density control reads it)', () => {
    const recent = at('id="stream-grid-recent"');
    const header = home.lastIndexOf('<div class="section-header"', recent);
    assert.ok(home.slice(header, recent).includes('Recently Online'));
});

check('nothing was removed', () => {
    for (const id of ['home-featured', 'stream-grid-live', 'home-digest', 'home-star-section', 'hero-egg', 'home-pulse-section',
        'stream-grid-recent', 'stream-grid-recent-pagination', 'home-recent-vods-header', 'home-recent-vods-grid', 'home-clips-header',
        'home-clips-grid', 'home-pastes-header', 'home-pastes-list', 'home-moments-section', 'home-tour-mount', 'home-cta-banner',
        'home-about-body', 'home-quest-header', 'home-leaderboards', 'home-canvas-header', 'home-canvas-preview']) {
        at(`id="${id}"`);
    }
    assert.ok(home.includes('class="network-hub"'));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nhome order: all checks passed');
process.exit(failures ? 1 : 0);
