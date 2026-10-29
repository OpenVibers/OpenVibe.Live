'use strict';
// server/ai/clip-score.js and server/ai/clip-trim.js: an automatic clip is cut only when the moment scores above a bar
// (public above a higher one, unlisted between), and starts and ends on sentences.
const assert = require('assert');
const { score, BARS } = require('../server/ai/clip-score');
const { trim } = require('../server/ai/clip-trim');

// ── Scoring ──
{
    const strong = score({ spike: { peak: 34, avg: 5 }, chatters: 12, sounds: [{ label: 'Laughter', confidence: 0.9 }], speechWords: 35, ai: { clip: true } });
    assert.strictEqual(strong.verdict, 'public', JSON.stringify(strong));
    assert.ok(strong.score >= BARS.public && strong.reasons.some((r) => /Laughter/.test(r)), 'a big, broad spike with laughter is public, and says what it heard');

    const fair = score({ spike: { peak: 14, avg: 5 }, chatters: 5, sounds: [], speechWords: 20, ai: { clip: true } });
    assert.strictEqual(fair.verdict, 'unlisted', `a fair moment is kept unlisted (${fair.score})`);

    const weak = score({ spike: { peak: 7, avg: 4 }, chatters: 2, sounds: [], speechWords: 3, ai: { clip: true } });
    assert.strictEqual(weak.verdict, 'skip', `the AI saying yes does not save a weak moment (${weak.score})`);
    assert.ok(weak.reasons.some((r) => /weak chat spike/.test(r)) && weak.reasons.some((r) => /only 2 people/.test(r)), 'it says why');

    const vetoed = score({ spike: { peak: 60, avg: 5 }, chatters: 20, sounds: [{ label: 'Cheering', confidence: 1 }], speechWords: 40, ai: { clip: false } });
    assert.strictEqual(vetoed.verdict, 'skip', "the AI's no is a veto, however loud the room");

    const aiOff = score({ spike: { peak: 14, avg: 5 }, chatters: 5, speechWords: 20, ai: { clip: null } });
    const aiOn = score({ spike: { peak: 14, avg: 5 }, chatters: 5, speechWords: 20, ai: { clip: true } });
    assert.ok(aiOff.score < aiOn.score && aiOff.verdict === 'skip', 'with the AI off its part is neutral and the bars rise');

    const music = score({ spike: { peak: 20, avg: 5 }, sounds: [{ label: 'Music', confidence: 1 }, { label: 'Speech', confidence: 1 }], ai: { clip: true } });
    assert.strictEqual(music.parts.sound, 0, 'music and speech are not a moment by themselves');
    assert.strictEqual(score({ spike: { peak: 20, avg: 5 }, ai: { clip: true } }).parts.breadth, score({ spike: { peak: 20, avg: 5 }, ai: { clip: true } }).parts.spike, 'unknown chatters follow the spike');
    assert.strictEqual(score().verdict, 'skip', 'nothing is nothing');
}

// ── Trimming ──
{
    const rows = [
        { start: 100, end: 106.5, text: 'So I said we should try the bridge.' },
        { start: 106.5, end: 112, text: 'Everyone told me it would not hold.' },
        { start: 112, end: 117.4, text: 'And then it held, and we all screamed!' },
        { start: 118, end: 124, text: 'Look at chat right now.' },
    ];
    // The moment is the scream at 115: the fixed window is 99..124; snapped to rows it is 100 (the setup) .. 124.
    const t = trim({ moment: 115, segments: rows });
    assert.deepStrictEqual([t.start, t.end, t.snapped], [100, 124, true], JSON.stringify(t));
    // A row without an end runs to the next row's start.
    const noEnd = trim({ moment: 115, segments: rows.map((r) => ({ ...r, end: null })) });
    assert.strictEqual(noEnd.start, 100);
    // The live edge caps the end.
    const edge = trim({ moment: 115, segments: rows, limit: 119 });
    assert.ok(edge.end <= 119, `never past the flushed edge (${edge.end})`);
    // No speech near the moment: the fixed window, unchanged.
    assert.deepStrictEqual(trim({ moment: 300, segments: rows }), { start: 284, end: 309, snapped: false });
    assert.deepStrictEqual(trim({ moment: 300, segments: [] }), { start: 284, end: 309, snapped: false });
    // A monologue row that began long before the moment is not followed back (more than maxLead).
    const mono = trim({ moment: 150, segments: [{ start: 100, end: 160, text: 'A very long uninterrupted rant about everything at once.' }] });
    assert.strictEqual(mono.start, 134, 'the fixed start stays when the row began too early');
    // A snapped window outside min..max falls back to the fixed one.
    const long = trim({ moment: 115, segments: rows, max: 20 });
    assert.deepStrictEqual([long.start, long.end, long.snapped], [99, 124, false], 'a snap that makes the clip too long is not taken');
    assert.strictEqual(trim({ moment: 5, segments: rows }).start, 0, 'never before the start of the recording');
}

console.log('clip score and trim: all checks passed');
