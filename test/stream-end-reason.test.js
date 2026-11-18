'use strict';
// Why a stream ended (streams.end_reason, migration 0014; plan 2026-10-22 track C2): db.endStream(id, reason) records the
// first known reason, a later end keeps it, and an unknown reason records nothing.
const assert = require('assert');
const db = require('../server/db/database');

(async () => {
    await db.initDb();
    const user = (await db.createUser({ username: 'endreason', email: 'endreason@x', password_hash: 'x', display_name: 'endreason', stream_key: 'endreason'.padEnd(32, '0') })).lastInsertRowid
        || (await db.get('SELECT id FROM users WHERE username = ?', ['endreason'])).id;
    const mk = async () => Number((await db.run(`INSERT INTO streams (user_id, title, protocol, is_live, started_at) VALUES (?, 't', 'webrtc', 1, ov_now()) RETURNING id`, [user])).lastInsertRowid);
    const reasonOf = async (id) => (await db.get('SELECT end_reason, is_live FROM streams WHERE id = ?', [id]));

    const a = await mk();
    await db.endStream(a, 'broadcaster_left');
    assert.deepStrictEqual(await reasonOf(a), { end_reason: 'broadcaster_left', is_live: 0 });
    await db.endStream(a, 'heartbeat_lost');
    assert.strictEqual((await reasonOf(a)).end_reason, 'broadcaster_left', 'the first reason stays');

    const b = await mk();
    await db.endStream(b, 'something made up');
    assert.strictEqual((await reasonOf(b)).end_reason, null, 'an unknown reason records nothing');
    await db.endStream(b, 'staff');
    assert.strictEqual((await reasonOf(b)).end_reason, 'staff', 'a known reason fills an empty one');

    const c = await mk();
    await db.endStream(c);
    assert.strictEqual((await reasonOf(c)).end_reason, null, 'an end path that names none records none');

    // A lost heartbeat ends the stream when the heartbeat stopped, not when the sweep noticed (2026-11-18).
    const d = Number((await db.run(`INSERT INTO streams (user_id, title, protocol, is_live, started_at, last_heartbeat) VALUES (?, 't', 'webrtc', 1, '2026-11-18 15:20:19', '2026-11-18 15:22:14') RETURNING id`, [user])).lastInsertRowid);
    await db.endStream(d, 'heartbeat_lost');
    const row = await db.get('SELECT ended_at, duration_seconds FROM streams WHERE id = ?', [d]);
    assert.deepStrictEqual([row.ended_at, Number(row.duration_seconds)], ['2026-11-18 15:22:14', 115], 'ended at its last heartbeat');
    // Any other reason ends it now, and a heartbeat from before the start is not used.
    const e = Number((await db.run(`INSERT INTO streams (user_id, title, protocol, is_live, started_at, last_heartbeat) VALUES (?, 't', 'webrtc', 1, ov_now(), '2000-01-01 00:00:00') RETURNING id`, [user])).lastInsertRowid);
    await db.endStream(e, 'heartbeat_lost');
    assert.ok(Number((await db.get('SELECT duration_seconds FROM streams WHERE id = ?', [e])).duration_seconds) >= 0, 'never before its start');

    // An encoder that left a grace ago (rtmp-server.js): ended at its last heartbeat too, with its own reason.
    const f = Number((await db.run(`INSERT INTO streams (user_id, title, protocol, is_live, started_at, last_heartbeat) VALUES (?, 't', 'rtmp', 1, '2026-11-18 19:20:15', '2026-11-18 19:32:08') RETURNING id`, [user])).lastInsertRowid);
    await db.endStream(f, 'ingest_ended', { atLastHeartbeat: true });
    const fr = await db.get('SELECT ended_at, duration_seconds, end_reason FROM streams WHERE id = ?', [f]);
    assert.deepStrictEqual([fr.ended_at, Number(fr.duration_seconds), fr.end_reason], ['2026-11-18 19:32:08', 713, 'ingest_ended']);

    // Ended once: a second end keeps its end time and length, and only fills a missing reason.
    const g = Number((await db.run(`INSERT INTO streams (user_id, title, protocol, is_live, started_at, last_heartbeat) VALUES (?, 't', 'rtmp', 1, '2026-11-18 10:00:00', '2026-11-18 10:30:00') RETURNING id`, [user])).lastInsertRowid);
    await db.endStream(g, null, { atLastHeartbeat: true });
    const first = await db.get('SELECT ended_at, duration_seconds, end_reason FROM streams WHERE id = ?', [g]);
    assert.deepStrictEqual([first.ended_at, Number(first.duration_seconds), first.end_reason], ['2026-11-18 10:30:00', 1800, null]);
    await db.endStream(g, 'heartbeat_lost');
    const again = await db.get('SELECT ended_at, duration_seconds, end_reason, is_live FROM streams WHERE id = ?', [g]);
    assert.deepStrictEqual([again.ended_at, Number(again.duration_seconds), again.end_reason, again.is_live], ['2026-11-18 10:30:00', 1800, 'heartbeat_lost', 0],
        'a second end keeps when it ended and fills the missing reason');

    console.log('stream end reason: first known reason kept; a lost heartbeat ends at the last heartbeat; ended once');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
