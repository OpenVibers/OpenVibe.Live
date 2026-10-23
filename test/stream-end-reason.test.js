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

    console.log('stream end reason: first known reason kept');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
