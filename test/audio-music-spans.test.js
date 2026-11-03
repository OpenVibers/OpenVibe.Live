/**
 * Background music is one span with hysteresis, not a flicker of frames (server/ai/audio-events.js; item 151, C14):
 * it starts after ~1.4 s of confident music and ends after ~2.9 s without, is kept only when it lasted 5 s, never
 * counts against the per-segment cap, and never feeds the clip picker or the moments as a highlight.
 *
 *   node test/run.js audio-music-spans
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ae = require('../server/ai/audio-events');

const labels = ['Music', 'Laughter', 'Speech'];
const HOP = 0.48;
/** frames × 3 scores from a per-frame [music, laughter, speech] list. */
function scoresOf(rows) {
    const out = new Float32Array(rows.length * labels.length);
    rows.forEach((r, f) => r.forEach((v, c) => { out[f * labels.length + c] = v; }));
    return out;
}
const run = (rows, offsetSec = 100) => ae.eventsFromScores(scoresOf(rows), rows.length, labels.length, labels, { offsetSec, minConfidence: 0.35 });

// 30 frames (14.4 s) of music with a 2-frame dip in the middle: one span, not two.
const music = Array.from({ length: 30 }, (_, f) => [f === 14 || f === 15 ? 0.1 : 0.7, 0, 0]);
let ev = run(music);
let m = ev.filter((e) => e.label === 'Music');
assert.strictEqual(m.length, 1, 'one span across a short dip');
assert.strictEqual(m[0].background, true);
assert.strictEqual(m[0].start, 100, 'starts where the confident run began');
assert.ok(m[0].end - m[0].start >= 13.5, `lasts the whole run (${m[0].end - m[0].start})`);
assert.strictEqual(m[0].confidence, 0.7);

// A 2-second jingle (4 frames) is below MUSIC_MIN_SEC: no span. A flicker (alternating frames) never starts one.
assert.deepStrictEqual(run(Array.from({ length: 4 }, () => [0.9, 0, 0])).filter((e) => e.label === 'Music'), []);
assert.deepStrictEqual(run(Array.from({ length: 30 }, (_, f) => [f % 2 ? 0.9 : 0.1, 0, 0])).filter((e) => e.label === 'Music'), []);

// Two pieces of music with a long silence between them: two spans.
const two = [...Array.from({ length: 14 }, () => [0.8, 0, 0]), ...Array.from({ length: 10 }, () => [0.05, 0, 0]), ...Array.from({ length: 14 }, () => [0.8, 0, 0])];
m = run(two).filter((e) => e.label === 'Music');
assert.strictEqual(m.length, 2, 'two spans');

// Laughter over music: both, and the laughter is an ordinary event (Music never a per-frame event).
const laughOverMusic = Array.from({ length: 20 }, (_, f) => [0.6, f >= 5 && f <= 8 ? 0.8 : 0, 0]);
ev = run(laughOverMusic);
assert.ok(ev.some((e) => e.label === 'Laughter' && !e.background), 'laughter is a moment');
assert.strictEqual(ev.filter((e) => e.label === 'Music').length, 1);
assert.ok(ev.every((e, i) => i === 0 || ev[i - 1].start <= e.start), 'in time order');

// Music never feeds the clip picker or the moments as a highlight.
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'ai', f), 'utf8');
assert.match(src('auto-clip-job.js'), /e\.label !== 'Music'/);
assert.match(src('ai-moments-job.js'), /e\.label !== 'Music'/);
console.log('audio music spans: all checks passed');
