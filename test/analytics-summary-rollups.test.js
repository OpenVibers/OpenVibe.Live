'use strict';
/**
 * GET /internal/analytics-summary answers from the daily rollups alone (server/analytics/summary-cache.js rollupSummary):
 * the same totals the shared tracker's full stats put in `summary` for a days-window, without its raw-event queries.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/analytics-summary-rollups.test.js
 */
const assert = require('assert');
const db = require('../server/db/database');
const { createAnalyticsStore } = require('../server/analytics/store');
const { rollupSummary } = require('../server/analytics/summary-cache');

async function main() {
    await db.initDb();
    const d = db.getDb();
    const store = createAnalyticsStore({ timers: false });
    try {
        const day = (ago) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
        const row = (service, ago, n) => d.exec(`INSERT INTO analytics_daily (service, date, pageviews, api_calls, unique_visitors, unique_users, bot_hits, avg_response_ms, error_count)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (service, date) DO NOTHING`, [service, day(ago), n, n * 2, n + 1, 1, n * 3, 40 + n, 1]);
        await row('live', 1, 10); await row('live', 3, 20); await row('live', 6, 30); await row('live', 20, 1000); await row('other', 2, 500);

        const fromRollups = await rollupSummary(d, { days: 7 });
        const fromStats = (await store.tracker.getStats({ days: 7 })).summary;
        assert.deepStrictEqual(fromRollups, fromStats, 'the same totals as the shared stats\' summary');
        assert.strictEqual(Number(fromRollups.total_pageviews), 60, 'the window\'s days only, this service only');
        assert.strictEqual(Number(fromRollups.total_bot_hits), 180);
        assert.strictEqual(Number((await rollupSummary(d, { days: 30 })).total_pageviews), 1060);
        assert.deepStrictEqual(Object.keys(await rollupSummary(d, { days: 7, service: 'nobody' })).sort(), Object.keys(fromStats).sort(), 'no rows: the same shape, empty sums');
    } finally {
        await store.close();
    }
    console.log('analytics summary from rollups: all checks passed');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
