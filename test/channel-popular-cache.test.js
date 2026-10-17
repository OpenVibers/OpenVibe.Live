'use strict';
/**
 * GET /api/streams/channel/:username/popular (the offline channel's "Most watched"): its three Media reads run in
 * parallel and the answer is kept for a minute per channel (they ran one after another on every view: p95 0.77 s,
 * 2026-10-17). A Media read that fails leaves its part empty, not the whole answer.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/channel-popular-cache.test.js
 */
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    await db.createUser({ username: 'popstar', email: 'pop@x', password_hash: 'x', display_name: 'popstar', stream_key: 'p'.repeat(32) });

    const media = require('../server/media-client');
    const lookups = require('../server/media-proxy/lookups');
    const calls = { vods: 0, clips: 0, ranges: 0 };
    let inFlight = 0, maxInFlight = 0;
    const slow = (fn) => async (...a) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 60));
        inFlight--;
        return fn(...a);
    };
    media.listVods = slow(() => { calls.vods++; return { vods: [{ id: 1, title: 'big night' }] }; });
    media.listClips = slow(() => { calls.clips++; throw new Error('Media down'); });
    lookups.topContentRanges = slow(() => { calls.ranges++; return { week: null, month: null, all: null }; });

    const express = require('express');
    const app = express();
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: r.status, json: await r.json() }; };

    const first = await get('/api/streams/channel/popstar/popular');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.json.vod.title, 'big night');
    assert.deepStrictEqual(first.json.clips, [], 'a failed Media read leaves its part empty');
    assert.ok(first.json.ranges, 'the other reads still answer');
    assert.strictEqual(maxInFlight, 3, 'the three Media reads run in parallel');

    await get('/api/streams/channel/popstar/popular');
    assert.deepStrictEqual(calls, { vods: 1, clips: 1, ranges: 1 }, 'the second view within a minute is answered from the cache');
    assert.strictEqual((await get('/api/streams/channel/nobody_here/popular')).status, 404);

    server.close();
    console.log = quiet;
    console.log('channel popular: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
