/**
 * Free RTP/RTCP port-pair allocation for PlainTransport consumers.
 *
 * The AI capture paths used to pick their port arithmetically:
 *
 *   const rtpPort = 26300 + ((stream.id * 2 + Math.floor(Math.random() * 20) * 2) % 300);
 *
 * which only jitters across 20 slots and takes no notice of whether the port is actually
 * free. Two captures of the same stream that overlap, or two streams whose ids land on the
 * same slot, silently point mediasoup at a socket somebody else already owns — and because
 * mediasoup PlainTransports are connect()ed, the loser gets the winner's RTP (or ICMP
 * unreachables) rather than an error. That is the kind of fault that shows up much later as
 * "the video just stopped" in a downstream forwarder.
 *
 * These allocations are inherently last-moment: we hand the port to ffmpeg, which binds it
 * a few milliseconds later, so nothing can hold a hard reservation. Probing for a genuinely
 * free consecutive pair still removes the systematic collision and leaves only a narrow race.
 */
const dgram = require('node:dgram');

// Probing cannot RESERVE a port — we close the socket before handing the number to ffmpeg —
// so two callers racing inside this process would happily be given the same "free" port.
// A short-lived claim closes that window, which is the exact collision the old
// stream.id-derived arithmetic suffered from (overlapping captures of one stream).
// The TTL only has to outlive the gap between allocating and ffmpeg binding.
const CLAIM_TTL_MS = 15000;
const _claimed = new Map();   // port -> expiry timestamp

function isClaimed(port, now) {
    const until = _claimed.get(port);
    if (until === undefined) return false;
    if (until <= now) { _claimed.delete(port); return false; }
    return true;
}

/** Bind one UDP port on loopback, resolving true if it was free. */
function probe(port) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const fail = () => { try { sock.close(); } catch { /* */ } resolve(false); };
        sock.once('error', fail);
        try {
            sock.bind(port, '127.0.0.1', () => {
                sock.removeListener('error', fail);
                sock.close(() => resolve(true));
            });
        } catch { fail(); }
    });
}

/**
 * Find a free (rtpPort, rtcpPort=rtpPort+1) pair inside [base, base+span).
 * RTP ports are kept even by convention, so the pair never straddles two allocations.
 *
 * Starts at a random slot (so concurrent callers rarely race for the same port) but then
 * sweeps the WHOLE range, so it only fails when the range is genuinely full rather than
 * when a random probe run happened to land on a busy stretch.
 *
 * @param {number} base   first port to consider (should be even)
 * @param {number} span   how many ports the range covers
 * @param {number} tries  cap on slots tested; defaults to the whole range
 * @returns {Promise<{rtpPort:number, rtcpPort:number}>}
 */
async function allocateRtpPair(base, span = 300, tries = 0) {
    const slots = Math.max(1, Math.floor(span / 2));
    const limit = tries > 0 ? Math.min(tries, slots) : slots;
    const start = Math.floor(Math.random() * slots);
    for (let i = 0; i < limit; i++) {
        const rtpPort = base + (((start + i) % slots) * 2);
        const rtcpPort = rtpPort + 1;
        const now = Date.now();
        if (isClaimed(rtpPort, now) || isClaimed(rtcpPort, now)) continue;
        // Claim BEFORE probing. probe() awaits, and a concurrent caller runs during that
        // await — if the claim were recorded after the probes, both callers would probe the
        // same free port, both succeed, and both be handed it. Claiming first is the only
        // point in this function that is atomic with respect to the check above.
        const until = now + CLAIM_TTL_MS;
        _claimed.set(rtpPort, until);
        _claimed.set(rtcpPort, until);
        if (await probe(rtpPort) && await probe(rtcpPort)) return { rtpPort, rtcpPort };
        _claimed.delete(rtpPort);
        _claimed.delete(rtcpPort);
    }
    throw new Error(`no free RTP port pair in ${base}-${base + span} (${limit} slots probed)`);
}

module.exports = { allocateRtpPair };
