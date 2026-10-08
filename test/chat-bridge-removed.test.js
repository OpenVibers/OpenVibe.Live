'use strict';

// T3 J2: Live delivers to OpenVibe.Chat through its typed ingress only (server/chat/chat-delivery.js).
// The old ordered-calls bridge (chat-remote.js, POST /internal/live/calls) is gone, nothing under server/
// reads or writes its outbox (only the operator migration that drops it names the table), and the drop
// (scripts/chat-bridge-outbox-drop.js → op_002_drop_chat_bridge_outbox) delivers queued chat writes to
// Chat first and refuses while any remain, so a write the old release queued is never lost.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

// 1. Static guard: no reader or writer of the outbox, no bridge, no flag.
const offenders = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const rel = path.relative(ROOT, p);
        const src = fs.readFileSync(p, 'utf8');
        if (/chat_bridge_outbox/i.test(src) && rel !== path.join('server', 'db', 'migrations.js')) offenders.push(`${rel}: chat_bridge_outbox`);
        if (/chat-remote/.test(src)) offenders.push(`${rel}: chat-remote`);
        if (/\/internal\/live\/(calls|presence)/.test(src)) offenders.push(`${rel}: the old bridge endpoints`);
        if (/LIVE_CHAT_INGRESS/.test(src)) offenders.push(`${rel}: LIVE_CHAT_INGRESS (retired: CHAT_AUTHORITY=chat is the ingress)`);
    }
})(path.join(ROOT, 'server'));
assert.deepStrictEqual(offenders, [], `server/ still uses the old chat bridge:\n${offenders.join('\n')}`);
assert.ok(!fs.existsSync(path.join(ROOT, 'server', 'chat', 'chat-remote.js')), 'chat-remote.js is deleted');

// 2. The drop is an operator step, never run at boot.
const migrations = require('../server/db/migrations');
const drop = require('../scripts/chat-bridge-outbox-drop');
assert.ok(!migrations.MIGRATIONS.some((m) => m.id === drop.ID), 'not a boot migration');
assert.ok(migrations.OPERATOR_MIGRATIONS.some((m) => m.id === drop.ID), 'an operator migration');

(async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE chat_bridge_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, boot TEXT NOT NULL, ref INTEGER, op TEXT NOT NULL, args TEXT NOT NULL,
        created_at DATETIME DEFAULT ov_now())`);
    const put = db.prepare('INSERT INTO chat_bridge_outbox (boot, ref, op, args) VALUES (?, ?, ?, ?)');
    put.run('boot-a', -(2 ** 40) - 1, 'db', JSON.stringify(['saveChatMessage', { stream_id: 1, message: 'queued' }]));
    put.run('boot-a', null, 'db', JSON.stringify(['deleteChatMessage', 5, 2]));
    put.run('boot-b', null, 'deployNotice', JSON.stringify([[{ hash: 'abc' }]]));
    put.run('boot-b', null, 'db', JSON.stringify(['recordFirstChat', 'user:9', 1]));
    assert.deepStrictEqual(drop.counts(db), { exists: true, total: 4, writes: 3, byOp: { db: 3, deployNotice: 1 }, boots: 2 });

    // 3. Unacknowledged chat writes: the drop refuses and keeps the table.
    let res = migrations.runOperator(db, drop.ID);
    assert.strictEqual(res.outcome, 'failed');
    assert.match(res.error, /3 chat write/);
    assert.strictEqual(drop.counts(db).total, 4, 'rolled back, nothing lost');

    // 4. Chat down: delivery stops, nothing is deleted.
    const sent = [];
    const down = async () => { const err = new Error('Chat 503'); err.status = 503; throw err; };
    let r = await drop.deliver(db, down);
    assert.strictEqual(r.delivered, 0);
    assert.strictEqual(r.error, 'Chat 503');
    assert.strictEqual(drop.counts(db).total, 4);

    // 5. Chat up: rows go in order, one boot per request, each with its idempotency key; Chat refuses one.
    const up = async (p, body) => {
        assert.strictEqual(p, '/internal/live/calls');
        sent.push(body);
        return { ok: true, results: body.ops.map((o) => ({ seq: o.seq, ok: o.op !== 'deployNotice', error: o.op === 'deployNotice' ? 'nope' : undefined })) };
    };
    r = await drop.deliver(db, up);
    assert.deepStrictEqual(sent.map((b) => [b.boot, b.ops.map((o) => o.op)]), [['boot-a', ['db', 'db']], ['boot-b', ['deployNotice', 'db']]]);
    assert.deepStrictEqual(sent.flatMap((b) => b.ops.map((o) => o.key)), ['live:1', 'live:2', 'live:3', 'live:4']);
    assert.strictEqual(sent[0].ops[0].ref, -(2 ** 40) - 1, 'the placeholder ref Chat maps');
    assert.strictEqual(r.delivered, 3);
    assert.deepStrictEqual(r.refused, [3], 'a refused row is left for the operator');
    assert.deepStrictEqual(drop.counts(db), { exists: true, total: 1, writes: 0, byOp: { deployNotice: 1 }, boots: 1 });

    // 5b. A whole batch refused (400) is retried row by row; an unparseable row is reported once.
    const db2 = new Database(':memory:');
    db2.exec(`CREATE TABLE chat_bridge_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, boot TEXT NOT NULL, ref INTEGER, op TEXT NOT NULL, args TEXT NOT NULL,
        created_at DATETIME DEFAULT ov_now())`);
    const put2 = db2.prepare('INSERT INTO chat_bridge_outbox (boot, ref, op, args) VALUES (?, ?, ?, ?)');
    put2.run('boot-c', null, 'db', '{not json');
    put2.run('boot-c', null, 'db', JSON.stringify(['recordFirstChat', 'user:1', 1]));
    put2.run('boot-c', null, 'db', JSON.stringify(['recordFirstChat', 'user:2', 1]));
    const picky = async (p, body) => {
        if (body.ops.length > 1) { const err = new Error('too big'); err.status = 413; throw err; }
        return { ok: true, results: body.ops.map((o) => ({ seq: o.seq, ok: true })) };
    };
    r = await drop.deliver(db2, picky);
    assert.strictEqual(r.delivered, 2);
    assert.deepStrictEqual(r.refused, [1], 'each refused id appears once');
    db2.close();

    // 6. No chat write left: the drop applies once.
    res = migrations.runOperator(db, drop.ID);
    assert.strictEqual(res.outcome, 'applied');
    assert.strictEqual(drop.counts(db).exists, false);
    assert.strictEqual(migrations.runOperator(db, drop.ID).outcome, 'already');
    db.close();

    console.log('chat bridge removed: no outbox reader or writer under server/; the operator drop delivers queued writes first and refuses while any remain — all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
