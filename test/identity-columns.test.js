'use strict';
// WS-B task 2: Live keeps no passwords and no email addresses (the OpenVibe account keeps them). The code
// never hashes a password, never writes or reads users.email or users.password_hash (the frozen-column
// tripwire), and createUser refuses a real hash or an address. The one exception is the contract step,
// scripts/identity-columns-contract.js (operator migration op_001_identity_columns_contract): it clears the
// legacy values, only when an operator runs it, after a backup, and never at boot.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-idcols-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const quiet = console.log; console.log = () => {}; console.warn = () => {};
const db = require('../server/db/database');
db.initDb();
console.log = quiet;

const files = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (p.endsWith('.js')) files.push(p); } };
walk(path.join(__dirname, '..', 'server'));
const MIGRATIONS = path.join('server', 'db', 'migrations.js');
// The contract step's own writes (and nothing else in that file).
const CONTRACT_WRITES = ['UPDATE users SET email = NULL', "UPDATE users SET password_hash = '$sso$'"];
// Reads of the legacy columns: a users alias or a user object's field, or SQL selecting or filtering them on users.
// camera_profiles.password_hash (ONVIF device credentials, server/controls) is another table: `camera.password_hash`.
const READS = [
    /\bu\.(email|password_hash)\b/,
    /\b\w*[uU]ser\.(email|password_hash)\b/,
    /SELECT\b[^;`'"]*\b(email|password_hash)\b[^;`'"]*\bFROM\s+users\b/i,
    /\bFROM\s+users\b[^;`'"]*\b(email|password_hash)\b/i,
];
const offenders = [];
for (const f of files) {
    const rel = path.relative(path.join(__dirname, '..'), f);
    const src = fs.readFileSync(f, 'utf8');
    // server/controls hashes robot and camera control secrets (devices, not accounts): allowed.
    if (!f.includes(`${path.sep}controls${path.sep}`) && /require\(['"]bcrypt(js)?['"]\)/.test(src)) offenders.push(`${rel}: requires bcrypt`);
    for (const m of src.matchAll(/UPDATE\s+users\s+SET[^;`'"]*\b(email|password_hash)\s*=\s*('\$sso\$'|NULL)?/gi)) {
        const stmt = m[0].replace(/\s+/g, ' ');
        if (!(rel === MIGRATIONS && CONTRACT_WRITES.includes(stmt))) offenders.push(`${rel}: writes users.${m[1]} (${stmt})`);
    }
    for (const re of READS) { const m = src.match(re); if (m) offenders.push(`${rel}: reads users.${m[1]} (${m[0].replace(/\s+/g, ' ').slice(0, 80)})`); }
}
assert.deepStrictEqual(offenders, [], 'Live never hashes passwords or writes or reads users.email / users.password_hash');

const base = { username: 'x1', display_name: 'X', stream_key: 'k1' };
assert.throws(() => db.createUser({ ...base, password_hash: '$2a$10$abcdefghijklmnopqrstuv' }), /stores no passwords/);
const id = db.createUser({ ...base, username: 'x2', stream_key: 'k2', email: 'a@b.c', password_hash: '$sso$x' }).lastInsertRowid;
assert.ok(id, 'an SSO account is created');
assert.strictEqual(db.getUserById(id).email, null, 'an email address given to createUser is not stored');

// ── The contract step (scripts/identity-columns-contract.js) ─────────────────────
const raw = db.getDb();
const migrations = require('../server/db/migrations');
const contract = require('../scripts/identity-columns-contract');
const BCRYPT = '$2a$10$' + 'x'.repeat(53);   // bcrypt-shaped, obviously fake
const SSO_KEPT = '$sso$' + 'ab'.repeat(32);
const addUser = (name, email, hash) => Number(raw.prepare('INSERT INTO users (username, display_name, email, password_hash, stream_key) VALUES (?, ?, ?, ?, ?)')
    .run(name, name, email, hash, `sk-${name}`).lastInsertRowid);
const link = (userId, networkId, subject) => raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, subject_id) VALUES (?, 'network', ?, 'x', ?)")
    .run(userId, String(networkId), subject);
