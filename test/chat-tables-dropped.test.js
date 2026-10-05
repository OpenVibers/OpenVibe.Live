'use strict';

// The twelve OpenVibe.Chat-owned chat tables (roadmap T3, final step). Live's readers and writers
// are gone (#28–#32 and the release that carries this file), it no longer creates them, and
// op_003_drop_chat_tables (scripts/chat-tables-drop.js) drops them. The drop is an operator
// contract step, not a boot migration: the release before this one still runs SQL over them
// (test/n-1.test.js), so it may only run once that release is out of rollback range (ADR-028).
// This guard: nothing under server/ names any of the twelve (the drop migration's own statements
// are the one exception), a freshly migrated database has none, and the operator migration drops
// legacy copies and is idempotent.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

const TABLES = [
    'chat_messages', 'dm_conversations', 'dm_participants', 'dm_messages', 'dm_blocks',
    'tts_voice_overrides', 'channel_sounds', 'relay_users', 'hidden_relay_users',
    'pending_ip_messages', 'stream_first_chats', 'moderation_actions',
];
const T = TABLES.join('|');

const READ_SQL = new RegExp(`\\b(FROM|JOIN)\\s+[\`"']?(?:main\\.)?(${T})\\b`, 'gi');
const WRITE_SQL = new RegExp(`\\b(INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(?:main\\.)?(${T})\\b`, 'i');
const SCHEMA_SQL = new RegExp(`\\b(CREATE\\s+(?:TABLE|INDEX|TRIGGER)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|ALTER\\s+TABLE\\s+|PRAGMA\\s+(?:table_info|table_xinfo|index_list|foreign_key_list)\\s*\\(\\s*[\`"']?)(${T})\\b`, 'i');
// The operator drop (server/db/migrations.js) is the one place allowed to name them.
const DROP_STMT = new RegExp(`^\\s*DROP\\s+(?:TABLE|INDEX|TRIGGER)\\s+IF\\s+EXISTS\\s+(?:${T})\\s*;\\s*$`, 'i');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
        else if (e.name.endsWith('.js') || e.name.endsWith('.sql')) out.push(p);
    }
    return out;
}
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*|--)/.test(line);

/** Every read matching one of `regexes` in a file's text → [{ line, text }]. */
function findReads(src, regexes) {
    const lines = src.split('\n');
    const hits = [];
    for (const re of regexes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src))) {
            const startLine = src.slice(0, m.index).split('\n').length;
            const endLine = src.slice(0, m.index + m[0].length - 1).split('\n').length;
            if (isCommentLine(lines[startLine - 1]) || isCommentLine(lines[endLine - 1])) continue;
            hits.push({ line: endLine, text: lines[endLine - 1].trim() });
        }
    }
    return hits;
}

// 1. No server/ code names any of the twelve (the drop migration's DROP lines excepted).
const offenders = [];
for (const file of walk(path.join(ROOT, 'server'))) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    if (rel !== path.join('server', 'db', 'migrations.js')) {
        for (const hit of findReads(src, [READ_SQL])) offenders.push(`${rel}:${hit.line}: ${hit.text.slice(0, 120)}`);
    }
    lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (rel === path.join('server', 'db', 'migrations.js') && DROP_STMT.test(line)) return;
        if (WRITE_SQL.test(line) || SCHEMA_SQL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], `server/ still names OpenVibe.Chat's chat tables (read and write them through Chat's API; the operator drop is the only exception):\n${offenders.join('\n')}`);

// 2. A database created by the schema has none of them.
const fresh = new Database(':memory:');
fresh.exec(fs.readFileSync(path.join(ROOT, 'server', 'db', 'schema.sql'), 'utf8'));
for (const t of TABLES) {
    assert.ok(!fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), `fresh schema must not create ${t}`);
}
fresh.close();

// 3. A boot neither creates nor drops them (the drop is the operator step), and op_003 drops them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-tables-dropped-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const legacy = new Database(process.env.DB_PATH);
for (const t of TABLES) legacy.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`);
legacy.close();

const db = require('../server/db/database');
db.initDb();
const d = db.getDb();
const exists = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
for (const t of TABLES) assert.ok(exists(t), `${t} must survive a boot: dropping it is the operator step, not a boot migration`);
assert.ok(!d.prepare("SELECT 1 FROM schema_migrations WHERE id = 'op_003_drop_chat_tables'").get(), 'op_003 is not a boot migration');

const migrations = require('../server/db/migrations');
assert.ok(!migrations.MIGRATIONS.some((m) => m.id === 'op_003_drop_chat_tables'), 'op_003 is not in the boot list');
assert.ok(migrations.OPERATOR_MIGRATIONS.some((m) => m.id === 'op_003_drop_chat_tables'), 'op_003 is an operator migration');
assert.strictEqual(migrations.runOperator(d, 'op_003_drop_chat_tables').outcome, 'applied', 'the operator drop applies');
for (const t of TABLES) assert.ok(!exists(t), `${t} must be gone after op_003`);
assert.strictEqual(migrations.runOperator(d, 'op_003_drop_chat_tables').outcome, 'already', 'the operator drop is idempotent');
db.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`chat tables dropped: no server/ code names the ${TABLES.length}; fresh schema none; op_003 drops legacy copies (idempotent)`);
process.exit(0);
