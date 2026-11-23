'use strict';
// The feed's glimpse on the home (2026-11-20; plan §V.1 guests, the owner's #800: "a glimpse into the feed … on the
// homepage that shows the beginning and then opens … the feed"):
//   - the section sits under Live Now (after the agents live), before For you;
//   - openvibe-shared's ov-home.js is never part of the first paint: it is asked for when the section comes near;
//   - a Shared without the glimpse (OpenVibeHome.glimpse !== true) would draw the whole endless feed: the section goes;
//   - Show more opens the menu's Feed; a feed that does not answer takes the section away.
//   node test/home-feed-glimpse.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/fragments/home.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/app-home.js'), 'utf8');

const at = (s) => html.indexOf(s);
assert.ok(at('id="home-feed-glimpse"') > at('id="stream-grid-live"'), 'under Live Now');
assert.ok(at('id="home-feed-glimpse"') > at('id="home-agents"'), 'after the agents live');
assert.ok(at('id="home-feed-glimpse"') < at('data-part="foryou"'), 'before For you');
assert.ok(!/ov-home\.js/.test(html), 'no ov-home.js in the first paint');

const fn = js.slice(js.indexOf('function loadHomeFeedGlimpse()'), js.indexOf('/* ── Community pulse'));
assert.ok(fn.length > 200, 'the loader is there');
assert.match(fn, /new IntersectionObserver\([\s\S]*rootMargin: '800px 0px'/, 'asked for when it comes near');
assert.match(fn, /sc\.src = '\/shared\/ov-home\.js'/);
assert.match(fn, /if \(OpenVibeHome\.glimpse !== true\) \{ section\.hidden = true; return; \}/, 'an older Shared draws nothing');
// 11-23 (the owner: "fade out really early and bring people to the actual feed menu"): a peek of two cards (four on a
// wide screen) that fades out, and three ways into the menu's Feed: the button over the fade, the header's, the fade.
assert.match(fn, /glimpse: window\.matchMedia && window\.matchMedia\('\(min-width: 1400px\)'\)\.matches \? 4 : 2/);
assert.match(fn, /onMore: openHomeFeed/);
assert.match(fn, /section\.querySelector\('\[data-open-feed\]'\)/, 'the header\'s Open the feed');
assert.match(fn, /openHomeFeed\(\); \}\s*\}, true\)/, 'a tap on the faded part opens the Feed');
assert.match(js, /function openHomeFeed\(\) \{[\s\S]{0,120}OpenVibeNavbar\.openSearch\('', 'feed'\)/, 'Open the feed opens the menu\'s Feed');
assert.match(html, /<button type="button" class="section-action" data-open-feed>Open the feed<\/button>/);
const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'features', 'home.css'), 'utf8');
assert.match(css, /\.home-feed-glimpse-list \.ovfd-list \{[^}]*max-height: 340px;[^}]*mask-image: linear-gradient\(to bottom/, 'the peek fades out');
assert.match(fn, /feedMissing: \(\) => \{ section\.hidden = true; \}/, 'a dead feed takes the section away');
assert.match(js, /\n {4}loadHomeFeedGlimpse\(\);/, 'the home starts it');
console.log('home-feed-glimpse: under Live Now, loaded when near, never an older Shared\'s whole feed, a peek that fades into the menu\'s Feed');
