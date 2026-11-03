'use strict';
// The home's reveal safety (public/js/home-fx.js startRevealSafety) hooks its scroll listener once per page life. Its
// sweeps stop after five passes and restart on a later mutation; each restart used to add another window scroll
// listener, so the browser smoke's laps grew by four every lap (11-03, windowListeners 82→86).
//   node test/home-fx-reveal-once.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'home-fx.js'), 'utf8');
const decl = /let io = null, revealSafety = 0, revealPasses = 0, firstRevealPass = true;/.exec(src);
assert.ok(decl, 'the reveal state is where the test expects it');
const at = src.indexOf('let revealScrollHooked = false;');
assert.ok(at > 0, 'the once flag is declared');
const fnAt = src.indexOf('function startRevealSafety()', at);
let depth = 0;
let end = -1;
for (let i = src.indexOf('{', fnAt); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const fnSrc = src.slice(at, end);

const scrolls = [];
const timers = [];
const sandbox = {
    window: { innerHeight: 800, addEventListener: (type, fn) => { if (type === 'scroll') scrolls.push(fn); } },
    document: { querySelectorAll: () => [] },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
};
vm.createContext(sandbox);
vm.runInContext(`${decl[0]}\n${fnSrc}\nthis.start = startRevealSafety; this.drain = () => { while (this.timers.length) this.timers.shift()(); };`, Object.assign(sandbox, { timers }));

sandbox.start();
assert.strictEqual(scrolls.length, 1, 'one scroll listener');
sandbox.drain();            // the five sweeps run out; revealSafety is 0 again
sandbox.start();            // a later mutation restarts the sweeps
sandbox.drain();
sandbox.start();
assert.strictEqual(scrolls.length, 1, 'still one scroll listener after the sweeps restart');
console.log('home-fx reveal: one scroll listener per page life');
