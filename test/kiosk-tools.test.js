'use strict';
/** The kiosk omnibar asks OpenVibe.Tools' opengraph tool for a page title first and only fetches the page itself when Tools cannot say. */
const assert = require('assert');
const http = require('http');
const express = require('express');

(async () => {
    let answer = { status: 200, body: { state: 'succeeded', result: { data: { url: 'https://1.1.1.1/', status: 200, tags: {}, preview: { title: '  One &amp; One\nOne&#39;s  &#x4e00; ' } } } } };
    const seen = [];
    const tools = await new Promise((r) => { const s = http.createServer((req, res) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
            seen.push({ path: req.url, host: req.headers.host, auth: req.headers.authorization || null, body: JSON.parse(b || '{}') });
            res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer.body));
        });
    }).listen(0, '127.0.0.1', () => r(s)); });
    process.env.OV_TOOLS_INTERNAL_URL = `http://127.0.0.1:${tools.address().port}`;
    delete process.env.OV_OAUTH_CLIENT_SECRET;
    const kiosk = require('../server/kiosk/routes');
    const app = express(); app.use('/api/kiosk', kiosk);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const site = (u) => fetch(`http://127.0.0.1:${srv.address().port}/api/kiosk/site?url=${encodeURIComponent(u)}`).then((r) => r.json());

    let r = await site('1.1.1.1');
    assert.deepStrictEqual({ reachable: r.reachable, title: r.title, host: r.host }, { reachable: true, title: "One & One One's 一", host: '1.1.1.1' });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].path, '/api/v1/tools/opengraph/run');
    assert.deepStrictEqual(seen[0].body, { input: { url: 'https://1.1.1.1/' } });
    assert.strictEqual(seen[0].auth, null, 'no service secret: the anonymous tier');

    r = await site('127.0.0.1');
    assert.deepStrictEqual(r, { reachable: false });
    assert.strictEqual(seen.length, 1, 'a private target never reaches Tools');

    answer = { status: 200, body: { state: 'succeeded', result: { data: { url: 'javascript:alert(1)', preview: { title: 'x' } } } } };
    assert.deepStrictEqual(await kiosk._titleViaTools('https://1.1.1.1/'), { title: 'x', url: 'javascript:alert(1)' });
    r = await site('1.1.1.1/a');
    assert.strictEqual(r.url, 'https://1.1.1.1/a', 'a non-http final URL from Tools is ignored');

    answer = { status: 503, body: { type: 'about:blank', title: 'busy', status: 503 } };
    assert.strictEqual(await kiosk._titleViaTools('https://1.1.1.1/'), null, 'Tools refusing = fall back to the local fetch');
    tools.close();
    assert.strictEqual(await kiosk._titleViaTools('https://1.1.1.1/'), null, 'Tools down = fall back');
    srv.close();
    console.log('kiosk tools: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
