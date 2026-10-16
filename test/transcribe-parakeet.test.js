'use strict';
// Parakeet TDT (server/ai/transcribe.js): parakeet-cli's per-token timing (centiseconds) becomes timed sentences: a
// sentence ends at . ? !, a 1.5 s pause or 20 s; "uh"/"um" are dropped; control tokens are skipped; the offset shifts
// every time; languages Parakeet does not know go to whisper, and ASR_ENGINE=whisper forces whisper.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('../server/ai/transcribe');

const tok = (t0, t1, start, s) => `  [ 0] id=    1 frame=  0 dur_idx= 1 dur_val= 1 p=0.9 plog=-1.0 t0=${t0} t1=${t1} word_start=${start} "${s}"`;

// The real output of parakeet-cli -ps on 6 s of stream talk (2026-10-16).
const real = t.parseParakeet(fs.readFileSync(path.join(__dirname, 'fixtures', 'parakeet-tokens.txt'), 'utf8'), 100);
assert.strictEqual(real.length, 1);
assert.strictEqual(real[0].text, "For all I know it said, just it's a blank chip initially they put in and it as soon as it it's");
assert.deepStrictEqual([real[0].start, real[0].end], [100.32, 105.92]);

const lines = [
    'Segments (1):',
    tok(10, 30, true, '▁So'), tok(30, 40, true, '▁uh'), tok(40, 41, false, ','), tok(41, 60, true, '▁he'), tok(60, 80, true, '▁lost'), tok(80, 81, false, '.'),
    tok(90, 100, true, '▁What'), tok(100, 110, true, '▁a'), tok(110, 130, true, '▁clown'), tok(130, 131, false, '?'),
    tok(140, 150, true, '<unk>'),
    tok(150, 170, true, '▁Then'), tok(170, 190, true, '▁silence'),
    tok(400, 420, true, '▁Back'), tok(420, 440, true, '▁again'),
].join('\n');
const out = t.parseParakeet(lines, 10);
assert.deepStrictEqual(out.map((s) => s.text), ['So he lost.', 'What a clown?', 'Then silence', 'Back again']);
assert.deepStrictEqual(out.map((s) => [s.start, s.end]), [[10.1, 10.81], [10.9, 11.31], [11.5, 11.9], [14, 14.4]], 'a 2.1 s pause ends a line');

const long = Array.from({ length: 30 }, (_, i) => tok(i * 100, i * 100 + 50, true, `▁w${i}`)).join('\n');
assert.ok(t.parseParakeet(long).length >= 2, 'no line runs past 20 s');
assert.deepStrictEqual(t.parseParakeet(''), []);

// Engines: without the Parakeet files every language is whisper's; Japanese is always whisper's.
assert.strictEqual(t.engineFor('ja'), 'whisper');
assert.ok(['parakeet', 'whisper'].includes(t.engineFor('en')));
console.log('transcribe-parakeet: ok');
