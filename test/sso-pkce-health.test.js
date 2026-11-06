/**
 * Live's sign-in is an OAuth2 client of OpenVibe.Network. The OAuth half moved to openvibe-sdk/sso: the authorize URL
 * now carries a PKCE S256 challenge, the callback requires the matching verifier, the flow state is compared in
 * constant time, and GET /api/auth/health says whether the Network accepts Live's client. The site's own cookie names
 * and the hbt_ API tokens are unchanged.
 *
 *   node test/sso-pkce-health.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'http://live.test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
delete process.env.OV_OAUTH_CLIENT_SECRET;

const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('../server/db/database');
const config = require('../server/config');
const routes = require('../server/auth/routes');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** The stand-in Network: the grants Live asks for, and the token request bodies it saw. */
function startNetwork() {
    const seen = [];
    let mode = 'ok';
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/oauth/token') return json(res, 404, { error: 'not_found' });
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let payload;
            try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_request' }); }
            seen.push(payload);
            if (mode === 'invalid_client') return json(res, 401, { error: 'invalid_client', error_description: 'bad client' });
            if (payload.grant_type === 'authorization_code') {
                if (payload.code !== 'good' || !/^[A-Za-z0-9_-]{43}$/.test(String(payload.code_verifier || ''))) {
                    return json(res, 400, { error: 'invalid_grant', error_description: 'code was not issued' });
                }
                return json(res, 200, {
                    access_token: 'access-good', refresh_token: 'refresh-good', token_type: 'Bearer', expires_in: 3600,
                    user: { id: 'network-1', username: 'networkuser', display_name: 'Network User', role: 'user' },
                });
            }
            if (payload.grant_type === 'refresh_token') {
                if (payload.refresh_token !== 'refresh-good') return json(res, 400, { error: 'invalid_grant' });
                return json(res, 200, { access_token: 'access-refreshed', refresh_token: 'refresh-2', expires_in: 3600 });
            }
            return json(res, 400, { error: 'unsupported_grant_type' });
        });
    });
    return { server, seen, setMode: (m) => { mode = m; } };
}

/** A Network that refuses this site's client, for the health 503 case. */
function startRefuser() {
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/oauth/token') return json(res, 401, { error: 'invalid_client' });
        return json(res, 404, { error: 'not_found' });
    });
    return { server };
}

function setCookies(res) {
    if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
    const raw = res.headers.get('set-cookie') || '';
    return raw ? raw.split(/,\s*(?=[^;,]+=)/) : [];
}

function jarOf(res) {
    const jar = {};
    for (const header of setCookies(res)) {
        const pair = header.split(';')[0];
        const at = pair.indexOf('=');
        if (at > 0) jar[pair.slice(0, at).trim()] = pair.slice(at + 1);
    }
    return jar;
}

