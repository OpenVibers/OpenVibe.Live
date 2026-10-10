/**
 * GET /api/home/stats/series/:metric — where each hero chart's daily values come from:
 *   - vods, clips and hours from OpenVibe.Media;
 *   - pastes from OpenVibe.Community (/api/pastes/admin/stats/series, as staff): Media's legacy copy
 *     stopped at the move, so its chart was flat;
 *   - a source that does not answer is a 503, never a made-up flat line.
 *
 *   node test/home-series.test.js
 */
'use strict';
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');

const POINTS = [{ day: '2026-10-09', value: 2 }, { day: '2026-10-10', value: 5 }];
const calls = { media: [], community: [] };
let communityDown = false;
const media = require('../server/media-client');
media.request = async (method, p) => { calls.media.push(p); return { metric: 'vods', days: 2, points: POINTS, total: 7 }; };
const pastesClient = require('../server/pastes-client');
pastesClient.request = async (method, p, opts = {}) => {
    calls.community.push({ method, p, opts });
    if (communityDown) throw new Error('down');
    return { metric: 'pastes', days: Number(opts.query && opts.query.days), points: POINTS, total: 7, before: 40, prev_total: 3 };
};

const express = require('express');
const app = express();
app.use('/api/home', require('../server/home/routes'));

function get(p) {
    return new Promise((resolve, reject) => {
        http.get(base + p, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(body); } catch { return null; } })() }));
        }).on('error', reject);
    });
}

let base;
let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet(`  ✓ ${name}`); } catch (err) { failures++; quiet(`  ✗ ${name}\n${err.stack}`); }
}

(async () => {
    await db.initDb();
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;

    await check('pastes come from Community as staff, with the requested window', async () => {
        const r = await get('/api/home/stats/series/pastes?days=14');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.json.metric, r.json.source, r.json.kind, r.json.peak, r.json.total], ['pastes', 'community', 'count', 5, 7]);
        const c = calls.community.pop();
        assert.deepStrictEqual([c.method, c.p, c.opts.query, c.opts.act], ['GET', '/admin/stats/series', { days: 14 }, { staff: true }]);
        assert.ok(!calls.media.some((p) => p.includes('/pastes')), 'Media is not asked for pastes');
    });

    await check('a Community that does not answer is a 503', async () => {
        communityDown = true;
        try {
            const r = await get('/api/home/stats/series/pastes?days=15');
            assert.strictEqual(r.status, 503);
        } finally { communityDown = false; }
    });

    await check('VODs still come from Media', async () => {
        const r = await get('/api/home/stats/series/vods?days=2');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.source, 'media');
        assert.ok(calls.media.includes('/stats/series/vods?days=2'));
    });

    server.close();
    await db.close().catch(() => {});
    if (failures) { quiet(`home-series: ${failures} failed`); process.exit(1); }
    quiet('home-series: passed');
    process.exit(0);
})().catch((err) => { quiet(err.stack); process.exit(1); });
