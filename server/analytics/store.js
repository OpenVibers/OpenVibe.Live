'use strict';

const fs = require('fs');
const path = require('path');
const analyticsModule = require('openvibe-shared/analytics');
const paths = require('../paths');

function createAnalyticsStore({ driver = process.env.ANALYTICS_DRIVER || 'sqlite',
    databaseUrl = process.env.DATABASE_URL, drill = false, timers = !drill } = {}) {
    if (driver !== 'sqlite' && driver !== 'postgres') {
        throw new Error(`ANALYTICS_DRIVER must be sqlite or postgres (got ${driver})`);
    }

    // Restore drills always use their isolated SQLite analytics file and never contact PostgreSQL.
    if (driver === 'postgres' && !drill) {
        if (!databaseUrl) throw new Error('DATABASE_URL is required when ANALYTICS_DRIVER=postgres');
        const { createDb } = require('openvibe-sdk/db');
        const { AnalyticsTrackerPg, pruneRawEventsPg } = require('openvibe-shared/analytics/pg');
        const db = createDb({ url: databaseUrl, service: 'live-analytics' });
        const tracker = new AnalyticsTrackerPg(db, 'live', { retention: false, timers });
        let closing;
        return {
            tracker,
            async ready() {
                // The owner runs migrations before enabling this driver; runtime has no DDL rights.
                await db.value('SELECT 1 FROM analytics_events LIMIT 1');
            },
            prune: () => pruneRawEventsPg(db, { days: analyticsModule.retention.MAX_DAYS }),
            close() {
                if (!closing) closing = Promise.resolve(tracker.destroy()).finally(() => db.close());
                return closing;
            },
        };
    }

    const file = paths.analyticsDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(file);
    db.pragma('journal_mode = WAL');
    const tracker = new analyticsModule.AnalyticsTracker(db, 'live', { retention: false, timers });
    return {
        tracker,
        ready: async () => {},
        prune: () => analyticsModule.retention.pruneRawEvents(db, { days: analyticsModule.retention.MAX_DAYS }),
        close: async () => { tracker.destroy(); db.close(); },
    };
}

module.exports = { createAnalyticsStore };
