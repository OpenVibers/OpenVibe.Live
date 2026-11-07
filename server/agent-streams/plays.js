'use strict';
/**
 * The chat plays mode of an agent stream (Agent Streams S6, design 2026-11-06, §3, §4 and §6).
 *
 * The owner page: Chat plays with the time box (5 to 30 minutes, the default 10), the cap (money) and Go.
 * Go arms the session once: the first request of a session waits for it, so a stream never starts acting on
 * chat unattended. Wipe now stops the run and resets the sandbox; it is one of the controls, and every press
 * is logged like the other four.
 *
 * The desk reports the queue it works: the overlay shows its top three with their votes and the current
 * request with who asked it. Live keeps the last report and draws it; Chat owns the queue itself.
 */
const TIME_BOX_MIN = 5;
const TIME_BOX_MAX = 30;
const TIME_BOX_DEFAULT = 10;
const CAP_MIN_CENTS = 0;
const CAP_MAX_CENTS = 100000;         // $1,000.00

/** The time box the owner set: 5 to 30 minutes, the default 10. Null when it is not a number. */
function cleanTimeBox(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(TIME_BOX_MAX, Math.max(TIME_BOX_MIN, Math.round(n)));
}

/** The cap the owner set, in cents. Null when it is not a number. */
function cleanCap(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(CAP_MAX_CENTS, Math.max(CAP_MIN_CENTS, Math.round(n)));
}

/** The plays settings of a stream, as the owner page and the desk read them. */
function playsState(row) {
    const r = row || {};
    const queue = r.plays_queue && typeof r.plays_queue === 'object' ? r.plays_queue : {};
    const requests = Array.isArray(queue.requests) ? queue.requests : [];
    return {
        time_box_minutes: Number(r.plays_time_box_minutes) || TIME_BOX_DEFAULT,
        cap_cents: Number(r.plays_cap_cents) || 0,
        spent_cents: Number(r.plays_spent_cents) || 0,
        armed: !!r.plays_armed_at,
        armed_at: r.plays_armed_at ? new Date(r.plays_armed_at).toISOString() : null,
        wiped_at: r.plays_wiped_at ? new Date(r.plays_wiped_at).toISOString() : null,
        queue: { requests, current: queue.current || null, reported_at: queue.reported_at || null },
    };
}

/** The queue's top three, with their votes: what the overlay shows. */
function queueTop(row, n = 3) {
    const state = playsState(row);
    const requests = state.queue.requests
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
            request_id: String(r.request_id || ''),
            text: String(r.text || '').slice(0, 200),
            votes: Number(r.votes) || 0,
            author: (r.author && r.author.handle) ? String(r.author.handle) : null,
            pinned: r.pinned === true,
        }));
    return {
        current: state.queue.current ? {
            request_id: String(state.queue.current.request_id || ''),
            text: String(state.queue.current.text || '').slice(0, 200),
            author: (state.queue.current.author && state.queue.current.author.handle) ? String(state.queue.current.author.handle) : null,
        } : null,
        top: requests.slice(0, Math.max(0, n)),
    };
}

/** The queue the desk reports: at most the top twenty, so a report never grows without bound. */
function cleanQueue(body) {
    const b = body || {};
    const requests = Array.isArray(b.requests) ? b.requests.slice(0, 20) : [];
    return {
        requests,
        current: b.current || null,
        reported_at: new Date().toISOString(),
    };
}

module.exports = { TIME_BOX_MIN, TIME_BOX_MAX, TIME_BOX_DEFAULT, CAP_MIN_CENTS, CAP_MAX_CENTS, cleanTimeBox, cleanCap, playsState, queueTop, cleanQueue };
