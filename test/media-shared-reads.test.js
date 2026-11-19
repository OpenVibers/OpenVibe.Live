'use strict';
// Live's reads of Media that every caller shares are kept a few seconds (server/media-client.js, 2026-11-19: Live asked
// Media for VOD lists 37 times a minute, mostly the same ones). What this proves:
//   - the same list read twice is one call to Media, and two at once are one call too;
//   - each caller gets its own copy (changing one changes nothing for the next);
//   - a write forgets them; a read for a person (actingUser) and the ingest status are never kept.
const assert = require('assert');

process.env.MEDIA_URL = 'http://media.test';
const media = require('../server/media-client');

(async () => {
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(url);
        calls.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
        const body = u.pathname.endsWith('/ingest') ? { recording: true } : u.pathname.match(/\/vods\/\d+$/) ? { id: 7, title: 'One' } : { vods: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    media._reset();
    const count = (s) => calls.filter((c) => c.includes(s)).length;

    const a = await media.request('GET', '/vods', { query: { limit: 12 } });
    const b = await media.request('GET', '/vods', { query: { limit: 12 } });
    assert.strictEqual(count('/vods?limit=12'), 1, 'the same list read twice is one call');
    a.vods[0].title = 'changed by one caller';
    assert.strictEqual(b.vods[0].title, 'A', 'each caller has its own copy');
    assert.strictEqual((await media.request('GET', '/vods', { query: { limit: 12 } })).vods[0].title, 'A');

    await Promise.all([media.request('GET', '/vods/7'), media.request('GET', '/vods/7'), media.request('GET', '/vods/7')]);
    assert.strictEqual(calls.filter((c) => c.startsWith('GET ') && c.endsWith('/vods/7')).length, 1, 'three at once are one call');

    await media.request('POST', '/vods/7/finalize');
    await media.request('GET', '/vods', { query: { limit: 12 } });
    assert.strictEqual(count('/vods?limit=12'), 2, 'a write forgets the kept reads');

    await media.request('GET', '/vods', { query: { limit: 12 }, actingUser: { id: 5, username: 'ada' } });
    await media.request('GET', '/vods', { query: { limit: 12 }, actingUser: { id: 5, username: 'ada' } });
    assert.strictEqual(count('/vods?limit=12'), 4, 'a read for a person is never shared');

    await media.ingestStatus(7);
    await media.ingestStatus(7);
    assert.strictEqual(count('/vods/7/ingest'), 2, 'the ingest status is always asked');

    console.log('media shared reads: one call for the same read, copies apart, writes forget, person reads and ingest never kept');
})().catch((err) => { console.error(err); process.exit(1); });
