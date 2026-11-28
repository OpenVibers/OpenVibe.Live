'use strict';
// GET /api/rum/summary (11-28, plan AD.37 "Reflect via Watch"): the p75 of what real visitors felt, per page kind and
// device class, public and cacheable, for readings with at least 20 samples; numbers only (no error messages, no
// element names), so a Watch or openvibe.report can follow a page's speed after a fix.
const assert = require('assert');
const express = require('express');
const { createRum } = require('../server/web/rum');

(async () => {
    const rum = createRum({ now: () => Date.parse('2026-11-28T08:30:00Z') });
    for (let i = 1; i <= 25; i++) rum.record({ path: '/', w: 820, lcp: 100 * i, cls: i / 100, inp: 10 * i, cls_on: 'section#home-live', errs: ['TypeError: secret thing'] });
    for (let i = 1; i <= 5; i++) rum.record({ path: '/', w: 390, lcp: 1000 });   // too few to say anything
    const app = express();
    app.use('/api/rum', rum.router);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rum/summary`);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('cache-control'), /public, max-age=300/);
        assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
        const doc = await res.json();
        assert.strictEqual(doc.generated_at, '2026-11-28T08:30:00.000Z');
        assert.deepStrictEqual(Object.keys(doc.pages), ['home|tablet'], 'only readings with 20 or more samples');
        assert.deepStrictEqual(doc.pages['home|tablet'].lcp, { p75: 1900, n: 25 });
        assert.deepStrictEqual(doc.pages['home|tablet'].cls, { p75: 0.19, n: 25 });
        const text = JSON.stringify(doc);
        assert.ok(!text.includes('secret') && !text.includes('section#home-live'), 'numbers only: no error messages, no element names');
    } finally {
        server.close();
    }
    console.log('rum-summary: public p75s per page and device, 20 samples or more, numbers only');
})().catch((e) => { console.error(e); process.exit(1); });
