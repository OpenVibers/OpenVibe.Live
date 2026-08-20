const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// After tearing the session down, cleanupSession asks whether the stream is still live —
// the one thing here that touches the database. It used to reach whatever data/live.db
// sat in the working tree, which passed on a developed checkout and threw "no such table:
// streams" on a fresh one: a property of the machine, not of the code under test.
//
// Stub that single lookup instead of building a schema. Answering "no such stream" ends
// endActiveWhipStream on its first line, which is the path this test wants anyway — what
// it asserts is that the producer, transport and session are released.
process.env.DB_PATH = path.join(os.tmpdir(), `ov-whip-cleanup-${process.pid}.db`);
require('../server/db/database').getStreamById = () => null;

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

for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* */ } }

console.log('✅ WHIP cleanup session regression test passed');
