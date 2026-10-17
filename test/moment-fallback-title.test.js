'use strict';
/**
 * The title an auto clip or AI moment gets when the AI gives none (server/ai/ai-moments-job.js): the stream's own
 * title and the moment's time. The first words of a frame caption were used before and titled public clips
 * "A Man With A Beard Is Speaking To" (cut off mid-sentence, and about how someone looks).
 *
 *   node --import ./test/helpers/pg-preload.mjs test/moment-fallback-title.test.js
 */
const assert = require('assert');
console.warn = () => {};
console.log = () => {};

const { fallbackTitle } = require('../server/ai/ai-moments-job')._internals;
assert.strictEqual(fallbackTitle({ title: 'Fortnite!' }, 2480), 'Fortnite! at 41:20');
assert.strictEqual(fallbackTitle({ title: '', username: 'goosely' }, 75), "goosely's stream at 1:15");
assert.strictEqual(fallbackTitle({}, 0), 'Stream at 0:00');
assert.ok(fallbackTitle({ title: 'x'.repeat(200) }, 59).length <= 80, 'at most 80 characters');
// The module no longer builds titles from frame captions.
const src = require('fs').readFileSync(require('path').join(__dirname, '../server/ai/ai-moments-job.js'), 'utf8');
assert.ok(!/_titleFromDesc/.test(src), 'no caption-derived titles');
process.stdout.write('moment fallback title: all checks passed\n');
process.exit(0);
