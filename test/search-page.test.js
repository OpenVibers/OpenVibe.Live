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
        return new Response(JSON.stringify({ results: [{ owner: 'live', type: 'vod', id: '912', title: 'Building a forum', canonical_url: 'https://openvibe.live/vod/912', facets: { channel: 'alex' }, snippet_html: '<mark>forum</mark>', acl: ['secret'], revision: 3 }], next_cursor: 'c1' }), { status: 200 });
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

    await get('/api/search?q=forum&type=paste&cursor=bad%20cursor');
    assert.strictEqual(asked[1].url.searchParams.get('type'), null, 'only Live\'s types');
    assert.strictEqual(asked[1].url.searchParams.get('cursor'), null);

    r = await get('/api/search?q=');
    assert.deepStrictEqual(r.body, { results: [], next_cursor: null });
    assert.strictEqual(asked.length, 2, 'an empty query asks nothing');

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
