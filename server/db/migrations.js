'use strict';
/**
 * Versioned schema migrations with a ledger.
 *
 * Schema changes used to be inline `ALTER TABLE` blocks in initDb(), each wrapped in its own
 * try/catch and guarded by "does the column exist" checks or by a row in site_settings. That has
 * three failure modes this file exists to close:
 *
 *   1. A guard that is ordinary data can be deleted. The Vibes ×100 conversion was guarded by the
 *      `bucks_bits_migration_done` settings row, which any admin can delete from the admin panel —
 *      and the next restart would multiply every balance, goal and ledger amount by 100 again.
 *   2. Order. On a brand-new database the paste AI columns were added before the pastes table was
 *      created, failed silently, and appeared only after a second restart.
 *   3. Partial application. Several statements ran outside a transaction, so a crash between them
 *      left some rows converted and the guard unset.
 *
 * Here each migration has a stable id and runs at most once, inside a transaction that also writes
 * its ledger row. A migration may declare `adopt(db)`: "is this already true of the schema?" —
 * existing production databases, which applied these changes under the old inline code, are
 * recorded as `adopted` without running anything. A migration whose prerequisite table does not
 * exist yet returns `defer` and is retried on the next boot instead of being recorded.
 *
 * The runner is called at the end of initDb(), so a migration never runs earlier than the inline
 * code it replaced. Status is available to staff through getStatus().
 */

