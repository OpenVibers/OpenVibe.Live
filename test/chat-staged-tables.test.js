'use strict';

// The six staged chat tables (channel_moderators, channel_moderation_settings, emotes, user_tags,
// chat_ai_summaries, chat_timeline_events) are OpenVibe.Chat's (roadmap T3), and so are the relay
// bookkeeping tables chat_staged_outbox and chat_dual_read_stats, which belonged to the staged-table
// machinery this release deleted (server/chat/chat-tables*.js). Like the frozen vods/clips tables
// (test/frozen-tables.test.js), no server/ or scripts/ code may WRITE them and none may READ them.
//
// The tables stay in the schema one more release for N-1 (ADR-016): the previous release's SQL still
// prepares against them (test/n-1.test.js) and its migrations expect them, so this is a code guard,
// not a schema one — CREATE/ALTER/PRAGMA/DROP lines are not counted.
//
// The two reads that remain are allow-listed, each with a reason:
//   - the home hero's "emotes created" figure and its over-time series read Live's copy of `emotes`
//     while the table is still here; the number is kept for the mixed-version window (an N-1 client
//     reads stats.emotes) and goes with the table.
//   - the one-time rebuild of `emotes` on a pre-existing database (per-channel code uniqueness) is
//     schema upkeep, not a use of the data.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGED = [
    'channel_moderators', 'channel_moderation_settings', 'emotes', 'user_tags',
    'chat_ai_summaries', 'chat_timeline_events', 'chat_staged_outbox', 'chat_dual_read_stats',
];
const T = STAGED.join('|');

const WRITE = new RegExp(`\\b(INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(?:main\\.)?(${T})\\b`, 'i');
const READ_SQL = new RegExp(`\\b(FROM|JOIN)\\s+[\`"']?(?:main\\.)?(${T})\\b`, 'gi');
const READ_REGISTRY = new RegExp(`\\btable\\s*:\\s*[\`"'](${T})[\`"']`, 'g');

// { file, snippet, reason }: each must be a real, current read (a stale entry fails the test).
const ALLOWED_READS = [
    { file: path.join('server', 'db', 'database.js'), snippet: "table: 'emotes'", reason: 'home hero "emotes created" series; the table stays for the N-1 client that reads stats.emotes' },
    { file: path.join('server', 'db', 'database.js'), snippet: 'SELECT id, user_id, code, url, animated, width, height, is_global, is_approved, created_at, channel_owner_id, size FROM emotes', reason: 'the one-time pre-existing-database emotes rebuild (per-channel code uniqueness) is schema upkeep' },
];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
        else if (e.name.endsWith('.js') || e.name.endsWith('.sql')) out.push(p);
    }
    return out;
}
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Every staged-table read in one file's text → [{ line, text }]. */
function findReads(src) {
    const lines = src.split('\n');
    const hits = [];
    for (const re of [READ_SQL, READ_REGISTRY]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src))) {
            const at = m.index + m[0].length - 1;
            const lineNo = src.slice(0, at).split('\n').length;
            const text = lines[lineNo - 1];
            const startLine = src.slice(0, m.index).split('\n').length;
            if (isCommentLine(lines[startLine - 1]) || isCommentLine(text)) continue;
            hits.push({ line: lineNo, text: text.trim() });
        }
    }
    return hits;
}

// The scanner itself: it has to catch the shapes the deleted machinery used, and leave schema
// upkeep alone.
for (const [src, n] of [
    ["db.get('SELECT * FROM chat_ai_summaries WHERE scope = ?', [scope])", 1],
    ["db.all(`SELECT cm.id FROM chat_messages cm LEFT JOIN channel_moderators cm2 ON cm2.channel_id = ?`)", 1],
    ["const S = { emotes: { table: 'emotes', ts: 'created_at', agg: 'COUNT(*)' } };", 1],
    ["db.run('INSERT INTO emote_media (id) VALUES (1)')", 0],
    ["db.run('INSERT INTO emotes_new (id, code) VALUES (1, \\'x\\')')", 0],
    ["db.run('INSERT INTO emotes_new (id, code) SELECT id, code FROM emotes')", 1],
    ["db.run('UPDATE emotes SET code = ? WHERE id = ?')", 0],
    ["database.exec('CREATE TABLE IF NOT EXISTS chat_staged_outbox (seq INTEGER)');", 0],
    ["database.exec('DROP TABLE emotes');", 0],
    ['    // used to read FROM user_tags here', 0],
    ["db.all('SELECT * FROM stream_timeline_events WHERE stream_id = ?')", 0],
]) assert.strictEqual(findReads(src).length, n, `scanner on: ${src}`);

const writes = [];
const reads = [];
const usedAllowances = new Set();
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
        if (WRITE.test(line) && !isCommentLine(line)) writes.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    for (const hit of findReads(src)) {
        const ok = ALLOWED_READS.find((a) => a.file === rel && hit.text.includes(a.snippet));
        if (ok) { usedAllowances.add(ok); continue; }
        reads.push(`${rel}:${hit.line}: ${hit.text.slice(0, 120)}`);
    }
}
assert.deepStrictEqual(writes, [], `writes to Chat's staged tables (OpenVibe.Chat owns them; write through Chat's API instead):\n${writes.join('\n')}`);
assert.deepStrictEqual(reads, [], `reads of Chat's staged tables (read them through server/chat/moderation-client.js, or Chat's own API):\n${reads.join('\n')}`);
for (const a of ALLOWED_READS) {
    assert.ok(a.reason && a.reason.length > 20, `allowed read without a reason: ${a.file}`);
    assert.ok(usedAllowances.has(a), `stale allow-list entry (the read is gone, remove it): ${a.file}: ${a.snippet}`);
}
console.log(`chat staged tables: no writes, no unlisted reads — ${STAGED.length} tables, ${ALLOWED_READS.length} allowed read(s)`);
