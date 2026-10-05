#!/usr/bin/env node
/**
 * The contract step for Live's copies of OpenVibe.Chat's chat tables (roadmap T3, final step): Live keeps no
 * copy of chat_messages, the DM tables, or the moderation/relay/sound/TTS queues any more (the readers and
 * writers went in #28–#32 and this release no longer creates them), but the release before this one still
 * runs SQL over them (test/n-1.test.js), so the drop is operator-run. Run it once that release is out of
 * rollback range.
 *
 *   node scripts/chat-tables-drop.js [--db <live.db>]
 *        # dry run (the default): which of the twelve tables exist, with row counts; changes nothing
 *   node scripts/chat-tables-drop.js --apply [--backup <file.db>] [--db <live.db>]
 *        # an online backup first (default <database dir>/backups/live-pre-chat-tables-drop-<time>.db, mode
 *        # 0600), then server/db/migrations.js operator migration op_003_drop_chat_tables, which drops the
 *        # twelve tables and their indexes. Idempotent: a second run reports 'already'.
 *
 * The rows in them came from OpenVibe.Chat (its scripts/import-from-live.js imported them with ids kept at
 * the 2026-09-23 cutover, and Chat has been their only writer since) and Live has read none of them since
 * #32; the backup is the operator's safety net, not a second home for the data.
 * Default database: $DB_PATH, else data/live.db under $DATA_DIR or the working directory (server/paths.js).
 * In production run it from /opt/openvibe.live/current as the service user (data -> ../../shared/data).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ID = 'op_003_drop_chat_tables';
const TABLES = [
    'chat_messages', 'dm_conversations', 'dm_participants', 'dm_messages', 'dm_blocks',
    'tts_voice_overrides', 'channel_sounds', 'relay_users', 'hidden_relay_users',
    'pending_ip_messages', 'stream_first_chats', 'moderation_actions',
];

function parseArgs(argv) {
    const opts = { mode: 'dry', db: null, backup: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--apply') opts.mode = 'apply';
        else if (a === '--dry-run') opts.mode = 'dry';
        else if (a === '--db') opts.db = next();
        else if (a === '--backup') opts.backup = next();
        else if (a === '--help' || a === '-h') opts.help = true;
        else throw new Error(`unknown option ${a}`);
    }
    return opts;
}

/** Which of the twelve exist, and how many rows each holds. Reads only. */
function counts(db) {
    const present = [];
    for (const t of TABLES) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
        present.push({ table: t, rows: db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n });
    }
    return present;
}

function report(present, log) {
    if (!present.length) { log('none of the twelve chat tables is present; the drop is already applied (or these are fresh-schema databases)'); return; }
    log(`${present.length} of ${TABLES.length} chat table(s) present:`);
    for (const p of present) log(`  ${p.table}: ${p.rows} row(s)`);
}

async function backup(db, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await db.backup(file);
    fs.chmodSync(file, 0o600);
    return file;
}

async function main(argv = process.argv.slice(2), log = console.log) {
    const opts = parseArgs(argv);
    if (opts.help) { log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
    const Database = require('better-sqlite3');
    const DB_PATH = path.resolve(opts.db || require('../server/paths').dbPath());
    const db = new Database(DB_PATH, { readonly: opts.mode === 'dry', fileMustExist: true });
    try {
        report(counts(db), log);
        if (opts.mode === 'dry') return 0;
        const file = opts.backup || path.join(path.dirname(DB_PATH), 'backups', `live-pre-chat-tables-drop-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
        log(`backup: ${await backup(db, file)}`);
        const res = require('../server/db/migrations').runOperator(db, ID);
        log(`${ID}: ${res.outcome}${res.error ? ` (${res.error})` : ''}`);
        if (res.outcome !== 'failed') report(counts(db), log);
        return res.outcome === 'failed' ? 1 : 0;
    } finally { db.close(); }
}

if (require.main === module) {
    main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}

module.exports = { ID, TABLES, counts, parseArgs, main };
