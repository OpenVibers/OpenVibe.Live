const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// cleanupSession looks the stream up to decide what to tear down, so requiring the WHIP
// handler pulls in the database. Point it at a throwaway file with a real schema BEFORE
// that require: the test used to open whatever data/live.db happened to be in the working
// tree, which passed on a developed checkout and threw "no such table: streams" on a
// fresh one — a property of the machine, not of the code under test.
process.env.DB_PATH = path.join(os.tmpdir(), `ov-whip-cleanup-${process.pid}.db`);
require('../server/db/database').initDb();

const webrtcSFU = require('../server/streaming/webrtc-sfu');
const whipHandler = require('../server/streaming/whip-handler');

const transportClosed = { value: false };
const producerClosed = { value: false };

const mockProducer = {
    close() { producerClosed.value = true; },
};

const mockTransport = {
    close() { transportClosed.value = true; },
};

const room = {
    producers: new Map([['producer-1', { producer: mockProducer, peerId: 'whip-test', transportId: 'transport-1' }]]),
    transports: new Map([['whip-test-transport-1', mockTransport]]),
};

webrtcSFU.rooms.set('stream-1', room);
whipHandler.sessions.set('resource-1', {
    streamId: 1,
    roomId: 'stream-1',
    peerId: 'whip-test',
    transportId: 'transport-1',
    producerIds: ['producer-1'],
    userId: 42,
});

whipHandler.cleanupSession('resource-1');

assert.strictEqual(whipHandler.sessions.has('resource-1'), false, 'session should be removed');
assert.strictEqual(room.producers.has('producer-1'), false, 'producer entry should be removed');
assert.strictEqual(room.transports.has('whip-test-transport-1'), false, 'transport entry should be removed');
assert.strictEqual(producerClosed.value, true, 'producer should be closed');
assert.strictEqual(transportClosed.value, true, 'transport should be closed');

try { fs.unlinkSync(process.env.DB_PATH); } catch { /* */ }
for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* */ } }

console.log('✅ WHIP cleanup session regression test passed');
