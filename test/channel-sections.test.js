'use strict';
/**
 * The channel page's sections are all on the page (owner 2026-10-31: content is never hidden behind a tab to shorten
 * a page). The row above them is a jump bar; AI timeline and Analytics are counted folds; a section is hidden only when
 * its jump link is (it has nothing in it).
 *
 *   node test/channel-sections.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'channel.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'channel.css'), 'utf8');

const below = html.slice(html.indexOf('<div class="channel-below-fold">'));
assert.ok(!/role="tab(list|panel)?"/.test(below), 'no tab roles under the player: the row is a jump bar');
assert.match(below, /<nav class="ch-tabs ch-jump" id="ch-tabs" aria-label="Jump to a section">/);

const SECTIONS = ['about', 'videos', 'agents', 'clips', 'clips-taken', 'pastes', 'media', 'ai-timeline', 'analytics'];
for (const tab of SECTIONS) {
    assert.match(below, new RegExp(`<section class="ch-tab-panel" id="ch-panel-${tab}" aria-labelledby="ch-h-${tab}">`), `${tab} is a section`);
    assert.match(below, new RegExp(`id="ch-h-${tab}"`), `${tab} has its own heading`);
    assert.match(below, new RegExp(`switchChannelTab\\('${tab}', this, true\\)`), `${tab}'s jump link scrolls to it`);
}
for (const fold of ['ai-timeline', 'analytics']) assert.match(below, new RegExp(`<details class="ch-fold" data-ch-fold="${fold}">`), `${fold} is a counted fold`);

// Every section shows on the channel page; only an empty one (its link hidden) is hidden, and the dashboard keeps its tabs.
assert.match(css, /#page-channel \.ch-tab-panel \{ display: block;/);
assert.ok(!/#page-channel \.ch-tab-panel \{[^}]*display: none/.test(css), 'no channel section is display:none by rule');
assert.match(js, /panel\.hidden = b\.style\.display === 'none';/, 'a section hides only with its jump link');
// Tabs on a phone (ask 367): a section not chosen never shows, whatever a later rule says (11-12: the rails' two-id grid
// outranked the one-id hiding, so Videos, Clips, Clips taken and Pastes showed under About with no heading); and every
// section keeps its heading there (the owner: "they need a nice header with icon").
assert.match(css, /#page-channel\.ch-tabbed \.ch-tab-panel:not\(\.is-current\) \{ display: none !important; \}/);
assert.ok(!/\.ch-tabbed[^{}]*\.ch-sec-h[^{}]*\{[^}]*display: none/.test(css), 'no heading is hidden in tabs');
assert.ok(!/\.ch-tabbed[^{}]*\.ch-fold > summary \{[^}]*display: none/.test(css), 'a fold\'s heading shows in tabs');
for (const tab of SECTIONS) {
    const h = below.match(new RegExp(`<h2 class="ch-sec-h" id="ch-h-${tab}">([\\s\\S]*?)</h2>`));
    assert.ok(h && /class="fa-solid [a-z-]+ ch-sec-ic"/.test(h[1]), `${tab}'s heading has its icon tile`);
}
assert.match(js, /function _watchChannelSections\(\)/);
assert.match(js, /new IntersectionObserver\([\s\S]{0,200}_ensureChannelSection\(e\.target\.id\.replace\('ch-panel-', ''\), true\)/, 'a section loads as it nears the screen');
assert.match(js, /if \(passing && \(tab === 'analytics' \|\| tab === 'ai-timeline'\)\) return;/, 'the folds load when opened, not on the way past');
// Every inline handler in the fragment parses (11-07: a stray backslash, onclick=\"...\", broke every jump link).
assert.ok(!/onclick=\\"/.test(html), 'no backslash-escaped onclick attributes');
const handlers = [...html.matchAll(/\son(click|change|input|submit)="([^"]*)"/g)].map((m) => m[2]);
assert.ok(handlers.length > 9, 'the handlers were found');
handlers.forEach((code) => assert.doesNotThrow(() => new Function('event', code), `the handler parses: ${code.slice(0, 80)}`));
console.log('channel sections: every section on the page, a jump bar, two counted folds, every handler parses');
