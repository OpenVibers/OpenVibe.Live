'use strict';

// Every write to a staged chat table (channel_moderators, channel_moderation_settings, emotes,
// user_tags, chat_ai_summaries, chat_timeline_events — roadmap C-04) goes through
// server/chat/chat-tables.js write(), which sends it to OpenVibe.Chat once Chat writes the table.
// A writer that called database.js directly, or wrote SQL of its own, would keep writing Live's copy
// after the handoff — a second writer next to Chat. So:
//   - no server/ or scripts/ code calls one of database.js's staged-table writers directly (chat-tables
//     calls them as db[op] while Live writes the table);
//   - SQL that writes a staged table appears only in database.js, inside one of those writers;
//   - chat-tables.OPS lists exactly database.js's writers.
// Schema upkeep (CREATE/ALTER, the one-time emotes_new rebuild) is not a write. Comment lines never count.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { OPS, TABLES } = require('../server/chat/chat-tables');
const T = Object.keys(TABLES).join('|');
const WRITE_SQL = new RegExp(`\\b(INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(${T})\\b`, 'i');
const DIRECT_CALL = new RegExp(`\\bdb\\.(${Object.keys(OPS).join('|')})\\s*\\(`);
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const problems = [];
const writersInDb = new Set();
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let fn = null;
    lines.forEach((line, i) => {
        const def = /^(?:async\s+)?function\s+(\w+)/.exec(line);
        if (def) fn = def[1];
        if (isCommentLine(line)) return;
        if (DIRECT_CALL.test(line)) problems.push(`${rel}:${i + 1} calls database.js directly — use require('../chat/chat-tables').write(): ${line.trim().slice(0, 120)}`);
        if (WRITE_SQL.test(line)) {
            if (rel === path.join('server', 'db', 'database.js') && fn && OPS[fn]) { writersInDb.add(fn); return; }
            problems.push(`${rel}:${i + 1} writes a staged chat table outside database.js's writers (${fn || 'top level'}): ${line.trim().slice(0, 120)}`);
        }
    });
}

try {
    assert.deepStrictEqual(problems, [], `staged-table writes that bypass chat-tables.write():\n  ${problems.join('\n  ')}`);
    // Every writer chat-tables knows exists in database.js and writes SQL there (setChannelAlertSound and
    // upsertChannelModerationSettings write the same table; each has its own SQL).
    const db = require('../server/db/database');
    for (const op of Object.keys(OPS)) assert.strictEqual(typeof db[op], 'function', `database.js exports ${op}`);
    assert.deepStrictEqual([...writersInDb].sort(), Object.keys(OPS).sort(), 'chat-tables.OPS lists exactly the functions that write the staged tables');
    console.log(`chat-tables writers: ${Object.keys(OPS).length} writers, all through chat-tables.write()`);
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