function cookieHeader(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

(async () => {
    await db.initDb();
    config.baseUrl = 'http://live.test';
    config.openvibeToolsUrl = 'https://openvibe.network';

    const network = startNetwork();
    const networkPort = await listen(network.server);
    config.openvibeToolsInternalUrl = `http://127.0.0.1:${networkPort}`;

    const refuser = startRefuser();
    const refuserPort = await listen(refuser.server);

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.get('/auth/health', routes.health);
    app.use('/api/auth', routes);
    const appServer = http.createServer(app);
    const appPort = await listen(appServer);

    const request = async (pathname, { cookie, method = 'GET', headers = {}, body } = {}) => {
        const res = await fetch(`http://127.0.0.1:${appPort}${pathname}`, {
            method, redirect: 'manual',
            headers: { ...(cookie ? { cookie } : {}), ...headers },
            body,
        });
        const text = await res.text();
        return { status: res.status, location: res.headers.get('location'), setCookies: setCookies(res), text, headers: res.headers };
    };

    try {
        // ── Login: PKCE S256, state, verifier cookie, silent/prompt/login_hint ──────────────────
        const login = await request('/api/auth/sso/login?silent=1&next=%2Fdashboard');
        assert.strictEqual(login.status, 302);
        const authorize = new URL(login.location);
        assert.deepStrictEqual([authorize.origin + authorize.pathname, authorize.searchParams.get('client_id')],
            ['https://openvibe.network/oauth/authorize', 'live']);
        assert.strictEqual(authorize.searchParams.get('redirect_uri'), 'http://live.test/api/auth/callback');
        assert.strictEqual(authorize.searchParams.get('response_type'), 'code');
        assert.strictEqual(authorize.searchParams.get('scope'), 'profile theme');
        assert.strictEqual(authorize.searchParams.get('prompt'), 'none', 'silent stays prompt=none');
        const state = authorize.searchParams.get('state');
        assert.match(state, /^[A-Za-z0-9_-]{32}$/, 'the SDK state is 24 random bytes, base64url');
        assert.strictEqual(authorize.searchParams.get('code_challenge_method'), 'S256');
        assert.match(authorize.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/, 'a PKCE S256 challenge');
        const loginJar = jarOf(login);
        assert.strictEqual(loginJar.oauth_state, state, 'the state stays in oauth_state');
        assert.strictEqual(decodeURIComponent(loginJar.oauth_next), '/dashboard');
        assert.match(loginJar.ov_oauth_verifier, /^[A-Za-z0-9_-]{43}$/, 'the verifier gets its own flow cookie');
        const verifierCookie = login.setCookies.find((c) => /^ov_oauth_verifier=/.test(c));
        assert.match(verifierCookie, /; Max-Age=300; Path=\/api\/auth; .*HttpOnly/, '5 minutes, httpOnly, callback path');

        let prompt = await request('/api/auth/sso/login?prompt=select_account&login_hint=%40alt');
        let u = new URL(prompt.location);
        assert.deepStrictEqual([u.searchParams.get('prompt'), u.searchParams.get('login_hint')], ['select_account', '@alt']);
        prompt = await request('/api/auth/sso/login?prompt=consent&login_hint=%3Cb%3E');
        u = new URL(prompt.location);
        assert.deepStrictEqual([u.searchParams.get('prompt'), u.searchParams.get('login_hint')], [null, null], 'anything else is dropped');
        const evilNext = await request('/api/auth/sso/login?next=https%3A%2F%2Fevil.test%2F');
        assert.ok(!jarOf(evilNext).oauth_next, 'safeNext still drops a next that is not an OpenVibe site');

        // ── The state comparison is constant time ──────────────────────────────────────────────
        assert.strictEqual(routes.sameString('a-state', 'a-state'), true);
        assert.strictEqual(routes.sameString('a-state', 'a-statf'), false, 'same length, different value');
        assert.strictEqual(routes.sameString('a-state', 'a-state!'), false, 'different length');
        assert.strictEqual(routes.sameString('', ''), false, 'an empty state is never a match');
        assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'auth', 'routes.js'), 'utf8'),
            /crypto\.timingSafeEqual/, 'the callback compares the state in constant time');

        // ── Callback: the verifier is required, and the state must match ───────────────────────
        const before = network.seen.length;
        const noVerifier = await request(`/api/auth/callback?code=good&state=${encodeURIComponent(state)}`,
            { cookie: `oauth_state=${state}; oauth_next=%2Fdashboard` });
        assert.strictEqual(noVerifier.status, 403);
        assert.match(noVerifier.text, /That sign-in link expired/, 'a flow from before the deploy retries the normal way');
        assert.strictEqual(network.seen.length, before, 'no verifier: nothing is sent to the Network');

        const wrongState = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A');
        const mismatch = await request(`/api/auth/callback?code=good&state=${encodeURIComponent(wrongState)}`,
            { cookie: cookieHeader(loginJar) });
        assert.strictEqual(mismatch.status, 403);
        assert.strictEqual(network.seen.length, before, 'a state mismatch: nothing is sent to the Network');

        const callback = await request(`/api/auth/callback?code=good&state=${encodeURIComponent(state)}`,
            { cookie: cookieHeader(loginJar) });
        assert.strictEqual(callback.status, 200, 'the callback hands the browser the session page');
        assert.match(callback.text, /window\.location\.replace\("\/dashboard"\)/, 'safeNext at the callback still wins');
        const grant = network.seen[network.seen.length - 1];
        assert.strictEqual(grant.grant_type, 'authorization_code');
        assert.strictEqual(grant.client_id, 'live');
        assert.strictEqual(grant.redirect_uri, 'http://live.test/api/auth/callback');
        assert.strictEqual(grant.code_verifier, loginJar.ov_oauth_verifier, 'the code is exchanged with the verifier from the cookie');
        const sessionJar = jarOf(callback);
        assert.strictEqual(sessionJar.ov_token, 'access-good');
        assert.strictEqual(sessionJar.ov_refresh, 'refresh-good');
        assert.strictEqual(sessionJar.ov_sso_hint, 'account', 'the cookie names the site has always used are kept');

        // ── The sign-in fan-out is still returned at the callback ──────────────────────────────
        const fanout = await request('/api/auth/sso/login?next=https%3A%2F%2Fopenvibe.network%2Fsso%2Ffanout%3Fx%3D1');
        const fanoutJar = jarOf(fanout);
        const fanoutState = new URL(fanout.location).searchParams.get('state');
        const fanoutCallback = await request(`/api/auth/callback?code=good&state=${encodeURIComponent(fanoutState)}`,
            { cookie: cookieHeader(fanoutJar) });
        assert.strictEqual(fanoutCallback.status, 200);
        assert.match(fanoutCallback.text, /window\.location\.replace\("https:\/\/openvibe\.network\/sso\/fanout\?x=1"\)/);

        // ── GET /api/auth/health: 200 when the Network accepts the client, 503 when it refuses it ─
        const healthy = await request('/api/auth/health');
        assert.strictEqual(healthy.status, 200);
        assert.deepStrictEqual(JSON.parse(healthy.text), { ok: true, client: 'ok' });
        assert.strictEqual(healthy.headers.get('cache-control'), 'no-store');
        assert.strictEqual(network.seen[network.seen.length - 1].code, 'ov_health_check_never_issued');
        const canary = await request('/auth/health');
        assert.strictEqual(canary.status, 200, 'the network-wide canary probes <origin>/auth/health');
        assert.deepStrictEqual(JSON.parse(canary.text), { ok: true, client: 'ok' });

        config.openvibeToolsInternalUrl = `http://127.0.0.1:${refuserPort}`;
        const refused = await request('/api/auth/health');
        assert.strictEqual(refused.status, 503, 'a refused client is a 503');
        assert.deepStrictEqual(JSON.parse(refused.text), { ok: false, client: 'invalid' });
        assert.strictEqual((await request('/auth/health')).status, 503, 'the canary sees the refusal too');

        config.openvibeToolsInternalUrl = `http://127.0.0.1:${networkPort}`;
        assert.strictEqual((await request('/api/auth/health')).status, 200, 'the next client build is checked again');

        // ── An hbt_ API token still authenticates ──────────────────────────────────────────────
        await db.createUser({ username: 'apitokenuser', display_name: 'API Token User', stream_key: 'stream-key-1' });
        const apiUser = await db.getUserByUsername('apitokenuser');
        const apiToken = await db.createApiToken(apiUser.id, 'sign-in test', ['chat', 'read']);
        const me = await request('/api/auth/me', { headers: { authorization: `Bearer ${apiToken.token}` } });
        assert.strictEqual(me.status, 200, me.text);
        const meJson = JSON.parse(me.text);
        assert.strictEqual(meJson.user.username, 'apitokenuser');
        assert.strictEqual(meJson.user.id, apiUser.id, 'requireAuth resolved the API token to the local account');
        assert.strictEqual(meJson.capabilities.admin_panel, false, 'the signed-in capabilities are answered, not a guest 401');

        quiet('sso pkce/health: all checks passed');
    } finally {
        appServer.close();
        network.server.close();
        refuser.server.close();
    }
    process.exit(0);
})().catch((err) => {
    console.log = quiet;
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
});
