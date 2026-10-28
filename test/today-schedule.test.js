'use strict';
// A channel's schedule from OpenVibe.Today (server/today/routes.js): only public fields and Today's own page as the link,
// cancelled and ended events left out, at most three, a minute's cache, and an empty answer (cached briefly) when Today
// is unreachable; a bad username is 404.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createTodayRoutes, createTodaySchedule, publicEvent } = require('../server/today/routes');

(async () => {
    let clock = Date.parse('2026-10-28T15:00:00Z');
    const asked = [];
    let down = false;
    const fetchImpl = async (url) => {
        asked.push(String(url));
        if (down) throw new Error('connect ECONNREFUSED');
        const ev = (id, o) => ({ id, owner_subject: 'usr_x', title: `Stream ${id}`, starts_at: '2026-10-30T03:00:00Z', ends_at: null, tz: 'America/Los_Angeles', status: 'scheduled', kind: 'stream', seq: 2, ...o });
        return new Response(JSON.stringify({ events: [
            ev('tev_AAAAAAAAAAAAAAAAAAA1'), ev('tev_AAAAAAAAAAAAAAAAAAA2', { status: 'cancelled' }), ev('tev_AAAAAAAAAAAAAAAAAAA3', { status: 'live', title: '<b>Live</b> now' }),
            ev('tev_AAAAAAAAAAAAAAAAAAA4'), ev('tev_AAAAAAAAAAAAAAAAAAA5'), ev('bad id'),
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const schedule = createTodaySchedule({ todayUrl: 'http://today.test', fetchImpl, now: () => clock });
    const app = express();
    app.use('/api/today', createTodayRoutes(schedule));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/today`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };

    try {
        let r = await get('/channel/carol');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.cache, 'public, max-age=60');
        assert.deepStrictEqual(r.body.events.map((e) => e.id), ['tev_AAAAAAAAAAAAAAAAAAA1', 'tev_AAAAAAAAAAAAAAAAAAA3', 'tev_AAAAAAAAAAAAAAAAAAA4'], 'cancelled and malformed left out, three at most');
        assert.deepStrictEqual(Object.keys(r.body.events[0]).sort(), ['ends_at', 'id', 'kind', 'starts_at', 'status', 'title', 'tz', 'url'], 'public fields only (no owner, no seq)');
        assert.strictEqual(r.body.events[0].url, 'https://openvibe.today/e/tev_AAAAAAAAAAAAAAAAAAA1', 'the link is Today\'s public page');
        assert.ok(/^http:\/\/today\.test\/api\/v1\/events\?channel=carol&from=/.test(asked[0]), asked[0]);

        await get('/channel/carol');
        assert.strictEqual(asked.length, 1, 'a minute\'s cache');
        clock += 61_000;
        down = true;
        r = await get('/channel/carol');
        assert.deepStrictEqual([r.status, r.body.events], [200, []], 'Today unreachable: an empty schedule, never an error');
        assert.strictEqual(asked.length, 2);
        down = false;
        clock += 5_000;
        await get('/channel/carol');
        assert.strictEqual(asked.length, 2, 'a failure is cached briefly too');
        clock += 11_000;
        r = await get('/channel/carol');
        assert.strictEqual(r.body.events.length, 3, 'asked again after the short failure cache');

        assert.strictEqual((await get('/channel/..%2Fx')).status, 404);
        assert.strictEqual(publicEvent({ id: 'tev_AAAAAAAAAAAAAAAAAAA1', starts_at: 'not a date' }), null);
    } finally {
        server.close();
    }
    console.log('today schedule: ok');
})().catch((e) => { console.error(e); process.exit(1); });
