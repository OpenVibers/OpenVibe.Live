'use strict';
/**
 * Page-view analytics (openvibe-shared/analytics/pg, ADR-021) on Live's own PostgreSQL database (plan T4): the tables
 * are migrations/0001_analytics.sql and, for the ingest counters, 0026_analytics_bot_api_rollups.sql. record() stays
 * synchronous — the tracker buffers and flushes in the background — so no request waits on an analytics write. A
 * restore drill runs no timers (LIVE_DRILL).
 */
const analyticsModule = require('openvibe-shared/analytics');
const { AnalyticsTrackerPg, pruneRawEventsPg } = require('openvibe-shared/analytics/pg');

/** The process-wide database, read on each use: the middleware is mounted before initDb() opens it at boot. */
function processDb() {
    const current = () => require('../db/database').getDb();
    return new Proxy({}, {
        get(_, key) {
            const d = current();
            const v = d[key];
            return typeof v === 'function' ? v.bind(d) : v;
        },
    });
}

// Bot API calls are counted into the hourly and daily rollups at ingest (countBotApiAtIngest), so no raw row is
// written for them any more (plan J3: they were 1.49M of 2.47M raw rows on 2026-10-22 and about 80k a day on
// 2026-11-06). Page views by bots, and a bot API call the shared tracker could not count, still get a raw row: those
// are kept 7 days, the window the admin's bot breakdown and its suspicious-sessions check use, and people's events 30.
const BOT_RAW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** Bot rows older than BOT_RAW_DAYS, in batches as the shared prune does. */
async function pruneBotEvents(db, { days = BOT_RAW_DAYS, now = Date.now, batch = 5000 } = {}) {
    const cutoff = sqlTime(now() - days * DAY_MS);
    let removed = 0;
    for (;;) {
        const n = await db.exec(`DELETE FROM analytics_events WHERE id IN (SELECT id FROM analytics_events WHERE is_bot = 1 AND created_at < $1 LIMIT ${batch})`, [cutoff]);
        removed += n;
        if (n < batch) break;
    }
    return { removed, cutoff };
}

function createAnalyticsStore({ db = processDb(), drill = false, timers = !drill, countBotApiAtIngest = true } = {}) {
    const tracker = new AnalyticsTrackerPg(db, 'live', { retention: false, timers, countBotApiAtIngest });
    let closing;
    return {
        tracker,
        // The owner's migrations made the tables; the runtime role has no DDL rights.
        async ready() {
            await db.value('SELECT 1 FROM analytics_events LIMIT 1');
            await db.value('SELECT 1 FROM analytics_bot_api_hourly LIMIT 1');
            await db.value('SELECT 1 FROM analytics_bot_api_daily LIMIT 1');
        },
        async prune() {
            const all = await pruneRawEventsPg(db, { days: analyticsModule.retention.MAX_DAYS });
            const bots = await pruneBotEvents(db);
            return { ...all, bots };
        },
        close() {
            if (!closing) closing = Promise.resolve(tracker.destroy());
            return closing;
        },
    };
}

module.exports = { createAnalyticsStore, pruneBotEvents, BOT_RAW_DAYS };
