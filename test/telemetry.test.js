'use strict';
// Request telemetry (openvibe-sdk/service, plan T1 step 10): server/index.js mounts the process-wide middleware right after
// the metrics, and start() calls telemetry.init() for service 'live' with a PostgreSQL sink and starts the 14-day
// retention once the database is ready (a drill returns before that, so LIVE_DRILL starts neither); the flush runs
// before the database closes. Through express, five hits on one route flush as ONE aggregated sample; migration 0006's
// table takes the retention.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { telemetry } = require('openvibe-sdk/service');
const { pruneTelemetry } = require('openvibe-sdk/telemetry');

(async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(src.indexOf('app.use(telemetry.middleware)') > src.indexOf('observability.mountMetrics(app'), 'the middleware follows the metrics');
    const start = src.indexOf('async function start()');
    const drillReturn = src.indexOf('if (drill.enabled) return await startDrill();', start);
    const init = src.indexOf("telemetry.init({ service: 'live', sink: createPgTelemetrySink(", start);
    assert.ok(start > 0 && drillReturn > start && init > drillReturn, 'init runs in start(), after a drill has returned');
    assert.ok(src.indexOf('telemetryRetention = startTelemetryRetention({ db: db.getDb(), log: console, olderThanDays: 14 })', start) > drillReturn);
    const flush = src.indexOf('async () => { if (telemetryRetention) await telemetryRetention.stop(); await telemetry.stop(); }');
    assert.ok(flush > 0 && flush < src.indexOf('await db.close();'), 'the flush runs before the database closes');

    const app = express();
    app.use(telemetry.middleware);
    app.get('/api/streams/:id', (req, res) => res.json({ ok: true }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const samples = [];
    telemetry.init({ service: 'live', sink: async (batch) => { samples.push(...batch); }, intervalMs: 3600e3 });
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await fetch(`${base}/api/streams/${i}`)).status, 200);
        await telemetry.flush();
        const hit = samples.filter((s) => s.operation === 'http.request' && s.resource === '/api/streams/:id' && s.status === '2xx');
        assert.strictEqual(hit.length, 1, JSON.stringify(samples));
        assert.strictEqual(hit[0].extra.count, 5, 'one sample per route template, never per URL');

        const db = require('../server/db/database');
        await db.initDb();
        const raw = db.getDb();
        await raw.query('DELETE FROM telemetry_samples');
        const insert = (days) => raw.query("INSERT INTO telemetry_samples (at, service, operation) VALUES (now() - make_interval(days => $1), 'live', 'http.request')", [days]);
        await insert(20);
        await insert(1);
        assert.strictEqual(await pruneTelemetry({ db: raw, olderThanDays: 14 }), 1);
        assert.strictEqual((await raw.query('SELECT count(*)::int AS n FROM telemetry_samples')).rows[0].n, 1);
        console.log('telemetry ok');
    } finally {
        await telemetry.stop();
        await new Promise((r) => server.close(r));
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
