'use strict';
/**
 * The Rundown's front page says what a visitor can do there (public/js/rundown.js _rdHow): catch up on a stream,
 * follow a topic, jump to the moment, get written up. A viewer said of the page "still don't rly know wtf to do
 * with this feature" (2026-10-20): it said what it is, never what it is for. The action card stays compact on a phone.
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
vm.runInContext(pick('_rdEsc') + pick('_rdA') + pick('_rdMe') + pick('_rdHow'), ctx);

const line = ctx._rdHow();
assert.match(line, /Catch up on what was said, then jump into the moment/, 'the card says what the page is for');
assert.match(line, /href="#rd-about-h">How it works/, 'how it works points at the explanation');
assert.match(line, /href="\/rundown\/topics">Follow topics/, 'the topic action opens the topic index');
assert.ok(!line.includes('rd-use'), 'the four tiles are one line now');
assert.ok(!js.includes('class="rd-uses"'), 'and the tiles are gone from the page');
assert.match(css, /\.rd-how \{/, 'the line has a style of its own');
assert.match(line, /href="\/api\/auth\/sso\/login\?next=%2Frundown">Your Rundown/, 'a signed-out visitor can sign in');
vm.runInContext("var currentUser = { username: 'goosely' };", ctx);
assert.match(ctx._rdHow(), /href="\/rundown\/goosely#mine"/, 'a signed-in person reaches their own Rundown from the card');

console.log('rundown uses: all checks passed');
