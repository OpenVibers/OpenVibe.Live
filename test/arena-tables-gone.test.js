'use strict';

// Arena cleanup, step 3: the Rundown replaced the Arena on 2026-10-19 (Live#264 deleted server/arena, AI#130 retired its
// workflows). Nothing under server/ or scripts/ names the Arena's tables, so the contract migration that drops them
// breaks nothing. arena_opt_outs stays: it is the Rundown's list of streamers who keep themselves out.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DROPPED = ['arena_beef_hype', 'arena_beefs', 'arena_clout_weeks', 'arena_drama', 'arena_drama_reactions', 'arena_mic_moments', 'arena_profiles', 'arena_trash_levels', 'arena_xp_log'];
const NAMES = new RegExp(`\\b(${DROPPED.join('|')}|arena_topics|arena_backfill_cursor_\\w*|arena_bot_usernames|arena_discover_window_min)\\b`);
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
assert.deepStrictEqual(offenders, [], 'the Arena is gone (the Rundown replaced it): nothing reads its tables or settings');
assert.ok(!fs.existsSync(path.join(ROOT, 'server/arena')), 'server/arena is gone');
// The Rundown still reads the opt-out list.
assert.match(fs.readFileSync(path.join(ROOT, 'server/rundown/read.js'), 'utf8'), /\barena_opt_outs\b/);

// The contract migration drops exactly these, after 0008's N-1 window, and keeps arena_opt_outs.
const drop = fs.readFileSync(path.join(ROOT, 'migrations', '0015_drop_arena.sql'), 'utf8');
assert.match(drop, /^-- phase: contract$/m);
assert.match(drop, /^-- after: 0008$/m);
const dropped = [...drop.matchAll(/^DROP TABLE IF EXISTS (\w+);$/gm)].map((m) => m[1]).sort();
assert.deepStrictEqual(dropped, DROPPED, '0015 drops exactly the nine');
assert.ok(!/arena_opt_outs/.test(drop.split('\n').filter((l) => !l.startsWith('--')).join('\n')), 'arena_opt_outs is kept');
console.log('arena tables: nothing under server/ or scripts/ names them, 0015 drops the nine and keeps arena_opt_outs');
