/**
 * Live's site settings as revisioned configuration (WS-C task 7; server/admin/site-config.js).
 *
 *   - revision 1 is the configuration rows as they were; job state and the money freeze are not in it;
 *   - an admin change through /api/admin/settings is one revision with who and why, written to the rows;
 *     db.getSetting reads exactly what it read before;
 *   - a row written around the journal (a job) is recorded as a sync revision before the next change, so
 *     neither the change nor a rollback reverts it;
 *   - history shows secrets only as fingerprints; the owner may roll back, an admin may not.
 *
 *   node test/site-config.test.js
 */
'use strict';
const assert = require('assert');
const http = require('http');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};
const db = require('../server/db/database');
const auth = require('../server/auth/auth');
const permissions = require('../server/auth/permissions');
const signIn = async (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? await db.getUserById(id) : null;
    if (u) { req.user = { ...u, subject_id: u.id === 1 ? 'usr_01KKT9AC60KM7CRTB3WN1Z8P56' : 'usr_01KRMBAEEGCF1Z34D5WXXAP3TA' }; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
permissions.requireAdmin = (req, res, next) => (req.user && ['admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'admin only' }));

async function main() {
await db.initDb();
// migrations/0002_live.sql does not create openvibe-shared/config's tables (config_snapshots/config_keys,
// their configSchema()); the service migrations are meant to. Owner-only DDL stands them up here until the
// migration includes configSchema() (Network's migrations/0006_config.sql is the pattern).
await globalThis.__ovLiveDdl(require('openvibe-shared/config-pg').configSchema());
const raw = db.getDb();
const add = async (id, username, role) => await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`, role);
await add(1, 'owner', 'admin');
await add(2, 'helper', 'admin');
const realIsOwner = permissions.isOwner;
permissions.isOwner = (u) => !!u && Number(u.id) === 1;

// What production looks like: configuration, a secret, job state and the money freeze in one table.
for (const [k, v, t] of [['motd', 'hello', 'string'], ['max_clip_duration', '60', 'number'], ['stripe_secret_key', 'sk_live_verysecret', 'string'],
    ['star_streamer', 'alice', 'string'], ['arena_backfill_cursor_3', '100', 'string'], ['money_writes_frozen', 'false', 'boolean']]) {
    await raw.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, type = excluded.type').run(k, v, t);
}

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/admin', auth.requireAuth, permissions.requireAdmin, require('../server/admin/routes'));
const server = http.createServer(app).listen(0);
const call = async (method, p, body, user = 1) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'x-test-user': String(user), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
};

    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const siteConfig = require('../server/admin/site-config');
    const store = await siteConfig.getStore();

    // ── Revision 1: the configuration rows, nothing else ──
    assert.strictEqual(store.revision(), 1);
    const keys = Object.keys(store.get());
    for (const k of ['max_clip_duration', 'motd', 'stripe_secret_key']) assert.ok(keys.includes(k), `${k} is configuration`);
    for (const k of ['star_streamer', 'arena_backfill_cursor_3', 'money_writes_frozen']) assert.ok(!keys.includes(k), `${k} is not`);
    assert.strictEqual(await db.getSetting('max_clip_duration'), 60, 'readers read the rows, typed as before');

    // ── An admin change: one revision, written to the rows ──
    let r = await call('PUT', '/api/admin/settings', { settings: { motd: 'welcome', max_clip_duration: '90' }, reason: 'longer clips' }, 2);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.revision, 2);
    assert.deepStrictEqual([await db.getSetting('motd'), await db.getSetting('max_clip_duration')], ['welcome', 90]);
    assert.strictEqual((await raw.prepare("SELECT type FROM site_settings WHERE key = 'max_clip_duration'").get()).type, 'number', 'the type column is kept');

    // ── A job writes around the journal; the next change records it first and never reverts it ──
    await db.setSetting('motd', 'set by a script');
    await db.setSetting('star_streamer', 'bob');
    r = await call('PUT', '/api/admin/settings/max_clip_duration', { value: '120' }, 2);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([store.revision(), await db.getSetting('motd'), await db.getSetting('max_clip_duration'), await db.getSetting('star_streamer')], [4, 'set by a script', 120, 'bob'], 'a sync revision (3), then the change (4)');

    // ── History: who, why, secrets as fingerprints ──
    r = await call('GET', '/api/admin/config/live.site_settings/history', undefined, 2);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.snapshots.map((x) => x.revision), [4, 3, 2, 1]);
    assert.deepStrictEqual(r.body.snapshots[2].created_by, { type: 'user', id: 'usr_01KRMBAEEGCF1Z34D5WXXAP3TA' });
    assert.strictEqual(r.body.snapshots[2].reason, 'longer clips');
    assert.match(r.body.snapshots[1].reason, /^sync: /);
    assert.ok(!JSON.stringify(r.body).includes('sk_live_verysecret'), 'the secret never leaves');
    assert.strictEqual(r.body.snapshots[0].values.stripe_secret_key.redacted, true);
    r = await call('GET', '/api/admin/config', undefined, 2);
    assert.strictEqual(r.body.namespaces[0].namespace, 'live.site_settings');

    // ── Rollback: owner only; undoes the last change, not the script's row, not job state ──
    assert.strictEqual((await call('POST', '/api/admin/config/live.site_settings/rollback', { reason: 'too long' }, 2)).status, 403);
    r = await call('POST', '/api/admin/config/live.site_settings/rollback', { reason: 'too long' }, 1);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([await db.getSetting('max_clip_duration'), await db.getSetting('motd'), await db.getSetting('star_streamer'), await db.getSetting('stripe_secret_key')], [90, 'set by a script', 'bob', 'sk_live_verysecret']);

    // ── Deleting a setting is a revision too; job state is written as before; the money freeze is never touched ──
    r = await call('DELETE', '/api/admin/settings/motd', undefined, 2);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await db.getSetting('motd'), null);
    assert.ok(!('motd' in store.get()));
    r = await call('PUT', '/api/admin/settings', { settings: { arena_backfill_cursor_3: '200' } }, 2);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await db.getSetting('arena_backfill_cursor_3'), '200');
    assert.ok(!('arena_backfill_cursor_3' in store.get()), 'job state stays out of the journal');
    assert.strictEqual(await db.getSetting('money_writes_frozen'), false);
    await assert.rejects(siteConfig.change({ set: { money_writes_frozen: 'true' } }), /not configuration/);

    permissions.isOwner = realIsOwner;
    server.close();
    quiet('site config: all checks passed');
    process.exit(0);
}

main().catch((err) => { quiet(err); process.exit(1); });
