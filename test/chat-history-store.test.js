'use strict';
/**
 * Live's chat history reads come from OpenVibe.Chat (roadmap T3 J4b: Read Live's chat stats,
 * queues and history from Chat). Live's own history store — the page/delta reads over its copy of
 * chat_messages — went with the read mirror, and the table itself is dropped (007_drop_chat_tables), so nothing
 * keeps a second answer to "what happened in this room?". These checks guard that the dead module
 * stays deleted, and that outside chat mode (dev, drills — Live runs no chat server either way) the
 * read seam answers empty/null rather than any local value.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
assert.ok(!fs.existsSync(path.join(ROOT, 'server', 'chat', 'history-store.js')), 'history-store.js is deleted — history is Chat\'s now');

delete process.env.CHAT_AUTHORITY;   // not chat mode: the seam answers its empty local answers
const db = require('../server/db/database');
const reads = require('../server/chat/chat-reads');

(async () => {
    await db.initDb();
    assert.deepStrictEqual(await reads.userHistory(1, { limit: 50 }), { messages: [], total: 0 }, 'no local user history');
    assert.deepStrictEqual(await reads.channelMessages(1, 10), [], 'no local channel page');
    assert.deepStrictEqual(await reads.searchMessages({ userId: 1, limit: 50 }), { messages: [], total: 0 }, 'no local search');
    assert.strictEqual(await reads.messageById(1), null, 'no local message by id');
    // The dropped tables are not recreated by a boot.
    for (const t of ['chat_messages', 'dm_conversations', 'dm_participants', 'dm_messages', 'dm_blocks', 'tts_voice_overrides',
        'channel_sounds', 'relay_users', 'hidden_relay_users', 'pending_ip_messages', 'stream_first_chats', 'moderation_actions']) {
        assert.ok(!await db.getDb().prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?").get(t), `${t} must not exist`);
    }
    console.log('chat-history-store: ok — Live\'s store is deleted; the read seam answers empty outside chat mode');
})().catch((e) => { console.error(e); process.exit(1); });
