'use strict';
/**
 * A counting semaphore for work that competes with live traffic for CPU: video encodes, frame grabs,
 * vision calls. Live chat, signaling and ingest run on the same 4 cores, so background media work
 * waits its turn instead of all starting in the same second.
 *
 *   const encodes = limit('offline-encode', 1);
 *   await encodes.run(() => transcode(...));
 */
const pools = new Map();

function limit(name, max) {
    if (pools.has(name)) return pools.get(name);
    let active = 0;
    const waiting = [];
    const next = () => {
        while (active < max && waiting.length) {
            const { fn, resolve, reject } = waiting.shift();
            active++;
            Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
        }
    };
    const pool = {
        name, max,
        /** Run fn when a slot is free. Rejects with code 'BUSY' if more than maxQueue are waiting. */
        run(fn, { maxQueue = 50 } = {}) {
            if (waiting.length >= maxQueue) {
                const e = new Error(`${name} is busy, try again shortly`);
                e.code = 'BUSY';
                return Promise.reject(e);
            }
            return new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
        },
        stats: () => ({ name, max, active, waiting: waiting.length }),
    };
    pools.set(name, pool);
    return pool;
}

limit.snapshot = () => [...pools.values()].map((p) => p.stats());

module.exports = limit;
