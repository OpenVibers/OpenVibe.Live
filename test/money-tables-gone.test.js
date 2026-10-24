'use strict';

// OpenVibe.Billing is the only money ledger since the cutover of 2026-10-17. Nothing under server/ or scripts/ reads or
// writes Live's old ledger (transactions, payment_orders, subscriptions) or the users money columns, and nothing
// touches vpn_approvals since Live#303, so the contract migration that drops them breaks nothing. The answers that
// still name a money column blank it (`x.col = null`) or omit it, for clients that read the field.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TABLES = /\b(FROM|INTO|UPDATE|JOIN|TABLE)\s+(transactions|payment_orders|subscriptions|vpn_approvals)\b/i;
const COLUMNS = /\b(openvibe_bucks_balance|openvibe_bucks_cashout_balance|openvibe_coins_balance)\b/;
// The output-side shapes that may name a column: set to null, deleted, or listed among the fields an answer omits.
const BLANKED = /(\.\s*(openvibe_bucks_balance|openvibe_bucks_cashout_balance|openvibe_coins_balance)\s*=\s*null\s*;|delete\s+\w+\.(openvibe_bucks_balance|openvibe_bucks_cashout_balance|openvibe_coins_balance)\b|^\s*(return omit\(|'openvibe_coins_balance', 'last_seen'))/;
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*|--)/.test(line);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const offenders = [];
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (TABLES.test(line) || (COLUMNS.test(line) && !BLANKED.test(line))) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], 'money is OpenVibe.Billing\'s (billing-client.js, billing-actions.js): Live keeps no ledger of its own');

// The contract migration drops exactly these, after 0009's N-1 window.
const drop = fs.readFileSync(path.join(ROOT, 'migrations', '0016_drop_old_money_ledger.sql'), 'utf8');
assert.match(drop, /^-- phase: contract$/m);
assert.match(drop, /^-- after: 0009$/m);
assert.deepStrictEqual([...drop.matchAll(/^DROP TABLE IF EXISTS (\w+);$/gm)].map((m) => m[1]).sort(), ['payment_orders', 'subscriptions', 'transactions', 'vpn_approvals']);
assert.deepStrictEqual([...drop.matchAll(/^ALTER TABLE users DROP COLUMN IF EXISTS (\w+);$/gm)].map((m) => m[1]).sort(), ['openvibe_bucks_balance', 'openvibe_bucks_cashout_balance', 'openvibe_coins_balance']);
console.log('money tables: nothing under server/ or scripts/ reads them, and 0016 drops the four tables and three columns');
