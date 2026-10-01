'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

async function main() {
    const directUrl = process.env.OV_TEST_PG_DIRECT_URL;
    if (!directUrl) {
        console.log('analytics PostgreSQL: skipped (OV_TEST_PG_DIRECT_URL not set)');
        return;
    }

    const { createDb } = require('openvibe-sdk/db');
    const admin = createDb({ url: directUrl, service: 'live-analytics-test-admin' });
    const healthy = await admin.ready();
    if (!healthy.ok) {
        await admin.close();
        console.log(`analytics PostgreSQL: skipped (test service unavailable: ${healthy.error})`);
        return;
    }

    const name = `ov_live_analytics_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    const url = new URL(directUrl);
    url.pathname = `/${name}`;
    let created = false;
    let owner;
    let store;
    try {
        await admin.query(`CREATE DATABASE ${name}`);
        created = true;
        owner = createDb({ url: url.toString(), service: 'live-analytics-test-owner' });
        const migrations = path.join(__dirname, '..', 'migrations');
        assert.strictEqual((await owner.migrate({ dir: migrations })).applied.length, 1);
        assert.strictEqual((await owner.migrate({ dir: migrations })).applied.length, 0);

        const { createAnalyticsStore } = require('../server/analytics/store');
        store = createAnalyticsStore({ driver: 'postgres', databaseUrl: url.toString(), timers: false });
        await store.ready();

        const express = require('express');
        const app = express();
        app.use(store.tracker.middleware());
        app.get('/watch/:id', (req, res) => res.send('ok'));
        const server = app.listen(0, '127.0.0.1');
        try {
            await new Promise((resolve) => server.once('listening', resolve));
            const response = await fetch(`http://127.0.0.1:${server.address().port}/watch/123?token=secret`, {
                headers: {
                    'user-agent': 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
                    referer: 'https://example.com/private/path?secret=1',
                    'x-forwarded-for': '203.0.113.77',
                },
            });
            assert.strictEqual(response.status, 200);
            await response.text();
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
        await store.tracker.flush();
        const rows = await owner.many('SELECT path, ip, user_id, city, user_agent, referer FROM analytics_events');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].path, '/watch/:id');
        assert.strictEqual(rows[0].ip, null);
        assert.strictEqual(rows[0].user_id, null);
        assert.strictEqual(rows[0].city, null);
        assert.strictEqual(rows[0].referer, 'https://example.com');
        assert.ok(!JSON.stringify(rows[0]).includes('secret'));
        const stats = await store.tracker.getStats({ hours: 1 });
        assert.strictEqual(Number(stats.summary.total_pageviews), 1);
        assert.ok(Array.isArray((await store.tracker.getBotAnalysis(1)).botTrend));

        await owner.query(`INSERT INTO analytics_events (service, path, created_at)
            VALUES ('live', '/old', '2020-01-01 00:00:00')`);
        assert.strictEqual((await store.prune()).removed, 1);
        assert.strictEqual(Number(await owner.value('SELECT COUNT(*) FROM analytics_events')), 1);
        console.log('analytics PostgreSQL: migration, record, privacy, reads, and prune passed');
    } finally {
        if (store) await store.close();
        if (owner) await owner.close();
        if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.close();
    }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
