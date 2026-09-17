'use strict';
/**
 * Background jobs that cannot pile up, crash the process, or keep running through shutdown.
 *
 * The server has ~60 timers. Several are async with no guard, so a slow run is joined by the next
 * tick (the VOD auto-clip backfill could double its AI and ffmpeg load and cut duplicate clips); a
 * synchronous throw in any of them is an uncaught exception, which exits the process and drops every
 * live stream; they all start at fixed offsets after boot, so every deploy fires them in lockstep
 * while streamers are reconnecting; and shutdown cleared almost none of them.
 *
 *   const jobs = require('../utils/jobs');
 *   jobs.every('restream-viewer-counts', 60_000, pollCounts, { initialDelayMs: 5_000, jitterMs: 5_000 });
 *   const guarded = jobs.singleFlight('auto-clip-backfill', backfill);   // for existing timers
 *
 * Every run is recorded (count, last start, duration, last error, skipped overlaps) for the staff
 * diagnostics endpoint. No queue, no Redis: this is one process.
 */

const registry = new Map(); // name -> stats
const timers = new Set();
let stopping = false;

function stats(name) {
    if (!registry.has(name)) {
        registry.set(name, { name, runs: 0, failures: 0, skippedOverlaps: 0, running: false, lastStartedAt: null, lastDurationMs: null, lastError: null, lastErrorAt: null });
    }
    return registry.get(name);
}

/** Wrap fn so calls while a previous call is still running are skipped, and errors are contained. */
function singleFlight(name, fn) {
    const st = stats(name);
    return async function guarded(...args) {
        if (stopping) return undefined;
        if (st.running) { st.skippedOverlaps++; return undefined; }
        st.running = true;
        st.runs++;
        const started = Date.now();
        st.lastStartedAt = new Date(started).toISOString();
        try {
            return await fn.apply(this, args);
        } catch (e) {
            st.failures++;
            st.lastError = String(e && e.message || e).slice(0, 300);
            st.lastErrorAt = new Date().toISOString();
            console.warn(`[Jobs] ${name} failed: ${st.lastError}`);
            return undefined;
        } finally {
            st.lastDurationMs = Date.now() - started;
            st.running = false;
        }
    };
}

const jitter = (ms) => (ms > 0 ? Math.floor(Math.random() * ms) : 0);

/**
 * Run fn every intervalMs (plus up to jitterMs), first after initialDelayMs (plus jitter).
 * Uses a timeout chain rather than setInterval, so the period is measured from the end of a run and
 * a slow run can never be overlapped. Returns a stop function.
 */
function every(name, intervalMs, fn, { initialDelayMs = intervalMs, jitterMs = 0 } = {}) {
    const run = singleFlight(name, fn);
    let handle = null;
    let active = true;
    const schedule = (delay) => {
        if (!active || stopping) return;
        handle = setTimeout(async () => {
            timers.delete(handle);
            await run();
            schedule(intervalMs + jitter(jitterMs));
        }, delay);
        if (handle.unref) handle.unref();
        timers.add(handle);
    };
    schedule(initialDelayMs + jitter(jitterMs));
    return () => { active = false; if (handle) { clearTimeout(handle); timers.delete(handle); } };
}

/** Stop scheduling everything registered through every(); in-flight runs finish on their own. */
function stopAll() {
    stopping = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
}

function snapshot() {
    return [...registry.values()].map((s) => ({ ...s }));
}

module.exports = { every, singleFlight, stopAll, snapshot, _reset: () => { stopping = false; registry.clear(); } };
