'use strict';
// What was heard, as caption cues (item 151, C15; server/ai/sound-captions.js): a short list of tags, each from a
// classifier label above its own bar, nothing written by a model. A burst is one cue; background music gives one cue
// where it starts; explosions and gunfire only where they are rare (in a shooter they are the game); the classifier's
// long tail is never captioned.
const assert = require('assert');
const sc = require('../server/ai/sound-captions');
const ev = (start_sec, label, confidence, end_sec) => ({ start_sec, end_sec, label, confidence });

assert.deepStrictEqual(sc.cues([ev(10, 'Laughter', 0.9, 11), ev(12, 'Giggle', 0.8, 13.2), ev(30, 'Laughter', 0.75)]),
    [{ start: 10, end: 13.2, text: '[laughter]' }, { start: 30, end: 31.5, text: '[laughter]' }], 'a burst is one cue; one 17 s later is another');
assert.deepStrictEqual(sc.cues([ev(10, 'Laughter', 0.6), ev(20, 'Applause', 0.69)]), [], 'below the bars, nothing');
assert.deepStrictEqual(sc.cues([ev(5, 'Vehicle', 0.95), ev(6, 'Animal', 0.95), ev(7, 'Glass', 0.95), ev(8, 'Speech', 0.99)]), [], 'the long tail is never captioned');
assert.deepStrictEqual(sc.cues([ev(100, 'Applause', 0.8, 160)]), [{ start: 100, end: 106, text: '[applause]' }], 'a cue lasts at most 6 s');
assert.deepStrictEqual(sc.cues([ev(0, 'Music', 0.7, 300), ev(302, 'Music', 0.7, 400), ev(500, 'Music', 0.4, 600)]),
    [{ start: 0, end: 3, text: '[music]' }, { start: 302, end: 305, text: '[music]' }], 'one cue where music starts, not under every line');

// Explosions: captioned from 0.85, and only where rare in the stream.
const shooter = Array.from({ length: 40 }, (_, i) => ev(i * 90, 'Explosion', 0.9, i * 90 + 1));
assert.deepStrictEqual(sc.cues(shooter, { spanSec: 3600 }), [], '40 explosions an hour are the game');
assert.deepStrictEqual(sc.cues([ev(50, 'Explosion', 0.9, 51), ev(70, 'Gunshot, gunfire', 0.84)], { spanSec: 3600 }),
    [{ start: 50, end: 51.5, text: '[explosion]' }], 'one rare explosion is news; gunfire below 0.85 is not captioned');
assert.deepStrictEqual(sc.cues(null), []);
assert.strictEqual(sc.tagOf('Dog').tag, 'dog barking');
console.log('sound captions: all checks passed');
