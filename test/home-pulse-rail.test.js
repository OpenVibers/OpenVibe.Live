'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/app-home.js'), 'utf8');
const start = source.indexOf('function _renderHomePulse(');
const end = source.indexOf('/* ── "While you were away"', start);
assert.ok(start >= 0 && end > start);
const { document } = parseHTML('<div id="home-pulse-section"><div id="pulse-grid"></div></div>');
const context = { document, window: {}, Intl, Number, String, encodeURIComponent };
vm.runInNewContext(source.slice(start, end) + '\nthis.render = _renderHomePulse;', context);
context.render({ goals: [{ title: 'Do not show', current_amount: 1, target_amount: 2 }],
    liveNow: { username: 'ann', display_name: 'Ann', viewer_count: 12 },
    topFan: { username: 'ben', display_name: 'Ben', points: 0 },
    dailyFinished: 2 });
const cards = [...document.querySelectorAll('.pulse-fact-card')];
assert.equal(cards.length, 2);
assert.match(cards[0].textContent, /LIVE NOW.*@ann.*12.*viewers watching/s);
assert.match(cards[1].textContent, /TODAY'S QUEST.*2.*people finished today/s);
assert.ok(!document.body.textContent.includes('Do not show'));
assert.ok(!document.body.textContent.includes('Ben'));
context.render({ goals: [{ title: 'Still hidden' }], dailyFinished: 0 });
assert.equal(document.querySelectorAll('.pulse-fact-card').length, 0);
assert.equal(document.getElementById('home-pulse-section').style.display, 'none');
process.stdout.write('home pulse rail: all checks passed\n');