const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    mode TEXT NOT NULL CHECK (mode IN ('applied', 'adopted')),
    duration_ms INTEGER DEFAULT 0
)`;

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const indexExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);

const DEFER = Symbol('defer');

/**
 * The ordered list. Append only: never renumber, never edit an applied migration's meaning.
 * `critical` migrations stop the boot on failure (money); others log and are retried next boot.
 */
const MIGRATIONS = [
    {
        id: '001_vibes_decimal_to_bits',
        critical: true,
        // Old model: 1 Vibe = $1 in decimal dollars; new model: integer Vibes, 100 = $1.
        // Evidence the conversion already happened: the old guard row EXISTS (its value does not
        // matter — the old code tested presence, and production's row reads 'false' after being
        // toggled as a boolean in the admin panel), or the rate was already flipped to 100.
        adopt: (db) => !!db.prepare("SELECT 1 FROM site_settings WHERE key = 'bucks_bits_migration_done'").get()
            || String((db.prepare("SELECT value FROM site_settings WHERE key = 'bucks_per_usd'").get() || {}).value) === '100',
        up: (db) => {
            db.exec(`
                UPDATE users SET
                    openvibe_bucks_balance = ROUND(COALESCE(openvibe_bucks_balance,0) * 100),
                    openvibe_bucks_cashout_balance = ROUND(COALESCE(openvibe_bucks_cashout_balance,0) * 100);
                UPDATE donation_goals SET
                    target_amount = ROUND(COALESCE(target_amount,0) * 100),
                    current_amount = ROUND(COALESCE(current_amount,0) * 100);
                UPDATE transactions SET amount = ROUND(COALESCE(amount,0) * 100);
            `);
            db.prepare("UPDATE site_settings SET value = '100' WHERE key = 'bucks_per_usd'").run();
            // Kept for anything that still reads the old flag; the ledger is what guards the migration.
            db.prepare("INSERT OR REPLACE INTO site_settings (key, value, description, type) VALUES ('bucks_bits_migration_done', '1', 'Internal: decimal→bit Vibes migration applied (see schema_migrations)', 'boolean')").run();
        },
    },
    {
        id: '002_pastes_ai_columns',
        // Legacy local pastes table (content moved to OpenVibe.Media). Column adds only.
        adopt: (db) => tableExists(db, 'pastes') && ['ai_summary', 'ai_tags', 'ai_analyzed_at'].every((c) => columns(db, 'pastes').includes(c)),
        up: (db) => {
            if (!tableExists(db, 'pastes')) return DEFER;
            const have = columns(db, 'pastes');
            if (!have.includes('ai_summary')) db.exec('ALTER TABLE pastes ADD COLUMN ai_summary TEXT');
            if (!have.includes('ai_tags')) db.exec('ALTER TABLE pastes ADD COLUMN ai_tags TEXT');
            if (!have.includes('ai_analyzed_at')) db.exec('ALTER TABLE pastes ADD COLUMN ai_analyzed_at DATETIME');
        },
    },
    {
        id: '003_idx_arena_moments_said',
        // arena_mic_moments is created by the arena job after boot; wait for it.
        adopt: (db) => indexExists(db, 'idx_arena_moments_said'),
        up: (db) => {
            if (!tableExists(db, 'arena_mic_moments')) return DEFER;
            db.exec('CREATE INDEX IF NOT EXISTS idx_arena_moments_said ON arena_mic_moments(said_at)');
        },
    },
    {
        id: '004_hot_path_indexes',
        // From EXPLAIN QUERY PLAN on production-shaped data (docs/performance-audit.md):
        //   users by username (every channel load and the 15s channel poll) was a full scan — the
        //   lookup uses COLLATE NOCASE, which the plain unique index cannot serve;
        //   bans by user_id is checked on every chat message;
        //   arena per-fighter stats filter timeline events by user and kind.
        up: (db) => {
            db.exec('CREATE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_bans_user ON bans(user_id)');
            if (tableExists(db, 'stream_timeline_events') && ['user_id', 'kind', 'created_at'].every((c) => columns(db, 'stream_timeline_events').includes(c))) {
                db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_user_kind_created ON stream_timeline_events(user_id, kind, created_at)');
            }
            if (columns(db, 'streams').includes('created_at')) db.exec('CREATE INDEX IF NOT EXISTS idx_streams_created ON streams(created_at)');
        },
    },
];

/**
 * SQL for the ids of Live accounts linked to a Network subject: a linked_accounts row (service 'network') that
 * names the subject, or whose Network user id subject_projection knows (server/auth/subject-projection.js
 * resolves a person the same way). An account without one has no Network identity.
 */
function networkLinkedUserIds(db) {
    const viaProjection = tableExists(db, 'subject_projection')
        ? ' OR EXISTS (SELECT 1 FROM subject_projection sp WHERE sp.network_user_id = CAST(la.service_user_id AS INTEGER))'
        : '';
    return `SELECT la.user_id FROM linked_accounts la WHERE la.service = 'network' AND (substr(COALESCE(la.subject_id, ''), 1, 4) = 'usr_'${viaProjection})`;
}

/**
 * Operator migrations: contract steps (expand/migrate/contract, ADR-028) that clear data the release before
 * might still want, so they never run at boot: run() from initDb() walks MIGRATIONS only. An operator script
 * runs one with runOperator() after taking its own backup; the ledger and the transaction are the same, so it
 * runs at most once and is recorded like any other. Append only, like MIGRATIONS; ids start with `op_`.
 */
const OPERATOR_MIGRATIONS = [
    {
        id: 'op_001_identity_columns_contract',
        // WS-B task 2 step 4 (scripts/identity-columns-contract.js). The OpenVibe account keeps the email and the
        // password; Live stopped writing them (createUser) and reading them (test/identity-columns.test.js). This
        // clears what is left: every stored email, and every password value other than the SSO placeholder on an
        // account linked to a Network subject (that person signs in through openvibe.network). Accounts with no
        // Network identity keep their legacy hash for a future claim flow. The columns stay (no DROP COLUMN:
        // SELECT * readers); NOT NULL password_hash gets the same '$sso$' + 64 hex placeholder as new accounts.
        up: (db) => {
            if (!tableExists(db, 'users') || !tableExists(db, 'linked_accounts')) return DEFER;
            db.prepare('UPDATE users SET email = NULL WHERE email IS NOT NULL').run();
            db.prepare(`UPDATE users SET password_hash = '$sso$' || lower(hex(randomblob(32)))
                        WHERE substr(password_hash, 1, 5) <> '$sso$' AND id IN (${networkLinkedUserIds(db)})`).run();
        },
    },
];

const failures = new Map(); // id -> message, for this process

function run(db, list = MIGRATIONS) {
    db.exec(LEDGER_SQL);
    const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
    const record = db.prepare('INSERT INTO schema_migrations (id, mode, duration_ms) VALUES (?, ?, ?)');
    const results = [];
    for (const m of list) {
        if (done.has(m.id)) continue;
        const started = Date.now();
        try {
            let adopted = false;
            let deferred = false;
            db.transaction(() => {
                if (m.adopt && m.adopt(db)) { adopted = true; }
                else if (m.up(db) === DEFER) { deferred = true; return; }
                record.run(m.id, adopted ? 'adopted' : 'applied', Date.now() - started);
            })();
            failures.delete(m.id);
            const outcome = deferred ? 'deferred' : adopted ? 'adopted' : 'applied';
            results.push({ id: m.id, outcome });
            if (outcome === 'applied') console.log(`[DB] migration ${m.id} applied in ${Date.now() - started}ms`);
        } catch (e) {
            failures.set(m.id, e.message);
            results.push({ id: m.id, outcome: 'failed', error: e.message });
            console.error(`[DB] migration ${m.id} FAILED (rolled back): ${e.message}`);
            if (m.critical) throw new Error(`critical migration ${m.id} failed: ${e.message}`);
        }
    }
    return results;
}

/** Ledger rows plus anything pending or failed in this process. */
function getStatus(db, list = MIGRATIONS) {
    db.exec(LEDGER_SQL);
    const rows = new Map(db.prepare('SELECT id, applied_at, mode, duration_ms FROM schema_migrations').all().map((r) => [r.id, r]));
    return list.map((m) => rows.get(m.id) || { id: m.id, mode: failures.has(m.id) ? 'failed' : 'pending', error: failures.get(m.id) || null });
}

/**
 * Run one operator migration now (never called at boot). → { id, outcome: 'applied' | 'deferred' | 'failed'
 * | 'already', error?, applied_at? }
 */
function runOperator(db, id, list = OPERATOR_MIGRATIONS) {
    const m = list.find((x) => x.id === id);
    if (!m) throw new Error(`no operator migration ${id}`);
    const res = run(db, [m])[0];
    if (res) return res;
    const row = db.prepare('SELECT applied_at FROM schema_migrations WHERE id = ?').get(id);
    return { id, outcome: 'already', applied_at: row ? row.applied_at : null };
}

module.exports = { MIGRATIONS, OPERATOR_MIGRATIONS, DEFER, run, getStatus, runOperator, networkLinkedUserIds };
