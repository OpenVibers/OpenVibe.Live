'use strict';
// /api/'s rate limit (server/web/api-limits.js): our own services calling Live directly on 127.0.0.1 with no proxy
// headers (openvibe.video's pages) are never refused (11-28: they shared one 900-a-minute bucket and Video answered
// 502 when it ran out), while a visitor coming through nginx (X-Forwarded-For set) is still limited at 900 GETs a minute.
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';

(async () => {
    const express = require('express');
    const rateLimit = require('express-rate-limit');
    const { apiLimiterOptions } = require('../server/web/api-limits');
    const app = express();
    app.use('/api/', rateLimit(apiLimiterOptions()));
    app.get('/api/ping', (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
    const get = (headers = {}) => new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/ping', headers, agent }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
    });
    const burst = async (n, headers) => {
        const codes = [];
        for (let i = 0; i < n; i += 50) codes.push(...await Promise.all(Array.from({ length: Math.min(50, n - i) }, () => get(headers))));
        return codes;
    };
    try {
        const direct = await burst(1000);
        assert.ok(direct.every((c) => c === 200), `a direct loopback caller was refused ${direct.filter((c) => c !== 200).length} times`);

        const proxied = await burst(901, { 'X-Forwarded-For': '203.0.113.9' });
        assert.strictEqual(proxied.filter((c) => c === 200).length, 900, 'a visitor through nginx gets 900 GETs a minute');
        assert.strictEqual(proxied.filter((c) => c === 429).length, 1, 'and the 901st is refused');

        const realIp = await get({ 'X-Real-IP': '203.0.113.9' });
        assert.strictEqual(realIp, 429, 'any proxy header counts as proxied, not only X-Forwarded-For');
    } finally {
        agent.destroy();
        server.close();
    }
    console.log('api-limit-internal-callers: direct loopback callers are never refused; proxied visitors are limited');
})().catch((e) => { console.error(e); process.exit(1); });
