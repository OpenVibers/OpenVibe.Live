'use strict';
// Live's /search page (WS-O task 10: product search boxes use the query API): GET /api/search asks
// OpenVibe.Search anonymously for owner=live only, passes a known type and a well-formed cursor, returns
// only the public fields, and answers 503 when Search does not; an empty query asks nothing. /search is
// a known page (not the SPA 404) and loads the search feature.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createSearchRouter } = require('../server/search/routes');

(async () => {
    const asked = [];
    let mode = 'ok';
    const fetchImpl = async (url, opts) => {
        asked.push({ url: new URL(url), opts });
        if (mode === 'down') throw new Error('connect ECONNREFUSED');
        if (mode === 'bad') return new Response('{"code":"search.bad_query"}', { status: 400 });
        if (mode === 'error') return new Response('{}', { status: 500 });
        const u = new URL(url);
        if (u.pathname === '/api/v1/suggest') {
            if (mode === 'suggest-down') throw new Error('timeout');
            return new Response(JSON.stringify({ suggestions: [{ owner: 'live', type: 'channel', id: '7', title: 'Forum builders', canonical_url: 'https://openvibe.live/@forum' }, { owner: 'community', type: 'thread', id: 'x', title: 'Not ours' }, { owner: 'live', type: 'channel', id: '8', title: 'forum builders', canonical_url: 'https://openvibe.live/@forum2' }] }), { status: 200 });
        }
        const facets = u.searchParams.get('facets') ? { facets: { category: [{ value: 'irl', count: 12 }, { value: 'gaming', count: 3 }], channel: [{ value: 'alex', count: 9 }, { value: 42, count: 1 }], secret: [{ value: 'x', count: 1 }] } } : {};
        return new Response(JSON.stringify({ ...facets, results: [{ owner: 'live', type: 'vod', id: '912', title: 'Building a forum', canonical_url: 'https://openvibe.live/vod/912', facets: { channel: 'alex' }, snippet_html: '<mark>forum</mark>', acl: ['secret'], revision: 3 }], next_cursor: 'c1' }), { status: 200 });
    };
    const app = express();
    app.use('/api/search', createSearchRouter({ fetchImpl, baseUrl: 'http://search.test' }));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const get = async (p) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}${p}`); return { status: res.status, body: await res.json() }; };

    let r = await get('/api/search?q=forum&type=vod&cursor=abc_1');
    assert.strictEqual(r.status, 200);
    const u = asked[0].url;
    assert.strictEqual(u.origin + u.pathname, 'http://search.test/api/v1/search');
    assert.strictEqual(u.searchParams.get('owner'), 'live');
    assert.strictEqual(u.searchParams.get('type'), 'vod');
    assert.strictEqual(u.searchParams.get('cursor'), 'abc_1');
    assert.ok(!asked[0].opts.headers.authorization, 'anonymous: public documents only');
    assert.deepStrictEqual(r.body, { results: [{ type: 'vod', id: '912', title: 'Building a forum', canonical_url: 'https://openvibe.live/vod/912', facets: { channel: 'alex' }, snippet_html: '<mark>forum</mark>' }], next_cursor: 'c1' });
    assert.strictEqual(u.searchParams.get('facets'), null, 'a later page asks no facets');

    await get('/api/search?q=forum&type=paste&cursor=bad%20cursor');
    assert.strictEqual(asked[1].url.searchParams.get('type'), null, 'only Live\'s types');
    assert.strictEqual(asked[1].url.searchParams.get('cursor'), null);

    // The first page carries the category and channel facets (well-formed rows only); category=/channel= narrow.
    r = await get('/api/search?q=forum&category=irl&channel=alex');
    const first = asked[asked.length - 1].url;
    assert.deepStrictEqual([first.searchParams.get('facets'), first.searchParams.get('facet.category'), first.searchParams.get('facet.channel')], ['category,channel', 'irl', 'alex']);
    assert.deepStrictEqual(r.body.facets, { category: [{ value: 'irl', count: 12 }, { value: 'gaming', count: 3 }], channel: [{ value: 'alex', count: 9 }] });
    const before = asked.length;
    r = await get('/api/search?q=');
    assert.deepStrictEqual(r.body, { results: [], next_cursor: null });
    assert.strictEqual(asked.length, before, 'an empty query asks nothing');

    // Suggestions: Live's own types only, nothing for one character, never an error.
    r = await get('/api/search/suggest?q=fo&type=channel');
    const su = asked[asked.length - 1].url;
    assert.deepStrictEqual([su.pathname, su.searchParams.get('owner'), su.searchParams.get('type'), su.searchParams.get('limit')], ['/api/v1/suggest', 'live', 'channel', '8']);
    assert.deepStrictEqual(r.body, { suggestions: [{ type: 'channel', id: '7', title: 'Forum builders', canonical_url: 'https://openvibe.live/@forum' }] });
    const n = asked.length;
    assert.deepStrictEqual((await get('/api/search/suggest?q=f')).body, { suggestions: [] });
    assert.strictEqual(asked.length, n, 'one character asks nothing');
    mode = 'suggest-down';
    r = await get('/api/search/suggest?q=forum');
    assert.deepStrictEqual([r.status, r.body], [200, { suggestions: [] }]);
    mode = 'ok';

    mode = 'down'; r = await get('/api/search?q=forum');
    assert.strictEqual(r.status, 503); assert.ok(/not answering/.test(r.body.error));
    mode = 'error'; assert.strictEqual((await get('/api/search?q=forum')).status, 503);
    mode = 'bad'; assert.strictEqual((await get('/api/search?q=forum')).status, 400);
    srv.close();

    const features = require('../public/features.json');
    const route = features.routes.find((x) => new RegExp(x.path).test('/search'));
    assert.deepStrictEqual(route && route.features, ['search']);
    assert.strictEqual(features.features.search.fragment, 'search');
    const fs = require('fs');
    assert.ok(fs.existsSync(require('path').join(__dirname, '../public/fragments/search.html')));
    const src = fs.readFileSync(require('path').join(__dirname, '../server/web/page-status.js'), 'utf8');
    assert.ok(/EXACT = new Set\([^)]*'search'/.test(src), '/search is a known page');

    console.log('search page: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
