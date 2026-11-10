'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const day = require('../server/rundown/day');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rundown-day.json'), 'utf8'));
assert.strictEqual(day.validDate(fixture.date), true);
assert.strictEqual(day.validDate('2026-02-30'), false);
assert.strictEqual(day.validDate('today'), false);
assert.deepStrictEqual(day.splitSentences(fixture.summary), [
    'Ari discussed the game update. [takes: 481,482]',
    'The new map loads faster than last season. [takes: 482,483]',
]);
console.log('rundown day fixtures: OK');
