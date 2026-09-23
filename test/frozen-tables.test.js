'use strict';

// Live's legacy vods/clips/pastes tables are frozen: Media and Community own that data now
// (AGENTS.md, Wave 22 register C-73). Live may read them for pre-cutover pages, but no server code
// may write them. The only writes allowed are the two guarded one-time visibility backfills that
// run when the column is first added.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WRITE = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(vods|clips|pastes|paste_likes)\b/i;
const ALLOWED = [
    "UPDATE vods SET visibility = CASE WHEN is_public = 1 THEN 'public' ELSE 'private' END",
    "UPDATE clips SET visibility = CASE WHEN is_public = 1 THEN 'public' ELSE 'unlisted' END",
];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const offenders = [];
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!WRITE.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        if (ALLOWED.some((a) => line.includes(a))) return;
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], `writes to frozen tables:\n${offenders.join('\n')}`);
console.log('frozen tables: all checks passed');
