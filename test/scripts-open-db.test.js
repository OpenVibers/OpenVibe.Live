'use strict';
/**
 * Every operator script that reads the database opens it first. The service opens the database at boot; a script run
 * on the host does not, and `db.getDb()` before `initDb()` stops with "the database is not open" (the Rundown VOD
 * backfill's first run, 2026-11-07, after Live #634 deployed). This reads each script under scripts/ that requires
 * server/db/database and uses it, and asks for an `initDb()` call before its first query.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'scripts');
const QUERY = /\bdb\.(getDb\(\)\.|get\(|all\(|run\(|prepare\()/;
const offenders = [];
let checked = 0;
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!/require\(['"]\.\.\/server\/db\/database['"]\)/.test(src)) continue;
    const q = src.search(QUERY);
    if (q < 0) continue;
    checked += 1;
    const init = src.search(/\binitDb\s*\(/);
    if (init < 0 || init > q) offenders.push(name);
}
assert.ok(checked >= 3, `the check found the scripts it guards (found ${checked})`);
assert.deepStrictEqual(offenders, [], `scripts that query the database before opening it: ${offenders.join(', ')}`);
console.log(`scripts open the database first: ${checked} checked`);
