'use strict';
/**
 * The Rundown's front page says what a visitor can do there (public/js/rundown.js _rdHow): catch up on a stream,
 * follow a topic, jump to the moment, get written up. A viewer said of the page "still don't rly know wtf to do
 * with this feature" (2026-10-20): it said what it is, never what it is for. The four tiles it used to be became
 * one line under the title (design 2026-11-06): on a phone they took a whole screen.
 *
 *   node test/rundown-uses.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, '../public/js/rundown.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/css/features/rundown.css'), 'utf8');
const pick = (name) => {
    const start = js.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} is in rundown.js`);
    const next = js.indexOf('\nfunction ', start + 1);
    return js.slice(start, next < 0 ? undefined : next);
};

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(pick('_rdHow'), ctx);

const line = ctx._rdHow();
assert.match(line, /Catch up, follow a topic, jump to the moment, get written up/, 'the line says what the page is for');
assert.match(line, /class="rd-how-link" href="#rd-about-h"/, 'and how it works points at the explanation');
assert.ok(!line.includes('rd-use'), 'the four tiles are one line now');
assert.ok(!js.includes('class="rd-uses"'), 'and the tiles are gone from the page');
assert.match(css, /\.rd-how \{/, 'the line has a style of its own');

console.log('rundown uses: all checks passed');
