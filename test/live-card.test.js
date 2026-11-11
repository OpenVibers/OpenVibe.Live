'use strict';
// Live looks live (plan ask 286, the owner: "when they're live … sets the background based on … their thumbnail …
// modern, stand out, unique"): a live card wears its own frame as a soft backdrop, a LIVE pill and the ring; an NSFW card
// keeps no backdrop; the backdrop is only ever our own address in a CSS url(); a phone's centred card comes alive like a
// hovered one. The functions are public/js/app-home.js's own, run here.
//   node test/live-card.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
const body = /function _liveBg\(u\) \{[\s\S]*?\n\}\n/.exec(src);
assert.ok(body, 'app-home.js has _liveBg');
const _liveBg = new Function(`${body[0]}; return _liveBg;`)();

assert.strictEqual(_liveBg('/api/thumbnails/live/12.jpg?t=1'), 'url("/api/thumbnails/live/12.jpg?t=1")', 'our own path');
assert.strictEqual(_liveBg('https://openvibe.media/t/a.jpg'), 'url("https://openvibe.media/t/a.jpg")', 'Media');
assert.strictEqual(_liveBg('https://cdn.openvibe.video/a.jpg'), 'url("https://cdn.openvibe.video/a.jpg")', 'a subdomain of ours');
for (const bad of ['https://evil.example/x.jpg', '//evil.example/x.jpg', 'javascript:alert(1)', '/x") ;background:red', '/a b.jpg', "/a'.jpg", 'http://openvibe.live/a.jpg', '', null]) {
    assert.strictEqual(_liveBg(bad), '', `refused: ${JSON.stringify(bad)}`);
}

assert.match(src, /const liveBg = isLive && !s\.is_nsfw \? _liveBg\(thumb\) : '';/, 'an NSFW card keeps no backdrop');
assert.match(src, /<a class="stream-card\$\{isLive \? ' is-live' : ''\}"\$\{liveBg \? ` style="--live-bg:\$\{esc\(liveBg\)\}"` : ''\}/, 'a live card is marked and wears its frame');
assert.match(src, /\$\{isLive \? '<span class="stream-card-live">Live<\/span>' : ''\}/, 'the LIVE pill');
assert.match(src, /if \(bg && !s\.is_nsfw\) card\.style\.setProperty\('--live-bg', bg\);/, 'the backdrop follows the newest frame');
assert.match(src, /if \(isLive\) _liveCentreWatch\(c\);/, 'a phone watches which live card is centred');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
assert.match(css, /\.stream-card\.is-live::before \{[^}]*background: var\(--live-bg, none\)[^}]*filter: blur\(/, 'the frame, blurred, behind the card');
assert.match(css, /\.stream-card\.is-live::after \{[^}]*linear-gradient\([^}]*var\(--bg-card\)/, 'a scrim of the card colour, so words stay readable');
assert.match(css, /\.stream-card\.is-live:hover \.stream-card-thumb img, \.stream-card\.is-live\.is-centred \.stream-card-thumb img \{ transform: scale\(1\.07\); \}/, 'hovered or centred, the frame drifts closer');
assert.match(css, /\.stream-card\.is-live \.stream-card-avatar \{ box-shadow: 0 0 0 2px var\(--live-red\)/, 'the live ring on the face');
assert.match(css, /html\[data-ov-motion=off\] \.stream-card\.is-live \.stream-card-thumb img \{ transition: none; transform: none; \}/, 'Motion Off keeps it still');
console.log('live card: our-own backdrops only, NSFW without one, the pill, the ring, centred on a phone, Motion Off');
