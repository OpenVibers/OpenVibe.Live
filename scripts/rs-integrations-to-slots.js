#!/usr/bin/env node
/**
 * Binds every account-level RobotStreamer integration (a robotstreamer_integrations row with no
 * managed_stream_id) to a stream slot, so RobotStreamer is configured per slot only.
 *
 * Live used to fall back to the account-level row for any slot that had no row of its own. That
 * fallback is gone: a stream now uses only its slot's row, and an account-level row applies to no
 * stream (Live logs it and skips it). Run this before deploying that change, so the configured
 * robots keep working on the slot they belong to.
 *
 * How a row's slot is chosen (never guessed):
 *   - the user has exactly one slot                      -> that slot
 *   - exactly one slot has RobotStreamer on it           -> that slot. The evidence: the slot's own
 *     RobotStreamer row points at the same robot, or the slot's past streams carried mirrored
 *     RobotStreamer chat (chat_messages.source_platform = 'rs') while it had no row of its own,
 *     i.e. the account-level row was serving it
 *   - --assign <row id>=<slot id> on the command line    -> that slot (the lead's decision)
 *   - anything else (no slot, several candidates, none)  -> reported as ambiguous and left alone
 *     (the report lists each slot's last live time and RobotStreamer chat count to decide with)
 * If the chosen slot already has its own RobotStreamer row, the account-level row is "superseded":
 * that slot never used it. It is left alone (inert) unless --drop-superseded is given.
 *
 *   node scripts/rs-integrations-to-slots.js [--db <live.db>]                      # dry run: the plan, changes nothing
 *   node scripts/rs-integrations-to-slots.js --assign 12=60 [--assign 13=85]        # dry run with decisions for ambiguous rows
 *   node scripts/rs-integrations-to-slots.js --apply --backup <file.db> [--assign …] [--drop-superseded]
 *        # online backup of the database to <file.db>, the journal to <file.db>.journal.json, then the changes
 *   node scripts/rs-integrations-to-slots.js --rollback <file.db>.journal.json      # dry run of the undo
 *   node scripts/rs-integrations-to-slots.js --rollback <journal> --apply --backup <file2.db>
 *        # undo exactly what the journal recorded (rows moved back to account level, dropped rows re-inserted)
 *   --json prints the plan as JSON.
 *
 * Default database: $DB_PATH, else data/live.db under $DATA_DIR or the working directory
 * (server/paths.js), i.e. run it from /opt/openvibe.live as the service user.
 * Tokens are never printed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const COLUMNS = ['id', 'user_id', 'managed_stream_id', 'enabled', 'mirror_chat', 'token', 'robot_id', 'owner_id',
    'chat_url', 'control_url', 'rtc_sfu_url', 'stream_name', 'owner_name', 'last_validated_at', 'created_at', 'updated_at'];

function parseArgs(argv) {
    const opts = { apply: false, json: false, dropSuperseded: false, assign: new Map(), db: null, backup: null, rollback: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--apply') opts.apply = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--drop-superseded') opts.dropSuperseded = true;
        else if (a === '--db') opts.db = next();
        else if (a === '--backup') opts.backup = next();
        else if (a === '--rollback') opts.rollback = next();
        else if (a === '--assign') {
            const m = /^(\d+)=(\d+)$/.exec(next());
            if (!m) throw new Error('--assign takes <row id>=<slot id>, e.g. --assign 12=60');
            opts.assign.set(Number(m[1]), Number(m[2]));
        } else if (a === '--help' || a === '-h') opts.help = true;
        else throw new Error(`unknown option ${a}`);
    }
    return opts;
}

function hasTable(db, name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** What would happen to each account-level row. Pure: reads only. */
function plan(db, { assign = new Map() } = {}) {
    const rows = db.prepare('SELECT * FROM robotstreamer_integrations WHERE managed_stream_id IS NULL ORDER BY id').all();
    const slotsOf = db.prepare('SELECT id, slug, title FROM managed_streams WHERE user_id = ? ORDER BY id');
    const slotRowsOf = db.prepare('SELECT id, managed_stream_id, robot_id FROM robotstreamer_integrations WHERE user_id = ? AND managed_stream_id IS NOT NULL');
    // Slots whose streams carried mirrored RobotStreamer chat, with how much and how recently.
    const rsChatOf = hasTable(db, 'chat_messages') && hasTable(db, 'streams')
        ? db.prepare(`SELECT s.managed_stream_id AS id, COUNT(*) AS n, MAX(cm.timestamp) AS last
                      FROM streams s JOIN chat_messages cm ON cm.stream_id = s.id
                      WHERE s.user_id = ? AND s.managed_stream_id IS NOT NULL AND cm.source_platform = 'rs'
                      GROUP BY s.managed_stream_id`)
        : null;
    const lastLiveOf = hasTable(db, 'streams')
        ? db.prepare('SELECT managed_stream_id AS id, MAX(started_at) AS last FROM streams WHERE user_id = ? AND managed_stream_id IS NOT NULL GROUP BY managed_stream_id')
        : null;
    const userOf = db.prepare('SELECT username FROM users WHERE id = ?');
    const known = new Set(rows.map((r) => r.id));
    const errors = [];
    for (const rowId of assign.keys()) {
        if (!known.has(rowId)) errors.push(`--assign ${rowId}=…: row ${rowId} is not an account-level RobotStreamer row`);
    }

    const items = rows.map((row) => {
        const slots = slotsOf.all(row.user_id);
        const slotIds = new Set(slots.map((s) => s.id));
        const slotRows = slotRowsOf.all(row.user_id);
        const taken = new Map(slotRows.map((r) => [r.managed_stream_id, r]));
        const rsChat = new Map((rsChatOf ? rsChatOf.all(row.user_id) : []).map((r) => [r.id, r]));
        const lastLive = new Map((lastLiveOf ? lastLiveOf.all(row.user_id) : []).map((r) => [r.id, r.last]));
        const item = {
            id: row.id,
            user_id: row.user_id,
            username: (userOf.get(row.user_id) || {}).username || null,
            enabled: !!row.enabled,
            has_token: !!row.token,
            robot_id: row.robot_id || null,
            stream_name: row.stream_name || null,
            slots: slots.map((s) => ({
                id: s.id, slug: s.slug || null, title: s.title || null, has_rs_row: taken.has(s.id),
                last_live: lastLive.get(s.id) || null, rs_chat_messages: rsChat.has(s.id) ? rsChat.get(s.id).n : 0,
            })),
            action: 'ambiguous',
            slot_id: null,
            reason: '',
        };
        const decide = (slotId, why) => {
            if (taken.has(slotId)) {
                item.action = 'superseded';
                item.slot_id = slotId;
                item.reason = `${why}, but slot ${slotId} already has its own RobotStreamer row (${taken.get(slotId).id}), which it always used`;
            } else {
                item.action = 'bind';
                item.slot_id = slotId;
                item.reason = why;
            }
        };

        if (assign.has(row.id)) {
            const slotId = assign.get(row.id);
            if (!slotIds.has(slotId)) {
                errors.push(`--assign ${row.id}=${slotId}: slot ${slotId} is not one of user ${row.user_id}'s slots (${[...slotIds].join(', ') || 'none'})`);
                item.reason = 'the --assign slot does not belong to this user';
            } else if (taken.has(slotId)) {
                errors.push(`--assign ${row.id}=${slotId}: slot ${slotId} already has its own RobotStreamer row (${taken.get(slotId).id})`);
                item.reason = 'the --assign slot already has its own RobotStreamer row';
            } else {
                decide(slotId, 'assigned on the command line');
            }
            return item;
        }
        if (slots.length === 0) {
            item.reason = 'the user has no stream slot';
            return item;
        }
        if (slots.length === 1) {
            decide(slots[0].id, 'the user\'s only slot');
            return item;
        }
        const signal = new Set();
        // A slot with its own row never used the account-level row, so its chat says nothing about it.
        for (const id of rsChat.keys()) if (slotIds.has(id) && !taken.has(id)) signal.add(id);
        if (row.robot_id) {
            for (const r of slotRows) if (String(r.robot_id || '') === String(row.robot_id)) signal.add(r.managed_stream_id);
        }
        if (signal.size === 1) {
            decide([...signal][0], 'the only slot with RobotStreamer on it');
            return item;
        }
        item.reason = signal.size === 0
            ? `${slots.length} slots and none has RobotStreamer on it`
            : `${signal.size} slots have RobotStreamer on them (${[...signal].join(', ')})`;
        return item;
    });
    return { items, errors };
}

