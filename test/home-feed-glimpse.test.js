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
assert.match(fn, /glimpse: 4/);
assert.match(fn, /OpenVibeNavbar\.openSearch\('', 'feed'\)/, 'Show more opens the menu\'s Feed');
assert.match(fn, /feedMissing: \(\) => \{ section\.hidden = true; \}/, 'a dead feed takes the section away');
assert.match(js, /\n {4}loadHomeFeedGlimpse\(\);/, 'the home starts it');
console.log('home-feed-glimpse: under Live Now, loaded when near, never an older Shared\'s whole feed, Show more opens the Feed');
