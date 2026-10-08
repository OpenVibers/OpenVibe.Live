'use strict';

// The twelve OpenVibe.Chat-owned chat tables (roadmap T3, final step). Live's readers and writers are gone (#28-#33),
// SQLite migration 007 dropped Live's copies, and on PostgreSQL (plan T4) they never exist: migrations/0002_live.sql
// leaves them out. This guard: nothing under server/ names any of the twelve, no migration creates one, and the
// migrated database has none.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
    for (const hit of findReads(src, [READ_SQL])) offenders.push(`${rel}:${hit.line}: ${hit.text.slice(0, 120)}`);
    lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (WRITE_SQL.test(line) || SCHEMA_SQL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], `server/ still names OpenVibe.Chat's chat tables (read and write them through Chat's API):\n${offenders.join('\n')}`);

// 2. No migration creates one, and the migrated database has none.
const MIGRATION_SQL = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')).join('\n');
for (const t of TABLES) assert.ok(!new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${t}\\s*\\(`, 'i').test(MIGRATION_SQL), `no migration creates ${t}`);
(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    for (const t of TABLES) {
        assert.ok(!await db.getDb().prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?").get(t), `${t} is not in the migrated database`);
    }
    console.log(`chat tables dropped: no server/ code names the ${TABLES.length}; no migration creates one; the migrated database has none`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
