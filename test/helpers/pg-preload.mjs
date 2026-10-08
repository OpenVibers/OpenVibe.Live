// Loaded with `node --import` into every test process (test/run.js): one migrated database for the process (plan T4,
// ADR-035) — PGlite by default, or, with LIVE_TEST_STORE=pg (npm run test:pg), the PostgreSQL + PgBouncer containers
// with roles and a schema of its own. server/db/database.js initDb()/getDb() adopt it, so test files open no database
// themselves. openvibe-sdk ≥ 0.35.1 unrefs PGlite's alarm timers and the containers' lease, so a test file that ends
// without process.exit() exits.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = path.join(root, 'migrations');
const store = process.env.LIVE_TEST_STORE || 'pglite';
const { createTestDb } = require('openvibe-sdk/testing');
// On the containers createTestDb only creates this process's schema and roles; the migration runs here on the owner
// connection with a timeout that covers the queue on the SDK's global migration lock (parallel test files).
const t = await createTestDb({ migrations: store === 'pg' ? null : MIGRATIONS, store, service: 'live', max: 4 });
if (t.directUrl) {
    const { createDb } = require('openvibe-sdk/db');
    const owner = createDb({ url: t.directUrl, service: 'live-test-owner', max: 1, queryTimeoutMs: 120000 });
    try { await owner.migrate({ dir: MIGRATIONS }); } catch (e) { await owner.close(); await t.close(); throw e; }
    await owner.close();
}
// Tests insert rows with small explicit ids. A PostgreSQL identity would continue after them, so generated ids start
// at 100000 here, clear of every id a test names.
for (const r of await t.db.prepare(`SELECT pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq FROM information_schema.columns
                                    WHERE table_schema = current_schema() AND is_identity = 'YES'`).all()) {
    if (r.seq) await t.db.prepare('SELECT setval(?::regclass, 100000)').get(r.seq);
}
globalThis.__ovLiveTestDb = t.db;
globalThis.__ovLiveTestDbClose = t.close;
// Owner-only DDL for tests that must make the database refuse a write (a trigger): on the containers the runtime role
// may not create in the schema, so it runs on the owner connection. PGlite has one role.
globalThis.__ovLiveDdl = async (sql) => {
    if (!t.directUrl) return t.db.exec(sql);
    const { createDb } = require('openvibe-sdk/db');
    const owner = createDb({ url: t.directUrl, service: 'live-test-owner', max: 1 });
    try { return await owner.exec(sql); } finally { await owner.close(); }
};
