'use strict';
const assert = require('assert');
const db = require('../server/db/database');
const benchClient = require('../server/bench-stream/bench-client');
const delivery = require('../server/chat/chat-delivery');

const calls = [];
benchClient.client = () => ({
    tasks: { create: async (kind, body, options) => { calls.push(['task', kind, body, options]); return { task: { id: 'btk_test' } }; } },
    rounds: {
        create: async (taskId, body, options) => { calls.push(['round', taskId, body, options]); return { round: { id: 'brd_test' } }; },
        get: async () => ({ round: { status: 'finished', entries: [
            { id: 'bte_first', payload: { reply: 'one' }, error: null },
            { id: 'bte_second', payload: { reply: 'two' }, error: null },
        ] } }),
    },
    judgements: { cast: async (id, body) => { calls.push(['judge', id, body]); return { judgement: { id: 'bju_test' } }; } },
});
delivery.message = async (body) => { calls.push(['line', body.message]); return 1; };
const poll = require('../server/bench-stream/service');

(async () => {
    await db.initDb();
    await db.run(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
        VALUES (31, 'bench_owner', 'Bench Owner', 'bench_owner@test', 'x', 'streamer', '2025-01-01 00:00:00')`);
    await db.run(`INSERT INTO users (id, username, display_name) OVERRIDING SYSTEM VALUE
        VALUES (32, 'bench_one', 'One'), (33, 'bench_two', 'Two'), (34, 'bench_three', 'Three')`);
    for (const id of [31, 32, 33, 34]) {
        await db.run("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)",
            [id, String(id), id === 31 ? 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA' : `usr_01J9AAAAAAAAAAAAAAAAAAAA${id}`]);
    }
    const channel = await db.ensureChannel(31);
    const created = await db.createStream({ user_id: 31, channel_id: channel.id, title: 'Bench live', protocol: 'rtmp' });
    const streamId = Number(created.lastInsertRowid);
    await db.run('UPDATE streams SET is_live = 1 WHERE id = ?', [streamId]);

    const started = await poll.start(31, { kind: 'chat.reply', prompt: 'Answer warmly', durationSeconds: 30 });
    assert.strictEqual(started.status, 'pending');
    assert.deepStrictEqual(calls.slice(0, 2).map((c) => c[0]), ['task', 'round']);
    assert.strictEqual(calls[0][3].actingSubject, 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA');
    assert.strictEqual(calls[1][3].actingSubject, 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA');
    await assert.rejects(() => poll.start(31, { kind: 'chat.reply', prompt: 'Again' }), /Finish the current/);

    let row = await db.get('SELECT * FROM live_bench_polls WHERE round_id = ?', ['brd_test']);
    await poll.advance(row);
    row = await db.get('SELECT * FROM live_bench_polls WHERE round_id = ?', ['brd_test']);
    assert.strictEqual(row.status, 'open');
    assert.strictEqual((await poll.current(31)).entries.length, 2);
    assert.ok(calls.some((c) => c[0] === 'line' && /!1, !2 or !tie/.test(c[1])));

    const votes = await Promise.all([
        poll.vote({ streamId, userId: 32, choice: 'left' }),
        poll.vote({ streamId, userId: 32, choice: 'right' }),
        poll.vote({ streamId, userId: 33, choice: 'left' }),
        poll.vote({ streamId, userId: 34, choice: 'tie' }),
    ]);
    assert.strictEqual(votes.filter((v) => v.ok).length, 3, 'a concurrent duplicate is not counted');
    assert.strictEqual((await poll.vote({ streamId, userId: 31, choice: 'right' })).ok, false);

    await db.run("UPDATE live_bench_polls SET closes_at = now() - interval '1 second' WHERE id = ?", [row.id]);
    row = await db.get('SELECT * FROM live_bench_polls WHERE id = ?', [row.id]);
    await poll.advance(row);
    const closed = await db.get('SELECT * FROM live_bench_polls WHERE id = ?', [row.id]);
    assert.strictEqual(closed.status, 'closed');
    assert.deepStrictEqual(calls.find((c) => c[0] === 'judge')[2].vote_counts, { left: 2, right: 0, tie: 1, voters: 3 });
    assert.strictEqual(calls.find((c) => c[0] === 'judge')[2].outcome, 'left');
    assert.ok(calls.some((c) => c[0] === 'line' && /1 wins.*3 voters/.test(c[1])));
    await poll.advance(closed);
    assert.strictEqual(calls.filter((c) => c[0] === 'judge').length, 1);
    console.log('✅ Bench stream round: creates task, opens chat vote, closes and records one service judgement');
})().catch((err) => { console.error(err); process.exitCode = 1; });
