'use strict';
// Live's sign-in (GET /api/auth/sso/login) passes "switch account" and "use another account" on to OpenVibe.Network:
// ?prompt=select_account shows the chooser, ?prompt=login the sign-in form, ?login_hint=<username> names the account the
// chooser continues as (owner, 2026-10-26: sign-in "like the Google sign-in does"; Network docs/sign-in.md). ?silent=1
// stays prompt=none, and anything else is dropped. The menu's "Switch account" opens the chooser without signing out.
//
//   node test/sso-login-prompt.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

(async () => {
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const app = express();
    app.use(cookieParser());
    app.use('/api/auth', require('../server/auth/routes'));
    const server = require('http').createServer(app).listen(0);
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const go = async (q) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/sso/login${q}`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302, q);
        return new URL(res.headers.get('location'));
    };

    let u = await go('?prompt=select_account&login_hint=%40alt&next=%2Fdashboard');
    assert.strictEqual(u.pathname, '/oauth/authorize');
    assert.deepStrictEqual([u.searchParams.get('prompt'), u.searchParams.get('login_hint')], ['select_account', '@alt']);
    u = await go('?prompt=login');
    assert.strictEqual(u.searchParams.get('prompt'), 'login');
    u = await go('?prompt=consent&login_hint=%3Cb%3E');
    assert.deepStrictEqual([u.searchParams.get('prompt'), u.searchParams.get('login_hint')], [null, null], 'anything else is dropped');
    u = await go('?silent=1&prompt=login');
    assert.strictEqual(u.searchParams.get('prompt'), 'none', 'silent stays silent');
    u = await go('');
    assert.strictEqual(u.searchParams.get('prompt'), null, 'a plain sign-in: the Network shows its chooser');
    server.close();

    // The menu's Switch account keeps this session until another account is chosen.
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const sw = appJs.slice(appJs.indexOf('function switchAccount()'), appJs.indexOf('function browseAsGuest()'));
    assert.ok(/prompt=select_account&next=/.test(sw) && !/logout|removeItem/.test(sw), 'Switch account opens the chooser, signing nothing out');
    const nav = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ov-navbar-live.js'), 'utf8');
    assert.ok(/loginUrl: '\/api\/auth\/sso\/login\?next=\{path\}'/.test(nav) && !/accounts: false/.test(nav), "the navbar's accounts come back through this sign-in, to the page they were on");

    quiet('sso login prompt: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
