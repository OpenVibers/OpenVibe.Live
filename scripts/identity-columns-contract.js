#!/usr/bin/env node
/**
 * The contract step for Live's identity columns (roadmap WS-B task 2 step 4): the OpenVibe account keeps
 * people's email and password, Live stopped writing them (createUser) and reading them
 * (test/identity-columns.test.js), and this clears what is left in live.db.
 *
 *   node scripts/identity-columns-contract.js [--db <live.db>]
 *        # dry run (the default): counts only, changes nothing
 *   node scripts/identity-columns-contract.js --apply [--backup <file.db>] [--db <live.db>]
 *        # an online backup first (default <database dir>/backups/live-pre-identity-contract-<time>.db,
 *        # mode 0600), then the change in one transaction
 *
 * What --apply changes (server/db/migrations.js operator migration op_001_identity_columns_contract; it is
 * recorded in schema_migrations and runs at most once; it never runs at boot or on deploy):
 *   - users.email is set to NULL on every row;
 *   - users.password_hash becomes the SSO placeholder ('$sso$' + 64 random hex, as new accounts get; no
 *     password matches it) on every account linked to a Network subject whose value is anything else;
 *   - accounts with no Network identity keep their value (legacy accounts, kept for a future claim flow),
 *     and so does an account whose Network link names no subject Live knows.
 * No column is dropped. Printed: counts and paths only, never an email, hash or username.
 *
 * Default database: $DB_PATH, else data/live.db under $DATA_DIR or the working directory (server/paths.js).
 * In production run it from /opt/openvibe.live/current as the service user (data -> ../../shared/data).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ID = 'op_001_identity_columns_contract';
const SSO = "substr(password_hash, 1, 5) <> '$sso$'";

function parseArgs(argv) {
    const opts = { apply: false, db: null, backup: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--apply') opts.apply = true;
        else if (a === '--dry-run') opts.apply = false;
        else if (a === '--db') opts.db = next();
        else if (a === '--backup') opts.backup = next();
        else if (a === '--help' || a === '-h') opts.help = true;
        else throw new Error(`unknown option ${a}`);
    }
    return opts;
}

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** What is stored now, as counts. Reads only. */
function counts(db) {
    const { networkLinkedUserIds } = require('../server/db/migrations');
    const links = hasTable(db, 'linked_accounts');
    const linked = links ? networkLinkedUserIds(db) : 'SELECT NULL WHERE 0';
    const anyLink = links ? "SELECT user_id FROM linked_accounts WHERE service = 'network'" : 'SELECT NULL WHERE 0';
    const n = (where) => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where}`).get().n;
    const noIdentity = `${SSO} AND id NOT IN (${anyLink})`;
    return {
        users: n('1'),
        emails: n('email IS NOT NULL'),
        passwords: n(SSO),
        passwords_linked: n(`${SSO} AND id IN (${linked})`),
        passwords_link_without_subject: n(`${SSO} AND id IN (${anyLink}) AND id NOT IN (${linked})`),
        passwords_no_identity: n(noIdentity),
        no_identity_hashes: n(`${noIdentity} AND (password_hash LIKE '$2%' OR password_hash LIKE '$argon2%' OR password_hash LIKE '$scrypt%' OR password_hash LIKE '$pbkdf2%')`),
        no_identity_anon_game: n(`${noIdentity} AND password_hash LIKE '!anon-game:%'`),
    };
}

function report(c, log, { after = false } = {}) {
    const verb = (what) => (after ? '' : ` -> ${what}`);
    log(`accounts: ${c.users}`);
    log(`emails stored: ${c.emails}${verb('set to NULL')}`);
    log(`password values other than the SSO placeholder: ${c.passwords}`);
    log(`  on accounts linked to a Network subject: ${c.passwords_linked}${verb('replaced with the SSO placeholder')}`);
    log(`  on accounts with a Network link but no known subject: ${c.passwords_link_without_subject}${verb('kept')}`);
    const other = c.passwords_no_identity - c.no_identity_hashes - c.no_identity_anon_game;
    log(`  on accounts with no Network identity: ${c.passwords_no_identity}${verb('kept')} (password hashes ${c.no_identity_hashes}, anon-game placeholders ${c.no_identity_anon_game}, other ${other})`);
}

function stamp(d = new Date()) {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

async function main(argv, log = console.log) {
    const opts = parseArgs(argv);
    if (opts.help) {
        const src = fs.readFileSync(__filename, 'utf8');
        log(src.slice(src.indexOf('/**') + 3, src.indexOf('*/')).split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
        return 0;
    }
    const Database = require('better-sqlite3');
    const dbPath = path.resolve(opts.db || require('../server/paths').dbPath());
    if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
    const backupPath = path.resolve(opts.backup || path.join(path.dirname(dbPath), 'backups', `live-pre-identity-contract-${stamp()}.db`));
    if (opts.apply && fs.existsSync(backupPath)) throw new Error(`${backupPath} already exists; choose a new backup file`);
    const db = new Database(dbPath, { readonly: !opts.apply, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    try {
        if (!hasTable(db, 'users')) { log('no users table; nothing to do'); return 0; }
        const done = hasTable(db, 'schema_migrations') ? db.prepare('SELECT applied_at FROM schema_migrations WHERE id = ?').get(ID) : null;
        log(`database: ${dbPath}`);
        log(`${ID}: ${done ? `applied at ${done.applied_at} UTC` : 'not run yet'}`);
        const before = counts(db);
        report(before, log, { after: !!done });
        if (done) { log('already applied: nothing to do'); return 0; }
        if (!opts.apply) { log('dry run: nothing changed (add --apply to back up the database and apply)'); return 0; }

        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        await db.backup(backupPath);
        fs.chmodSync(backupPath, 0o600);   // it holds the emails and hashes this clears
        log(`backup: ${backupPath}`);

        const res = require('../server/db/migrations').runOperator(db, ID);
        if (res.outcome === 'deferred') { log('users or linked_accounts is missing: nothing changed'); return 1; }
        if (res.outcome !== 'applied') throw new Error(`${ID} ${res.outcome}${res.error ? `: ${res.error}` : ''}`);
        log(`${ID}: applied`);
        log('now:');
        report(counts(db), log, { after: true });
        log(`restore (service stopped): copy ${backupPath} over ${dbPath}, remove any -wal/-shm beside it`);
        return 0;
    } finally {
        db.close();
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        console.error(`error: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { main, counts, parseArgs, ID };
