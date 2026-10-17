/**
 * The home page's right-now counters (Live, Watching; public/js/app-home.js) compare with the last 24 hours. With
 * nobody live they said "-100% vs 24h" in red, which read as broken on any quiet hour; zero now says "quiet now".
 *
 *   node test/home-stat-quiet.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
const start = src.indexOf('function _baselineDeltaHTML(');
let i = src.indexOf('{', start), depth = 0;
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
// eslint-disable-next-line no-new-func
const delta = new Function('_fmtCount', 'esc', `${src.slice(start, i + 1)}; return _baselineDeltaHTML;`)(String, (s) => String(s));

assert.match(delta(0, 2.5, 4), /is-flat[^>]*><b>quiet now<\/b>/, 'zero now: quiet, not -100% in red');
assert.ok(!/-100%/.test(delta(0, 2.5, 4)));
assert.match(delta(3, 2, 4), /is-up[^>]*><b>\+50%<\/b>/, 'above average: up');
assert.match(delta(1, 2, 4), /is-down[^>]*><b>-50%<\/b>/, 'below average but live: down');
assert.match(delta(0, 0), /<b>quiet<\/b>/, 'nothing in 24 h: quiet');
assert.match(delta(2, 0), /<b>first today<\/b>/);
console.log('home stat quiet: all checks passed');
