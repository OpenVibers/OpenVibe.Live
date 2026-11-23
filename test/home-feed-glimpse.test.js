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
// 11-23 (the owner: "fade out really early and bring people to the actual feed menu"): a peek that fades out, and two
// ways into the menu's Feed: the button over the fade, and the fade itself.
// 11-23 night (the owner, desktop: "this looks retarded"): the peek takes the home row's whole width (not the menu's
// 720 px column), a column per card (4 from 1100 px, 3 from 700 px), no empty filter bar, one "Open the feed".
assert.match(fn, /glimpse: window\.matchMedia && window\.matchMedia\('\(min-width: 1100px\)'\)\.matches \? 4 : \(window\.matchMedia && window\.matchMedia\('\(min-width: 700px\)'\)\.matches \? 3 : 2\)/);
assert.match(fn, /onMore: openHomeFeed/);
assert.match(fn, /openHomeFeed\(\); \}\s*\}, true\)/, 'a tap on the faded part opens the Feed');
assert.match(js, /function openHomeFeed\(\) \{[\s\S]{0,120}OpenVibeNavbar\.openSearch\('', 'feed'\)/, 'Open the feed opens the menu\'s Feed');
assert.doesNotMatch(html, /data-open-feed/, 'one Open the feed (the one on the fade), not a second in the header');
const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'features', 'home.css'), 'utf8');
assert.match(css, /\.home-feed-glimpse-list \.ovfd-list \{[^}]*max-height: 340px;[^}]*mask-image: linear-gradient\(to bottom/, 'the peek fades out');
assert.match(css, /\.home-feed-glimpse-list\.ovfd \{ max-width: none; margin-inline: 0; \}/, 'the whole row, not the menu\'s 720 px column');
assert.match(css, /\.home-feed-glimpse-list \.ovfd-chips \{ display: none; \}/, 'no empty filter bar');
assert.match(css, /repeat\(auto-fit, minmax\(220px, 1fr\)\)/, 'a column per card');
assert.match(fn, /feedMissing: \(\) => \{ section\.hidden = true; \}/, 'a dead feed takes the section away');
assert.match(js, /\n {4}loadHomeFeedGlimpse\(\);/, 'the home starts it');
console.log('home-feed-glimpse: under Live Now, loaded when near, never an older Shared\'s whole feed, a peek that fades into the menu\'s Feed');
