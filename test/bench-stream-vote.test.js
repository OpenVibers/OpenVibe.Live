'use strict';
const assert = require('assert');
const db = require('../server/db/database');
const identity = require('../server/auth/identity-sync');
const service = require('../server/bench-stream/service');

const original = { getStreamById: db.getStreamById, get: db.get, getUserById: db.getUserById,
    run: db.run, tx: db.tx, subjectOf: identity.subjectOf };
const votes = new Set();
const poll = { id: 5, stream_id: 17, streamer_id: 2, status: 'open', closes_at: new Date(Date.now() + 60000).toISOString() };
db.getStreamById = async (id) => id === 17 ? { id: 17, user_id: 2, is_live: 1 } : null;
db.get = async (sql) => sql.includes('live_bench_polls') ? poll : null;
db.getUserById = async (id) => id === 3 || id === 4 ? { id } : null;
identity.subjectOf = async (id) => id === 3 ? 'usr_test' : null;
db.tx = async (fn) => await fn();
db.run = async (sql, params) => {
    if (!sql.includes('INSERT INTO live_bench_votes')) throw new Error('unexpected write');
    const key = `${params[0]}:${params[1]}`;
    if (votes.has(key)) return { changes: 0 };
    votes.add(key);
    return { changes: 1 };
};

(async () => {
    try {
        assert.strictEqual((await service.vote({ streamId: 17, userId: 0, choice: 'left' })).ok, false, 'anonymous viewer');
        assert.strictEqual((await service.vote({ streamId: 17, userId: 2, choice: 'left' })).ok, false, 'streamer');
        assert.strictEqual((await service.vote({ streamId: 17, userId: 4, choice: 'left' })).ok, false, 'no Network identity');
        assert.strictEqual((await service.vote({ streamId: 17, userId: 3, choice: 'left' })).ok, true, 'signed-in viewer');
        assert.strictEqual((await service.vote({ streamId: 17, userId: 3, choice: 'right' })).ok, false, 'second command cannot change vote');
        assert.strictEqual(votes.size, 1);
        poll.closes_at = new Date(Date.now() - 1000).toISOString();
        poll.status = 'closed';
        assert.strictEqual((await service.vote({ streamId: 17, userId: 3, choice: 'tie' })).ok, false, 'late vote');
        console.log('✅ Bench stream votes: signed-in only, streamer excluded, one per viewer, closed deadline');
    } finally {
        Object.assign(db, { getStreamById: original.getStreamById, get: original.get, getUserById: original.getUserById, run: original.run, tx: original.tx });
        identity.subjectOf = original.subjectOf;
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
