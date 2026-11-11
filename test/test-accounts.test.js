'use strict';
// Test accounts on Live (server/auth/test-accounts.js): the identity authority's is_test list becomes users.is_test,
// follows linked accounts by subject, and replaces the whole set on success; a failed refresh keeps the last good
// flags so a Network outage never makes a probe public again.
//   node --import ./test/helpers/pg-preload.mjs test/test-accounts.test.js
const assert = require('assert');

process.env.NODE_ENV = 'test';
console.warn = () => {};
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const db = require('../server/db/database');
const principal = require('../server/net/network-principal');
const testAccounts = require('../server/auth/test-accounts');

const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const OTHER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';

(async () => {
    await db.initDb();
    const d = db.getDb();
    const user = await d.prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('ovprobe_live', 'x', 'ovprobe_live') RETURNING id").get();
    const linked = await d.prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('renamed_probe', 'x', 'renamed_probe') RETURNING id").get();
    await d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', '410', ?)").run(linked.id, SUBJECT);
    await d.prepare("UPDATE users SET is_test = 0").run();

    // The token is minted by the same principal the service uses; the Network answer is this stub.
    principal.headersFor = async () => ({ authorization: 'Bearer test-service-token' });
    let answer = { subjects: [{ subject: { type: 'user', id: SUBJECT }, network_user_id: 410, username: 'ovprobe_live', is_test: true }] };
    let down = false;
    const fetchImpl = async (url) => {
        if (down) return new Response('{}', { status: 503 });
        assert.ok(String(url).endsWith('/internal/identity/test-subjects'));
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    assert.strictEqual(await testAccounts.refresh({ fetchImpl }), 1);
    assert.strictEqual(Number((await d.prepare('SELECT is_test FROM users WHERE id = ?').get(user.id)).is_test), 1, 'the probe name is marked');
    assert.strictEqual(Number((await d.prepare('SELECT is_test FROM users WHERE id = ?').get(linked.id)).is_test), 1, 'a renamed account follows its subject link');
    assert.strictEqual(Number((await d.prepare('SELECT is_test FROM subject_projection WHERE subject_id = ?').get(SUBJECT)).is_test), 1, 'the projection carries the flag');

    // A failed refresh changes nothing.
    down = true;
    await assert.rejects(testAccounts.refresh({ fetchImpl }));
    assert.strictEqual(Number((await d.prepare('SELECT is_test FROM users WHERE id = ?').get(user.id)).is_test), 1, 'the last good list stays after an outage');

    // A successful refresh with an empty list unmarks everyone (the Network no longer calls them test accounts).
    down = false; answer = { subjects: [] };
    assert.strictEqual(await testAccounts.refresh({ fetchImpl }), 0);
    assert.strictEqual(Number((await d.prepare('SELECT is_test FROM users WHERE id = ?').get(user.id)).is_test), 0);
    assert.strictEqual(Number((await d.prepare('SELECT is_test FROM users WHERE id = ?').get(linked.id)).is_test), 0);
    assert.strictEqual(Number((await d.prepare('SELECT is_test FROM subject_projection WHERE subject_id = ?').get(SUBJECT)).is_test), 0);

    // A second subject is fine too and the module never trusts a malformed id.
    answer = { subjects: [{ subject: { type: 'user', id: OTHER }, network_user_id: 411, username: 'ovprobe_two' }, { subject: { type: 'user', id: 'nope' } }] };
    assert.strictEqual(await testAccounts.refresh({ fetchImpl }), 1);

    console.log('test accounts: marked by name and by subject link, kept through an outage, unmarked by a new list');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
