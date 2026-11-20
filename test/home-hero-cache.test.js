/**
 * GET /api/home/hero is built once and served to everyone for 15 s (server/home/routes.js heroPayload; 11-20: it was built
 * afresh on every ask, ~50-70 ms on the host, 1,206 asks a day at 208 ms on average). What this proves:
 *   - many asks at once build it once;
 *   - inside 15 s the next ask builds nothing;
 *   - an older answer is served at once while the next is built (one build), and the build after replaces it.
 *
 *   node test/home-hero-cache.test.js
 */
'use strict';
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
let builds = 0, homeStatsDelay = 0;
db.getHomeStats = async () => { builds++; if (homeStatsDelay) await new Promise((ok) => setTimeout(ok, homeStatsDelay)); return { streams: builds }; };
db.getViewerTrend = async () => [];
db.getConcurrencyBaseline = async () => null;
const lookups = require('../server/media-proxy/lookups');
lookups.withArchiveStats = async (s) => s;
require('../server/monetization/wallet-client').networkCoinStats = async () => null;
require('../server/monetization/billing-stats').counts = async () => null;

const express = require('express');
const app = express();
app.use('/api/home', require('../server/home/routes'));
let base = '';
const get = (p) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    http.get(base + p, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body || 'null'), ms: Date.now() - t0 })); }).on('error', reject);
});

(async () => {
    await db.initDb();
    const server = app.listen(0, '127.0.0.1');
    await new Promise((ok) => server.on('listening', ok));
    base = `http://127.0.0.1:${server.address().port}`;
    try {
        const realNow = Date.now;
        const first = await Promise.all([get('/api/home/hero'), get('/api/home/hero'), get('/api/home/hero')]);
        assert.ok(first.every((r) => r.status === 200 && r.json.stats.streams === 1), JSON.stringify(first.map((r) => r.json && r.json.stats)));
        assert.strictEqual(builds, 1, 'three asks at once, one build');
        await get('/api/home/hero');
        assert.strictEqual(builds, 1, 'inside 15 s: no build');

        // 20 s later the answer is old: served at once while one build runs behind it.
        Date.now = () => realNow() + 20_000;
        homeStatsDelay = 400;
        const stale = await get('/api/home/hero');
        assert.strictEqual(stale.json.stats.streams, 1, 'the older answer');
        assert.ok(stale.ms < 300, `not waiting for the build (${stale.ms} ms)`);
        await get('/api/home/hero');
        assert.strictEqual(builds, 2, 'one build behind them');
        await new Promise((ok) => setTimeout(ok, 600));
        Date.now = () => realNow() + 21_000;
        assert.strictEqual((await get('/api/home/hero')).json.stats.streams, 2, 'the new build replaces it');
        Date.now = realNow;
        console.log = quiet;
        console.log('home hero: built once and served to everyone; an older one at once while the next is built');
    } finally { server.close(); }
    process.exit(0);
})().catch((e) => { console.log = quiet; console.error(e); process.exit(1); });
