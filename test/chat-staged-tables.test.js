'use strict';

// The staged chat tables are OpenVibe.Chat's (roadmap T3). Migration 005 dropped seven Live copies
// in N+2; migration 006 drops the unread emotes copy in N+3. No server/ or scripts/ code may read
// or write any of them. The N-1 release fb3957f no longer reads Live's emotes table.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

const DROPPED = [
    'channel_moderators', 'channel_moderation_settings', 'user_tags',
    'chat_ai_summaries', 'chat_timeline_events', 'chat_staged_outbox', 'chat_dual_read_stats', 'emotes',
];
const T = DROPPED.join('|');

const WRITE = new RegExp(`\\b(INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(?:main\\.)?(${T})\\b`, 'i');
const READ_SQL = new RegExp(`\\b(FROM|JOIN)\\s+[\`"']?(?:main\\.)?(${T})\\b`, 'gi');
const READ_REGISTRY = new RegExp(`\\btable\\s*:\\s*[\`"'](${T})[\`"']`, 'g');
const EMOTES_SCHEMA_ACCESS = /\b(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+|PRAGMA\s+table_info\s*\(\s*)[`"']?emotes\b/i;

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

// The scanner itself: it has to catch the shapes the deleted machinery used, and leave schema
// upkeep (DROP) and comments alone.
for (const [src, regexes, n] of [
    ["db.get('SELECT * FROM chat_ai_summaries WHERE scope = ?', [scope])", [READ_SQL, READ_REGISTRY], 1],
    ["db.all(`SELECT cm.id FROM chat_messages cm LEFT JOIN channel_moderators cm2 ON cm2.channel_id = ?`)", [READ_SQL, READ_REGISTRY], 1],
    ["const S = { emotes: { table: 'emotes', ts: 'created_at', agg: 'COUNT(*)' } };", [READ_SQL, READ_REGISTRY], 1],
    ["db.run('INSERT INTO emote_media (id) VALUES (1)')", [READ_SQL, READ_REGISTRY], 0],
    ["db.run('INSERT INTO emotes (id, code) VALUES (1, \\'x\\')')", [READ_SQL, READ_REGISTRY], 0],
    ["db.run('INSERT INTO emotes_new (id, code) SELECT id, code FROM emotes')", [READ_SQL, READ_REGISTRY], 1],
    ["db.run('UPDATE emotes SET code = ? WHERE id = ?')", [READ_SQL, READ_REGISTRY], 0],
    ["database.exec('CREATE TABLE IF NOT EXISTS chat_staged_outbox (seq INTEGER)');", [READ_SQL, READ_REGISTRY], 0],
    ["database.exec('DROP TABLE user_tags');", [READ_SQL, READ_REGISTRY], 0],
    ['    // used to read FROM user_tags here', [READ_SQL, READ_REGISTRY], 0],
    ["db.all('SELECT * FROM stream_timeline_events WHERE stream_id = ?')", [READ_SQL, READ_REGISTRY], 0],
]) assert.strictEqual(findReads(src, regexes).length, n, `scanner on: ${src}`);

// Start with the old table so boot must drop it. A separate in-memory schema check covers fresh DBs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-staged-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const legacy = new Database(process.env.DB_PATH);
legacy.exec('CREATE TABLE emotes (id INTEGER PRIMARY KEY, code TEXT)');
legacy.close();
const db = require('../server/db/database');
db.initDb();
const d = db.getDb();
for (const t of DROPPED) {
    assert.ok(!d.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?").get(t),
        `${t} still exists after boot`);
}
const rec = d.prepare('SELECT mode FROM schema_migrations WHERE id = ?').get('005_drop_chat_staged_tables');
assert.ok(rec, 'the 005_drop_chat_staged_tables migration is not recorded');
assert.strictEqual(d.prepare('SELECT mode FROM schema_migrations WHERE id = ?').get('006_drop_emotes').mode, 'applied');
const fresh = new Database(':memory:');
fresh.exec(fs.readFileSync(path.join(ROOT, 'server', 'db', 'schema.sql'), 'utf8'));
assert.ok(!fresh.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'emotes'").get(),
    'fresh schema must not create emotes');
fresh.close();

const writes = [];
const reads = [];
const schemaAccess = [];
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
        if (WRITE.test(line) && !isCommentLine(line)) writes.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        if (EMOTES_SCHEMA_ACCESS.test(line) && !isCommentLine(line)) schemaAccess.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    for (const hit of findReads(src, [READ_SQL, READ_REGISTRY])) reads.push(`${rel}:${hit.line}: ${hit.text.slice(0, 120)}`);
}
assert.deepStrictEqual(writes, [], `writes to Chat's dropped tables (OpenVibe.Chat owns them; write through Chat's API instead):\n${writes.join('\n')}`);
assert.deepStrictEqual(reads, [], `reads of Chat's dropped tables (read them through server/chat/moderation-client.js, or Chat's own API):\n${reads.join('\n')}`);
assert.deepStrictEqual(schemaAccess, [], `schema access to dropped emotes:\n${schemaAccess.join('\n')}`);
console.log(`chat staged tables: 005 recorded (${rec.mode}), 006 applied — ${DROPPED.length} tables absent; no reads or writes`);
process.exit(0);
