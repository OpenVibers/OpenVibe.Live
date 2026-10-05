'use strict';
// Live no longer runs a chat server: DM delivery is OpenVibe.Chat's (chat-delivery.js only carries
// the seam). server/chat/dm.js stays for its tables and the participant/block helpers Live's own
// routes still use — server/index.js ensureTables() and server/streaming/routes.js (call blocking by
// isBlockedEither). This checks those helpers.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tempDbPath = path.join(os.tmpdir(), `openvibelive-dm-leak-${Date.now()}.db`);
process.env.DB_PATH = tempDbPath;

const db = require('../server/db/database');
const dm = require('../server/chat/dm');

async function run() {
    try {
        db.initDb();
        dm.ensureTables();

        const userA = db.createUser({ username: 'accountA', email: null, password_hash: '!test', display_name: 'Account A', stream_key: 'streamA' }).lastInsertRowid;
        const userB = db.createUser({ username: 'accountB', email: null, password_hash: '!test', display_name: 'Account B', stream_key: 'streamB' }).lastInsertRowid;
        const userC = db.createUser({ username: 'accountC', email: null, password_hash: '!test', display_name: 'Account C', stream_key: 'streamC' }).lastInsertRowid;
        const userD = db.createUser({ username: 'accountD', email: null, password_hash: '!test', display_name: 'Account D', stream_key: 'streamD' }).lastInsertRowid;

        const convId = dm.createConversation(userA, [userA, userB, userC], 'Test Group');
        const participants = dm.getParticipants(convId).map(u => u.id).sort((a, b) => a - b);
        assert.deepStrictEqual(participants, [userA, userB, userC]);
        assert(dm.isParticipant(convId, userA), 'userA should be participant');
        assert(dm.isParticipant(convId, userB), 'userB should be participant');
        assert(dm.isParticipant(convId, userC), 'userC should be participant');
        assert(!dm.isParticipant(convId, userD), 'userD should not be a participant');

        // The call routes use these to refuse a ring between users either of whom blocked the other.
        assert.strictEqual(dm.isBlockedEither(userA, userD), false);
        dm.blockUser(userD, userA);
        assert(dm.isBlockedEither(userA, userD), 'a block in either direction counts');
        assert(dm.hasBlocked(userD, userA));
        assert(!dm.hasBlocked(userA, userD), 'blocking stays one-directional in the row');
        dm.unblockUser(userD, userA);
        assert.strictEqual(dm.isBlockedEither(userA, userD), false);

        console.log('✅ DM helpers (participants, blocks) regression test passed');
    } finally {
        try { db.close(); } catch {};
        try { fs.unlinkSync(tempDbPath); } catch {};
    }
}

run().catch((err) => {
    console.error('DM helpers test failed:', err);
    process.exit(1);
});
