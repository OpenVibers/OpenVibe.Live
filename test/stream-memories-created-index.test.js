'use strict';
/**
 * The home hero counts stream_memories in four rolling windows by created_at (server/db/database.js winCount).
 * On the 2026-11-08 production read each of those was a 68 ms sequential scan of the 22 MB table. Migration 0035
 * adds a plain btree; this proves the range filter can use it and still counts the same rows.
 */
const assert = require('assert');

(async () => {
    const db = globalThis.__ovLiveTestDb;
    assert.ok(db, 'the test preload provides the migrated database');

    const indexes = await db.prepare(`SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'stream_memories'`).all();
    assert.ok(indexes.some((r) => r.indexname === 'stream_memories_created_at'), 'migration 0035 created the index');

    await db.prepare(`INSERT INTO users (id, username, password_hash, created_at) OVERRIDING SYSTEM VALUE VALUES (900000, 'index-test', 'x', datetime('now', '-2 days'))`).run();
    await db.prepare(`INSERT INTO streams (id, user_id, title, is_live, created_at) OVERRIDING SYSTEM VALUE VALUES (900001, 900000, 'index test', 0, datetime('now', '-2 days'))`).run();
    await db.prepare(`INSERT INTO stream_memories (stream_id, offset_seconds, description, created_at) VALUES
        (900001, 1, 'recent', datetime('now', '-1 hour')), (900001, 2, 'old', datetime('now', '-40 days'))`).run();

    const n = await db.prepare(`SELECT COUNT(*) AS c FROM stream_memories WHERE created_at >= datetime('now', '-1 day')`).get();
    assert.strictEqual(Number(n.c), 1, 'the day window still counts only the recent memory');

    await db.query('SET enable_seqscan = off');
    const plan = (await db.prepare(`EXPLAIN SELECT COUNT(*) FROM stream_memories WHERE created_at >= datetime('now', '-1 day')`).all())
        .map((r) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /stream_memories_created_at/, plan);
    console.log('ok - the memory window count is an index scan over stream_memories_created_at');
})().catch((err) => { console.error(err); process.exit(1); });
