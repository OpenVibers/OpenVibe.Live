/**
 * Regression: the RS passthrough relay must forward ONLY the consumer's media SSRC.
 *
 * mediasoup's RTP probation generator emits bandwidth-probing padding on a fixed
 * ssrc=1234 / payloadType=127, and it arrives on the same plain-transport socket as the
 * media. The relay used to forward every packet on that socket: it rewrote the payload
 * type to the video PT so the padding looked like H264, werift rewrote the SSRC to the
 * sender's, and the probation packet's SEQUENCE NUMBER went out unchanged.
 *
 * RobotStreamer therefore saw one video stream whose sequence jumped ~18000 back and
 * forth several times a second. Their mediasoup (pre-3.12 — it still advertises the
 * framemarking extensions removed in 3.12) treats a jump past MaxDropout(3000) as a
 * "very large jump": discard the packet, arm badSeq, and keep computing `expected` from a
 * max_seq that has been dragged into the probation range. That inflates loss to ~72%,
 * collapses the producer score to 0, and deactivates every consumer — video stops
 * reaching viewers while audio (a separate SSRC, no probation on it) keeps playing.
 *
 * This test asserts the filter drops foreign SSRCs and that the surviving sequence
 * numbers stay monotonic, which is the property RS's sequence accounting depends on.
 */
const assert = require('assert');

const MEDIA_SSRC = 378058538;
const PROBATION_SSRC = 1234;      // RTC::RtpProbationGenerator
const PROBATION_PT = 127;
const VIDEO_PT = 103;

/** The relay's ingest guard, mirrored exactly. */
function accept(expectedSsrc, pkt) {
    return !(expectedSsrc != null && pkt.ssrc !== expectedSsrc);
}

// A realistic ingest burst: contiguous media interleaved with probation padding whose
// sequence numbers sit ~18000 away, which is what was measured on the live socket.
const ingest = [];
let mediaSeq = 39276, probSeq = 62728;
for (let i = 0; i < 600; i++) {
    ingest.push({ ssrc: MEDIA_SSRC, pt: VIDEO_PT, seq: mediaSeq++ & 0xffff });
    if (i % 40 === 39) ingest.push({ ssrc: PROBATION_SSRC, pt: PROBATION_PT, seq: probSeq++ & 0xffff });
}

// ── Without the filter: reproduce the corruption ────────────────────────────────────
const unfiltered = ingest.slice();
let bigJumps = 0, prev = null;
for (const p of unfiltered) {
    if (prev !== null) {
        const adv = (p.seq - prev) & 0xffff;
        if (adv >= 3000 && adv <= 65536 - 100) bigJumps++;   // mediasoup MaxDropout / MaxMisorder
    }
    prev = p.seq;
}
assert.ok(bigJumps > 0, 'expected the unfiltered stream to contain mediasoup-fatal sequence jumps');
console.log(`OK A: unfiltered ingest produces ${bigJumps} sequence jumps past MaxDropout — the corruption`);

// ── With the filter: clean, monotonic media only ────────────────────────────────────
const filtered = ingest.filter(p => accept(MEDIA_SSRC, p));
assert.strictEqual(filtered.length, 600, 'filter must keep every media packet');
assert.ok(filtered.every(p => p.ssrc === MEDIA_SSRC), 'no foreign SSRC may survive the filter');
assert.ok(filtered.every(p => p.pt === VIDEO_PT), 'no foreign payload type may survive the filter');

let jumpsAfter = 0; prev = null;
for (const p of filtered) {
    if (prev !== null) {
        const adv = (p.seq - prev) & 0xffff;
        if (adv >= 3000 && adv <= 65536 - 100) jumpsAfter++;
    }
    prev = p.seq;
}
assert.strictEqual(jumpsAfter, 0, 'filtered stream must contain NO mediasoup-fatal sequence jumps');
console.log('OK B: filtered ingest is contiguous — zero jumps past MaxDropout');

// ── The guard must not disarm when the SSRC is unknown ──────────────────────────────
assert.ok(accept(null, { ssrc: PROBATION_SSRC }), 'unknown expected SSRC must fall back to forwarding');
assert.ok(!accept(MEDIA_SSRC, { ssrc: MEDIA_SSRC + 1 }), 'a near-miss SSRC must still be rejected');
assert.ok(accept(MEDIA_SSRC, { ssrc: MEDIA_SSRC }), 'the media SSRC must always pass');
console.log('OK C: guard edge cases (unknown ssrc, near-miss, exact match)');

// ── The relay must actually contain the guard ───────────────────────────────────────
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../server/integrations/rs-passthrough-relay.js'), 'utf8');
assert.ok(src.includes('const vSsrcExpect = videoIn.ssrc'), 'relay must derive the expected video SSRC from the consumer');
assert.ok(src.includes('p.header.ssrc !== vSsrcExpect'), 'relay must drop video packets from a foreign SSRC');
assert.ok(src.includes('p.header.ssrc !== aSsrcExpect'), 'relay must drop audio packets from a foreign SSRC');
assert.ok(/ssrc: info\.ssrc/.test(src), 'openPlainIngest must propagate the consumer SSRC');
console.log('OK D: rs-passthrough-relay.js carries the SSRC guard on both ingests');

console.log('✅ RS passthrough SSRC-filter regression test passed');
