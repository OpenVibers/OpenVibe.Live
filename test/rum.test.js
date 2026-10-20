'use strict';
/**
 * Real-user measurements (server/web/rum.js, public/js/ov-rum.js): a beacon becomes numbers in a reservoir per page
 * kind and device class, with nothing about the visitor kept. Checked here:
 *   - POST /api/rum takes the text/plain JSON navigator.sendBeacon sends and always answers 204;
 *   - page kinds and device classes; out-of-range or unmeasured values are left out; CLS keeps 3 decimals;
 *   - percentiles in the staff snapshot and the p75 gauge (only once a reservoir has 5 samples);
 *   - error messages are counted (at most 3 per beacon, at most 100 distinct); junk and floods are dropped;
 *   - app.js loads the script on every page load, after the page is idle.
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

    // Across a restart: the state is numbers only, and a new process puts it back under what arrived since its boot.
    const saved = JSON.parse(JSON.stringify(rum.state()));
    assert.ok(!JSON.stringify(saved).includes('10.0.0.'), 'no address in the saved state');
    const next = createRum({ now: () => t });
    next.record({ path: '/', w: 390, lcp: 1234 });                                  // a beacon before the read
    assert.strictEqual(next.restore(saved), true);
    const homeNext = next.snapshot().pages['home|phone'];
    assert.strictEqual(homeNext.beacons, rum.snapshot().pages['home|phone'].beacons + 1);
    assert.strictEqual(homeNext.lcp.n, 11, 'the saved samples, then the new one');
    assert.deepStrictEqual(next.p75Gauge().find((x) => x.labels.metric === 'lcp' && x.labels.page === 'home').value, 8000);
    assert.ok(next.snapshot().errors.some((e) => e.message === 'TypeError: x is undefined'));
    assert.strictEqual(createRum({ now: () => t + 15 * 86400000 }).restore(saved), false, 'older than 14 days: start empty');
    const junk = createRum(); junk.restore({ v: 1, at: Date.now(), pages: { 'evil|key': { n: 9, samples: {} }, 'home|phone': { n: 2, samples: { lcp: [100, 'a', -5, 1e9] } } } });
    assert.deepStrictEqual([Object.keys(junk.snapshot().pages), junk.snapshot().pages['home|phone'].lcp.n], [['home|phone'], 1], 'malformed keys and values are left out');
    const index = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    assert.ok(index.includes("app.get('/metrics/rum'") && index.includes('isLoopbackDirect(req)'), 'the host reads the snapshot on loopback only');
    // Restored once the database is open (read at module load, the read failed before the pool existed and the first save
    // overwrote the stored reservoirs: every deploy emptied them), and nothing is saved before a successful read.
    const initAt = index.indexOf('await db.initDb();');
    const restoreAt = index.indexOf('await restoreRum();');
    assert.ok(initAt > 0 && restoreAt > initAt, 'restoreRum() runs in start(), after initDb');
    assert.ok(index.indexOf('if (drill.enabled) return await startDrill();') < restoreAt, 'never in a restore drill');
    const fn = index.slice(index.indexOf('async function restoreRum()'), index.indexOf('async function restoreRum()') + 900);
    assert.ok(fn.indexOf("db.getState('rum_state')") < fn.indexOf('rumRestored = true') && fn.indexOf('rumRestored = true') < fn.indexOf("every('rum-save'"),
        'read first, then mark restored, then start saving');
    assert.ok(/catch \(err\) \{[^}]*return; \}/.test(fn), 'a failed read returns before any save is scheduled');
    assert.ok(index.includes("if (!drill.enabled && rumRestored) await db.setState('rum_state'"), 'the shutdown save waits for a restore too');
    assert.ok(!/^db\.getState\('rum_state'\)/m.test(index) && !/^\s{4}db\.getState\('rum_state'\)\.then/m.test(index), 'no read at module load any more');

    // app.js: every page load, once idle, through the runtime's versioned loader (a quarter of them gave too few
    // samples at this traffic; automated browsers are skipped in the script itself).
    const app_js = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
    assert.ok(app_js.includes("if (window.ov) (window.requestIdleCallback || setTimeout)(() => ov.loadScript('/js/ov-rum.js'));"));
    const client = fs.readFileSync(path.join(__dirname, '../public/js/ov-rum.js'), 'utf8');
    assert.ok(client.includes("navigator.sendBeacon('/api/rum'") && !/cookie|localStorage/i.test(client.replace(/\/\*[\s\S]*?\*\//g, '')), 'the beacon carries no identifier');
    assert.ok(/navigator\.webdriver \|\| \/bot\|crawl\|spider[^/]*headless/.test(client), 'automated browsers (crawlers, headless runs) send nothing');
    assert.ok(!/userAgent[^)]*sendBeacon|JSON\.stringify\(\{[^}]*userAgent/.test(client), 'the user agent is checked, never sent');

    // ov-rum.js in a sandbox: what it sends for a page shown at once, one opened in a background tab, and its errors.
    const runClient = ({ visibility, paints, lcp, errors = [] }) => {
        const sent = [];
        const handlers = {};
        const observers = {};
        const vm = require('vm');
        const ctx = {
            navigator: { sendBeacon: (url, body) => { sent.push(JSON.parse(body)); return true; }, webdriver: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140 Mobile' },
            document: { visibilityState: 'visible' },
            location: { pathname: '/@goosely' }, innerWidth: 390, window: {},
            performance: {
                now: () => 30000,
                getEntriesByType: (t) => (t === 'visibility-state' ? visibility : t === 'navigation' ? [{ name: 'https://openvibe.live/@goosely', responseStart: 120, activationStart: 0 }] : []),
            },
            PerformanceObserver: class { constructor(cb) { this.cb = cb; } observe(o) { observers[o.type] = this.cb; } },
            addEventListener: (type, fn) => { handlers[type] = fn; },
            URL, JSON, Math, String, Object, Infinity,
        };
        ctx.window = ctx;
        vm.createContext(ctx);
        vm.runInContext(client, ctx);
        const feed = (type, entries) => observers[type] && observers[type]({ getEntries: () => entries });
        feed('paint', paints);
        feed('largest-contentful-paint', lcp);
        for (const message of errors) handlers.error({ message });
        ctx.document.visibilityState = 'hidden';
        handlers.visibilitychange();
        return sent[0];
    };
    const shownAtOnce = runClient({ visibility: [{ name: 'visible', startTime: 0 }], paints: [{ name: 'first-contentful-paint', startTime: 900 }], lcp: [{ startTime: 1400 }] });
    assert.deepStrictEqual([shownAtOnce.fcp, shownAtOnce.lcp], [900, 1400], 'a page shown at once keeps its paints');
    // Opened in a background tab (hidden from the start), shown 28 s later: its paints say when the visitor looked.
    const background = runClient({ visibility: [{ name: 'hidden', startTime: 0 }, { name: 'visible', startTime: 28000 }], paints: [{ name: 'first-contentful-paint', startTime: 28488 }], lcp: [{ startTime: 28712 }] });
    assert.deepStrictEqual([background.fcp, background.lcp], [0, 0], 'a background tab sends no FCP or LCP (the 28-29 s samples of 2026-10-20)');
    assert.strictEqual(background.ttfb, 120, 'its other timings still count');
    // Hidden after its first paint but before the largest one: the first counts, the late one does not.
    const leftEarly = runClient({ visibility: [{ name: 'visible', startTime: 0 }, { name: 'hidden', startTime: 2000 }], paints: [{ name: 'first-contentful-paint', startTime: 800 }], lcp: [{ startTime: 1200 }, { startTime: 9000 }] });
    assert.deepStrictEqual([leftEarly.fcp, leftEarly.lcp], [800, 1200]);
    const errs = runClient({ visibility: [], paints: [], lcp: [], errors: ['ResizeObserver loop completed with undelivered notifications.', 'TypeError: x is undefined'] }).errs;
    assert.deepStrictEqual(errs, ['TypeError: x is undefined'], 'the ResizeObserver notice is not an error');

    console.log('rum: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
