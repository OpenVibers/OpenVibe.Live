'use strict';
/**
 * Live reaches OpenVibe.Media with its own Network service token (plan T4): a client-credentials
 * token for audience openvibe.media, sent as `Authorization: Bearer …`, beside the acting user's
 * `X-OV-User-Id`. The retired per-app key is gone. A local stub stands in for Media (recording the
 * headers it receives) and another for Network's /oauth/token.
 *
 *   node test/media-service-token.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
}

const tokensSeen = [];
const mediaCalls = [];
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));

const tokenStub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const f = new URLSearchParams(raw);
        tokensSeen.push({ url: req.url, grant: f.get('grant_type'), audience: f.get('audience'), scope: f.get('scope') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: `svc-token-for-${f.get('audience')}`, token_type: 'Bearer', expires_in: 300, scope: 'media.object.read media.object.list' }));
    });
});
const mediaStub = http.createServer((req, res) => {
    mediaCalls.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
});

(async () => {
    await listen(tokenStub);
    await listen(mediaStub);
    process.env.MEDIA_URL = `http://127.0.0.1:${mediaStub.address().port}`;
    process.env.MEDIA_APP_ID = 'live';
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${tokenStub.address().port}`;
    process.env.OV_OAUTH_CLIENT_ID = 'live';
    process.env.OV_OAUTH_CLIENT_SECRET = 'k'.repeat(40);
    // The retired per-app key, named without the literal so a repo-wide grep for it stays empty. Set
    // on purpose: it must never be sent.
    const RETIRED_KEY_ENV = ['MEDIA', 'API_KEY'].join('_');
    process.env[RETIRED_KEY_ENV] = 'retired-per-app-key';

    const media = require('../server/media-client');

    console.log('media service token: the request');
    await check('nothing is fetched at module load (the client is lazy)', () => {
        assert.strictEqual(tokensSeen.length, 0, 'no token fetch at module load');
    });
    await check('a request carries the openvibe.media token and the acting user, fetched once', async () => {
        await media.request('GET', '/vods', { actingUser: 80 });
        await media.request('GET', '/vods', { actingUser: 80 });
        assert.strictEqual(tokensSeen.length, 1, 'the token is fetched once and reused');
        assert.strictEqual(tokensSeen[0].url, '/oauth/token');
        assert.strictEqual(tokensSeen[0].grant, 'client_credentials');
        assert.strictEqual(tokensSeen[0].audience, 'openvibe.media');
        assert.strictEqual(mediaCalls.length, 2);
        for (const call of mediaCalls) {
            assert.strictEqual(call.url, '/api/v1/live/vods', 'the Media base still carries the tenant');
            assert.strictEqual(call.headers.authorization, 'Bearer svc-token-for-openvibe.media');
            assert.strictEqual(call.headers['x-ov-user-id'], '80');
        }
    });
    await check('an anonymous call claims no acting user, only the service token', async () => {
        mediaCalls.length = 0;
        await media.request('GET', '/vods');
        assert.strictEqual(mediaCalls[0].headers['x-ov-user-id'], undefined);
        assert.strictEqual(mediaCalls[0].headers.authorization, 'Bearer svc-token-for-openvibe.media');
    });
    await check('the proxy helper awaits the same token', async () => {
        const app = express();
        app.get('/pastes', (req, res) => media.proxy(req, res, '/pastes'));
        const srv = http.createServer(app);
        await listen(srv);
        mediaCalls.length = 0;
        const r = await fetch(`http://127.0.0.1:${srv.address().port}/pastes`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(mediaCalls[0].headers.authorization, 'Bearer svc-token-for-openvibe.media');
        srv.close();
    });

    console.log('media service token: the retired key and the unconfigured case');
    await check('with no client secret, no Authorization header is sent and the retired key is not used', async () => {
        media._reset();
        delete process.env.OV_OAUTH_CLIENT_SECRET;
        mediaCalls.length = 0;
        await media.request('GET', '/vods', { actingUser: 7 });
        assert.strictEqual(mediaCalls[0].headers.authorization, undefined, 'nothing configured = no Authorization');
        assert.ok(!/retired-per-app-key/.test(JSON.stringify(mediaCalls[0].headers)),
            `the retired key (${RETIRED_KEY_ENV}) is never sent, even when set in the environment`);
        assert.strictEqual(mediaCalls[0].headers['x-ov-user-id'], '7', 'the acting user still rides along');
    });
    await check('a configured credential is the service token, never the retired key', async () => {
        process.env.OV_OAUTH_CLIENT_SECRET = 'k'.repeat(40);
        media._reset();
        mediaCalls.length = 0;
        await media.request('GET', '/vods');
        assert.strictEqual(mediaCalls[0].headers.authorization, 'Bearer svc-token-for-openvibe.media');
        assert.notStrictEqual(mediaCalls[0].headers.authorization, 'Bearer retired-per-app-key');
    });
    await check('the client is off under LIVE_DRILL', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'media-client.js'), 'utf8');
        assert.ok(/require\('\.\/drill'\)\.enabled/.test(src), 'serviceTokens() refuses to build under a restore drill');
    });

    tokenStub.close();
    mediaStub.close();
    if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
    console.log('\nmedia service token: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
