'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-analytics-store-'));
    process.env.DATA_DIR = tmp;
    delete process.env.ANALYTICS_DB_PATH;
    const { createAnalyticsStore } = require('../server/analytics/store');
    const sqlite = createAnalyticsStore({ timers: false });
    try {
        await sqlite.ready();
        assert.ok(fs.existsSync(path.join(tmp, 'analytics.db')));
        assert.strictEqual(typeof sqlite.tracker.getStats({ days: 1 }), 'object');
        assert.ok('deleted' in await sqlite.prune());
    } finally {
        await sqlite.close();
    }

    // Production's PostgreSQL setting must not open an outbound connection during a restore drill.
    const drill = createAnalyticsStore({ driver: 'postgres', drill: true, databaseUrl: 'postgres://unreachable', timers: false });
    try {
        await drill.ready();
        assert.ok(fs.existsSync(path.join(tmp, 'analytics.db')));
    } finally {
        await drill.close();
    }
    console.log('analytics store: SQLite default and isolated drill passed');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
