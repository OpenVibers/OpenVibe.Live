'use strict';
/**
 * A publisher that drops and comes back carries on the same stream (the owner, 2026-11-18: one broadcast "chunked … in
 * weird ways"). An RTMP encoder that disconnected ended its stream at once, so a network blip or a Live restart turned
 * one broadcast into two streams, each with its own replay (iZoR_One's 3057 + 3058). Browser broadcasts already had a
 * resume grace (broadcast-server.js RESUME_GRACE_MS); this is RTMP's.
 *
 *   createResumeGrace({ graceMs, onExpire, setTimer, clearTimer })
 *     hold(key, info)   the publisher left: keep its stream for graceMs; onExpire(info) ends it after that
 *     take(key)         the same key published again: → the held info (the stream to carry on), or null
 *     held(key)         → the held info without taking it
 *     clear()           drop every hold (tests, shutdown)
 *
 * A Live restart needs no hold: the process goes, its timers with it, and the stream stays live in the database, where
 * the reconnecting encoder finds it (rtmp-server.js, wasFed) or the stale sweep ends it at its last heartbeat.
 */
const DEFAULT_GRACE_MS = 90 * 1000;

function createResumeGrace({ graceMs = DEFAULT_GRACE_MS, onExpire, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (typeof onExpire !== 'function') throw new TypeError('createResumeGrace needs onExpire(info)');
    const holds = new Map();   // key → { info, timer }

    function hold(key, info) {
        const had = holds.get(key);
        if (had) clearTimer(had.timer);
        const entry = { info, timer: null };
        entry.timer = setTimer(() => {
            if (holds.get(key) !== entry) return;
            holds.delete(key);
            Promise.resolve().then(() => onExpire(info)).catch(() => { /* the stale sweep ends it */ });
        }, graceMs);
        if (entry.timer && entry.timer.unref) entry.timer.unref();
        holds.set(key, entry);
    }

    function take(key) {
        const entry = holds.get(key);
        if (!entry) return null;
        clearTimer(entry.timer);
        holds.delete(key);
        return entry.info;
    }

    return {
        hold, take,
        held: (key) => (holds.get(key) || {}).info || null,
        clear() { for (const e of holds.values()) clearTimer(e.timer); holds.clear(); },
        size: () => holds.size,
    };
}

const RTMP_RESUME_GRACE_MS = Math.max(15000, Number(process.env.RTMP_RESUME_GRACE_MS) || DEFAULT_GRACE_MS);

module.exports = { createResumeGrace, DEFAULT_GRACE_MS, RTMP_RESUME_GRACE_MS };
