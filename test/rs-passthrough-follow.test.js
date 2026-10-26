/**
 * The RobotStreamer relay follows a broadcaster who reconnects (the owner, 2026-10-26: "while it was visible on
 * openvibe.live, it was a black screen on robot stream, and I had to end and restart the stream").
 *
 * Stream 2781: the broadcaster's network dropped and they produced again on a new transport while the old producers
 * stayed open on the dead one. Viewers moved to the new producer (findProducerByKind, the 10-22 fix); the relay had
 * sampled the producer once at start and forwarded the dead one for 32 minutes, logging STALLED every ten seconds.
 *
 * Now the relay moves its ingest to the producer viewers get (a producer added in the room, ours closed, or a stall)
 * and keeps its RS producer, SSRC and consumer, so RS sees one stream with a pause in it rather than the cut a restart
 * causes. These checks pin:
 *   - the rebase: after a switch, RS's sequence goes on at last + 1 and its clock advances by the time that passed,
 *     across 16-bit and 32-bit wrap-around, and a reordered packet never moves "last" back;
 *   - a simulated reconnect: source A then source B (unrelated sequence and clock) reach RS as one contiguous stream;
 *   - the wiring: removal of a stale producer is ignored, the follower decides once forwarding, and a teardown
 *     removes its listener.
 *
 *   node test/rs-passthrough-follow.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};

const relay = require('../server/integrations/rs-passthrough-relay');
const { rebaseFor, applyRebase, advanceLast } = relay._internals;

// ── The helpers ──
assert.strictEqual(rebaseFor(null, { sequenceNumber: 5, timestamp: 9 }, 0, 90000), null, 'nothing sent yet: no rebase');
let rb = rebaseFor({ seq: 1000, ts: 500000, at: 10_000 }, { sequenceNumber: 40000, timestamp: 7 }, 10_500, 90000);
let h = { sequenceNumber: 40000, timestamp: 7 };
applyRebase(h, rb);
assert.deepStrictEqual(h, { sequenceNumber: 1001, timestamp: 500000 + 45000 }, 'continues at last + 1, clock + 0.5 s of 90 kHz');
// Wrap-around both ways.
rb = rebaseFor({ seq: 65535, ts: 0xffffff00, at: 0 }, { sequenceNumber: 12, timestamp: 0x10 }, 20, 48000);
h = { sequenceNumber: 12, timestamp: 0x10 };
applyRebase(h, rb);
assert.strictEqual(h.sequenceNumber, 0, '65535 + 1 wraps to 0');
assert.strictEqual(h.timestamp, (0xffffff00 + 960) >>> 0, 'the clock wraps at 2^32 (20 ms of 48 kHz)');
// The clock always moves forward, even for a switch within the same millisecond.
rb = rebaseFor({ seq: 1, ts: 100, at: 5 }, { sequenceNumber: 9, timestamp: 9 }, 5, 90000);
h = { sequenceNumber: 9, timestamp: 9 }; applyRebase(h, rb);
assert.ok(h.timestamp > 100);
// "last" only moves forward.
let last = advanceLast(null, { sequenceNumber: 100, timestamp: 1 }, 1);
last = advanceLast(last, { sequenceNumber: 98, timestamp: 0 }, 2);
assert.strictEqual(last.seq, 100, 'a reordered older packet leaves it');
last = advanceLast(last, { sequenceNumber: 101, timestamp: 2 }, 3);
assert.strictEqual(last.seq, 101);
last = advanceLast({ seq: 65535, ts: 1, at: 0 }, { sequenceNumber: 0, timestamp: 2 }, 1);
assert.strictEqual(last.seq, 0, 'across the wrap');

// ── A reconnect, as the handler sees it: source A, a pause, then source B ──
function forward(packets, state) {
    const out = [];
    for (const { seq, ts, at, src } of packets) {
        const p = { sequenceNumber: seq, timestamp: ts };
        if (state.pending && src !== state.src) { state.pending = false; state.src = src; state.rb = rebaseFor(state.last, p, at, 90000); }
        applyRebase(p, state.rb);
        state.last = advanceLast(state.last, p, at);
        out.push({ ...p, at });
    }
    return out;
}
const A = Array.from({ length: 300 }, (_, i) => ({ seq: (64000 + i) & 0xffff, ts: (4294000000 + i * 3000) >>> 0, at: i * 33, src: 'A' }));
const B = Array.from({ length: 300 }, (_, i) => ({ seq: 1200 + i, ts: 77 + i * 3000, at: 9900 + 25000 + i * 33, src: 'B' }));   // 25 s later
const state = { last: null, rb: null, pending: false, src: 'A' };
const outA = forward(A, state);
state.pending = true;   // the follower switched the ingest
const outB = forward(B, state);
const all = outA.concat(outB);
for (let i = 1; i < all.length; i++) {
    assert.strictEqual(all[i].sequenceNumber, (all[i - 1].sequenceNumber + 1) & 0xffff, `contiguous sequence at ${i}`);
}
const tsStep = ((outB[0].timestamp - outA[outA.length - 1].timestamp) >>> 0);
const gapMs = B[0].at - A[A.length - 1].at;
assert.ok(Math.abs(tsStep - gapMs * 90) <= 1, `the clock jumps by the pause, ${gapMs} ms (${tsStep} ticks)`);
assert.strictEqual(((outB[1].timestamp - outB[0].timestamp) >>> 0), 3000, 'and runs at its own rate after it');

// ── The wiring ──
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'integrations', 'rs-passthrough-relay.js'), 'utf8');
assert.match(src, /const onProducerRemoved = \(\{ roomId, kind, producerId \}\) => \{[\s\S]{0,300}if \(session\.follow\) \{ session\.follow\.removed\(kind, producerId\); return; \}[\s\S]{0,300}producerId !== videoProd\.id/,
    'a producer that is not ours going away is ignored; once forwarding, the follower decides');
assert.match(src, /removed: \(kind, producerId\) => \{[\s\S]{0,200}producerId !== cur\.producerId\)\) return;/, 'the follower ignores a stale producer closing');
assert.match(src, /REPLACE_WAIT_MS[\s\S]*_scheduleRestart\(session, 'source video producer removed'\)/, 'no replacement in time: the old restart path');
assert.match(src, /sfu\.on\?\.\('producer-added', onFollowAdded\)/);
assert.match(src, /session\.follow\.stalled\('video', now - _videoStalledSince\)/, 'a stall looks for a newer producer');
assert.match(src, /if \(session\._followWatch\) \{ try \{ session\._followWatch\(\); \}/, 'teardown removes the follower');
assert.match(src, /if \(kind === 'video'\) \{ videoIn = next; vSsrcExpect = next\.ssrc; _vPendingRebase = true;/, 'the new source is accepted (its SSRC) and rebased');
assert.match(src, /source video codec changed/, 'a codec change still restarts (RS was told one codec)');

quiet('rs passthrough follow: all checks passed');
process.exit(0);
