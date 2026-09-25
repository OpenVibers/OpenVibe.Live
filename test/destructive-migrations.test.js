'use strict';
/**
 * Expand/migrate/contract (roadmap WS-P task 12; ADR-028 in OpenVibe.Contracts): a schema change that
 * removes or renames something (DROP TABLE, DROP COLUMN, RENAME COLUMN, RENAME TO) breaks the release
 * production may roll back to, so it is only allowed as a contract step: listed in
 * test/fixtures/destructive-migrations.json with the dated plan entry that runs it after a release where
 * nothing reads the old shape. Everything else is additive (CREATE … IF NOT EXISTS, ADD COLUMN, new
 * tables) and test/rollback-newer-writes.test.js proves the older release still works on it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RE = /\b(DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)|DROP\s+COLUMN\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)|RENAME\s+COLUMN\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)|RENAME\s+TO\s+[`"]?([A-Za-z_][A-Za-z0-9_]*))/gi;
const TEMP = /^_|_new$|_old$|_tmp$|^tmp_/i;

const found = new Map();   // "file|STATEMENT" -> count
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        let m;
        while ((m = RE.exec(src))) {
            const name = m[2] || m[3] || m[4] || m[5];
            if (TEMP.test(name) || /\$\{/.test(name)) continue;
            const statement = m[1].replace(/[`"]/g, '').replace(/\s+/g, ' ').toUpperCase();
            const key = `${path.relative(ROOT, p)}|${statement}`;
            found.set(key, (found.get(key) || 0) + 1);
        }
    }
})(path.join(ROOT, 'server'));

const allow = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'destructive-migrations.json'), 'utf8')).allowed;
const allowed = new Map(allow.map((a) => [`${a.file}|${a.statement}`, a]));
const unlisted = [];
for (const [key, n] of found) {
    const a = allowed.get(key);
    if (!a || n > a.count) unlisted.push(`${key.replace('|', ': ')} ×${n}`);
}
assert.deepStrictEqual(unlisted, [], 'a destructive schema change needs its contract step in test/fixtures/destructive-migrations.json');
for (const a of allow) assert.ok(a.contract && a.contract.length > 10, `${a.statement}: say which contract step runs it`);
console.log(`destructive migrations: ${found.size} known statement(s), each with its contract step; nothing new`);
