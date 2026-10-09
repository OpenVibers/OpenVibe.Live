'use strict';

// ADR-054 §8: Live's cosmetics live in OpenVibe.Inventory since 2026-10-09 (imported and verified row for row first),
// and the legacy game's chat tags left with the game. Nothing under server/ reads or writes Live's old
// user_cosmetics, user_equipped or user_equipped_tag, so the contract migration that drops them breaks nothing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAMES = /\b(user_cosmetics|user_equipped_tag|user_equipped)\b/;
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
        if (!isCommentLine(line) && NAMES.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], 'Live\'s cosmetics are OpenVibe.Inventory\'s (ADR-054 §8): read them through server/monetization/cosmetics.js');
assert.ok(!fs.existsSync(path.join(ROOT, 'server/chat/tags.js')), 'the legacy chat tags left with the game');
assert.ok(!/INVENTORY_AUTHORITY/.test(fs.readFileSync(path.join(ROOT, 'server/monetization/cosmetics.js'), 'utf8')), 'no switch back to Live\'s tables');
// The contract migration drops them, after the N-1 window (it names 0002, so the migrator holds it for 7 days).
const drop = fs.readFileSync(path.join(ROOT, 'migrations', '0003_drop_live_cosmetics.sql'), 'utf8');
assert.match(drop, /^-- phase: contract$/m);
assert.match(drop, /^-- after: 0002$/m);
const dropped = [...drop.matchAll(/^DROP TABLE IF EXISTS (\w+);$/gm)].map((m) => m[1]).sort();
assert.deepStrictEqual(dropped, ['user_cosmetics', 'user_equipped', 'user_equipped_tag'], '0003 drops exactly the three');
console.log('cosmetics tables: nothing under server/ or scripts/ names them, and 0003 drops them');
