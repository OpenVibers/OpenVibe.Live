/**
 * Compatibility register C-05: Live's legacy `token` cookie (the same Network token as `ov_token`, under another name)
 * is neither set nor read any more. `ov_token` is the session cookie; logout still clears a leftover `token`.
 *
 *   node test/legacy-token-cookie.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
const ROOT = path.join(__dirname, '..');
const { extractToken } = require('../server/auth/auth');

// The server reads the Network cookie only: cookie-parser's object and the raw header (WebSocket upgrades) alike.
assert.strictEqual(extractToken({ headers: {}, cookies: { ov_token: 'net' } }), 'net');
assert.strictEqual(extractToken({ headers: { cookie: 'ov_token=net' } }), 'net');
assert.strictEqual(extractToken({ headers: {}, cookies: { token: 'legacy' } }), null, 'a lone legacy cookie authenticates nothing');
assert.strictEqual(extractToken({ headers: { cookie: 'token=legacy' } }), null, 'nor through the raw Cookie header');
assert.strictEqual(extractToken({ headers: {}, cookies: { token: 'legacy', ov_token: 'net' } }), 'net');

// Sign-in and refresh set ov_token only; logout clears both names.
const routes = fs.readFileSync(path.join(ROOT, 'server/auth/routes.js'), 'utf8');
assert.ok(!/res\.cookie\(\s*'token'/.test(routes), 'no route sets the legacy token cookie');
assert.ok(/res\.clearCookie\(\s*'token'/.test(routes), 'logout still clears a leftover legacy cookie');

// The browser code reads ov_token, never the legacy cookie.
for (const f of ['public/js/app.js', 'public/js/call.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\)token=\(\[\^;\]\+\)/.test(src), `${f} does not read the legacy token cookie`);
}

console.log('legacy token cookie: not set, not read; ov_token is the session cookie — all checks passed');
