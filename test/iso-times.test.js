'use strict';
/**
 * Times leave with their zone (openvibe.design rule 148): Live's SQLite-era text timestamps are UTC
 * but a browser reads `YYYY-MM-DD HH:MM:SS` as local time. The JSON edge renders time fields as ISO
 * 8601 with Z; stored text, cursors and every query that compares it stay unchanged.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/iso-times.test.js
 */
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const { isoTime, normalizeTimes, isoJsonTimes } = require('../server/iso-times');
assert.strictEqual(isoTime('2026-11-12 05:01:02'), '2026-11-12T05:01:02Z');
assert.strictEqual(isoTime('2026-11-12T05:01:02.123Z'), '2026-11-12T05:01:02.123Z', 'ISO with Z is left alone');
assert.strictEqual(isoTime('2026-11-12T05:01:02+02:00'), '2026-11-12T05:01:02+02:00', 'ISO with an offset is left alone');
assert.strictEqual(isoTime('2026-11-12'), '2026-11-12', 'a date is not a time');
assert.strictEqual(isoTime(null), null);
assert.deepStrictEqual(
    normalizeTimes({ id: 1, created_at: '2026-11-12 05:01:02', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12 05:01:02' }, tags: [{ expires_at: '2026-11-12 05:01:02' }] }),
    { id: 1, created_at: '2026-11-12T05:01:02Z', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12T05:01:02Z' }, tags: [{ expires_at: '2026-11-12T05:01:02Z' }] },
    'time-named fields are rendered; body text that looks like a time is not',
);

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const created = await db.createUser({ username: 'zoner', display_name: 'Zoner', stream_key: 'z'.repeat(32) });
    const userId = created.id || created.lastInsertRowid;
    const raw = db.getDb();
    await raw.prepare(`INSERT INTO streams (id, user_id, title, is_live, started_at, created_at) OVERRIDING SYSTEM VALUE
                       VALUES (91, ?, 'Zoned', 1, '2026-10-01 10:00:00', '2026-10-01 10:00:00')`).run(userId);

    const express = require('express');
    const app = express();
    app.use(isoJsonTimes);
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: r.status, json: await r.json() }; };

    const r = await get('/api/streams');
    assert.strictEqual(r.status, 200);
    const stream = (r.json.streams || []).find((s) => s.id === 91);
    assert.ok(stream, 'the live stream is listed');
    assert.strictEqual(stream.started_at, '2026-10-01T10:00:00Z', 'started_at is ISO with Z');
    assert.match(stream.started_at, /Z$/);
    const stored = await raw.prepare('SELECT started_at FROM streams WHERE id = 91').get();
    assert.strictEqual(stored.started_at, '2026-10-01 10:00:00', 'the stored text is untouched');

    server.close();
    try { await globalThis.__ovLiveTestDbClose(); } catch { /* */ }
    console.log = quiet;
    console.log('iso times: helper and GET /api/streams checked');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
