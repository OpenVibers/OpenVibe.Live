'use strict';
// Long audio goes to Parakeet in 30 s pieces (server/ai/transcribe.js): a 70 s WAV is cut into three, each decoded on
// its own, and each piece's lines shift by where the piece starts. A stand-in parakeet-cli (a script that says "word"
// one second into whatever it is given) stands in for the real one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-pk-chunks-'));
const bin = path.join(dir, 'parakeet-cli');
const calls = path.join(dir, 'calls.log');
fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${calls}\necho '  [ 0] id=    1 frame=  0 dur_idx= 1 dur_val= 1 p=0.9 plog=-1 t0= 100 t1= 150 word_start=true "\u2581Word."' 1>&2\n`);
fs.chmodSync(bin, 0o755);
const model = path.join(dir, 'model.bin');
fs.writeFileSync(model, 'x');
process.env.PARAKEET_BIN = bin;
process.env.PARAKEET_MODEL = model;
const t = require('../server/ai/transcribe');

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
(async () => {
    assert.strictEqual(t.engineFor('en'), 'parakeet');
    if (!ffmpeg) { console.log('transcribe-parakeet-chunks: ffmpeg not installed here, chunking not exercised'); return; }
    const wav = path.join(dir, 'long.wav');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '70', '-c:a', 'pcm_s16le', wav]);
    const r = await t.transcribeWavDetailed(wav, { offsetSec: 100, timeoutMs: 60000 });
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual(r.segments.map((s) => s.start), [101, 131, 161], 'each 30 s piece shifted by its start');
    assert.strictEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 3, 'three pieces, three runs');
    const short = path.join(dir, 'short.wav');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '10', '-c:a', 'pcm_s16le', short]);
    const s = await t.transcribeWavDetailed(short, { offsetSec: 0 });
    assert.deepStrictEqual(s.segments.map((x) => [x.start, x.text]), [[1, 'Word.']], 'short audio: one run, no split');
    assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith('openvibe-pk-') && fs.existsSync(path.join(os.tmpdir(), n, 'p0000.wav'))), 'pieces are cleaned up');
    console.log('transcribe-parakeet-chunks: ok');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
