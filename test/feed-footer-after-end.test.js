'use strict';
// The site's footer waits for a feed's end (11-28: on a tablet the next page loaded above a footer the reader had
// reached and pushed it out of view: CLS 0.525 on /moments and 0.864 on /content, 0 with this, measured in place).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('public/js/content-feed.js');
const css = read('public/css/features/content.css');

// foot(kind): null = more pages load by themselves (the footer waits); any other state ends the list (it shows).
const start = js.indexOf('const feedMore = ');
const fn = js.slice(start, js.indexOf('\n', start));
let attr = null;
const ctx = { document: { documentElement: { toggleAttribute: (n, on) => { assert.strictEqual(n, 'data-feed-more'); attr = on; } } } };
vm.createContext(ctx);
vm.runInContext(fn.replace('const feedMore', 'var feedMore'), ctx);
const footState = (kind, done) => { vm.runInContext('feedMore', ctx)(!kind && !done); return attr; };
assert.strictEqual(footState(null, false), true, 'more pages coming: the footer waits');
assert.strictEqual(footState('end', true), false, 'the end: the footer shows');
assert.strictEqual(footState(null, true), false, 'done with no foot: shows');
['error', 'more', 'empty', 'partial'].forEach((k) => assert.strictEqual(footState(k, false), false, `${k}: the list stops, the footer shows`));
assert.ok(/function foot\(kind, detail\) \{[\s\S]{0,200}feedMore\(!kind && !S\.done\);/.test(js), 'every foot() decides it');
assert.ok(/scope\.onDispose\(\(\) => \{\s*\n\s*if \(S === st\) feedMore\(false\);/.test(js), 'leaving the route shows the footer again');
assert.ok(css.includes('html[data-feed-more] #ov-footer { display: none; }'), 'the style');
console.log('feed-footer-after-end: the footer waits for a feed\'s end, so the next page never pushes it out of view');
