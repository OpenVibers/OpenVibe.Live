'use strict';
// The Rundown's front page draws the day (GET /api/rundown/day/today): today's moments as a row in time order, and the
// day in short when the owner has the AI summary on. Rules this file holds: the section is part of the plain front
// page only, it is in the first draw (fetched beside the page's own data), it is built with DOM nodes (every word in
// it came from a stream), and nothing is drawn when there is nothing to show.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rundown.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'rundown.css'), 'utf8');

const from = js.indexOf('async function _rdDayFetch()');
const to = js.indexOf('async function _rdBrowse(root, state) {');
assert.ok(from > 0 && to > from, 'the day section sits before the front page that uses it');
const day = js.slice(from, to);

assert.ok(day.includes("api('/rundown/day/today?limit=100')"), 'it reads the day endpoint');
assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(day), 'the day section is built with DOM nodes, never markup strings');
assert.ok(day.includes("sum.status === 'ready'"), 'the day in short shows only when the summary is ready (off, too few takes: no card)');
assert.ok(day.includes('if (!day.items.length && !sentences.length) return;'), 'nothing to show: nothing is drawn');
assert.ok(day.includes("'Written by AI from today\\u2019s takes."), 'the summary says who wrote it');
assert.ok(day.includes('rail.scrollLeft = rail.scrollWidth;'), 'the row opens at the newest moment');
assert.ok(/for \(let i = 0; next != null && i < 3; i\+\+\)/.test(day), 'a busy day is read in a bounded number of pages');

const browse = js.slice(to, js.indexOf('async function _rdRefresh()'));
assert.ok(browse.includes('const [d, day] = await Promise.all([api(\'/rundown/browse\' + _rdQuery(state)), plain ? _rdDayFetch() : null]);'), 'the day is fetched beside the page, so it is in the first draw');
assert.ok(/const plain = !state\.q && !state\.streamer\.length && !state\.topic/.test(browse), 'a search or a filter does not show the day');
assert.ok(browse.includes('<div id="rd-day-host"></div>') && browse.includes('_rdDayDraw(day);'));

for (const sel of ['.rd-day-rail', '.rd-day-it', '.rd-day-when', '.rd-day-topic', '.rd-day-take', '.rd-day-watch', '.rd-day-sum']) assert.ok(css.includes(`${sel} {`), `${sel} is styled`);
assert.ok(/\.rd-day-watch \{[^}]*min-height: 44px/.test(css), 'the way to the moment is a full touch target');
// Trending on a phone is ranked: the place, the topic, and what the place rests on.
const rails = js.slice(js.indexOf('function _rdRails(d) {'), js.indexOf('// ── The page the bar is on'));
assert.ok(rails.includes('<b class="rd-rank-n" aria-hidden="true">${i + 1}</b>') && rails.includes("${t.streamers} streamer") && rails.includes("${t.takes} take"), 'a ranked row says its place and what it rests on');
assert.ok(css.includes('.rd-rank {') && /\.rd-rank \{[^}]*min-height: 52px/.test(css), 'and is a full touch target');
console.log('rundown day on the front page: OK');