function describe(item) {
    const who = `user ${item.user_id}${item.username ? ` (${item.username})` : ''}`;
    const what = `enabled=${item.enabled ? 1 : 0} token=${item.has_token ? 'yes' : 'no'} robot=${item.robot_id || '-'}${item.stream_name ? ` "${item.stream_name}"` : ''}`;
    const slots = item.slots.map((s) => `${s.id}${s.slug ? `/${s.slug}` : ''}${s.has_rs_row ? '*' : ''}`
        + ` [last live ${s.last_live || 'never'}${s.rs_chat_messages ? `, ${s.rs_chat_messages} RS chat` : ''}]`).join(', ') || 'none';
    const verdict = item.action === 'bind' ? `bind to slot ${item.slot_id}`
        : item.action === 'superseded' ? `superseded by slot ${item.slot_id}'s own row`
            : 'AMBIGUOUS, left alone';
    return `row ${item.id}  ${who}  ${what}\n    slots: ${slots}   (* = has its own RobotStreamer row)\n    -> ${verdict}: ${item.reason}`;
}

/** Writes the journal, then applies the plan in one transaction. Returns the journal. */
function apply(db, items, { journalPath, backupPath, dropSuperseded = false, dbPath = null }) {
    const byId = db.prepare('SELECT * FROM robotstreamer_integrations WHERE id = ?');
    const changes = [];
    for (const item of items) {
        if (item.action === 'bind') {
            changes.push({ action: 'bind', id: item.id, user_id: item.user_id, from: null, to: item.slot_id });
        } else if (item.action === 'superseded' && dropSuperseded) {
            const row = byId.get(item.id);
            changes.push({ action: 'delete', id: item.id, user_id: item.user_id, row: Object.fromEntries(COLUMNS.map((c) => [c, row[c] === undefined ? null : row[c]])) });
        }
    }
    const journal = { script: 'rs-integrations-to-slots', created_at: new Date().toISOString(), db: dbPath, backup: backupPath, changes };
    // The journal goes to disk first: if anything below fails, the record of the intent exists.
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
    const bind = db.prepare('UPDATE robotstreamer_integrations SET managed_stream_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND managed_stream_id IS NULL');
    const drop = db.prepare('DELETE FROM robotstreamer_integrations WHERE id = ? AND managed_stream_id IS NULL');
    db.transaction(() => {
        for (const c of changes) {
            const r = c.action === 'bind' ? bind.run(c.to, c.id) : drop.run(c.id);
            if (r.changes !== 1) throw new Error(`row ${c.id} changed since the plan was made (no longer account-level); nothing was applied`);
        }
    })();
    return journal;
}

