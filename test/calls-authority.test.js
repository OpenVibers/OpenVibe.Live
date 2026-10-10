'use strict';

// Calls are OpenVibe.Chat's (WS-I task 1, T3; server/streaming/calls-authority.js). Live's own call server is gone:
// a stream's call hooks are POST/DELETE /internal/calls/stream-channel on OpenVibe.Chat with Live's service token for
// audience openvibe.chat, retried after a network error or a 5xx, never after a 4xx, and a retry that a later call for
// the same stream superseded is dropped. The go-live, stream-end, WHIP and admin force-end hooks all go through it, and
// Live serves no /ws/call or voice-channel route of its own. Against a stub Network + Chat.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const seen = [];          // requests to Chat's /internal/calls
const tokenAudiences = [];
let answer = () => [200, { ok: true }];
const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') {
            const aud = new URLSearchParams(raw).get('audience');
            tokenAudiences.push(aud);
            return res.end(JSON.stringify({ access_token: `svc-live-for-${aud}`, token_type: 'Bearer', expires_in: 300 }));
        }
        if (req.url.startsWith('/internal/calls/')) {
            const r = { method: req.method, url: req.url, auth: req.headers.authorization || null, body: raw ? JSON.parse(raw) : null };
            seen.push(r);
            const [status, body] = answer(r);
            res.statusCode = status;
            return res.end(JSON.stringify(body));
        }
        res.statusCode = 404; res.end('{}');
    });
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const port = await listen(stub);
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${port}`;
    process.env.OV_CHAT_INTERNAL_URL = `http://127.0.0.1:${port}`;

    const db = require('../server/db/database');
    db.getStreamById = (id) => ({ id: Number(id), user_id: 7, title: `Stream ${id} title`, is_live: 1 });
    const calls = require('../server/streaming/calls-authority');
    calls.RETRY_MS.splice(0, calls.RETRY_MS.length, 30, 30, 30);

    let exit = 0;
    try {
        // 1. The hooks go to Chat's internal endpoints with Live's service token.
        const created = await calls.createStreamChannel(42, 'mic+cam', 7);
        assert.deepStrictEqual(created, { ok: true });
        assert.deepStrictEqual(seen[0], { method: 'POST', url: '/internal/calls/stream-channel', auth: 'Bearer svc-live-for-openvibe.chat', body: { stream_id: 42, mode: 'mic+cam', user_id: 7 } });
        assert.ok(tokenAudiences.includes('openvibe.chat'));
        await calls.removeStreamChannel(42);
        assert.deepStrictEqual([seen[1].method, seen[1].url, seen[1].body], ['DELETE', '/internal/calls/stream-channel/42', null]);

        // 2. A 5xx (or Chat down) is retried; a 4xx is not.
        seen.length = 0;
        let n = 0;
        answer = () => (++n === 1 ? [503, { error: 'restarting' }] : [200, { ok: true }]);
        assert.deepStrictEqual(await calls.createStreamChannel(43, 'mic', 7), { ok: true });
        assert.strictEqual(seen.length, 2, 'retried once');
        seen.length = 0;
        answer = () => [409, { error: 'Calls are not served by Chat (CHAT_CALLS is not set)', code: 'calls.off' }];
        assert.strictEqual(await calls.createStreamChannel(43, 'mic', 7), null);
        assert.strictEqual(seen.length, 1, 'a refusal is not retried');
        assert.ok(/409/.test(calls.stats.lastError));

        // 3. A retry that a later call for the same stream superseded is dropped: a stream that ended
        //    while its go-live was being retried does not get its channel back.
        seen.length = 0;
        answer = (r) => (r.method === 'POST' ? [502, { error: 'bad gateway' }] : [200, { ok: true, removed: false }]);
        const pending = calls.createStreamChannel(44, 'mic', 7);
        await sleep(10);
        await calls.removeStreamChannel(44);
        assert.strictEqual(await pending, null);
        await sleep(120);
        assert.deepStrictEqual(seen.map((r) => r.method), ['POST', 'DELETE'], 'the go-live was not retried after the stream ended');
        assert.ok(calls.stats.superseded >= 1);

        // 4. Every stream hook goes through the authority, not straight to Live's call server.
        const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');
        const routes = src('streaming/routes.js');
        assert.ok(routes.includes('callsAuthority.createStreamChannel(streamId, callMode, req.user.id)'), 'go-live');
        assert.ok(routes.includes('callsAuthority.removeStreamChannel(stream.id)'), 'stream end');
        for (const f of ['streaming/whip-handler.js', 'admin/routes.js']) {
            assert.ok(/calls-authority'\)\.removeStreamChannel\(/.test(src(f)), f);
            assert.ok(!/call-server'\)\.removeStreamChannel\(/.test(src(f)), `${f} no longer calls Live's call server directly`);
        }
        // 5. Live's own call server is gone: no module, no /ws/call upgrade, no voice-channel or group-call routes, no flag.
        assert.ok(!fs.existsSync(path.join(__dirname, '..', 'server', 'streaming', 'call-server.js')), 'call-server.js is deleted');
        assert.ok(!src('index.js').includes("'/ws/call'"), 'index.js upgrades no /ws/call');
        assert.ok(!/router\.(get|post|put|delete)\('\/(voice-channels|:id\/call)/.test(routes), 'no voice-channel or group-call routes in Live');
        for (const f of ['index.js', 'streaming/routes.js', 'streaming/calls-authority.js', 'streaming/whip-handler.js', 'admin/routes.js']) {
            assert.ok(!src(f).includes('CALLS_AUTHORITY'), `${f} reads no CALLS_AUTHORITY`);
        }
    } catch (err) {
        exit = 1;
        console.error(err);
    }
    stub.close();
    console.log = quiet;
    console.log(exit ? 'calls authority: FAILED' : 'calls authority: all checks passed');
    process.exit(exit);
})();
