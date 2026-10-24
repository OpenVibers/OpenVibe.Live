'use strict';
// WebSocket paths Live does not serve get a real HTTP answer, not a dropped socket (server/net/ws-paths.js): nginx
// logged every drop as a 502, 2,137 of them in three hours on 2026-10-23 from two old Pi clients reconnecting to
// the retired /ws/control. /ws/control answers 410 naming OpenVibe.Bot, any other unknown path 404, and both before
// the handler's origin check and ban lookup. The served list is exactly what server/index.js dispatches.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { classify, refuse, SERVED } = require('../server/net/ws-paths');

(async () => {
    assert.strictEqual(classify('/ws/broadcast?stream=1'), 'served');
    assert.deepStrictEqual(classify('/ws/vibe-coding/publish?token=x'), { status: '410 Gone', text: 'Vibe coding feeds moved to OpenVibe.Chat: https://openvibe.chat/feeds' });
    assert.strictEqual(classify('/ws/robotstreamer-publish?key=x'), 'served');
    assert.deepStrictEqual(classify('/ws/control'), { status: '410 Gone', text: 'Robot control moved to OpenVibe.Bot: https://openvibe.bot' });
    assert.deepStrictEqual(classify('/ws/control?robot=7'), classify('/ws/control'));
    assert.strictEqual(classify('/ws/nope').status, '404 Not Found');
    assert.strictEqual(classify('').status, '404 Not Found');

    // A real client reads the refusal as an HTTP response.
    const server = http.createServer((_req, res) => res.end());
    server.on('upgrade', (req, socket) => { const t = classify(req.url); if (t !== 'served') refuse(socket, t); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const ask = (p) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
        req.on('response', (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
        req.on('upgrade', () => reject(new Error('upgraded')));
        req.on('error', reject);
        req.end();
    });
    assert.deepStrictEqual(await ask('/ws/control'), { status: 410, body: 'Robot control moved to OpenVibe.Bot: https://openvibe.bot\n' });
    assert.strictEqual((await ask('/ws/whatever')).status, 404);
    server.close();

    // server/index.js classifies first (before the origin check and the ban lookup) and dispatches exactly SERVED.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const handler = src.slice(src.indexOf("server.on('upgrade'"), src.indexOf('// ── Initialize & Start'));
    assert.ok(handler.indexOf('wsPaths.classify(url)') > 0 && handler.indexOf('wsPaths.classify(url)') < handler.indexOf('isIpBanned'), 'classified before the ban lookup');
    assert.ok(handler.indexOf('wsPaths.classify(url)') < handler.indexOf('allowedOrigins.has'), 'classified before the origin check');
    const dispatched = [...handler.matchAll(/url\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(dispatched.sort(), [...SERVED].sort(), 'SERVED is what the handler dispatches');
    assert.ok(!/socket\.destroy\(\);\s*\}\s*\}\);/.test(handler), 'no silent drop for an unknown path');
    console.log('ws-paths: ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