/** Undo a journal: bound rows go back to account level, dropped rows are re-inserted. */
function rollbackPlan(db, journal) {
    const byId = db.prepare('SELECT id, user_id, managed_stream_id FROM robotstreamer_integrations WHERE id = ?');
    const accountRow = db.prepare('SELECT id FROM robotstreamer_integrations WHERE user_id = ? AND managed_stream_id IS NULL');
    return (journal.changes || []).map((c) => {
        const now = byId.get(c.id);
        const clash = accountRow.get(c.user_id);
        if (c.action === 'bind') {
            if (!now) return { ...c, undo: 'skip', reason: 'the row no longer exists' };
            if (now.managed_stream_id !== c.to) return { ...c, undo: 'skip', reason: `the row is now on slot ${now.managed_stream_id ?? 'none'}, not ${c.to}` };
            if (clash) return { ...c, undo: 'skip', reason: `user ${c.user_id} has a new account-level row (${clash.id})` };
            return { ...c, undo: 'unbind' };
        }
        if (now) return { ...c, undo: 'skip', reason: 'a row with that id exists again' };
        if (clash) return { ...c, undo: 'skip', reason: `user ${c.user_id} has a new account-level row (${clash.id})` };
        return { ...c, undo: 'reinsert' };
    });
}

function rollbackApply(db, steps) {
    const unbind = db.prepare('UPDATE robotstreamer_integrations SET managed_stream_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND managed_stream_id = ?');
    const insert = db.prepare(`INSERT INTO robotstreamer_integrations (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`);
    db.transaction(() => {
        for (const s of steps) {
            if (s.undo === 'unbind' && unbind.run(s.id, s.to).changes !== 1) throw new Error(`row ${s.id} changed during the rollback; nothing was undone`);
            if (s.undo === 'reinsert') insert.run(s.row);
        }
    })();
}

