'use strict';
/**
 * J3: Live counts bot API calls at ingest (openvibe-shared's countBotApiAtIngest, server/analytics/store.js), so a
 * bot's API call makes no raw analytics_events row; page views by bots still do, and the option-off path is
 * unchanged. The counters survive the 7-day raw-row prune, and the hour's and day's rollups keep the raw rollup's
 * api_calls, bot_hits and error_count.
 *
 *   node test/analytics-bot-ingest.test.js   (with the test preload; `ov test` loads it)
 */
const assert = require('assert');
const db = require('../server/db/database');
const { createAnalyticsStore } = require('../server/analytics/store');

const BOT_UA = 'curl/8.5.0';
const HUMAN_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const req = (path, ua, ip) => ({ path, method: 'GET', ip, headers: { 'user-agent': ua }, user: null });
const res = (status = 200) => ({ statusCode: status });

async function main() {
    await db.initDb();
    const d = db.getDb();
    const store = createAnalyticsStore({ timers: false });
    try {
        await store.ready();   // includes the 0026 counter tables
        const t = store.tracker;

        assert.strictEqual(t.record(req('/api/j3/streams/abc', BOT_UA, '203.0.113.10'), res(200), '/api/j3/streams/abc', 10), true);
        assert.strictEqual(t.record(req('/api/j3/streams/abc', BOT_UA, '203.0.113.10'), res(404), '/api/j3/streams/abc', 10), true);
        assert.strictEqual(t.record(req('/j3/about', BOT_UA, '203.0.113.10'), res(200), '/j3/about', 10), true);
        assert.strictEqual(t.record(req('/api/j3/vods/xyz', HUMAN_UA, '198.51.100.20'), res(200), '/api/j3/vods/xyz', 10), true);
        await t.flush();

        const raw = await d.many("SELECT event_type, is_bot FROM analytics_events WHERE service = 'live' ORDER BY id");
        assert.deepStrictEqual(raw.map((r) => [r.event_type, r.is_bot]), [['pageview', 1], ['api_call', 0]], 'no raw row for a bot API call; the bot page view and the person\'s call are rows');

        const counters = await d.many(`SELECT endpoint_group, status_class, bot_family, SUM(hits)::bigint AS hits
            FROM analytics_bot_api_hourly WHERE service = 'live' GROUP BY 1, 2, 3 ORDER BY 1, 2`);
        assert.deepStrictEqual(counters.map((r) => [r.endpoint_group, r.status_class, r.bot_family, Number(r.hits)]), [
            ['/api/j3/streams', '2xx', 'known_crawler', 1],
            ['/api/j3/streams', '4xx', 'known_crawler', 1],
        ]);
        assert.strictEqual(Number(await d.value("SELECT SUM(hits) FROM analytics_bot_api_daily WHERE service = 'live'")), 2);

        await t.aggregate();
        const hour = await d.maybe("SELECT pageviews, api_calls, bot_hits, error_count FROM analytics_hourly WHERE service = 'live' ORDER BY hour DESC LIMIT 1");
        assert.deepStrictEqual([hour.pageviews, hour.api_calls, hour.bot_hits, hour.error_count].map(Number), [1, 3, 3, 1], 'the hour keeps the raw rollup\'s counters');
        const day = await d.maybe("SELECT pageviews, api_calls, bot_hits, error_count FROM analytics_daily WHERE service = 'live' ORDER BY date DESC LIMIT 1");
        assert.deepStrictEqual([day.pageviews, day.api_calls, day.bot_hits, day.error_count].map(Number), [1, 3, 3, 1], 'the day too');

        const stats = await t.getStats({ hours: 6 });
        // A sub-day summary's pageviews are people's only; bots are in total_bot_hits, including the counted API calls.
        assert.deepStrictEqual([stats.summary.total_pageviews, stats.summary.total_bot_hits, stats.summary.total_errors].map(Number), [0, 3, 1]);
        assert.deepStrictEqual(stats.botBreakdown.map((r) => [r.bot_type, Number(r.hits)]), [['known_crawler', 3]]);
        const bots = await t.getBotAnalysis(7);
        assert.deepStrictEqual(bots.botTypes.map((r) => [r.bot_type, Number(r.hits)]), [['known_crawler', 3]]);
        assert.deepStrictEqual(bots.botApi.map((r) => [r.endpoint_group, r.status_class, Number(r.hits)]), [['/api/j3/streams', '2xx', 1], ['/api/j3/streams', '4xx', 1]]);

        // Option off keeps the old behaviour: a raw row, no counter.
        const off = createAnalyticsStore({ timers: false, countBotApiAtIngest: false });
        try {
            off.tracker.record(req('/api/j3/off', BOT_UA, '203.0.113.30'), res(200), '/api/j3/off', 10);
            await off.tracker.flush();
        } finally { await off.close(); }
        assert.strictEqual(Number(await d.value("SELECT COUNT(*) FROM analytics_events WHERE service = 'live' AND path = '/api/j3/off' AND is_bot = 1")), 1, 'option off writes the raw row');
        assert.strictEqual(Number(await d.value("SELECT SUM(hits) FROM analytics_bot_api_daily WHERE service = 'live'")), 2, 'option off adds no counter');

        // The counters outlive the raw rows: the 7-day bot prune leaves them, so the admin's families stay readable.
        const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
        await d.exec("INSERT INTO analytics_events (service, event_type, path, is_bot, created_at) VALUES ('live', 'api_call', '/j3/old-bot', 1, $1)", [tenDaysAgo]);
        await d.exec("INSERT INTO analytics_bot_api_daily (service, date, endpoint_group, status_class, bot_family, hits) VALUES ('live', '2026-10-01', '/j3', '2xx', 'known_crawler', 5)");
        const pruned = await store.prune();
        assert.strictEqual(pruned.bots.removed, 1, JSON.stringify(pruned));
        assert.strictEqual(Number(await d.value("SELECT COUNT(*) FROM analytics_events WHERE path = '/j3/old-bot'")), 0);
        assert.strictEqual(Number(await d.value("SELECT hits FROM analytics_bot_api_daily WHERE date = '2026-10-01' AND endpoint_group = '/j3'")), 5, 'the counter survives the raw prune');
    } finally {
        await store.close();
    }
    console.log('analytics bot ingest: all checks passed');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
