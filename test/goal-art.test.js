'use strict';
// A goal without a picture gets art drawn from its title (ask 289): the same title always draws the same art, the
// glyph fits what the goal is for, and nothing from the title reaches the markup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const start = src.indexOf('const _GOAL_GLYPHS');
const end = src.indexOf('function _goalWidgetItemHTML');
assert.ok(start > 0 && end > start, 'goalArtHTML sits before the goal widget in app.js');
const ctx = {};
vm.runInNewContext(src.slice(start, end) + '\nthis.goalArtHTML = goalArtHTML;', ctx);
const art = ctx.goalArtHTML;

const a = art({ title: 'POWERLEVEL' }, 'cgw-media');
assert.equal(a, art({ title: 'POWERLEVEL' }, 'cgw-media'), 'the same title draws the same art');
assert.notEqual(a, art({ title: 'Pizza night' }, 'cgw-media'), 'another title draws other art');
assert.match(a, /^<div class="cgw-media cgw-art" style="--ga1:hsl\(\d+ 68% 42%\);--ga2:hsl\(\d+ 72% 20%\)" aria-hidden="true"><i class="fa-solid fa-bolt"><\/i><\/div>$/);
assert.match(art({ title: 'LOOI robot upgrades' }, 'x'), /fa-robot/);
assert.match(art({ title: 'New webcam' }, 'x'), /fa-camera/);
assert.match(art({ title: 'Something else' }, 'x'), /fa-bullseye/, 'a title with no known word gets the target');
assert.match(art({}, 'x'), /fa-bullseye/, 'a goal with no title still draws');
const evil = art({ title: '<img src=x onerror=alert(1)>"' }, 'x');
assert.ok(!/<img|onerror|"\s*>/.test(evil.replace(/^<div class="x cgw-art" style="[^"]*" aria-hidden="true"><i class="fa-solid fa-[a-z-]+"><\/i><\/div>$/, '')), 'nothing from the title reaches the markup');
console.log('goal art: all checks passed');
