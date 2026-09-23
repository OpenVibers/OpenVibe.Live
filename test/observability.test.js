'use strict';
/**
 * Metrics and readiness (server/web/observability.js, roadmap Track O):
 *   - /metrics answers direct loopback callers only; through a proxy (X-Forwarded-For) it is a 404
 *   - HTTP metrics are labelled by route template, never by raw URL, id or query
 *   - release_info and the domain gauges (live streams, WebSocket connections, outbox)
 *   - /api/ready: boot + db required (503 when either fails); SFU, Media and the Network key optional
 *     (200 "degraded", naming what is missing)
 * A temp SQLite database stands in for Live's; no Media, Network or mediasoup is needed.
 *
 * Run: node test/observability.test.js
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const observability = require('../server/web/observability');

const tmpDb = path.join(os.tmpdir(), `openvibe-observability-test-${process.pid}-${Date.now()}.db`);

(async () => {
    const sqlite = new Database(tmpDb);
    sqlite.exec('CREATE TABLE streams (id INTEGER PRIMARY KEY, is_live INTEGER)');
    sqlite.prepare('INSERT INTO streams (is_live) VALUES (1), (1), (0)').run();
    let dbBroken = false;
    const dbQuery = () => { if (dbBroken) throw new Error('SQLITE_IOERR: disk I/O error'); return sqlite.prepare('SELECT 1 AS ok').get(); };

    // Fake Media: /healthz answers 200 or 502.
    let mediaUp = true; let mediaHits = 0;
    const media = http.createServer((req, res) => { mediaHits++; res.statusCode = req.url === '/healthz' && mediaUp ? 200 : 502; res.end('{}'); });
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    const mediaUrl = `http://127.0.0.1:${media.address().port}`;

    const release = { release: 'abc123def456' };
    let booted = false; let sfu = true; let key = '-----BEGIN PUBLIC KEY-----\nMII…\n-----END PUBLIC KEY-----';
    const fakeWss = (n) => ({ wss: { clients: { size: n } } });
    let outbox = { enabled: true, pending: 4, rejected: 1 };

    const app = express();
    const { registry } = observability.mountMetrics(app, { release });
    const readiness = observability.createLiveReadiness({
        release, bootComplete: () => booted, dbQuery, sfuReady: () => sfu, mediaUrl, networkKey: () => key,
    });
    app.get('/api/ready', readiness.handler);
    observability.registerDomainGauges(registry, {
        liveStreams: () => sqlite.prepare('SELECT COUNT(*) AS n FROM streams WHERE is_live = 1').get().n,
        wsServers: { chat: fakeWss(12), broadcast: fakeWss(2), control: fakeWss(0), call: { wss: null } },
        outboxStatus: () => outbox,
    });
    const vods = express.Router();
    vods.get('/:id', (req, res) => res.json({ id: req.params.id }));
    app.use('/api/vods', vods);
    app.get('/api/live-events', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(); });
    app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js')));
    app.get('*', (_req, res) => res.send('spa'));

    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p, headers = {}) => new Promise((resolve, reject) => {
        http.get(base + p, { headers }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
    });

    // ── readiness ──
    let r = await get('/api/ready');
    assert.strictEqual(r.status, 503, 'not ready before boot completes');
    let body = JSON.parse(r.body);
    assert.strictEqual(body.ready, false);
    assert.deepStrictEqual(body.failed, ['boot']);

    booted = true;
    r = await get('/api/ready');
    body = JSON.parse(r.body);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.status, 'ready');
    assert.strictEqual(body.service, 'live');
    assert.strictEqual(body.release, 'abc123def456');
    for (const name of ['boot', 'db', 'sfu', 'media', 'network_key']) {
        const c = body.checks[name];
        assert.strictEqual(c.status, 'ok', name);
        assert.strictEqual(typeof c.latency_ms, 'number');
        assert.ok(Date.parse(c.checked_at), `${name} checked_at`);
    }
    assert.strictEqual(body.checks.db.required, true);
    assert.strictEqual(body.checks.media.required, false);
    assert.deepStrictEqual(body.optional, { sfu: true, media: true, network_key: true }, 'the previous optional booleans are still served');
    assert.strictEqual(typeof body.uptime, 'number');

    // Optional dependencies down: still 200, but degraded and named.
    sfu = false; key = null;
    r = await get('/api/ready');
    body = JSON.parse(r.body);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.status, 'degraded');
    assert.deepStrictEqual(body.degraded.sort(), ['network_key', 'sfu']);
    assert.match(body.checks.sfu.error, /mediasoup/);
    assert.strictEqual(body.optional.sfu, false);

    // Media is cached for 30 s: its checked_at is when it really ran, and a down Media is not re-asked.
    const hitsBefore = mediaHits;
    mediaUp = false;
    r = await get('/api/ready');
    assert.strictEqual(mediaHits, hitsBefore, 'Media check is cached');
    assert.strictEqual(JSON.parse(r.body).checks.media.status, 'ok', 'cached result, with its own checked_at');

    // The database failing is not ready (503), whatever else is up.
    sfu = true; key = '-----BEGIN PUBLIC KEY-----x';
    dbBroken = true;
    r = await get('/api/ready');
    body = JSON.parse(r.body);
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(body.failed, ['db']);
    assert.match(body.checks.db.error, /SQLITE_IOERR/);
    dbBroken = false;

    // A fresh readiness with Media down reports it degraded.
    const r2 = observability.createLiveReadiness({ release, bootComplete: () => true, dbQuery, sfuReady: () => true, mediaUrl, networkKey: () => key });
    const b2 = await r2.run();
    assert.strictEqual(b2.ready, true);
    assert.deepStrictEqual(b2.degraded, ['media']);
    assert.strictEqual(b2.checks.media.error, 'Media answered 502');
    const r3 = observability.createLiveReadiness({ release, bootComplete: () => true, dbQuery, sfuReady: () => true, mediaUrl: 'http://127.0.0.1:1', networkKey: () => key });
    const b3 = await r3.run();
    assert.deepStrictEqual(b3.degraded, ['media'], 'Media unreachable is degraded, not down');

    // ── metrics ──
    await get('/api/vods/12345?token=secret');
    await get('/api/vods/67890');
    await get('/some/channel-name-xyz');
    await get('/api/live-events');
    await get('/js/app.js?v=deadbeef');
    const m = await get('/metrics');
    assert.strictEqual(m.status, 200);
    const text = m.body;
    assert.ok(text.includes('http_requests_total{method="GET",route="/api/vods/:id",status_class="2xx"} 2\n'), text);
    assert.ok(text.includes('route="*"'), 'the SPA fallback is its template');
    assert.ok(text.includes('route="/js/*"'), 'static mounts are labelled by mount');
    const labels = text.split('\n').filter((l) => l.startsWith('http_')).map((l) => (l.match(/\{[^}]*\}/) || [''])[0]).join('\n');
    assert.ok(!/12345|67890|secret|channel-name|app\.js|deadbeef/.test(labels), 'no ids, queries or raw paths in labels');
    assert.ok(!labels.includes('/api/live-events'), 'the SSE stream is not a request');
    assert.ok(text.includes('release_info{service="live",release="abc123def456"} 1\n'));
    assert.ok(text.includes('live_streams_live 2\n'));
    assert.ok(text.includes('live_ws_connections{server="chat"} 12\n'));
    assert.ok(text.includes('live_ws_connections{server="broadcast"} 2\n'));
    assert.ok(text.includes('live_ws_connections{server="control"} 0\n'));
    assert.ok(!text.includes('live_ws_connections{server="call"}'), 'an uninitialised server reports nothing');
    assert.ok(text.includes('live_events_outbox{status="pending"} 4\n'));
    assert.ok(text.includes('live_events_outbox{status="rejected"} 1\n'));
    assert.ok(text.includes('\nprocess_resident_memory_bytes '));
    assert.ok(text.includes('\nnodejs_eventloop_lag_seconds{stat="p99"} '));

    outbox = { enabled: false };
    assert.ok(!(await get('/metrics')).body.includes('live_events_outbox{'), 'a disabled outbox reports nothing, not zero');

    // Through nginx (X-Forwarded-For on a loopback connection) /metrics does not exist.
    assert.strictEqual((await get('/metrics', { 'X-Forwarded-For': '203.0.113.7' })).status, 404);
    assert.strictEqual((await get('/metrics', { 'X-Real-IP': '203.0.113.7' })).status, 404);

    // server/index.js mounts metrics before anything else and serves /api/ready from this module.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const mountAt = src.indexOf('observability.mountMetrics(app');
    assert.ok(mountAt > 0 && mountAt < src.indexOf('app.use(helmet('), 'metrics middleware is mounted before the rest of the middleware');
    assert.ok(/app\.get\('\/api\/ready', readiness\.handler\)/.test(src));

    server.close(); media.close(); sqlite.close();
    for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    console.log('observability: all checks passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    process.exit(1);
});
