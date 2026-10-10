'use strict';

// OpenCoins are each person's OpenVibe.Network wallet (server/monetization/wallet-client.js). Live's legacy
// users.openvibe_coins_balance column is read and written by nothing under server/, scripts/ or public/ (no stale
// fallback, no copy sent to a page), so the contract migration that drops it breaks nothing. The one mention allowed is
// the public serializer's list of fields that must never leave the server.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAME = /\bopenvibe_coins_balance\b/;
const ALLOWED = new Set(['server/web/serializers.js']);
// The one write the previous release needs: /api/auth/me keeps the field, as null, for one release (test/n-1.test.js).
const NULL_SHAPE = /\bopenvibe_coins_balance\s*=\s*null\s*;/;
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*|--)/.test(line);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const offenders = [];
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, 'public', 'js'))]) {
    const rel = path.relative(ROOT, file);
    if (ALLOWED.has(rel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!isCommentLine(line) && NAME.test(line) && !NULL_SHAPE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], 'OpenCoins come from the Network wallet (wallet-client.js / opencoins.getGold), never users.openvibe_coins_balance');
console.log('coins column: nothing reads users.openvibe_coins_balance');
