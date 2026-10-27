/**
 * The home page's stat board (public/js/app-home.js) and its charts (public/js/stats-nerds.js), after the 2026-10-27
 * review: every number appears once, a seven-day figure's pill is only its comparison with the week before, and a
 * daily headcount's chart has no running total.
 *
 *   node test/home-stat-board.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
const fnSource = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
};
// eslint-disable-next-line no-new-func
const windowDelta = new Function('_fmtCount', 'esc', `${fnSource('_heroTrendBits')}\n${fnSource('_heroWindowDeltaHTML')}; return _heroWindowDeltaHTML;`)(String, (s) => String(s));

// "+66 7d" under a chip reading 66 said the number twice: the pill is only the comparison.
const pill = windowDelta(66, 68);
assert.match(pill, /is-window is-down/);
assert.match(pill, /<em>7d<\/em><span class="hero-stat-trend is-down"><i><\/i>3%<\/span>/);
assert.ok(!/\+66/.test(pill), 'the week\'s own number is not repeated');
assert.match(windowDelta(5, 0), /is-new/, 'nothing the week before: new');
assert.strictEqual(windowDelta(5, undefined), '', 'no previous week: no pill');
assert.match(windowDelta(4, 4), /is-flat/);

// The board: each chart metric once, and visitors are one chip (the same table was "Visitors" and "Anons").
// (The 24-hour viewers line opens the Watching chart too: it is a picture of that metric, not another number.)
const boardAll = src.slice(src.indexOf('// ── Right now ──'), src.indexOf('// Rolling-window deltas'));
const board = boardAll.slice(0, boardAll.indexOf('const trend = Array.isArray')) + boardAll.slice(boardAll.indexOf("groups.push({ kicker: 'Right now'"));
const metrics = [...board.matchAll(/metric: '([a-zA-Z]+)'/g)].map((m) => m[1]);
const twice = metrics.filter((m, i) => metrics.indexOf(m) !== i);
assert.deepStrictEqual(twice, [], `each metric once on the board (twice: ${twice.join(', ')})`);
assert.ok(metrics.includes('visitors') && !metrics.includes('anons'), 'one visitors chip');
assert.ok(!/label: 'Coins Held'|label: 'Coins held'/.test(board), 'coins held was coins earned less 50: gone');
assert.ok(board.includes("label: 'Hours watched'") && board.includes("label: 'Hours archived'"), 'the two hours say which');
const strip = src.slice(src.indexOf('const HEADLINE = ['), src.indexOf('];', src.indexOf('const HEADLINE = [')));
const stripMetrics = [...strip.matchAll(/metric: '([a-zA-Z]+)'/g)].map((m) => m[1]);
assert.strictEqual(new Set(stripMetrics).size, stripMetrics.length, 'the strip shows each metric once');
assert.strictEqual(stripMetrics.length, 9, 'nine chips: three rows of three on a phone');
// Every site's numbers (openvibe.network/stats, Network#359) under the board and in the chart dialog.
assert.ok(src.includes('<a class="hero-stat-all-sites" href="https://openvibe.network/stats">'), 'the board links every site\'s numbers');

// The chart dialog: daily headcounts have no running total, and an error answer is never redrawn.
const nerds = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'stats-nerds.js'), 'utf8');
assert.ok(/const DISTINCT = new Set\(\['active', 'supporters'\]\)/.test(nerds));
assert.ok(nerds.includes("DISTINCT.has(m.metric) ? [['daily', 'Per day']]"), 'a headcount offers only per day');
assert.ok(nerds.includes('if (state.data?.points && !state.table) drawChart();'), 'a resize never redraws an error answer');
assert.ok(nerds.includes('const asked = Number(chip?.dataset?.days);'), 'the 24-hour line opens its own 24 hours');
assert.ok(nerds.includes('<a class="sn-all" href="https://openvibe.network/stats">'), 'and the dialog links them too');
console.log('home stat board: all checks passed');
