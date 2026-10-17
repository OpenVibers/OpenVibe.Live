'use strict';
/**
 * The totals behind GET /internal/analytics-summary (Network orders its navigation by real use). The full stats they
 * come from took ~4 s of database time (p95, 2026-10-17) for a few numbers Network reads every so often, so each
 * window is computed at most once per `ttlMs`, and concurrent callers share one computation. A failed computation is
 * not kept: the next call tries again.
 *
 *   const summary = createSummaryCache((days) => analytics.getStats({ days }));
 *   await summary(7)   // → { … }  (the stats' `summary`, or {})
 */
function createSummaryCache(getStats, { ttlMs = 600_000, now = () => Date.now() } = {}) {
    const entries = new Map();   // days -> { at, promise }
    return function summary(days) {
        let e = entries.get(days);
        if (!e || now() - e.at > ttlMs) {
            e = { at: now(), promise: Promise.resolve().then(() => getStats(days)).then((st) => (st && st.summary) || {}) };
            const mine = e;
            e.promise.catch(() => { if (entries.get(days) === mine) entries.delete(days); });
            entries.set(days, e);
        }
        return e.promise;
    };
}

module.exports = { createSummaryCache };
