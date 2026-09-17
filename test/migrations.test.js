/**
 * Schema migration ledger (server/db/migrations.js) against real databases.
 *
 *   A. a fresh database initialises in one boot, with every migration recorded;
 *   B. a second boot changes nothing and logs no migration errors;
 *   C. a database that applied the Vibes conversion under the old inline code is adopted, not
 *      converted twice;
 *   D. deleting the old settings-row guard (possible from the admin panel) no longer re-runs the ×100;
 *   E. a failing migration rolls back, is not recorded, and does not stop later migrations;
 *   F. a migration waiting for a table is deferred, then applied once the table exists;
 *   G. the username lookup uses its index.
 *
 *   node test/migrations.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `ov-migrations-${process.pid}.db`);
process.env.DB_PATH = tmp;
const cleanup = () => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } } };
cleanup();

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origError(...a); };
const origLog = console.log;
console.log = (...a) => { if (!/^\[DB\]/.test(String(a[0]))) origLog(...a); };

let failures = 0;
function check(name, fn) {
    try { fn(); origLog('  ✓', name); } catch (e) { failures++; origLog('  ✗', name, '\n     ', e.message); }
}

const db = require('../server/db/database');
const migrations = require('../server/db/migrations');
const raw = () => db.getDb();
const ledger = () => raw().prepare('SELECT id, mode FROM schema_migrations ORDER BY id').all();

db.initDb();
check('A. fresh database: every non-deferred migration recorded in one boot', () => {
    const ids = ledger().map((r) => r.id);
    for (const m of migrations.MIGRATIONS) {
        if (m.id === '003_idx_arena_moments_said') continue; // its table is created by the arena job
        assert.ok(ids.includes(m.id), `${m.id} missing from ledger: ${ids.join(', ')}`);
    }
    const cols = raw().prepare('PRAGMA table_info(pastes)').all().map((c) => c.name);
    assert.ok(cols.includes('ai_summary'), 'paste AI columns exist after the first boot');
});

check('B. second boot: no new ledger rows, no migration errors', () => {
    const before = ledger().length;
    const errsBefore = errors.length;
    db.initDb();
    assert.strictEqual(ledger().length, before);
    assert.strictEqual(errors.filter((e) => /migration/.test(e)).length - errors.slice(0, errsBefore).filter((e) => /migration/.test(e)).length, 0);
});

check('C/D. Vibes ×100 never runs twice, even with the old guard row deleted', () => {
    raw().prepare("INSERT INTO users (id, username, display_name, email, password_hash, openvibe_bucks_balance, openvibe_bucks_cashout_balance) VALUES (7001, 'rich', 'Rich', 'r@x', 'x', 500, 250)").run();
    raw().prepare("DELETE FROM site_settings WHERE key = 'bucks_bits_migration_done'").run();
    db.initDb();
    db.initDb();
    const u = raw().prepare('SELECT openvibe_bucks_balance b, openvibe_bucks_cashout_balance c FROM users WHERE id = 7001').get();
    assert.deepStrictEqual(u, { b: 500, c: 250 });
});

check('C. an old database that applied the conversion inline is adopted', () => {
    raw().prepare("DELETE FROM schema_migrations WHERE id = '001_vibes_decimal_to_bits'").run();
    raw().prepare("INSERT OR REPLACE INTO site_settings (key, value, type) VALUES ('bucks_bits_migration_done', '1', 'boolean')").run();
    migrations.run(raw());
    const row = raw().prepare("SELECT mode FROM schema_migrations WHERE id = '001_vibes_decimal_to_bits'").get();
    assert.strictEqual(row.mode, 'adopted');
    assert.strictEqual(raw().prepare('SELECT openvibe_bucks_balance b FROM users WHERE id = 7001').get().b, 500);
});

check('C. production shape: guard row reads \'false\', rate already 100 → adopted, not converted', () => {
    raw().prepare("DELETE FROM schema_migrations WHERE id = '001_vibes_decimal_to_bits'").run();
    raw().prepare("INSERT OR REPLACE INTO site_settings (key, value, type) VALUES ('bucks_bits_migration_done', 'false', 'boolean')").run();
    migrations.run(raw());
    assert.strictEqual(raw().prepare("SELECT mode FROM schema_migrations WHERE id = '001_vibes_decimal_to_bits'").get().mode, 'adopted');
    assert.strictEqual(raw().prepare('SELECT openvibe_bucks_balance b FROM users WHERE id = 7001').get().b, 500);
});

check('E. a failing migration rolls back and later ones still run', () => {
    const list = [
        { id: 'T1_fails', up: (d) => { d.exec('CREATE TABLE t_partial (x)'); throw new Error('boom'); } },
        { id: 'T2_runs', up: (d) => { d.exec('CREATE TABLE t_after (x)'); } },
    ];
    const res = migrations.run(raw(), list);
    assert.strictEqual(res[0].outcome, 'failed');
    assert.strictEqual(res[1].outcome, 'applied');
    assert.ok(!raw().prepare("SELECT 1 FROM sqlite_master WHERE name = 't_partial'").get(), 'partial work rolled back');
    assert.ok(!raw().prepare("SELECT 1 FROM schema_migrations WHERE id = 'T1_fails'").get(), 'failure not recorded');
    assert.strictEqual(migrations.getStatus(raw(), list)[0].mode, 'failed');
});

check('E. a failing critical migration stops the boot', () => {
    assert.throws(() => migrations.run(raw(), [{ id: 'T3_critical', critical: true, up: () => { throw new Error('money'); } }]), /critical migration/);
});

check('F. deferred until the table exists, then applied', () => {
    const list = [{ id: 'T4_wait', up: (d) => { if (!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 't_later'").get()) return migrations.DEFER; d.exec('CREATE INDEX i_later ON t_later(x)'); } }];
    assert.strictEqual(migrations.run(raw(), list)[0].outcome, 'deferred');
    raw().exec('CREATE TABLE t_later (x)');
    assert.strictEqual(migrations.run(raw(), list)[0].outcome, 'applied');
});

check('G. username lookup (COLLATE NOCASE) uses an index', () => {
    const plan = raw().prepare("EXPLAIN QUERY PLAN SELECT * FROM users WHERE username = ? COLLATE NOCASE").all('x').map((r) => r.detail).join(' | ');
    assert.ok(/USING INDEX/.test(plan), plan);
});

try { db.close(); } catch { /* */ }
cleanup();
if (failures) { origLog(`\n${failures} failure(s)`); process.exit(1); }
origLog('\nmigrations: all checks passed');
process.exit(0);
