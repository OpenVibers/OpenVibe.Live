'use strict';
// OBS scenes in the streamer's look (plan L45 step 5): /obs/scene/<starting|brb|ending>/<username> is a full-screen
// browser source. The document goes through the asset rewrite (content-hashed /shared files), takes any OpenVibe theme
// by id, never prints a query value as markup, and keeps still under reduced motion.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const assets = require('../server/web/assets');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/obs/scene.html'), 'utf8');
const doc = assets.document('obs/scene.html').html;
const index = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');

// ── The route: three scenes, a username, nothing else ──
const re = /^\/obs\/scene\/(starting|brb|ending)\/[A-Za-z0-9_.-]{1,40}\/?$/;
assert.ok(index.includes(`app.get(${re.toString()}`), 'the scene route');
assert.ok(re.test('/obs/scene/starting/goosely') && re.test('/obs/scene/brb/goosely') && re.test('/obs/scene/ending/goosely/'));
assert.ok(!re.test('/obs/scene/party/goosely') && !re.test('/obs/scene/starting/<x>') && !re.test('/obs/scene/starting'), 'only the three, and only a username');

// ── The document ──
assert.match(doc, /<script src="\/shared\/theme-loader\.js[^"]*"><\/script>/, 'the look loader (Shared files keep their own caching)');
assert.match(doc, /<script src="\/shared\/ov-mark\.js[^"]*"><\/script>/, 'the mark');
assert.match(SRC, /<span class="ov-mark" data-size="240" data-glow id="sc-mark"><\/span>/, 'the mark with its glow arrives with its intro');
assert.match(SRC, /L\.applyVars\(L\.THEMES\[themeId\]\)/, 'any OpenVibe theme by id');
assert.match(SRC, /\/\^\[a-z0-9-\]\{1,40\}\$\/\.test\(q\.get\('theme'\)/, 'the theme is a name, never colours from the URL');
assert.ok(!/innerHTML/.test(SRC), 'a query value is only ever text');
assert.match(SRC, /\(q\.get\('msg'\) \|\| ''\)\.slice\(0, 140\)/, 'a message of your own, short');
assert.match(SRC, /setAttribute\('data-state', 'busy'\)/, 'on Be right back the mark breathes');
assert.match(SRC, /@media \(prefers-reduced-motion: reduce\) \{ \.sc-light \{ animation: none; \}/, 'still under reduced motion');
assert.ok(!/spin|rotate\(/.test(SRC.replace(/<!--[\s\S]*?-->/g, '')), 'nothing spins');
console.log('obs scenes: three scenes by route, the loader and the mark, any theme by name, the mark arriving, text only, still under reduced motion');
