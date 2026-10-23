'use strict';
/**
 * Dead air: a browser or WHIP stream whose page still heartbeats while its producers receive nothing. Stream 2718
 * (2026-10-23) stayed live 7.5 hours after its camera and microphone stopped: a channel marked live with nothing to
 * watch, a recording of silence, and every deploy waiting for idle. The heartbeat sweep (server/index.js) reads the
 * bytes its SFU room's producers have received once a minute; a count that has not changed for `limitMs` ends the
 * stream like a stale one. A new producer starts from 0, so any change counts as media.
 *
 *   const dead = createDeadAir({ limitMs });
 *   dead.observe(streamId, bytes)   → true once the count has not changed for limitMs (then forgets the stream)
 *   dead.keep(liveIds)              forget the streams that are no longer live
 */
function createDeadAir({ limitMs = 30 * 60 * 1000, now = Date.now } = {}) {
    const seen = new Map();   // streamId → { bytes, at }: when the count last changed
    return {
        limitMs,
        observe(id, bytes) {
            const s = seen.get(id);
            if (!s || s.bytes !== bytes) { seen.set(id, { bytes, at: now() }); return false; }
            if (now() - s.at < limitMs) return false;
            seen.delete(id);
            return true;
        },
        keep(ids) { for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id); },
    };
}

module.exports = { createDeadAir };