const linkedSub = addUser('linked_sub', 'sub@example.test', BCRYPT);           // linked, the subject on the link
link(linkedSub, 101, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA');
const linkedProj = addUser('linked_proj', 'proj@example.test', BCRYPT);        // linked, the subject only in the projection
link(linkedProj, 102, null);
require('../server/auth/subject-projection').ensureSchema();
raw.prepare("INSERT INTO subject_projection (subject_id, network_user_id, revision, username, role) VALUES ('usr_01JAB2C3D4E5F6G7H8J9K0MNPB', 102, 1, 'linked_proj', 'user')").run();
const linkedNoSub = addUser('linked_nosub', null, BCRYPT);                     // a link that names no known subject: kept
link(linkedNoSub, 103, null);
const legacy = addUser('legacy_local', 'legacy@example.test', BCRYPT);         // no Network identity: kept
const anonGame = addUser('anon_game', null, '!anon-game:k:0123');              // a guest placeholder: kept
const ssoAlready = addUser('sso_already', 'sso@example.test', SSO_KEPT);       // already the placeholder: untouched
link(ssoAlready, 104, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC');
const row = (uid) => raw.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(uid);
const snapshot = () => raw.prepare('SELECT id, email, password_hash FROM users ORDER BY id').all();

// Boot never runs it.
const before = snapshot();
console.log = () => {};
db.initDb(); migrations.run(raw);
console.log = quiet;
assert.deepStrictEqual(snapshot(), before, 'boot migrations leave the identity columns alone');
assert.ok(!raw.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(contract.ID), 'and do not record the contract step');
assert.ok(!migrations.MIGRATIONS.some((m) => m.id === contract.ID) && migrations.OPERATOR_MIGRATIONS.some((m) => m.id === contract.ID));

const secrets = ['sub@example.test', 'proj@example.test', 'legacy@example.test', 'sso@example.test', BCRYPT, SSO_KEPT, 'linked_sub', 'legacy_local'];
const run = async (argv) => {
    const lines = [];
    console.log = () => {};   // the migration runner's own [DB] line
    try { return { code: await contract.main(argv, (l) => lines.push(String(l))), out: lines.join('\n') }; } finally { console.log = quiet; }
};
const noValues = (out) => { for (const s of secrets) assert.ok(!out.includes(s), 'the script prints counts only'); };

(async () => {
    const dbArg = ['--db', process.env.DB_PATH];
    // Dry run (the default): counts, nothing changed.
    let r = await run(dbArg);
    assert.strictEqual(r.code, 0);
    noValues(r.out);
    assert.match(r.out, /not run yet/);
    assert.match(r.out, /emails stored: 4 -> set to NULL/);
    assert.match(r.out, /other than the SSO placeholder: 5\b/);
    assert.match(r.out, /linked to a Network subject: 2 -> replaced/);
    assert.match(r.out, /Network link but no known subject: 1 -> kept/);
    assert.match(r.out, /no Network identity: 2 -> kept \(password hashes 1, anon-game placeholders 1, other 0\)/);
    assert.match(r.out, /dry run: nothing changed/);
    assert.deepStrictEqual(snapshot(), before, 'a dry run changes nothing');
    assert.deepStrictEqual(contract.parseArgs(['--dry-run']).apply, false);

    // Apply: backup first (0600, still holding the old values), then the change, recorded once.
    const backup = path.join(tmp, 'backups', 'pre.db');
    r = await run([...dbArg, '--apply', '--backup', backup]);
    assert.strictEqual(r.code, 0, r.out);
    noValues(r.out);
    assert.ok(fs.existsSync(backup), 'a backup is taken');
    assert.strictEqual(fs.statSync(backup).mode & 0o777, 0o600);
    const Database = require('better-sqlite3');
    const b = new Database(backup, { readonly: true });
    assert.strictEqual(b.prepare('SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL').get().n, 4, 'the backup has the old values');
    b.close();

    assert.strictEqual(raw.prepare('SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL').get().n, 0, 'every email is cleared');
    for (const uid of [linkedSub, linkedProj]) {
        assert.match(row(uid).password_hash, /^\$sso\$[0-9a-f]{64}$/, 'a linked account gets the SSO placeholder');
    }
    assert.notStrictEqual(row(linkedSub).password_hash, row(linkedProj).password_hash, 'each placeholder is random');
    assert.strictEqual(row(linkedNoSub).password_hash, BCRYPT, 'a link without a known subject keeps its value');
    assert.strictEqual(row(legacy).password_hash, BCRYPT, 'an account with no Network identity keeps its hash');
    assert.strictEqual(row(anonGame).password_hash, '!anon-game:k:0123');
    assert.strictEqual(row(ssoAlready).password_hash, SSO_KEPT, 'a placeholder is left as it was');
    assert.strictEqual(raw.prepare('SELECT mode FROM schema_migrations WHERE id = ?').get(contract.ID).mode, 'applied');
    assert.match(r.out, /now:[\s\S]*emails stored: 0[\s\S]*linked to a Network subject: 0/);

    // Once only.
    const after = snapshot();
    r = await run([...dbArg, '--apply', '--backup', path.join(tmp, 'backups', 'again.db')]);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /already applied: nothing to do/);
    assert.ok(!fs.existsSync(path.join(tmp, 'backups', 'again.db')), 'nothing to do, no backup');
    assert.deepStrictEqual(snapshot(), after);
    assert.strictEqual(migrations.runOperator(raw, contract.ID).outcome, 'already');
    assert.throws(() => migrations.runOperator(raw, 'op_999_nope'), /no operator migration/);

    // An existing backup file is never overwritten.
    raw.prepare("DELETE FROM schema_migrations WHERE id = ?").run(contract.ID);
    await assert.rejects(run([...dbArg, '--apply', '--backup', backup]), /already exists/);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('identity columns: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
