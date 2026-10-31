'use strict';
/**
 * Viewer freezes (plan L23, 2026-10-31).
 *
 * A viewer's picture can stop moving while everything else looks fine: the signaling socket is
 * open, the SFU transport says "connected", the audio keeps playing. The owner saw it on stream
 * 2833 (2026-10-31 04:05 UTC): the picture played for a few seconds and then froze, and a reload
 * played fine. Without a number, "it froze" is a story; with one, it is a bug we can find.
 *
 * The player's own decoder reports every 5 s (public/js/ov-viewer-health.js): how many frames it
 * decoded, how many it dropped, how many packets were lost, the jitter, the jitter buffer delay,
 * the codec and the decoder. This module reads those samples and decides what a freeze is:
 *
 *   • no new decoded frame for FREEZE_MS (2 s) while packets keep arriving — the picture is stuck
 *     but the media is flowing, so the fault is in the decode or the display, not in the network;
 *   • the player's own freezeCount went up — the player saw it too.
 *
 * A freeze is logged once (one line: the stream, the peer, the codec) and counted, per stream and
 * per codec, so /metrics can show it as live_viewer_freezes_total{codec}.
 */
const FREEZE_MS = 2000;

/** The per-stream rolling count and the last freezes (a ring, so a long night cannot grow). */
const streams = new Map();
const RING = 20;

let counter = null;   // the Prometheus counter, once the registry exists

/** Attach the metric to the metrics registry (server/web/observability.js calls this). */
function attachCounter(registry) {
    if (counter) return counter;
    if (!registry || typeof registry.counter !== 'function') return null;
    counter = registry.counter({
        name: 'live_viewer_freezes_total',
        help: 'Viewer freezes on live streams (a picture that stopped moving while packets kept arriving)',
        labelNames: ['codec'],
    });
    return counter;
}

/** The counter itself (null before the registry is attached). */
function freezeCounter() { return counter; }

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const str = (v, max = 64) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A telemetry sample, cleaned up: the browser is not a trusted source of numbers. */
function normalize(sample) {
    const s = sample && typeof sample === 'object' ? sample : {};
    return {
        framesDecoded: num(s.framesDecoded),
        framesDropped: num(s.framesDropped),
        packetsReceived: num(s.packetsReceived),
        packetsLost: num(s.packetsLost),
        jitter: num(s.jitter),
        jitterBufferDelay: num(s.jitterBufferDelay),
        freezeCount: num(s.freezeCount),
        freezeMs: num(s.freezeMs),
        codec: str(s.codec, 32),
        decoder: str(s.decoder, 48),
    };
}

/**
 * Reads one viewer's samples and says when the picture froze.
 *
 *   tracker.observe(sample)  → { freeze, first, reason, detail, codec }
 */
class ViewerTracker {
    constructor() {
        this.last = null;             // the previous sample
        this.lastFrameAt = 0;         // when a new decoded frame was last seen
        this.inFreeze = false;        // the freeze is already logged
        this.clientFreezeCount = 0;   // the player's own count, to spot a rise
    }

    /**
     * One sample. Returns what the caller should log (nothing when the picture is moving).
     * @param {object} sample the telemetry payload (already normalized or not)
     * @param {number} now
     */
    observe(sample, now = Date.now()) {
        const s = normalize(sample);
        const out = { freeze: false, first: false, reason: '', detail: '', codec: s.codec, decoder: s.decoder };
        const prev = this.last;
        this.last = { ...s, at: now };

        // The player saw a freeze: that is the strongest signal, and it counts each freeze once.
        const cf = s.freezeCount;
        if (cf !== null && cf > this.clientFreezeCount) {
            this.clientFreezeCount = cf;
            out.freeze = true;
            out.first = true;
            out.reason = 'the player saw the picture freeze';
            out.detail = `freezeCount=${cf} freezeMs=${s.freezeMs ?? '?'} framesDecoded=${s.framesDecoded ?? '?'} framesDropped=${s.framesDropped ?? '?'} packetsLost=${s.packetsLost ?? '?'} jitter=${s.jitter ?? '?'} jitterBufferDelay=${s.jitterBufferDelay ?? '?'}`;
            this.inFreeze = true;
            return out;
        }
        if (cf !== null) this.clientFreezeCount = cf;

        if (!prev) { this.lastFrameAt = now; return out; }

        const fd = s.framesDecoded, pfd = prev.framesDecoded;
        const pk = s.packetsReceived, ppk = prev.packetsReceived;
        if (fd !== null && pfd !== null && fd > pfd) {
            this.lastFrameAt = now;
            this.inFreeze = false;
            return out;
        }
        // No new frame — but are packets still arriving? If they are, the media flows and the
        // picture is stuck in the decoder (a lost keyframe, a decode hiccup). If they are not,
        // the network is the problem and the player recovers on its own.
        if (pk !== null && ppk !== null && pk > ppk) {
            const silent = now - (this.lastFrameAt || prev.at);
            if (silent >= FREEZE_MS) {
                out.freeze = true;
                out.reason = `no new frame for ${Math.round(silent / 1000)}s while packets keep arriving`;
                out.detail = `framesDecoded=${fd ?? '?'} packetsReceived=${pk} packetsLost=${s.packetsLost ?? '?'} jitter=${s.jitter ?? '?'} jitterBufferDelay=${s.jitterBufferDelay ?? '?'}`;
                if (!this.inFreeze) { out.first = true; this.inFreeze = true; }
            }
        }
        return out;
    }
}

/** Count a freeze for a stream (and for the metric). */
function noteFreeze({ streamId, peerId, codec, reason, detail, decoder }) {
    const key = String(streamId || 'unknown');
    const c = String(codec || 'unknown').slice(0, 32) || 'unknown';
    let s = streams.get(key);
    if (!s) { s = { total: 0, byCodec: {}, recent: [] }; streams.set(key, s); }
    s.total++;
    s.byCodec[c] = (s.byCodec[c] || 0) + 1;
    s.recent.push({ at: Date.now(), peerId: String(peerId || ''), codec: c, decoder: String(decoder || ''), reason: String(reason || ''), detail: String(detail || '') });
    if (s.recent.length > RING) s.recent.splice(0, s.recent.length - RING);
    if (counter) counter.inc({ codec: c });
    return s.total;
}

/** The freezes of one stream (the rolling count). */
function streamFreezes(streamId) {
    const s = streams.get(String(streamId));
    return s ? s.total : 0;
}

/** Every stream's count, for a status endpoint or a test. */
function allStreamFreezes() {
    const out = {};
    for (const [k, v] of streams) out[k] = v.total;
    return out;
}

/** Forget everything (a test, and a fresh process). */
function reset() {
    streams.clear();
}

module.exports = {
    FREEZE_MS,
    ViewerTracker,
    attachCounter,
    freezeCounter,
    normalize,
    noteFreeze,
    streamFreezes,
    allStreamFreezes,
    reset,
};