async function main(argv, log = console.log) {
    const opts = parseArgs(argv);
    if (opts.help) {
        const src = fs.readFileSync(__filename, 'utf8');
        log(src.slice(src.indexOf('/**') + 3, src.indexOf('*/')).split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
        return 0;
    }
    const Database = require('better-sqlite3');
    const dbPath = path.resolve(opts.db || require('../server/paths').dbPath());
    if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
    if (opts.apply && !opts.backup) throw new Error('--apply needs --backup <file> (an online backup of the database is taken first)');
    if (opts.backup && fs.existsSync(opts.backup)) throw new Error(`${opts.backup} already exists; choose a new backup file`);
    const db = new Database(dbPath, { readonly: !opts.apply, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    try {
        if (!hasTable(db, 'robotstreamer_integrations')) { log('no robotstreamer_integrations table; nothing to do'); return 0; }
        const backup = async () => {
            await db.backup(opts.backup);
            log(`backup: ${path.resolve(opts.backup)}`);
        };

        if (opts.rollback) {
            const journal = JSON.parse(fs.readFileSync(opts.rollback, 'utf8'));
            if (journal.script !== 'rs-integrations-to-slots') throw new Error(`${opts.rollback} is not a journal of this script`);
            const steps = rollbackPlan(db, journal);
            for (const s of steps) {
                log(`row ${s.id} (${s.action}${s.to ? ` -> slot ${s.to}` : ''}): ${s.undo === 'skip' ? `skip, ${s.reason}` : s.undo}`);
            }
            if (!steps.length) log('the journal records no changes');
            if (!opts.apply) { log('dry run: nothing changed (add --apply --backup <file> to undo)'); return 0; }
            await backup();
            rollbackApply(db, steps);
            log(`rolled back ${steps.filter((s) => s.undo !== 'skip').length} of ${steps.length} change(s)`);
            return steps.some((s) => s.undo === 'skip') ? 2 : 0;
        }

        const { items, errors } = plan(db, { assign: opts.assign });
        if (opts.json) log(JSON.stringify({ db: dbPath, items, errors }, null, 2));
        else {
            log(`database: ${dbPath}`);
            log(`account-level RobotStreamer rows: ${items.length}`);
            for (const item of items) log(describe(item));
        }
        for (const e of errors) log(`error: ${e}`);
        const count = (a) => items.filter((i) => i.action === a).length;
        log(`bind ${count('bind')}, superseded ${count('superseded')}${opts.dropSuperseded ? ' (dropped)' : ' (left alone)'}, ambiguous ${count('ambiguous')} (left alone)`);
        if (count('ambiguous')) log('for an ambiguous row, decide its slot and rerun with --assign <row id>=<slot id>');
        if (errors.length) { log('refusing to continue until the errors above are fixed'); return 1; }
        if (!opts.apply) { log('dry run: nothing changed (add --apply --backup <file> to apply)'); return 0; }
        await backup();
        const journalPath = `${opts.backup}.journal.json`;
        const journal = apply(db, items, { journalPath, backupPath: path.resolve(opts.backup), dropSuperseded: opts.dropSuperseded, dbPath });
        log(`applied ${journal.changes.length} change(s); journal: ${path.resolve(journalPath)}`);
        log(`undo: node scripts/rs-integrations-to-slots.js --db ${dbPath} --rollback ${path.resolve(journalPath)} --apply --backup <new file>`);
        return 0;
    } finally {
        db.close();
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        console.error(`error: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { main, plan, apply, rollbackPlan, rollbackApply, parseArgs };
