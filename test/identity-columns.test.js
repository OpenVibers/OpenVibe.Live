'use strict';
// WS-B task 2: Live keeps no passwords and no email addresses (the OpenVibe account keeps them). The code
// never hashes a password, never writes or reads users.email or users.password_hash (the frozen-column
// tripwire), and createUser refuses a real hash or stores no address.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
const quiet = console.log; console.log = () => {}; console.warn = () => {};
const db = require('../server/db/database');

(async () => {
    await db.initDb();

    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (p.endsWith('.js')) files.push(p); } };
    walk(path.join(__dirname, '..', 'server'));
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
        for (const m of src.matchAll(/UPDATE\s+users\s+SET[^;`'"]*\b(email|password_hash)\s*=/gi)) offenders.push(`${rel}: writes users.${m[1]} (${m[0].replace(/\s+/g, ' ')})`);
        for (const re of READS) { const m = src.match(re); if (m) offenders.push(`${rel}: reads users.${m[1]} (${m[0].replace(/\s+/g, ' ').slice(0, 80)})`); }
    }
    assert.deepStrictEqual(offenders, [], 'Live never hashes passwords or writes or reads users.email / users.password_hash');

    const base = { username: 'x1', display_name: 'X', stream_key: 'k1' };
    await assert.rejects(db.createUser({ ...base, password_hash: '$2a$10$abcdefghijklmnopqrstuv' }), /stores no passwords/);
    const id = (await db.createUser({ ...base, username: 'x2', stream_key: 'k2', email: 'a@b.c', password_hash: '$sso$x' })).lastInsertRowid;
    assert.ok(id, 'an SSO account is created');
    assert.strictEqual((await db.getUserById(id)).email, null, 'an email address given to createUser is not stored');

    console.log = quiet;
    quiet('identity columns: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
