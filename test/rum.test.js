'use strict';
/**
 * Real-user measurements (server/web/rum.js, public/js/ov-rum.js): a beacon becomes numbers in a reservoir per page
 * kind and device class, with nothing about the visitor kept. Checked here:
 *   - POST /api/rum takes the text/plain JSON navigator.sendBeacon sends and always answers 204;
 *   - page kinds and device classes; out-of-range or unmeasured values are left out; CLS keeps 3 decimals;
 *   - percentiles in the staff snapshot and the p75 gauge (only once a reservoir has 5 samples);
 *   - error messages are counted (at most 3 per beacon, at most 100 distinct); junk and floods are dropped;
 *   - app.js loads the script on a quarter of page loads, after the page is idle.
 *
 *   node test/rum.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { createRum, pageKind, deviceClass } = require('../server/web/rum');

(async () => {
    assert.deepStrictEqual(['/', '/@goosely', '/vod/5', '/clip/9', '/chat', '/broadcast', '/dashboard', '/docs/whip', '/@a/b'].map(pageKind),
        ['home', 'channel', 'vod', 'clip', 'chat', 'broadcast', 'dashboard', 'other', 'other']);
    assert.deepStrictEqual([390, 800, 1440, 0].map(deviceClass), ['phone', 'tablet', 'desktop', 'desktop']);

    let t = 0;
    const rum = createRum({ now: () => t });
    const app = express();
    app.set('trust proxy', true);
    app.use('/api/rum', rum.router);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const beacon = (body, ip = '10.0.0.1') => fetch(`${base}/api/rum`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', 'cf-connecting-ip': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) });

    // Ten phone loads of the home page.
    for (let i = 1; i <= 10; i++) {
        const r = await beacon({ path: '/', w: 390, ttfb: 100 * i, fcp: 800 + i, lcp: 1000 * i, cls: 0.0123, inp: 0, tbt: 50 * i, errs: i === 1 ? ['TypeError: x is undefined', 'b', 'c', 'd'] : [] }, `10.0.0.${i}`);
        assert.strictEqual(r.status, 204);
    }
    // Out of range, unmeasured and junk.
    await beacon({ path: '/', w: 390, lcp: 999999, fcp: 0, cls: 50 }, '10.0.1.1');
    assert.strictEqual((await beacon('not json', '10.0.1.2')).status, 204);
    await beacon({ path: '/@goosely', w: 1440, lcp: 2500 }, '10.0.1.3');

    const snap = rum.snapshot();
    const home = snap.pages['home|phone'];
    assert.strictEqual(home.beacons, 11, 'every well-formed beacon counts');
    assert.strictEqual(home.lcp.n, 10, 'an LCP over 60 s is left out');
    assert.deepStrictEqual([home.lcp.p50, home.lcp.p75, home.lcp.p95], [6000, 8000, 10000]);
    assert.strictEqual(home.fcp.n, 10, 'an unmeasured (0) FCP is left out');
    assert.strictEqual(home.cls.n, 10, 'a CLS over 10 is left out');
    assert.strictEqual(home.cls.p75, 0.012);
    assert.strictEqual(home.inp.n, 10, 'INP 0 is a real value (no slow interaction)');
    assert.strictEqual(snap.pages['channel|desktop'].lcp.p50, 2500);
    assert.strictEqual(snap.pages['channel|desktop'].ttff, undefined, 'no live picture: no ttff');
    await beacon({ path: '/@goosely', w: 1440, ttff: 1800 }, '10.0.1.4');
    assert.strictEqual(rum.snapshot().pages['channel|desktop'].ttff.p50, 1800, 'time to the first live picture');
    assert.deepStrictEqual(snap.errors.map((e) => e.message), ['TypeError: x is undefined', 'b', 'c'], 'at most three errors per beacon');
    // The gauge: p75 per metric, only for reservoirs with at least 5 samples.
    const g = rum.p75Gauge();
    assert.ok(g.some((x) => x.labels.metric === 'lcp' && x.labels.page === 'home' && x.labels.device === 'phone' && x.value === 8000));
    assert.ok(!g.some((x) => x.labels.page === 'channel'), 'one channel sample is not a p75');
    assert.deepStrictEqual(rum.errorsGauge().map((x) => [x.labels.message, x.value]), [['TypeError: x is undefined', 1], ['b', 1], ['c', 1]]);

    // A flood from one address: 20 a minute, then dropped until the next minute.
    const before = rum.snapshot().pages['clip|phone'];
    for (let i = 0; i < 25; i++) await beacon({ path: '/clip/1', w: 390, lcp: 1000 }, '10.9.9.9');
    assert.strictEqual(before, undefined);
    assert.strictEqual(rum.snapshot().pages['clip|phone'].beacons, 20);
    t += 60_000;
    await beacon({ path: '/clip/1', w: 390, lcp: 1000 }, '10.9.9.9');
    assert.strictEqual(rum.snapshot().pages['clip|phone'].beacons, 21);

    // At most 100 distinct error messages: the rarest (the oldest among equals) make room; a frequent one stays.
    rum.record({ path: '/', w: 390, errs: ['TypeError: x is undefined'] });
    for (let i = 0; i < 120; i++) rum.record({ path: '/', w: 390, errs: [`err ${i}`] });
    assert.ok(rum.snapshot().errors.length <= 25 && rum.snapshot().errors[0].message === 'TypeError: x is undefined');
    server.close();

    // app.js: a quarter of page loads, once idle, through the runtime's versioned loader.
    const app_js = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
    assert.ok(app_js.includes("if (Math.random() < 0.25 && window.ov) (window.requestIdleCallback || setTimeout)(() => ov.loadScript('/js/ov-rum.js'));"));
    const client = fs.readFileSync(path.join(__dirname, '../public/js/ov-rum.js'), 'utf8');
    assert.ok(client.includes("navigator.sendBeacon('/api/rum'") && !/cookie|localStorage/i.test(client.replace(/\/\*[\s\S]*?\*\//g, '')), 'the beacon carries no identifier');
    assert.ok(/navigator\.webdriver \|\| \/bot\|crawl\|spider[^/]*headless/.test(client), 'automated browsers (crawlers, headless runs) send nothing');
    assert.ok(!/userAgent[^)]*sendBeacon|JSON\.stringify\(\{[^}]*userAgent/.test(client), 'the user agent is checked, never sent');

    console.log('rum: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
