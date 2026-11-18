'use strict';
// An agent stream's chapter links (public/js/agent-stream.js): the watch page's link already carries ?v=<id>, so the
// chapter's second joins with &t=. On 2026-11-18 openvibe.video answered 404 to links shaped /watch?v=<id>?t=99.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'agent-stream.js'), 'utf8');
assert.ok(!/\$\{vodBase\}\?t=/.test(src), 'a chapter link never appends ?t= to a base that may already have a query');
const line = src.split('\n').find((l) => l.includes('time.href = vodBase'));
assert.ok(line, 'the chapter link is built from vodBase');
// The expression the page uses, run on both kinds of base.
const expr = /time\.href = (vodBase \? `[^`]+` : '#');/.exec(line);
assert.ok(expr, `the chapter link expression: ${line.trim()}`);
const linkFor = (vodBase, at) => new Function('vodBase', 'chapter', `return ${expr[1]};`)(vodBase, { at });
assert.strictEqual(linkFor('https://openvibe.video/watch?v=abcdefghijk', 99), 'https://openvibe.video/watch?v=abcdefghijk&t=99');
assert.strictEqual(linkFor('https://openvibe.video/v/6613', 725.6), 'https://openvibe.video/v/6613?t=725');
assert.strictEqual(linkFor(null, 5), '#');
console.log('agent chapter links: ok');
