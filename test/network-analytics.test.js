'use strict';
// Creator analytics from Network (roadmap WS-E task 6; server/analytics/network-analytics.js): with
// ANALYTICS_SOURCE=network Live reads Network's figures with its service token and merges its own per-stream
// extras; unset, no subject, or Network down → Live's own tables (null here).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-netanalytics-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_INTERNAL_URL = 'http://network.test';
const log = console.log; console.log = () => {}; console.warn = () => {};
const db = require('../server/db/database');
db.initDb();
console.log = log;
require('../server/net/network-principal').serviceHeaders = async () => ({ Authorization: 'Bearer svc' });
const na = require('../server/analytics/network-analytics');
const SUBJ = `usr_${'01JAA'.padEnd(26, '0')}`;
const d = db.getDb();
d.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'carol', 'x'), (8, 'nolink', 'x')").run();
d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (7, 'network', '70', ?)").run(SUBJ);
d.prepare('INSERT INTO streams (id, user_id, title) VALUES (501, 7, \'A\')').run();
d.prepare('INSERT INTO stream_analytics (stream_id, new_followers, clips_created, coins_earned) VALUES (501, 3, 2, 40)').run();

(async () => {
    const calls = [];
    let status = 200;
    const body = { creator: SUBJ, days: 30, full: true, totals: { streams: 2, stream_seconds: 5400, peak_viewers: 20, avg_viewers: 7.7, unique_chatters: 13, messages: 320, watch_minutes: 550 }, daily: [],
        streams: [{ stream_id: 501, title: 'A', category: null, started_at: '2026-09-25T10:00:00.000Z', ended_at: '2026-09-25T11:00:00.000Z', duration_seconds: 3600, peak_viewers: 12, avg_viewers: 6.5, unique_chatters: 4, messages: 120, watch_minutes: 300 },
            { stream_id: 502, title: 'B', category: null, started_at: '2026-09-26T10:00:00.000Z', ended_at: '2026-09-26T10:30:00.000Z', duration_seconds: 1800, peak_viewers: 20, avg_viewers: 10, unique_chatters: 9, messages: 200, watch_minutes: 250 }] };
    const fetchImpl = async (url, o) => { calls.push({ url, auth: o.headers.Authorization }); if (status instanceof Error) throw status; return { status, json: async () => body }; };

    delete process.env.ANALYTICS_SOURCE;
    assert.strictEqual(await na.summaryFor(7, 30, { fetchImpl }), null, 'off by default');
    process.env.ANALYTICS_SOURCE = 'network';
    const r = await na.summaryFor(7, 30, { fetchImpl });
    assert.deepStrictEqual(calls.pop(), { url: `http://network.test/api/v1/creators/${SUBJ}/analytics?days=30`, auth: 'Bearer svc' });
    assert.strictEqual(r.source, 'network');
    assert.deepStrictEqual([r.summary.total_streams, r.summary.total_messages, r.summary.total_watch_minutes, r.summary.avg_viewers_per_stream], [2, 320, 550, 7.7]);
    assert.deepStrictEqual([r.summary.total_new_followers, r.summary.total_clips], [3, 2], 'Live\'s own extras merged');
    assert.deepStrictEqual([r.streams[0].id, r.streams[0].total_messages, r.streams[0].coins_earned], [501, 120, 40]);
    assert.ok(r.all_time, 'all_time stays Live\'s');
    assert.strictEqual(await na.summaryFor(8, 30, { fetchImpl }), null, 'no subject: Live\'s tables');
    status = 503;
    assert.strictEqual(await na.summaryFor(7, 30, { fetchImpl }), null, 'Network refused: Live\'s tables');
    status = new Error('ECONNREFUSED');
    assert.strictEqual(await na.summaryFor(7, 30, { fetchImpl }), null);
    const routes = fs.readFileSync(path.join(__dirname, '..', 'server', 'streaming', 'analytics-routes.js'), 'utf8');
    assert.strictEqual((routes.match(/network-analytics'\)\.summaryFor\(channel\.user_id, days\)\) \|\| db\.getChannelAnalyticsSummary/g) || []).length, 2, 'both channel analytics routes');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('network analytics: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
