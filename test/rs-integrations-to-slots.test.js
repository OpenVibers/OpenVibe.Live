/**
 * scripts/rs-integrations-to-slots.js moves account-level RobotStreamer rows (no managed_stream_id;
 * 5 of 8 in production) onto stream slots before Live stops reading them. Dry run by default;
 * binds a row to the user's only slot or to the one slot with RobotStreamer on it (its own row
 * for the same robot, or mirrored RobotStreamer chat on its streams); reports ambiguous rows and
 * leaves them; --assign decides one; --apply needs --backup and writes a journal; --rollback
 * undoes exactly the journal.
 *
 *   node test/rs-integrations-to-slots.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-rs-slot-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

const addUser = (id, name) => raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'streamer')`).run(id, name, name, `${name}@x`);
const slot = (userId, slug) => Number(db.createManagedStream({ user_id: userId, slug, title: slug, stream_key: `key-${userId}-${slug}` }).lastInsertRowid);
const rsRow = (userId, slotId, fields = {}) => Number(raw.prepare(
    `INSERT INTO robotstreamer_integrations (user_id, managed_stream_id, enabled, token, robot_id, stream_name, chat_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, slotId, fields.enabled ?? 1, fields.token ?? 'tok', fields.robot_id ?? null, fields.stream_name ?? null, 'wss://chat.example').lastInsertRowid);
const rowById = (id) => raw.prepare('SELECT * FROM robotstreamer_integrations WHERE id = ?').get(id);

// 1: three slots (like production's user 1: slots 1/60/85), an enabled account-level row, robot 777
//    also configured on slot "second" -> superseded there.
addUser(1, 'alex');
const a1 = slot(1, 'main'), a2 = slot(1, 'second'), a3 = slot(1, 'third');
const r1 = rsRow(1, null, { robot_id: '777', stream_name: 'Robot' });
const r1slot = rsRow(1, a2, { robot_id: '777' });
// 2: one slot -> bind there.
addUser(2, 'solo');
const b1 = slot(2, 'only');
const r2 = rsRow(2, null, { robot_id: '42' });
// 3: two slots, nothing points either way -> ambiguous.
addUser(3, 'twoslots');
const c1 = slot(3, 'one'), c2 = slot(3, 'two');
const r3 = rsRow(3, null, { robot_id: '5', enabled: 0 });
// 4: no slot at all -> ambiguous.
addUser(4, 'noslot');
const r4 = rsRow(4, null, { robot_id: '9', enabled: 0 });
// 5: two slots, RobotStreamer chat mirrored on one of them -> bind there.
addUser(5, 'dests');
const e1 = slot(5, 'x'), e2 = slot(5, 'y');
const r5 = rsRow(5, null, { robot_id: '11' });
// Its streams on slot y carried mirrored RobotStreamer chat: the account-level row was serving y.
const e2stream = Number(db.createStream({ user_id: 5, managed_stream_id: e2, title: 'y', protocol: 'webrtc' }).lastInsertRowid);
db.endStream(e2stream);
db.saveChatMessage({ stream_id: e2stream, username: '[RS] fan', message: 'hi', source_platform: 'rs' });
db.saveChatMessage({ stream_id: e2stream, username: '[RS] fan', message: 'again', source_platform: 'rs' });
// User 3's slot "one" was live with native chat only: that is no RobotStreamer evidence.
const s1 = Number(db.createStream({ user_id: 3, managed_stream_id: c1, title: 'c1', protocol: 'webrtc' }).lastInsertRowid);
db.endStream(s1);
db.saveChatMessage({ stream_id: s1, username: 'viewer', message: 'native chat is no evidence' });

const script = require('../scripts/rs-integrations-to-slots');
const out = [];
const log = (line) => out.push(String(line));
const run = async (...args) => { out.length = 0; const code = await script.main(['--db', process.env.DB_PATH, ...args], log); return { code, text: out.join('\n') }; };

(async () => {
    // ── Script: dry run ─────────────────────────────────────────────────────────────
    const before = raw.prepare('SELECT * FROM robotstreamer_integrations ORDER BY id').all();
    let res = await run();
    assert.strictEqual(res.code, 0);
    assert.deepStrictEqual(raw.prepare('SELECT * FROM robotstreamer_integrations ORDER BY id').all(), before, 'the dry run changes nothing');
    assert.ok(!/tok\b/.test(res.text.replace(/token=(yes|no)/g, '')), 'tokens are never printed');
    const { items } = script.plan(raw);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.deepStrictEqual([byId[r1].action, byId[r1].slot_id], ['superseded', a2], 'user 1: slot "second" already carries robot 777');
    assert.deepStrictEqual([byId[r2].action, byId[r2].slot_id], ['bind', b1], 'user 2: the only slot');
    assert.strictEqual(byId[r3].action, 'ambiguous', 'user 3: two slots, no signal');
    assert.match(byId[r3].reason, /none has RobotStreamer on it/);
    assert.ok(byId[r3].slots.find((x) => x.id === c1).last_live, 'the report carries each slot\'s last live time');
    assert.strictEqual(byId[r4].action, 'ambiguous', 'user 4: no slot');
    assert.deepStrictEqual([byId[r5].action, byId[r5].slot_id], ['bind', e2], 'user 5: the one slot whose streams carried RobotStreamer chat');
    assert.strictEqual(byId[r5].slots.find((x) => x.id === e2).rs_chat_messages, 2);
    assert.match(res.text, /ambiguous 2/);

    // --apply without --backup is refused; bad --assign is refused before anything changes.
    await assert.rejects(run('--apply'), /--backup/);
    res = await run('--assign', `${r3}=${a1}`);
    assert.strictEqual(res.code, 1, 'assigning another user\'s slot is an error');
    res = await run('--assign', `${r1}=${a2}`);
    assert.strictEqual(res.code, 1, 'assigning a slot that already has a row is an error');

    // ── Script: apply with a decision for row 3 ─────────────────────────────────────
    const backup = path.join(tmp, 'before.db');
    res = await run('--apply', '--backup', backup, '--assign', `${r3}=${c2}`);
    assert.strictEqual(res.code, 0, res.text);
    assert.ok(fs.existsSync(backup), 'the online backup was written');
    const journalPath = `${backup}.journal.json`;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.deepStrictEqual(journal.changes.map((c) => [c.id, c.action, c.to]).sort(), [[r2, 'bind', b1], [r3, 'bind', c2], [r5, 'bind', e2]].sort());
    assert.strictEqual(rowById(r2).managed_stream_id, b1);
    assert.strictEqual(rowById(r3).managed_stream_id, c2);
    assert.strictEqual(rowById(r5).managed_stream_id, e2);
    assert.strictEqual(rowById(r1).managed_stream_id, null, 'superseded rows are left alone by default');
    assert.strictEqual(rowById(r4).managed_stream_id, null, 'ambiguous rows are left alone');
    assert.strictEqual(db.getRobotStreamerIntegrationBySlot(2, b1).id, r2, 'the moved row is now its slot\'s row');
    await assert.rejects(run('--apply', '--backup', backup), /already exists/, 'a backup file is never overwritten');

    // Rerun: idempotent (only the rows still at account level remain).
    res = await run();
    assert.match(res.text, /account-level RobotStreamer rows: 2/);

    // ── Rollback ────────────────────────────────────────────────────────────────────
    res = await run('--rollback', journalPath);
    assert.strictEqual(rowById(r2).managed_stream_id, b1, 'the rollback dry run changes nothing');
    res = await run('--rollback', journalPath, '--apply', '--backup', path.join(tmp, 'before-rollback.db'));
    assert.strictEqual(res.code, 0, res.text);
    for (const id of [r2, r3, r5]) assert.strictEqual(rowById(id).managed_stream_id, null, `row ${id} is account-level again`);

    // ── --drop-superseded deletes (journaled) and the rollback re-inserts ───────────
    const full = rowById(r1);
    res = await run('--apply', '--backup', path.join(tmp, 'drop.db'), '--drop-superseded');
    assert.strictEqual(res.code, 0, res.text);
    assert.strictEqual(rowById(r1), undefined, 'the superseded row was dropped');
    res = await run('--rollback', path.join(tmp, 'drop.db.journal.json'), '--apply', '--backup', path.join(tmp, 'drop-undo.db'));
    assert.strictEqual(res.code, 0, res.text);
    assert.deepStrictEqual(rowById(r1), full, 'the rollback re-inserts the dropped row exactly');
    assert.strictEqual(rowById(r2).managed_stream_id, null, 'and unbinds what that run bound');

    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('rs-integrations-to-slots: ok');
    process.exit(0);
})().catch((err) => {
    quiet(err);
    process.exit(1);
});
