'use strict';
/**
 * The home's Live Now grid is newest first, never by crowd (market research, Live's outcome: a channel that just went
 * live is seen instead of the biggest staying on top), and the section says so. The server's /api/streams keeps its
 * own order for its other readers; the home sorts what it draws.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fragment = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'home.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');

assert.match(fragment, /Live Now<small class="section-kicker"[^>]*>newest first, never by crowd<\/small>/, 'the section says how it is sorted');
const sorter = /const streams = \(liveData\.streams \|\| \[\]\)\.slice\(\)\.sort\(\(a, b\) => (.+?)\);\n/.exec(js);
assert.ok(sorter, 'the home sorts the live streams it draws');
// The comparator the home uses, run on three streams: the one that started last comes first, whatever its crowd.
const cmp = new Function('a', 'b', `return ${sorter[1]};`);
const list = [
    { username: 'big', viewer_count: 900, started_at: '2026-11-01T08:00:00Z' },
    { username: 'new', viewer_count: 1, started_at: '2026-11-01T10:30:00Z' },
    { username: 'mid', viewer_count: 40, started_at: '2026-11-01T09:00:00Z' },
].sort(cmp);
assert.deepStrictEqual(list.map((s) => s.username), ['new', 'mid', 'big']);
assert.ok(js.indexOf(sorter[0]) < js.indexOf("renderStreamGrid('stream-grid-live', streams, true)"), 'sorted before it is drawn');
console.log('home-live-order: ok');
