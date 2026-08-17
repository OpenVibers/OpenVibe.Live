const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tempDbPath = path.join(os.tmpdir(), `openvibelive-dm-leak-${Date.now()}.db`);
process.env.DB_PATH = tempDbPath;

const db = require('../server/db/database');
const dm = require('../server/chat/dm');
const chatServer = require('../server/chat/chat-server');

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

        const sent = [];
        const makeWs = (label, userId) => ({
            readyState: 1,
            bufferedAmount: 0,
            send(payload) {
                sent.push({ label, payload, userId });
            },
        });

        const wsA1 = makeWs('A1', userA);
        const wsA2 = makeWs('A2', userA);
        const wsB = makeWs('B', userB);
        const wsD = makeWs('D', userD);

        chatServer.clients.set(wsA1, { user: { id: userA, username: 'accountA' } });
        chatServer.clients.set(wsA2, { user: { id: userA, username: 'accountA' } });
        chatServer.clients.set(wsB, { user: { id: userB, username: 'accountB' } });
        chatServer.clients.set(wsD, { user: { id: userD, username: 'accountD' } });

        chatServer.sendDm(userA, { type: 'dm', conversation_id: convId, message: { id: 1, text: 'hello A' } });
        assert.strictEqual(sent.filter(x => x.label.startsWith('A')).length, 2, 'userA sockets should receive DM');

        chatServer.sendDm(userB, { type: 'dm', conversation_id: convId, message: { id: 2, text: 'hello B' } });
        assert.strictEqual(sent.filter(x => x.label === 'B').length, 1, 'userB should receive DM');

        const beforeCount = sent.length;
        chatServer.sendDm(userD, { type: 'dm', conversation_id: convId, message: { id: 3, text: 'should not deliver' } });
        assert.strictEqual(sent.length, beforeCount, 'non-participant should not receive DM');

        console.log('✅ DM delivery regression test passed');
    } finally {
        try { db.close(); } catch {};
        try { fs.unlinkSync(tempDbPath); } catch {};
    }
}

run().catch((err) => {
    console.error('DM delivery test failed:', err);
    process.exit(1);
});
