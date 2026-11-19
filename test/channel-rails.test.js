/**
 * The channel page's rails measure together (public/js/app-channel.js _railFrame; 2026-11-19: each rail read its size
 * and changed its arrows in a frame of its own, so every rail after the first laid the page out again, 254 ms at 4x
 * CPU on a channel's first load):
 *   - several rails waiting make one frame, not one each;
 *   - every rail's measure (reads) runs before any rail's write;
 *   - one rail's failing measure does not stop the others;
 *   - a rail asked for again during the frame waits for the next one.
 *
 *   node test/channel-rails.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
const block = /const _railWaiting = new Set\(\);[\s\S]*?\nfunction _railFrame\(measure\) \{[\s\S]*?\n\}/.exec(src);
assert.ok(block, '_railFrame is in app-channel.js');
assert.match(src, /_railFrame\(update\);/, 'a rail asks for its first measure through it');
assert.ok(!/requestAnimationFrame\(update\)/.test(src), 'no rail measures in a frame of its own');

const frames = [];
const ctx = { requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; } };
vm.runInNewContext(`${block[0]}; this.frame = _railFrame;`, ctx);

const log = [];
const rail = (name, { fail = false } = {}) => () => { log.push(`read ${name}`); if (fail) throw new Error('gone'); return () => log.push(`write ${name}`); };
const a = rail('a'), b = rail('b'), c = rail('c', { fail: true });
ctx.frame(a); ctx.frame(b); ctx.frame(a); ctx.frame(c);
assert.strictEqual(frames.length, 1, 'one frame for every waiting rail');
frames.shift()();
assert.deepStrictEqual(log, ['read a', 'read b', 'read c', 'write a', 'write b'], 'all reads, then the writes; a failing rail is skipped');

log.length = 0;
const late = () => { log.push('read late'); return () => log.push('write late'); };
const again = () => { log.push('read again'); ctx.frame(late); return () => log.push('write again'); };
ctx.frame(again);
frames.shift()();
assert.deepStrictEqual(log, ['read again', 'write again'], 'a rail asked for during the frame is not run in it');
assert.strictEqual(frames.length, 1, 'it waits for the next frame');
frames.shift()();
assert.deepStrictEqual(log.slice(2), ['read late', 'write late']);
console.log('channel-rails: one frame, every read before any write, failures skipped, late asks wait');
