/**
 * One unreadable segment must not take audio-event detection down for good.
 *
 * ffmpeg writes a zero-byte WAV when a segment has no decodable audio. The RIFF walk
 * found no data chunk, fell back to assuming a 44-byte header, and computed a NEGATIVE
 * sample count — so `new Float32Array(-22)` threw. That throw landed in a catch whose job
 * was to disable the feature when the MODEL is broken, so a single bad segment set
 * _loadFailed and every later segment on the box was skipped, blaming a model that was
 * fine. Production ran this way: "[AI-Timeline] audio-events disabled: Invalid typed
 * array length: -22".
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const audioEvents = require('../server/ai/audio-events');
const src = fs.readFileSync(path.join(__dirname, '../server/ai/audio-events.js'), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-audio-events-'));
const write = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };

// A RIFF/WAVE header with no data chunk at all, and one that stops mid-header.
const headerOnly = Buffer.alloc(12);
headerOnly.write('RIFF', 0, 'ascii');
headerOnly.writeUInt32LE(4, 4);
headerOnly.write('WAVE', 8, 'ascii');

(async () => {
    // ── A: the shapes ffmpeg actually produces are handled, not thrown on ──────────────
    const bad = {
        'empty.wav': Buffer.alloc(0),
        'header-only.wav': headerOnly,
        'truncated.wav': headerOnly.subarray(0, 9),
    };
    // Straight at the parser: detect() short-circuits when the model file is absent, so
    // going through it would assert nothing on a machine without one.
    for (const [name, buf] of Object.entries(bad)) {
        const samples = audioEvents._wavToFloat32(write(name, buf));
        assert.strictEqual(samples.length, 0, `${name} must read as zero samples, not throw`);
    }
    console.log('OK A: empty, header-only and truncated WAVs read as zero samples');

    // ── A2: a well-formed file still reads correctly ──────────────────────────────────
    {
        const samples = 3;
        const wav = Buffer.alloc(44 + samples * 2);
        wav.write('RIFF', 0, 'ascii');
        wav.writeUInt32LE(36 + samples * 2, 4);
        wav.write('WAVEfmt ', 8, 'ascii');
        wav.writeUInt32LE(16, 16);
        wav.write('data', 36, 'ascii');
        wav.writeUInt32LE(samples * 2, 40);
        for (const [i, v] of [0, 32767, -32768].entries()) wav.writeInt16LE(v, 44 + i * 2);
        const out = audioEvents._wavToFloat32(write('good.wav', wav));
        assert.strictEqual(out.length, samples, 'a real data chunk must yield its samples');
        assert.strictEqual(out[0], 0);
        assert.ok(out[1] > 0.99 && out[1] <= 1, 'full-scale positive maps into [0,1]');
        assert.strictEqual(out[2], -1, 'full-scale negative maps to -1');
        console.log('OK A2: a well-formed WAV still reads its samples correctly');
    }

    // ── A3: and detect() itself stays quiet on a bad file ─────────────────────────────
    assert.deepStrictEqual(await audioEvents.detect(path.join(tmp, 'empty.wav'), { offsetSec: 0 }), [],
        'detect() must return no events for an unreadable segment');
    console.log('OK A3: detect() returns no events for an unreadable segment');

    // ── B: and the feature is still alive afterwards ──────────────────────────────────
    // available() is the gate every later segment passes through. If a bad file flipped
    // _loadFailed, this is false and audio events are gone until the process restarts.
    const modelPresent = fs.existsSync(audioEvents.MODEL_PATH) && fs.existsSync(audioEvents.CLASSMAP_PATH);
    if (modelPresent) {
        assert.strictEqual(audioEvents.available(), true,
            'a bad segment must not disable detection for every segment that follows');
        console.log('OK B: detection still available after a bad segment');
    } else {
        console.log('OK B: skipped — no local model to check availability against');
    }

    // ── C: only a model load failure is allowed to be permanent ───────────────────────
    const loadFail = src.indexOf('_loadFailed = true');
    assert.ok(loadFail > 0, '_loadFailed must still exist');
    assert.strictEqual(src.split('_loadFailed = true').length - 1, 1,
        'exactly one place may disable the feature permanently');
    const guard = src.slice(src.lastIndexOf('try {', loadFail), loadFail);
    assert.ok(/_session_\(\)/.test(guard), 'the permanent failure must come from loading the model');
    assert.ok(!/_wavToFloat32/.test(guard) && !/session\.run/.test(guard),
        'reading a segment or running inference on it must not be able to disable the feature');
    console.log('OK C: only model loading can disable detection permanently');

    // ── D: a negative sample count cannot reach the allocator ─────────────────────────
    assert.ok(/Math\.max\(0, Math\.floor\(/.test(src),
        'the sample count must be clamped before it reaches new Float32Array');
    console.log('OK D: sample count is clamped at zero');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('✅ audio events bad segment test passed');
})().catch((e) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error('FAIL', e.message);
    process.exit(1);
});
