'use strict';

// The staged chat tables are OpenVibe.Chat's (roadmap T3). This release (N+2) dropped Live's copies
// of seven of them — channel_moderators, channel_moderation_settings, user_tags, chat_ai_summaries,
// chat_timeline_events, chat_staged_outbox and chat_dual_read_stats — in the boot migration
// 005_drop_chat_staged_tables (server/db/migrations.js). `emotes` stays one more release because the
// N-1 release's SQL still prepares two COUNT(*) against it (test/fixtures/n-1/worker.json), but
// nothing reads it: the home hero's "emotes created" series is gone and its recent figures are zero
// (kept for the N-1 client). Like the frozen vods/clips tables (test/frozen-tables.test.js), no
// server/ or scripts/ code may READ or WRITE any of the dropped tables; the one allowed read is the
// emotes rebuild that is schema upkeep and goes with the table next release.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Dropped by 005_drop_chat_staged_tables. `emotes` is deliberately not here (kept one release).
const DROPPED = [
    'channel_moderators', 'channel_moderation_settings', 'user_tags',
    'chat_ai_summaries', 'chat_timeline_events', 'chat_staged_outbox', 'chat_dual_read_stats',
];
const T = DROPPED.join('|');

const WRITE = new RegExp(`\\b(INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(?:main\\.)?(${T})\\b`, 'i');
const READ_SQL = new RegExp(`\\b(FROM|JOIN)\\s+[\`"']?(?:main\\.)?(${T})\\b`, 'gi');
const READ_REGISTRY = new RegExp(`\\btable\\s*:\\s*[\`"'](${T})[\`"']`, 'g');

// Reads of the one kept table under server/: only the schema upkeep must remain.
const EMOTES_READ_SQL = /\b(FROM|JOIN)\s+[`"']?(?:main\.)?emotes\b/gi;
const EMOTES_READ_REGISTRY = /\btable\s*:\s*[`"']emotes[`"']/g;
// { file, snippet, reason }: each must be a real, current read (a stale entry fails the test).
const ALLOWED_EMOTES_READS = [
    { file: path.join('server', 'db', 'database.js'), snippet: 'FROM emotes', reason: 'the one-time pre-existing-database emotes rebuild (per-channel code uniqueness) is schema upkeep; it goes with the table next release' },
];

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
// upkeep (CREATE/DROP/ALTER) and comments alone.
for (const [src, regexes, n] of [
    ["db.get('SELECT * FROM chat_ai_summaries WHERE scope = ?', [scope])", [READ_SQL, READ_REGISTRY], 1],
    ["db.all(`SELECT cm.id FROM chat_messages cm LEFT JOIN channel_moderators cm2 ON cm2.channel_id = ?`)", [READ_SQL, READ_REGISTRY], 1],
    ["const S = { emotes: { table: 'emotes', ts: 'created_at', agg: 'COUNT(*)' } };", [EMOTES_READ_SQL, EMOTES_READ_REGISTRY], 1],
    ["db.run('INSERT INTO emote_media (id) VALUES (1)')", [READ_SQL, READ_REGISTRY], 0],
    ["db.run('INSERT INTO emotes (id, code) VALUES (1, \\'x\\')')", [READ_SQL, READ_REGISTRY], 0],
    ["db.run('INSERT INTO emotes_new (id, code) SELECT id, code FROM emotes')", [EMOTES_READ_SQL, EMOTES_READ_REGISTRY], 1],
    ["db.run('UPDATE emotes SET code = ? WHERE id = ?')", [READ_SQL, READ_REGISTRY], 0],
    ["database.exec('CREATE TABLE IF NOT EXISTS chat_staged_outbox (seq INTEGER)');", [READ_SQL, READ_REGISTRY], 0],
    ["database.exec('DROP TABLE user_tags');", [READ_SQL, READ_REGISTRY], 0],
    ['    // used to read FROM user_tags here', [READ_SQL, READ_REGISTRY], 0],
    ["db.all('SELECT * FROM stream_timeline_events WHERE stream_id = ?')", [READ_SQL, READ_REGISTRY], 0],
]) assert.strictEqual(findReads(src, regexes).length, n, `scanner on: ${src}`);

// After boot the seven are gone, the migration is recorded, and `emotes` is still there for N-1.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-staged-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const db = require('../server/db/database');
db.initDb();
const d = db.getDb();
for (const t of DROPPED) {
    assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t),
        `${t} still exists after boot — 005_drop_chat_staged_tables did not drop it`);
}
assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'emotes'").get(),
    'emotes is kept one more release (N-1 still prepares two COUNT(*) against it)');
const rec = d.prepare('SELECT mode FROM schema_migrations WHERE id = ?').get('005_drop_chat_staged_tables');
assert.ok(rec, 'the 005_drop_chat_staged_tables migration is not recorded');

const writes = [];
const reads = [];
const emoteReads = [];
const usedAllowances = new Set();
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
        if (WRITE.test(line) && !isCommentLine(line)) writes.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    for (const hit of findReads(src, [READ_SQL, READ_REGISTRY])) reads.push(`${rel}:${hit.line}: ${hit.text.slice(0, 120)}`);
    for (const hit of findReads(src, [EMOTES_READ_SQL, EMOTES_READ_REGISTRY])) {
        const ok = ALLOWED_EMOTES_READS.find((a) => a.file === rel && hit.text.includes(a.snippet));
        if (ok) { usedAllowances.add(ok); continue; }
        emoteReads.push(`${rel}:${hit.line}: ${hit.text.slice(0, 120)}`);
    }
}
assert.deepStrictEqual(writes, [], `writes to Chat's dropped tables (OpenVibe.Chat owns them; write through Chat's API instead):\n${writes.join('\n')}`);
assert.deepStrictEqual(reads, [], `reads of Chat's dropped tables (read them through server/chat/moderation-client.js, or Chat's own API):\n${reads.join('\n')}`);
assert.deepStrictEqual(emoteReads, [], `reads of \`emotes\` (only the schema upkeep may read it; it goes next release):\n${emoteReads.join('\n')}`);
for (const a of ALLOWED_EMOTES_READS) {
    assert.ok(a.reason && a.reason.length > 20, `allowed read without a reason: ${a.file}`);
    assert.ok(usedAllowances.has(a), `stale allow-list entry (the read is gone, remove it): ${a.file}: ${a.snippet}`);
}
console.log(`chat staged tables: 005_drop_chat_staged_tables recorded (${rec.mode}) — ${DROPPED.length} tables dropped, emotes kept, ${ALLOWED_EMOTES_READS.length} allowed read(s)`);
process.exit(0);
