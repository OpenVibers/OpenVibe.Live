'use strict';

// The twelve OpenVibe.Chat-owned chat tables (roadmap T3, final step). Live's readers and writers
// are gone (#28-#32 and the release that carries this file, #33), it no longer creates them, and
// since #33 is the production release its N-1 fixtures no longer run SQL over them (test/n-1.test.js),
// so boot migration 007_drop_chat_tables drops them (ADR-028). This guard: nothing under server/
// names any of the twelve (the drop migration's own DROP statements are the one exception), a fresh
// schema creates none, a boot drops legacy copies that are there and is adopted when none exist.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DROP_ID = '007_drop_chat_tables';

const TABLES = [
    'chat_messages', 'dm_conversations', 'dm_participants', 'dm_messages', 'dm_blocks',
    'tts_voice_overrides', 'channel_sounds', 'relay_users', 'hidden_relay_users',
    'pending_ip_messages', 'stream_first_chats', 'moderation_actions',
];
const T = TABLES.join('|');

const READ_SQL = new RegExp(`\\b(FROM|JOIN)\\s+[\`"']?(?:main\\.)?(${T})\\b`, 'gi');
const WRITE_SQL = new RegExp(`\\b(INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(?:main\\.)?(${T})\\b`, 'i');
const SCHEMA_SQL = new RegExp(`\\b(CREATE\\s+(?:TABLE|INDEX|TRIGGER)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|ALTER\\s+TABLE\\s+|PRAGMA\\s+(?:table_info|table_xinfo|index_list|foreign_key_list)\\s*\\(\\s*[\`"']?)(${T})\\b`, 'i');
// The boot drop (server/db/migrations.js) is the one place allowed to name them.
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

/** Every read matching one of `regexes` in a file's text -> [{ line, text }]. */
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
assert.deepStrictEqual(offenders, [], `server/ still names OpenVibe.Chat's chat tables (read and write them through Chat's API; the boot drop is the only exception):\n${offenders.join('\n')}`);

// 2. A database created by the schema has none of them.
const fresh = new Database(':memory:');
fresh.exec(fs.readFileSync(path.join(ROOT, 'server', 'db', 'schema.sql'), 'utf8'));
for (const t of TABLES) {
    assert.ok(!fresh.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?").get(t), `fresh schema must not create ${t}`);
}
fresh.close();

const migrations = require('../server/db/migrations');
assert.ok(migrations.MIGRATIONS.some((m) => m.id === DROP_ID), `${DROP_ID} is a boot migration`);
assert.ok(migrations.OPERATOR_MIGRATIONS.every((m) => m.id !== 'op_003_drop_chat_tables'), 'the superseded operator step is gone');

// 3. The boot migration drops them on a database that has them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-tables-dropped-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const legacy = new Database(process.env.DB_PATH);
for (const t of TABLES) legacy.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`);
legacy.close();

const db = require('../server/db/database');
db.initDb();
const d = db.getDb();
const exists = (t) => !!d.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?").get(t);
for (const t of TABLES) assert.ok(!exists(t), `${t} must be gone after a boot with the drop migration`);
assert.strictEqual(d.prepare('SELECT mode FROM schema_migrations WHERE id = ?').get(DROP_ID).mode, 'applied', 'the drop is applied, not adopted, when the tables are present');
assert.strictEqual(migrations.run(d, migrations.MIGRATIONS.filter((m) => m.id === DROP_ID)).length, 0, 'the drop runs at most once');
db.close();
fs.rmSync(tmp, { recursive: true, force: true });

// 4. On a fresh database none of the twelve exists and the migration is adopted.
const mem = new Database(':memory:');
const res = migrations.run(mem, migrations.MIGRATIONS.filter((m) => m.id === DROP_ID));
assert.strictEqual(res[0].outcome, 'adopted', 'a fresh database adopts the drop');
mem.close();

// 5. Fast on a large table: chat_messages references itself (reply_to_id ON DELETE SET NULL, no index), so a drop
// with foreign_keys ON scans the table once per row. The migration runs with enforcement off, and turns it back on.
const big = new Database(':memory:');
big.pragma('foreign_keys = ON');
big.exec(`CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL,
    reply_to_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL)`);
const ins = big.prepare('INSERT INTO chat_messages (message, reply_to_id) VALUES (?, ?)');
big.tx(() => { for (let i = 1; i <= 30000; i++) ins.run('line', i > 1 ? i - 1 : null); });
const t0 = Date.now();
const out = migrations.run(big, migrations.MIGRATIONS.filter((m) => m.id === DROP_ID));
const took = Date.now() - t0;
assert.strictEqual(out[0].outcome, 'applied', JSON.stringify(out));
assert.ok(took < 3000, `30,000 self-referencing rows drop in well under the boot budget (took ${took} ms)`);
assert.strictEqual(big.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'chat_messages'").get().n, 0);
assert.strictEqual(big.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are back on after the migration');
big.close();

console.log(`chat tables dropped: no server/ code names the ${TABLES.length} outside ${DROP_ID}; fresh schema none; a boot drops legacy copies and adopts a fresh database`);
process.exit(0);
