'use strict';
// WS-B task 2: Live keeps no passwords and no email addresses (the OpenVibe account keeps them). The code
// never hashes a password or writes users.email, and createUser refuses a real hash or an address.
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
const offenders = [];
for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // server/controls hashes robot and camera control secrets (devices, not accounts): allowed.
    if (!f.includes(`${path.sep}controls${path.sep}`) && /require\(['"]bcrypt(js)?['"]\)/.test(src)) offenders.push(`${path.relative(process.cwd(), f)}: requires bcrypt`);
    if (/UPDATE\s+users\s+SET[^;`'"]*\b(email|password_hash)\s*=/i.test(src)) offenders.push(`${path.relative(process.cwd(), f)}: writes users.email or users.password_hash`);
}
assert.deepStrictEqual(offenders, [], 'Live never hashes passwords or writes users.email');

const base = { username: 'x1', display_name: 'X', stream_key: 'k1' };
assert.throws(() => db.createUser({ ...base, password_hash: '$2a$10$abcdefghijklmnopqrstuv' }), /stores no passwords/);
const id = db.createUser({ ...base, username: 'x2', stream_key: 'k2', email: 'a@b.c', password_hash: '$sso$x' }).lastInsertRowid;
assert.ok(id, 'an SSO account is created');
assert.strictEqual(db.getUserById(id).email, null, 'an email address given to createUser is not stored');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('identity columns: all checks passed');
