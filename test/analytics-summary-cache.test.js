'use strict';
/**
 * GET /internal/analytics-summary computes Live's full stats for a few totals (~4 s of database time at p95). The
 * summary cache (server/analytics/summary-cache.js): one computation per window per 10 minutes, shared by concurrent
 * callers; a failed computation is not kept.
 *
 *   node test/analytics-summary-cache.test.js
 */
const assert = require('assert');
const { createSummaryCache } = require('../server/analytics/summary-cache');

(async () => {
    let t = 0, calls = 0, fail = false;
    const summary = createSummaryCache(async (days) => {
        calls++;
        if (fail) throw new Error('db down');
        return { summary: { days, views: calls } };
    }, { ttlMs: 600_000, now: () => t });

    // Concurrent callers share one computation.
    const [a, b] = await Promise.all([summary(7), summary(7)]);
    assert.deepStrictEqual([a, b, calls], [{ days: 7, views: 1 }, { days: 7, views: 1 }, 1]);
    // Within ten minutes: the same answer, no new computation; another window is its own.
    t += 599_000;
    assert.deepStrictEqual(await summary(7), { days: 7, views: 1 });
    assert.deepStrictEqual(await summary(30), { days: 30, views: 2 });
    assert.strictEqual(calls, 2);
    // After ten minutes: computed again.
    t += 2_000;
    assert.deepStrictEqual(await summary(7), { days: 7, views: 3 });
    // A failure is not kept: the next call tries again.
    t += 700_000;
    fail = true;
    await assert.rejects(summary(7), /db down/);
    fail = false;
    assert.deepStrictEqual(await summary(7), { days: 7, views: 5 });
    // No summary in the stats: an empty object.
    const empty = createSummaryCache(async () => ({}));
    assert.deepStrictEqual(await empty(7), {});

    console.log('analytics summary cache: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
