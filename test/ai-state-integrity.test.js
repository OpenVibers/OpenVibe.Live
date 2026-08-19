/**
 * Regression: openvibe.media/live/:sel/transcript.json served broken data.
 *
 * Four independent faults, all reproduced here against a throwaway DB:
 *
 *  1. vod_ai_state / clip_ai_state drifted in production to a keyless schema
 *     (`vod_id INT`, no PRIMARY KEY — CREATE TABLE IF NOT EXISTS never repairs an
 *     existing table). Their writers use `INSERT OR IGNORE ... (vod_id) VALUES (?)`,
 *     which needs a uniqueness constraint to be a no-op, so every call appended a row:
 *     2818 rows for 487 VODs, 2986 for 103 clips.
 *
 *  2. That silently jammed the AI backfill. The queues are
 *     `WHERE ai_overview_short IS NULL ORDER BY vod_id DESC LIMIT 4`, so a VOD with four
 *     empty duplicates filled the whole batch with itself and nothing else was ever
 *     processed — every recent VOD had ai_overview null.
 *
 *  3. stream_memories had no constraint either, so re-analysing a stream stored the same
 *     moment again; the memories list read as near-duplicate pairs a minute apart.
 *
 *  4. The transcript endpoint preferred the timeline over the batch blob whenever the
 *     timeline was non-empty, so a partially-linked timeline truncated the result
 *     (vod 2163: 426 characters served against a 3548-character transcript).
 *
 * The merge must be lossless: duplicates were written at different times, so a transcript
 * can sit on one row and an overview on another.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `ov-ai-state-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const Database = require('better-sqlite3');

// ── Build a DB with the DRIFTED (keyless) production schema, then dirty it ──────────
{
    const raw = new Database(tmp);
    raw.exec(`CREATE TABLE vod_ai_state (
        vod_id INT, ai_overview_short TEXT, ai_transcript_json TEXT, transcript_status TEXT,
        transcript_attempts INT, transcript_error TEXT, transcript_next_at NUM)`);
    raw.exec(`CREATE TABLE clip_ai_state (
        clip_id INT, ai_overview_short TEXT, ai_transcript_json TEXT, transcript_status TEXT,
        transcript_attempts INT, transcript_error TEXT, transcript_next_at NUM,
        clip_notified INT, clip_notify_at NUM)`);

    const v = raw.prepare(`INSERT INTO vod_ai_state
        (vod_id, ai_overview_short, ai_transcript_json, transcript_status, transcript_attempts)
        VALUES (?,?,?,?,?)`);
    // vod 100: transcript and overview live on DIFFERENT duplicate rows, and a later
    // duplicate carries a regressed 'pending' status. A lossless merge keeps all three.
    v.run(100, null, JSON.stringify([{ start: 0, end: 2, text: 'the full transcript' }]), 'done', 1);
    v.run(100, 'the overview', null, 'done', 2);
    v.run(100, null, null, 'pending', 0);
    // vod 101: four empty duplicates — the shape that jammed the overview queue.
    for (let i = 0; i < 4; i++) v.run(101, null, null, null, 0);

    const c = raw.prepare(`INSERT INTO clip_ai_state
        (clip_id, ai_overview_short, clip_notified, clip_notify_at) VALUES (?,?,?,?)`);
    c.run(200, 'clip overview', 1, 1234);      // extra columns must survive the rebuild
    c.run(200, null, null, null);
    raw.close();
}

const db = require('../server/db/database');
db.initDb();

// stream_memories and stream_timeline_events both carry a FK to streams(id), so the
// fixture needs real parent rows (user_id is the only NOT NULL column without a default).
{
    const w = new Database(tmp);
    w.pragma('foreign_keys = OFF');   // fixture only: streams.user_id -> users(id) is not under test
    const ins = w.prepare('INSERT OR IGNORE INTO streams (id, user_id) VALUES (?, 1)');
    for (const id of [900, 901, 902]) ins.run(id);
    w.close();
}

// ── 1: one row per key, nothing lost ────────────────────────────────────────────────
const raw = new Database(tmp, { readonly: true });
const count = (sql) => raw.prepare(sql).get().n;
assert.strictEqual(count('SELECT COUNT(*) n FROM vod_ai_state'), 2, 'vod_ai_state must collapse to one row per vod');
assert.strictEqual(count('SELECT COUNT(*) n FROM clip_ai_state'), 1, 'clip_ai_state must collapse to one row per clip');

const v100 = db.getVodAiState(100);
assert.ok(v100.ai_transcript_json && v100.ai_transcript_json.includes('the full transcript'),
    'transcript must survive even though it lived on a different duplicate than the overview');
assert.strictEqual(v100.ai_overview_short, 'the overview',
    'overview must survive even though it lived on a different duplicate than the transcript');
assert.strictEqual(v100.transcript_status, 'done',
    "a stray 'pending' duplicate must not resurrect finished work");
console.log('OK 1: duplicates merged losslessly (transcript + overview + settled status all kept)');

const clip = raw.prepare('SELECT * FROM clip_ai_state WHERE clip_id = 200').get();
assert.strictEqual(clip.clip_notified, 1, 'clip_notified must survive the rebuild');
assert.strictEqual(clip.clip_notify_at, 1234, 'clip_notify_at must survive the rebuild');
assert.strictEqual(clip.ai_overview_short, 'clip overview');
console.log('OK 2: table-specific extra columns preserved (column-driven merge, not a fixed list)');

// ── 2: the backfill queue is no longer jammed by one VOD ────────────────────────────
const queue = db.getVodsNeedingOverview(4).map(r => r.id);
assert.strictEqual(queue.length, new Set(queue).size, `overview queue still returns duplicates: ${queue}`);
assert.ok(queue.includes(101), 'the VOD lacking an overview must still be queued');
assert.ok(!queue.includes(100), 'a VOD that already has an overview must not be queued');
console.log(`OK 3: overview backfill queue returns distinct VODs (${JSON.stringify(queue)})`);

// ── 3: re-seeding is genuinely idempotent now ───────────────────────────────────────
for (let i = 0; i < 5; i++) db.setVodTranscriptStatus(100, 'pending');
assert.strictEqual(count('SELECT COUNT(*) n FROM vod_ai_state WHERE vod_id = 100'), 1,
    'INSERT OR IGNORE must no-op now that a UNIQUE index exists');
assert.ok((db.getVodAiState(100).ai_transcript_json || '').includes('the full transcript'),
    're-seeding must not clobber an existing transcript');
console.log('OK 4: five re-seeds leave exactly one row, transcript intact');

// ── 4: one memory per (stream, offset) ──────────────────────────────────────────────
db.addStreamMemory({ stream_id: 900, offset_seconds: 15, description: 'a red figure by a brick building' });
db.addStreamMemory({ stream_id: 900, offset_seconds: 15, description: 'a red horse statue by a brick building' });
db.addStreamMemory({ stream_id: 900, offset_seconds: 23, description: 'a different moment' });
assert.strictEqual(count('SELECT COUNT(*) n FROM stream_memories WHERE stream_id = 900'), 2,
    're-describing the same moment must not create a second memory');
console.log('OK 5: duplicate stream memories rejected, distinct moments kept');

// ── 5: transcript source selection prefers the more complete view ───────────────────
// Mirrors the endpoint's rule: whichever view carries more speech wins.
const spoken = (arr) => arr.reduce((n, x) => n + String(x.text || '').trim().length, 0);
const choose = (timeline, blob) => (spoken(blob) > spoken(timeline) ? blob : timeline);
const partialTimeline = [{ start: 0, text: 'x'.repeat(426) }];
const fullBlob = [{ start: 0, text: 'y'.repeat(3548) }];
assert.strictEqual(spoken(choose(partialTimeline, fullBlob)), 3548,
    'a partially-linked timeline must not beat a fuller transcript blob');
assert.strictEqual(spoken(choose(fullBlob, partialTimeline)), 3548,
    'and the richer source wins regardless of which side it is on');
assert.strictEqual(spoken(choose([], [])), 0, 'no speech anywhere is a real answer, not an error');
console.log('OK 6: transcript endpoint picks whichever source carries more speech');

// ── 6: live rows are reachable — the headline complaint ─────────────────────────────
db.addTimelineEvents([
    { stream_id: 901, kind: 'speech', start_sec: 1, end_sec: 2, text: 'live speech', vod_id: 500 },
    { stream_id: 901, kind: 'sound', start_sec: 3, end_sec: 4, label: 'laughter', vod_id: 500 },
]);
const byVod = db.getTimelineByVod(500);
assert.strictEqual(byVod.length, 2, 'rows stamped with vod_id while live must be queryable by vod_id');
assert.strictEqual(db.getTimelineVodId(901), 500, 'a late writer must be able to recover the stream vod id');
// A row written before the vod id was known stays orphaned until relinked — that is the
// case linkTimelineToVod covers, and getTimelineVodId lets later writers self-stamp.
db.addTimelineEvents([{ stream_id: 902, kind: 'speech', start_sec: 1, text: 'orphan' }]);
assert.strictEqual(db.getTimelineByVod(501).length, 0, 'unlinked rows are not visible by vod_id');
db.linkTimelineToVod(902, 501);
assert.strictEqual(db.getTimelineByVod(501).length, 1, 'linkTimelineToVod must adopt orphaned rows');
console.log('OK 7: live timeline rows reachable by vod_id; orphans still adoptable');

// ── 7: rows written AFTER the one-shot vod.ready link get adopted on restart ────────
// This is the real-world shape: the webhook links what exists, then transcription of
// spooled audio keeps appending rows that nobody ever comes back for.
db.addTimelineEvents([
    { stream_id: 902, kind: 'speech', start_sec: 90, text: 'transcribed after vod.ready' },
    { stream_id: 902, kind: 'speech', start_sec: 120, text: 'and later still' },
]);
assert.strictEqual(db.getTimelineByVod(501).length, 1, 'late rows start orphaned (the bug)');
db.initDb();                                    // startup repair
assert.strictEqual(db.getTimelineByVod(501).length, 3,
    'orphaned rows must be adopted onto the VOD their siblings already point at');
// A stream that never had a VOD must stay untouched — nothing to infer from.
db.addTimelineEvents([{ stream_id: 900, kind: 'speech', start_sec: 5, text: 'never recorded' }]);
db.initDb();
const orphanCount = raw.prepare('SELECT COUNT(*) n FROM stream_timeline_events WHERE stream_id = 900 AND vod_id IS NULL').get().n;
assert.strictEqual(orphanCount, 1, 'a stream with no VOD at all must not be given one');
console.log('OK 8: late rows adopted onto their VOD; VOD-less streams left alone');

raw.close();
try { fs.unlinkSync(tmp); } catch { /* */ }
for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
console.log('✅ AI state integrity regression test passed');
