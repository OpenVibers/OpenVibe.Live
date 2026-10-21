'use strict';

// Plan T15 B9: robots are OpenVibe.Bot's. Live's control configs became Bot robots on 2026-10-07 and Live#119 deleted
// the code that read them (server/controls, the control socket and its keys, the ONVIF routes). Nothing under server/,
// scripts/ or public/js reads Live's old controls tables or the channel/slot/stream columns that pointed at them, so
// the contract migration that drops them breaks nothing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TABLES = ['api_keys', 'camera_presets', 'camera_profiles', 'control_config_buttons', 'control_configs', 'control_whitelist', 'stream_controls'];
const COLUMNS = {
    channels: ['active_control_config_id', 'anon_controls_enabled', 'control_mode', 'control_rate_limit_ms', 'video_click_enabled', 'video_click_rate_limit_ms'],
    managed_streams: ['control_config_id'],
    streams: ['control_config_id'],
};
const NAMES = new RegExp(`\\b(${[...TABLES, ...new Set(Object.values(COLUMNS).flat())].join('|')})\\b`);
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*|--)/.test(line);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const offenders = [];
for (const file of ['server', 'scripts', 'public/js'].flatMap((d) => walk(path.join(ROOT, d)))) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!isCommentLine(line) && NAMES.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], 'robots are OpenVibe.Bot\'s (plan T15): a bound channel embeds its robot (server/bot/)');
// The one-release stub for tabs still running the client that loaded controls.js leaves with the tables.
assert.ok(!fs.existsSync(path.join(ROOT, 'public/js/controls.js')), 'public/js/controls.js is gone');
assert.ok(!fs.existsSync(path.join(ROOT, 'server/controls')), 'server/controls is gone');

// The contract migration drops them, after the N-1 window (it names 0002, so the migrator holds it for 7 days).
const drop = fs.readFileSync(path.join(ROOT, 'migrations', '0011_drop_live_controls.sql'), 'utf8');
assert.match(drop, /^-- phase: contract$/m);
assert.match(drop, /^-- after: 0002$/m);
const dropped = [...drop.matchAll(/^DROP TABLE IF EXISTS (\w+);$/gm)].map((m) => m[1]).sort();
assert.deepStrictEqual(dropped, TABLES, '0011 drops exactly the seven tables');
const columns = {};
for (const [, table, column] of drop.matchAll(/^ALTER TABLE (\w+) DROP COLUMN IF EXISTS (\w+);$/gm)) (columns[table] ||= []).push(column);
for (const t of Object.keys(columns)) columns[t].sort();
assert.deepStrictEqual(columns, COLUMNS, '0011 drops exactly the columns that pointed at them');
// Every column goes before the tables, so no foreign key still names control_configs when it is dropped.
assert.ok(drop.lastIndexOf('DROP COLUMN') < drop.indexOf('DROP TABLE'), 'columns first, then tables');
console.log('controls tables: nothing under server/, scripts/ or public/js names them, and 0011 drops them');
