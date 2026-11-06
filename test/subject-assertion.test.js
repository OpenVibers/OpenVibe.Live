'use strict';
/**
 * The person's own subject assertion on Live's money calls (ADR-003, the 2026-11-06 amendment; plan H1).
 *
 * Live names the person it acts for, and Billing believes it. On a money route that is only Live's
 * word, so Live asks Network to sign the person's own token into a 60-second assertion and carries
 * it on (X-OV-Subject-Assertion). Without the person's token there is nothing to sign, and the call
 * travels the old way — which Billing's BILLING_REQUIRE_SUBJECT_ASSERTION flag decides on.
 */
const assert = require('assert');
const http = require('http');
const { startNetwork, startBilling } = require('./billing-stub');

process.env.NODE_ENV = 'test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
process.env.OV_BILLING_TIMEOUT_MS = '1500';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const SID = {
    ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1',
    bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2',
};

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 9).join('\n      ')); }
}

/** The claims of an assertion (the stub signs one; the signature is not what this test is about). */
const claimsOf = (assertion) => JSON.parse(Buffer.from(String(assertion).split('.')[1], 'base64url').toString('utf8'));

(async () => {
    const network = await startNetwork();
    const billing = await startBilling({ network });
    process.env.OV_NETWORK_INTERNAL_URL = network.url;
    process.env.OV_BILLING_INTERNAL_URL = billing.url;

    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const addUser = async (id, username, role) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, 0)`).run(id, username, username, `${username}@x`, role);
    await addUser(2, 'ann', 'user');
    await addUser(3, 'bob', 'streamer');
    const link = async (uid, sid) => await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)").run(uid, String(100 + uid), sid);
    await link(2, SID.ann); await link(3, SID.bob);
    await db.ensureChannel(3);
    const streamB = Number((await db.createStream({ user_id: 3, channel_id: (await db.getChannelByUserId(3)).id, title: 'B', protocol: 'webrtc' })).lastInsertRowid);

    const auth = require('../server/auth/auth');
    const signIn = async (req) => { const id = Number(req.headers['x-test-user'] || 0); const u = id ? await db.getUserById(id) : null; if (u) req.user = u; return u; };
    auth.requireAuth = (req, res, next) => { signIn(req).then((u) => u ? next() : res.status(401).json({ error: 'Authentication required' })).catch(next); };
    auth.optionalAuth = (req, res, next) => { signIn(req).then(() => next()).catch(next); };

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { signIn(req).then(() => next()).catch(next); });
    app.use('/api/funds', require('../server/monetization/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = async (method, p, user, body, headers = {}) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
            method, redirect: 'manual',
            headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, json, text };
    };
    const callsSince = (n) => billing.calls.slice(n);

    billing.fund(SID.ann, 3000);

    await check('a money call for a person carries the person\'s own assertion', async () => {
        const n = billing.calls.length;
        const r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, stream_id: streamB, amount: 150 }, { cookie: `ov_token=${network.signUser(SID.ann, 'ann')}` });
        assert.strictEqual(r.status, 200, r.text);
        const c = callsSince(n);
        assert.strictEqual(c.length, 1, 'one Billing call');
        assert.ok(c[0].assertion, 'the call carried an assertion');
        const claims = claimsOf(c[0].assertion);
        assert.strictEqual(claims.sub, SID.ann, 'the assertion names the person');
        assert.deepStrictEqual(claims.aud, ['openvibe.billing']);
        assert.strictEqual(claims.act, 'svc:live', 'Live is the service it was minted for');
    });

    await check('without the person\'s token the money call travels the old way (no assertion)', async () => {
        const n = billing.calls.length;
        const r = await call('POST', '/api/funds/donate', 2, { streamer_id: 3, stream_id: streamB, amount: 100 });
        assert.strictEqual(r.status, 200, r.text);
        const c = callsSince(n);
        assert.strictEqual(c.length, 1, 'one Billing call');
        assert.strictEqual(c[0].assertion, null, 'no assertion without the person\'s token');
        assert.deepStrictEqual(c[0].body.from, { type: 'user', id: SID.ann }, 'the person is still named in the body');
    });

    await check('two money calls get two assertions (a replayed one is refused)', async () => {
        const token = network.signUser(SID.ann, 'ann');
        const n = billing.calls.length;
        await call('POST', '/api/funds/donate', 2, { streamer_id: 3, stream_id: streamB, amount: 100 }, { cookie: `ov_token=${token}` });
        await call('POST', '/api/funds/donate', 2, { streamer_id: 3, stream_id: streamB, amount: 100 }, { cookie: `ov_token=${token}` });
        const c = callsSince(n);
        assert.strictEqual(c.length, 2);
        assert.ok(c[0].assertion && c[1].assertion);
        assert.notStrictEqual(c[0].assertion, c[1].assertion, 'each call has its own assertion');
    });

    quiet(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
