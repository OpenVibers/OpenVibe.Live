'use strict';

// Who runs calls (WS-I task 1, server/streaming/calls-authority.js). CALLS_AUTHORITY unset (or
// anything but "chat"): stream voice channels are made and removed by Live's own call server and
// nothing is sent anywhere — as before. "chat": the same hooks become POST/DELETE
// /internal/calls/stream-channel on OpenVibe.Chat with Live's service token for audience
// openvibe.chat, retried after a network error or a 5xx, never after a 4xx, and a retry that a later
// call for the same stream superseded is dropped. The go-live, stream-end, WHIP and admin force-end
// hooks all go through it. Against a stub Network + Chat.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-calls-authority-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
delete process.env.CALLS_AUTHORITY;
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
    const callServer = require('../server/streaming/call-server');
    calls.RETRY_MS.splice(0, calls.RETRY_MS.length, 30, 30, 30);

    let exit = 0;
    try {
        // 1. The flag.
        for (const v of [undefined, '', 'live', 'LIVE', 'other']) {
            if (v === undefined) delete process.env.CALLS_AUTHORITY; else process.env.CALLS_AUTHORITY = v;
            assert.strictEqual(calls.authority(), 'live', String(v));
        }
        for (const v of ['chat', 'CHAT', ' chat ']) { process.env.CALLS_AUTHORITY = v; assert.strictEqual(calls.authority(), 'chat', v); }
        delete process.env.CALLS_AUTHORITY;

        // 2. Default: Live's call server, nothing sent.
        const ch = calls.createStreamChannel(41, 'mic', 7);
        assert.deepStrictEqual([ch.id, ch.mode, ch.name, ch.createdBy], ['stream-41', 'mic', 'Stream 41 title', 7]);
        assert.ok(callServer.channels.has('stream-41'));
        calls.removeStreamChannel(41);
        assert.ok(!callServer.channels.has('stream-41'));
        await sleep(50);
        assert.deepStrictEqual(seen, [], 'CALLS_AUTHORITY unset sends nothing to Chat');

        // 3. chat: the hooks go to Chat's internal endpoints with Live's service token; nothing local.
        process.env.CALLS_AUTHORITY = 'chat';
        const created = await calls.createStreamChannel(42, 'mic+cam', 7);
        assert.deepStrictEqual(created, { ok: true });
        assert.deepStrictEqual(seen[0], { method: 'POST', url: '/internal/calls/stream-channel', auth: 'Bearer svc-live-for-openvibe.chat', body: { stream_id: 42, mode: 'mic+cam', user_id: 7 } });
        assert.ok(tokenAudiences.includes('openvibe.chat'));
        assert.ok(!callServer.channels.has('stream-42'), 'Live\'s call server is not used');
        await calls.removeStreamChannel(42);
        assert.deepStrictEqual([seen[1].method, seen[1].url, seen[1].body], ['DELETE', '/internal/calls/stream-channel/42', null]);

        // 4. A 5xx (or Chat down) is retried; a 4xx is not.
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

        // 5. A retry that a later call for the same stream superseded is dropped: a stream that ended
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

        // 6. Every stream hook goes through the authority, not straight to Live's call server.
        const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');
        const routes = src('streaming/routes.js');
        assert.ok(routes.includes('callsAuthority.createStreamChannel(streamId, callMode, req.user.id)'), 'go-live');
        assert.ok(routes.includes('callsAuthority.removeStreamChannel(stream.id)'), 'stream end');
        for (const f of ['streaming/whip-handler.js', 'admin/routes.js']) {
            assert.ok(/calls-authority'\)\.removeStreamChannel\(/.test(src(f)), f);
            assert.ok(!/call-server'\)\.removeStreamChannel\(/.test(src(f)), `${f} no longer calls Live's call server directly`);
        }
        assert.strictEqual((src('streaming/calls-authority.js').match(/process\.env\.CALLS_AUTHORITY/g) || []).length, 1);
        for (const f of ['index.js', 'streaming/routes.js', 'streaming/whip-handler.js', 'admin/routes.js']) {
            assert.ok(!src(f).includes('process.env.CALLS_AUTHORITY'), `${f} does not read the flag itself`);
        }
    } catch (err) {
        exit = 1;
        console.error(err);
    }
    stub.close();
    try { callServer.close(); } catch { /* */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log = quiet;
    console.log(exit ? 'calls authority: FAILED' : 'calls authority: all checks passed');
    process.exit(exit);
})();
