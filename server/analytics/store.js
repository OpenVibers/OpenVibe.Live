'use strict';
/**
 * Page-view analytics (openvibe-shared/analytics/pg, ADR-021) on Live's own PostgreSQL database (plan T4): the tables
 * are migrations/0001_analytics.sql. record() stays synchronous — the tracker buffers and flushes in the background —
 * so no request waits on an analytics write. A restore drill runs no timers (LIVE_DRILL).
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

function createAnalyticsStore({ db = processDb(), drill = false, timers = !drill } = {}) {
    const tracker = new AnalyticsTrackerPg(db, 'live', { retention: false, timers });
    let closing;
    return {
        tracker,
        // The owner's migration made the table; the runtime role has no DDL rights.
        async ready() { await db.value('SELECT 1 FROM analytics_events LIMIT 1'); },
        prune: () => pruneRawEventsPg(db, { days: analyticsModule.retention.MAX_DAYS }),
        close() {
            if (!closing) closing = Promise.resolve(tracker.destroy());
            return closing;
        },
    };
}

module.exports = { createAnalyticsStore };
