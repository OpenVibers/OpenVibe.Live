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
let streamLookups = 0;
require('../server/db/database').getStreamById = () => { streamLookups++; return null; };

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

// Live ending a stream itself (dead air, a lost heartbeat) closes that stream's sessions, and only those, without
// ending the stream again from here: the caller ends it with its own reason.
(async () => {
    const mk = (sid, id) => {
        const r = webrtcSFU.rooms.get(`stream-${sid}`) || { producers: new Map(), transports: new Map() };
        webrtcSFU.rooms.set(`stream-${sid}`, r);
        r.producers.set(`p-${id}`, { producer: { close() {} }, peerId: `whip-${id}`, transportId: `t-${id}` });
        r.transports.set(`whip-${id}-t-${id}`, { close() {} });
        whipHandler.sessions.set(id, { streamId: sid, roomId: `stream-${sid}`, peerId: `whip-${id}`, transportId: `t-${id}`, producerIds: [`p-${id}`], heartbeatTimer: setInterval(() => {}, 60000) });
    };
    mk(7, 'r7a'); mk(7, 'r7b'); mk(8, 'r8');
    await new Promise((r) => setImmediate(r));
    const before = streamLookups;
    assert.strictEqual(await whipHandler.endSessionsForStream(7, 'dead_air'), 2);
    assert.ok(!whipHandler.sessions.has('r7a') && !whipHandler.sessions.has('r7b'), 'stream 7\'s sessions are closed');
    assert.ok(whipHandler.sessions.has('r8'), 'another stream\'s session stays');
    assert.strictEqual(webrtcSFU.rooms.get('stream-7').transports.size, 0, 'their transports are closed');
    assert.strictEqual(streamLookups, before, 'the stream is the caller\'s to end');
    assert.strictEqual(await whipHandler.endSessionsForStream(9, 'dead_air'), 0, 'a stream with no WHIP session: nothing to do');
    await whipHandler.cleanupSession('r8');
    console.log('✅ WHIP cleanup session regression test passed');
})().catch((err) => { console.error(err); process.exit(1); });
