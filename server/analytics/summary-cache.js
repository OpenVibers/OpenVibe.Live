'use strict';
/**
 * The totals behind GET /internal/analytics-summary (Network orders its navigation by real use). They come from the
 * daily rollups alone (rollupSummary): the shared tracker's full stats gave the same totals from the same rollups, but
 * ran about twenty raw-event queries for everything else first (~4 s of database time at p95, 2026-10-17). Each window
 * is still computed at most once per `ttlMs`, and concurrent callers share one computation. A failed computation is not
 * kept: the next call tries again.
 *
 *   const summary = createSummaryCache(async (days) => ({ summary: await rollupSummary(db, { days }) }));
 *   await summary(7)   // → { … }  (the stats' `summary`, or {})
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A window's totals from analytics_daily: the same row openvibe-shared/analytics/pg getStats({ days }) puts in
 * `summary` (its rollup branch, the one every days-window takes), one query on a table of a row a day. → the row, or {}.
 */
async function rollupSummary(db, { days, service = 'live', now = Date.now() } = {}) {
    const since = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
    const row = await db.maybe(`SELECT SUM(pageviews)::bigint AS total_pageviews, SUM(api_calls)::bigint AS total_api_calls, SUM(unique_visitors)::bigint AS total_unique_visitors,
            SUM(unique_users)::bigint AS total_unique_users, SUM(bot_hits)::bigint AS total_bot_hits, SUM(error_count)::bigint AS total_errors,
            CAST(AVG(avg_response_ms) AS integer) AS avg_response_ms
        FROM analytics_daily WHERE service = $1 AND date >= $2`, [service, since]);
    return row || {};
}
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

module.exports = { createSummaryCache, rollupSummary };
