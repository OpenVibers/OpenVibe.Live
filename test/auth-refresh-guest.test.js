/**
 * POST /api/auth/refresh for a guest: no ov_refresh cookie at all is "signed out", not an error, so
 * it answers 200 { access_token: null, user: null } (every guest page view asks it, and a 401 logged
 * a console error on each: browser check, OpenVibe.Host scripts/browser-check.js). A refresh cookie
 * that is present but rejected by the Network still answers 401 and clears the cookie. The client
 * (public/js/app.js tryRefreshToken) treats a missing access_token as "no session".
 *
 *   node test/auth-refresh-guest.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-auth-refresh-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const db = require('../server/db/database');
db.initDb();
const config = require('../server/config');
const express = require('express');
const cookieParser = require('cookie-parser');

function listen(server) { return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port))); }

(async () => {
    // The Network's token endpoint: rejects every refresh token it is shown.
    let grants = 0;
    const network = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (req.url === '/oauth/token') grants++;
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token rejected' }));
        });
    });
    config.openvibeToolsInternalUrl = `http://127.0.0.1:${await listen(network)}`;

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/auth', require('../server/auth/routes'));
    const server = http.createServer(app);
    const port = await listen(server);
    const post = (headers = {}) => new Promise((ok, fail) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/refresh', method: 'POST', headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => ok({ status: res.status || res.statusCode, headers: res.headers, json: JSON.parse(body || '{}') }));
        });
        req.on('error', fail);
        req.end();
    });

    try {
        // A guest: no cookie at all.
        const guest = await post();
        assert.strictEqual(guest.status, 200, 'a guest is answered 200, not 401');
        assert.deepStrictEqual(guest.json, { access_token: null, user: null });
        assert.strictEqual(grants, 0, 'nothing to refresh, so the Network is not asked');

        // A refresh cookie the Network rejects: still 401, and the stale cookie is cleared.
        const stale = await post({ cookie: 'ov_refresh=stale-token' });
        assert.strictEqual(stale.status, 401, 'a present but rejected credential stays 401');
        assert.ok(stale.json.error);
        assert.strictEqual(grants, 1);
        assert.ok(String(stale.headers['set-cookie'] || '').includes('ov_refresh=;'), 'the stale cookie is cleared');

        // The client reads "signed in" only from an access_token, so the guest answer is no session.
        const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
        const fn = appJs.slice(appJs.indexOf('async function tryRefreshToken'), appJs.indexOf('function _syncAccountSwitcherToken'));
        assert.match(fn, /if \(!res\.ok\) return false;/);
        assert.match(fn, /if \(data\.access_token\) \{/);
        assert.match(fn, /return false;\s*\} catch/);

        quiet('auth refresh: a guest gets 200 { access_token: null }, a rejected refresh cookie 401');
    } finally {
        server.close(); network.close();
        try { db.getDb().close(); } catch { /* */ }
        for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    }
})().catch((e) => { console.log = quiet; process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
