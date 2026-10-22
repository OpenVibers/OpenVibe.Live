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

        // Bot rows go after 7 days (they are in the rollups by then); people's rows stay the 30 days ADR-021 allows.
        const d = db.getDb();
        const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().replace('T', ' ').slice(0, 19);
        const ins = (isBot, daysAgo, path) => d.exec("INSERT INTO analytics_events (service, event_type, path, is_bot, created_at) VALUES ('live', 'api_call', $1, $2, $3)", [path, isBot, at(daysAgo)]);
        await ins(1, 10, '/t/bot-old'); await ins(1, 2, '/t/bot-new'); await ins(0, 10, '/t/person-old'); await ins(0, 40, '/t/person-older');
        const out = await store.prune();
        assert.ok(out.bots && out.bots.removed >= 1, JSON.stringify(out));
        const left = (await d.many("SELECT path FROM analytics_events WHERE path LIKE '/t/%' ORDER BY path")).map((r) => r.path);
        assert.deepStrictEqual(left, ['/t/bot-new', '/t/person-old'], 'a 10-day-old bot row and a 40-day-old row go; a 2-day-old bot row and a 10-day-old person\'s row stay');
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
