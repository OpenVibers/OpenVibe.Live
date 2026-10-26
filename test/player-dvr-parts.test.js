/**
 * The live rewind spans every recording part of the stream (public/js/stream-player.js _dvrSpan, _dvrBarTime,
 * _dvrSeekBar, _dvrNudge). Stream 2795 (2026-10-26) was recorded in two parts after its broadcaster reconnected, and the
 * rewind only knew the part being recorded. With the stream's history (GET /api/streams/:id/history) the bar runs from
 * the first part's start to the live edge, in stream time:
 * - a point in the recording part seeks the live recording at that part's time;
 * - a point in an earlier part plays that part's VOD at its own time (never past its end);
 * - with no history the bar is the recording part alone, as before;
 * - nudging by 5 s moves within what is playing, and into the next part across a boundary.
 *
 *   node test/player-dvr-parts.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'stream-player.js'), 'utf8');
function extract(name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = m.index + m[0].length;
    for (let parens = 1; parens; i++) { if (src[i] === '(') parens++; else if (src[i] === ')') parens--; }
    i = src.indexOf('{', i);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

const calls = [];
const video = { currentTime: 0 };
const ctx = { Math, Number, calls, video, updateDVRUI: () => {}, switchToDVR: (t, part = null) => calls.push([Math.round(t * 10) / 10, part ? part.vodId : 'rec']) };
vm.createContext(ctx);
vm.runInContext(['_dvrSpan', '_dvrBarTime', '_dvrSeekBar', '_dvrNudge', '_dvrPartEnded'].map(extract).join('\n'), ctx);

// Stream 2795's shape: part 1 (VOD 6025) from 28 s to 706 s, part 2 recording since 709 s and 900 s long so far.
const part1 = { vodId: 6025, at: 28, end: 706, src: 'https://media.test/o/med_1/master.m3u8', hls: true };
const set = (state) => vm.runInContext(`var dvrState = ${JSON.stringify(state)};`, ctx);
set({ duration: 900, seekable: true, hlsUrl: 'https://media.test/v/6026/dvr.m3u8', vodFile: null, earlier: [part1], activeAt: 709, playingPart: null });

const span = vm.runInContext('_dvrSpan()', ctx);
assert.deepStrictEqual({ ...span }, { start: 28, total: 709 - 28 + 900 }, 'the bar runs from part 1\'s start to the live edge');

vm.runInContext('_dvrSeekBar(1500)', ctx);   // stream 1528 s: part 2 at 819 s
assert.deepStrictEqual(calls.pop(), [819, 'rec']);
vm.runInContext('_dvrSeekBar(100)', ctx);    // stream 128 s: part 1 at 100 s
assert.deepStrictEqual(calls.pop(), [100, 6025]);
vm.runInContext('_dvrSeekBar(679.9)', ctx);  // stream 707.9 s, the reconnect's gap: part 1, just before its end
assert.deepStrictEqual(calls.pop(), [677.5, 6025]);

// The bar time of what plays: part 1 at 650 s is 650 s in; the recording at 10 s is (709 - 28) + 10.
vm.runInContext('dvrState.playingPart = dvrState.earlier[0];', ctx);
video.currentTime = 650;
assert.strictEqual(vm.runInContext('_dvrBarTime(video)', ctx), 650);
vm.runInContext('dvrState.playingPart = null;', ctx);
video.currentTime = 10;
assert.strictEqual(vm.runInContext('_dvrBarTime(video)', ctx), 691);

// Nudging: within the recording part it moves the video; back across the boundary it plays part 1 near its end.
vm.runInContext('_dvrNudge(video, 5)', ctx);
assert.strictEqual(video.currentTime, 15);
assert.strictEqual(calls.length, 0, 'no new source for a move within it');
video.currentTime = 2;
vm.runInContext('_dvrNudge(video, -5)', ctx);   // bar 683 - 5 = 678 → stream 706: part 1 at 677.5 (half a second before its end)
assert.deepStrictEqual(calls.pop(), [677.5, 6025]);

// Part 1 played to its end: on at the start of part 2 (the recording), not back to part 1's end across the gap.
vm.runInContext('dvrState.isLive = false; dvrState.playingPart = dvrState.earlier[0]; _dvrPartEnded();', ctx);
assert.deepStrictEqual(calls.pop(), [0, 'rec']);
// With a part between, the next earlier part.
vm.runInContext(`dvrState.earlier.push(${JSON.stringify({ vodId: 6027, at: 710, end: 800, src: 'https://media.test/v/6027', hls: false })}); dvrState.activeAt = 805; dvrState.playingPart = dvrState.earlier[0]; _dvrPartEnded();`, ctx);
assert.deepStrictEqual(calls.pop(), [0, 6027]);

// No history: the bar is the recording part alone, as before.
set({ duration: 300, seekable: true, hlsUrl: 'https://media.test/v/7/dvr.m3u8', vodFile: null, earlier: [], activeAt: null, playingPart: null });
assert.deepStrictEqual({ ...vm.runInContext('_dvrSpan()', ctx) }, { start: 0, total: 300 });
vm.runInContext('_dvrSeekBar(120)', ctx);
assert.deepStrictEqual(calls.pop(), [120, 'rec']);

// History for a single part (no earlier ones): seconds into the recording, wherever it starts in the stream.
set({ duration: 300, seekable: true, hlsUrl: 'https://media.test/v/7/dvr.m3u8', vodFile: null, earlier: [], activeAt: 40, playingPart: null });
vm.runInContext('_dvrSeekBar(120)', ctx);
assert.deepStrictEqual(calls.pop(), [120, 'rec']);
video.currentTime = 50;
assert.strictEqual(vm.runInContext('_dvrBarTime(video)', ctx), 50);

console.log('player dvr parts: ok');
