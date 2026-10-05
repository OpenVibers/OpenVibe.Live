'use strict';
/**
 * Live's chat history reads now come from OpenVibe.Chat (roadmap T3 J4b: Read Live's chat stats,
 * queues and history from Chat). Live's own history store — the page/delta reads over its copy of
 * chat_messages — is gone with the read mirror, so nothing keeps a second answer to "what happened
 * in this room?". These checks guard that the dead module stays deleted, and that the replacement
 * (server/chat/chat-reads.js) answers history from Live's own tables while Live runs chat itself
 * (the rollback / dev path) with the same rules: deleted and auto-expired rows never come back.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
assert.ok(!fs.existsSync(path.join(ROOT, 'server', 'chat', 'history-store.js')), 'history-store.js is deleted — history is Chat\'s now');

process.env.DB_PATH = path.join(os.tmpdir(), `ov-chat-history-${Date.now()}.db`);
delete process.env.CHAT_AUTHORITY;   // Live runs chat itself: chat-reads answers from Live's tables
const db = require('../server/db/database');
db.initDb();
const reads = require('../server/chat/chat-reads');

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
// A channel room row (channel_user_id set) belongs to its channel's history.
const chanId = Number(db.saveChatMessage({ user_id: bob, username: 'bob', message: 'channel only', stream_id: null, channel_user_id: bob, message_type: 'chat' }).lastInsertRowid);

(async () => {
    // A user's site-wide history (deleted and auto-expired rows never come back). The rows share a
    // timestamp here, so compare as a set.
    const hist = await reads.userHistory(u, { limit: 50 });
    assert.deepStrictEqual(hist.messages.map((m) => m.message).sort(), ['m1', 'm10', 'm11', 'm12', 'm2', 'm3', 'm4', 'm5', 'm8', 'm9'], 'user history, no deleted/expired rows');
    assert.ok(hist.total >= hist.messages.length, 'a total is reported for paging');

    // A channel's recent lines, oldest→newest — what an AI viewer's prompt sees.
    const ch = await reads.channelMessages(bob, 10);
    assert.deepEqual(ch.map((m) => m.message), ['channel only'], 'only the channel room, oldest → newest');
    assert.strictEqual(ch[ch.length - 1].id, chanId);

    // A chat search by user id (the admin console), same rows.
    const search = await reads.searchMessages({ userId: u, limit: 50 });
    assert.strictEqual(search.messages.length, hist.messages.length, 'search by user id matches the history');

    // One message by id (the moderation delete path).
    const one = await reads.messageById(ids[0]);
    assert.strictEqual(one.message, 'm1');
    assert.strictEqual(await reads.messageById(10 ** 9), null, 'an unknown id is null');

    console.log('chat-history-store: ok — Live\'s store is deleted; chat-reads answers history in local mode');
})().catch((e) => { console.error(e); process.exit(1); });
