'use strict';
/**
 * Chat history reads through one store: a page is the newest rows oldest→newest, a delta is only
 * what a client with a cursor has not seen, and a gap wider than the cap says so instead of
 * silently handing back a slice the client would splice in the wrong place.
 */
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `ov-chat-history-${Date.now()}.db`);
const db = require('../server/db/database');
db.initDb();
const store = require('../server/chat/history-store');

const u = db.run(`INSERT INTO users (username, password_hash, email) VALUES ('alice', 'x', 'a@example.com')`).lastInsertRowid;
const bob = db.run(`INSERT INTO users (username, password_hash, email) VALUES ('bob', 'x', 'b@example.com')`).lastInsertRowid;

const ids = [];
for (let i = 1; i <= 12; i++) {
    const r = db.saveChatMessage({ user_id: u, username: 'alice', message: `m${i}`, stream_id: null, is_global: 1, message_type: 'chat' });
    ids.push(Number(r.lastInsertRowid));
}
// One deleted and one auto-expired row must never come back through either read.
db.run(`UPDATE chat_messages SET is_deleted = 1 WHERE id = ?`, [ids[5]]);
db.run(`UPDATE chat_messages SET auto_delete_at = datetime('now', '-1 minute') WHERE id = ?`, [ids[6]]);
// The global feed is every public room with a source badge, so a channel row belongs in it too.
const chanId = Number(db.saveChatMessage({ user_id: bob, username: 'bob', message: 'channel only', stream_id: null, channel_user_id: bob, message_type: 'chat' }).lastInsertRowid);

// ── page ──────────────────────────────────────────────────────────────────────────────────────
const page = store.page('global', { limit: 5 });
assert.equal(page.messages.length, 5, 'a page is capped by limit');
assert.deepEqual(page.messages.map((m) => m.message), ['m9', 'm10', 'm11', 'm12', 'channel only'], 'newest rows, oldest → newest, all rooms');
assert.equal(page.latest_id, chanId, 'latest_id is the cursor of the newest row');

// ── delta ─────────────────────────────────────────────────────────────────────────────────────
const d = store.delta('global', { afterId: ids[3], limit: 200 });
assert.deepEqual(d.messages.map((m) => m.message), ['m5', 'm8', 'm9', 'm10', 'm11', 'm12', 'channel only'], 'only rows after the cursor; deleted and expired rows skipped');
assert.equal(d.complete, true);
assert.equal(d.latest_id, chanId);

const none = store.delta('global', { afterId: chanId, limit: 200 });
assert.equal(none.messages.length, 0, 'nothing new → empty delta');
assert.equal(none.latest_id, chanId, 'the cursor is handed back unchanged when nothing is new');

const wide = store.delta('global', { afterId: 0, limit: 3 });
assert.equal(wide.complete, false, 'a gap wider than the cap is reported, not silently truncated');
assert.equal(wide.messages.length, 3);

// ── decorate gets copies, memo stays correct across writes ────────────────────────────────────
const seen = [];
store.page('global', { limit: 5, decorate: (rows) => { rows.forEach((r) => { r.touched = true; seen.push(r.id); }); return rows; } });
const again = store.page('global', { limit: 5 });
assert.ok(!again.messages.some((m) => m.touched), 'decorators work on copies; memoised rows are pristine');
db.saveChatMessage({ user_id: u, username: 'alice', message: 'm13', stream_id: null, is_global: 1, message_type: 'chat' });
const after = store.page('global', { limit: 5 });
assert.equal(after.messages[after.messages.length - 1].message, 'm13', 'a new row invalidates the memoised page at once');

// ── channel room ──────────────────────────────────────────────────────────────────────────────
const ch = store.page(`channel:${bob}`, { limit: 10 });
assert.deepEqual(ch.messages.map((m) => m.message), ['channel only']);
const chDelta = store.delta(`channel:${bob}`, { afterId: ch.latest_id, limit: 50 });
assert.equal(chDelta.messages.length, 0);

assert.throws(() => store.page('nope', {}), /unknown room/);

console.log('chat-history-store: ok');
