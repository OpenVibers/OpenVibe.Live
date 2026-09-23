'use strict';

// Live's legacy vods/clips/pastes tables (and paste_likes, paste_comments) are frozen: OpenVibe.Media
// and OpenVibe.Community own that data now (AGENTS.md, register C-73). No server code may WRITE them
// (step 1), and no server code may READ them either (step 2): every reader asks Media or Community,
// mostly through server/media-proxy/lookups.js. The tables stay only until the drop procedure in
// docs/vods-and-clips.md ("Dropping the frozen tables"), which starts once this test has held in
// production for 30 days.
//
// The VOD/clip `comments` table is frozen for writes too: comments are OpenVibe.Community threads
// (roadmap Wave 5), and the old rows are only read by Community's one-time import.
//
// What counts: SQL text in server/ and scripts/ (.js and .sql) that selects or joins one of the
// frozen tables, or a table registry entry naming one (`table: 'vods'`, the HOME_SERIES shape).
// Schema upkeep is not a read: CREATE/ALTER/PRAGMA table_info lines in database.js and migrations.js
// go away with the tables in the drop procedure. A JS comment line never counts.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FROZEN = ['vods', 'clips', 'pastes', 'paste_likes', 'paste_comments'];
const T = FROZEN.join('|');

// ── writes ──────────────────────────────────────────────────────────────────
const WRITE = new RegExp(`\\b(INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(${T}|comments)\\b`, 'i');
// The only writes allowed are the two guarded one-time visibility backfills that run when the column
// is first added (database.js initDb).
const ALLOWED_WRITES = [
    "UPDATE vods SET visibility = CASE WHEN is_public = 1 THEN 'public' ELSE 'private' END",
    "UPDATE clips SET visibility = CASE WHEN is_public = 1 THEN 'public' ELSE 'unlisted' END",
];

// ── reads ───────────────────────────────────────────────────────────────────
// `FROM vods`, `JOIN clips c`, `FROM "pastes"`, also split over lines inside a template literal.
const READ_SQL = new RegExp(`\\b(FROM|JOIN)\\s+[\`"']?(${T})\\b`, 'gi');
// A table registry that builds its SQL from a name (getHomeStatSeries used `table: 'vods'`).
const READ_REGISTRY = new RegExp(`\\btable\\s*:\\s*[\`"'](${T})[\`"']`, 'g');
// Kept reads: { file, snippet, reason }. Each entry must be documented in docs/vods-and-clips.md and
// have a reason here. There are none: since C-73 step 2, Live reads nothing from these tables.
const ALLOWED_READS = [];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
        else if (e.name.endsWith('.js') || e.name.endsWith('.sql')) out.push(p);
    }
    return out;
}
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Every frozen-table read in one file's text → [{ line, text }]. */
function findReads(src) {
    const lines = src.split('\n');
    const hits = [];
    for (const re of [READ_SQL, READ_REGISTRY]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src))) {
            // The line the table name is on (a match may start with FROM on the line before).
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

// The scanner itself: it has to catch the shapes Live used, and leave schema upkeep alone.
for (const [src, n] of [
    ['db.get(`SELECT COUNT(*) AS c FROM vods WHERE is_public = 1`)', 1],
    ['all(`SELECT c.*\n        FROM clips c\n        JOIN users u ON u.id = c.user_id`)', 1],
    ['get(`SELECT 1 FROM\n  paste_likes WHERE paste_id = ?`)', 1],
    ["all('SELECT s.* FROM streams s LEFT JOIN vods v ON v.stream_id = s.id')", 1],
    ['get(`SELECT * FROM "pastes" WHERE slug = ?`)', 1],
    ["const S = { vods: { table: 'vods', ts: 'created_at' } };", 1],
    ["database.exec('ALTER TABLE vods ADD COLUMN clips_only INTEGER DEFAULT 0');", 0],
    ["database.prepare('PRAGMA table_info(clips)').all();", 0],
    ['CREATE INDEX IF NOT EXISTS idx_vods_user_id ON vods(user_id);', 0],
    ['    // used to read FROM vods here', 0],
    ["all('SELECT * FROM vod_ai_state WHERE vod_id = ?')", 0],
    ["all('SELECT * FROM clip_ai_state')", 0],
]) assert.strictEqual(findReads(src).length, n, `scanner on: ${src}`);

const writes = [];
const reads = [];
const usedAllowances = new Set();
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
        if (!WRITE.test(line) || isCommentLine(line)) return;
        if (ALLOWED_WRITES.some((a) => line.includes(a))) return;
        writes.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    for (const hit of findReads(src)) {
        const ok = ALLOWED_READS.find((a) => a.file === rel && hit.text.includes(a.snippet));
        if (ok) { usedAllowances.add(ok); continue; }
        reads.push(`${rel}:${hit.line}: ${hit.text.slice(0, 120)}`);
    }
}
assert.deepStrictEqual(writes, [], `writes to frozen tables:\n${writes.join('\n')}`);
assert.deepStrictEqual(reads, [], `reads of frozen tables (ask OpenVibe.Media / OpenVibe.Community instead, see server/media-proxy/lookups.js):\n${reads.join('\n')}`);
for (const a of ALLOWED_READS) {
    assert.ok(a.reason && a.reason.length > 20, `allowed read without a reason: ${a.file}`);
    assert.ok(usedAllowances.has(a), `stale allow-list entry (the read is gone, remove it): ${a.file}: ${a.snippet}`);
}
console.log('frozen tables: no writes, no reads — all checks passed');
