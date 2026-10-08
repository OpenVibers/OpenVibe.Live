'use strict';

const assert = require('assert');
const db = require('../server/db/database');
const { createAnalyticsStore } = require('../server/analytics/store');

async function main() {
    await db.initDb();
    const store = createAnalyticsStore({ timers: false });
    try {
        await store.ready();
        assert.ok(store.tracker, 'analytics tracker opens on the migrated PostgreSQL database');
        assert.ok(await db.getDb().maybe("SELECT 1 FROM information_schema.tables WHERE table_name = 'analytics_events'"));
        assert.ok('removed' in await store.prune());
    } finally {
        await store.close();
    }

    const drill = createAnalyticsStore({ drill: true });
    try {
        await drill.ready();
        assert.ok(drill.tracker, 'restore drills use the same migrated database without starting timers');
    } finally {
        await drill.close();
    }
    console.log('analytics store: migrated PostgreSQL and drill mode passed');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
