'use strict';

// A broadcaster whose network changes produces again on a new transport while the old producers stay open on the dead
// one (2026-10-22, stream 2697: three recording parts and the transcript read the dead producer). findProducerByKind,
// which the recorder, speech capture, restreams and live thumbnails use, picks the newest transport whose ICE is up;
// within one transport the first producer still wins (a screen share next to the camera does not replace it).

const assert = require('assert');
const sfu = require('../server/streaming/webrtc-sfu');

const producer = (kind, closed = false) => ({ kind, closed });
function room(transports, producers) {
    return {
        transports: new Map(transports.map(([key, iceState]) => [key, { iceState }])),
        producers: new Map(producers.map(([id, kind, transportId, closed]) => [id, { producer: producer(kind, closed), peerId: 'b', transportId }])),
    };
}
const pick = (r, kind) => { sfu.rooms.set('stream-1', r); try { return (sfu.findProducerByKind('stream-1', kind) || {}).id || null; } finally { sfu.rooms.delete('stream-1'); } };

// The 2697 shape: the first transport's ICE dropped, the phone produced again on a second one.
assert.strictEqual(pick(room([['b-t1', 'disconnected'], ['b-t2', 'connected']],
    [['v1', 'video', 't1'], ['a1', 'audio', 't1'], ['v2', 'video', 't2'], ['a2', 'audio', 't2']]), 'audio'), 'a2', 'audio from the live transport');
assert.strictEqual(pick(room([['b-t1', 'disconnected'], ['b-t2', 'connected']],
    [['v1', 'video', 't1'], ['a1', 'audio', 't1'], ['v2', 'video', 't2'], ['a2', 'audio', 't2']]), 'video'), 'v2', 'video from the live transport');

// Video re-produced first (the recorder rolls on it); the new audio is not there yet: the newest transport still wins
// over a dead one once it has audio, and until then the only audio is the old one.
assert.strictEqual(pick(room([['b-t1', 'disconnected'], ['b-t2', 'connected']], [['v1', 'video', 't1'], ['a1', 'audio', 't1'], ['v2', 'video', 't2']]), 'audio'), 'a1');

// A new transport still connecting does not displace a healthy one.
assert.strictEqual(pick(room([['b-t1', 'connected'], ['b-t2', 'new']], [['a1', 'audio', 't1'], ['a2', 'audio', 't2']]), 'audio'), 'a1');

// No transport is healthy (both reconnecting): the newest one.
assert.strictEqual(pick(room([['b-t1', 'disconnected'], ['b-t2', 'checking']], [['a1', 'audio', 't1'], ['a2', 'audio', 't2']]), 'audio'), 'a2');

// A screen share on the same transport as the camera: the camera (first) stays the recorded video.
assert.strictEqual(pick(room([['b-t1', 'completed']], [['cam', 'video', 't1'], ['screen', 'video', 't1']]), 'video'), 'cam');

// Closed producers never count; nothing open → null.
assert.strictEqual(pick(room([['b-t1', 'connected'], ['b-t2', 'connected']], [['a1', 'audio', 't1'], ['a2', 'audio', 't2', true]]), 'audio'), 'a1');
assert.strictEqual(pick(room([['b-t1', 'connected']], [['a1', 'audio', 't1', true]]), 'audio'), null);
assert.strictEqual(sfu.findProducerByKind('stream-404', 'audio'), null);

// waitForProducer resolves with the same choice when a producer already exists.
(async () => {
    sfu.rooms.set('stream-2', room([['b-t1', 'disconnected'], ['b-t2', 'connected']], [['a1', 'audio', 't1'], ['a2', 'audio', 't2']]));
    assert.strictEqual((await sfu.waitForProducer('stream-2', 'audio', 10)).id, 'a2');
    sfu.rooms.delete('stream-2');
    console.log('sfu producer pick: the newest healthy transport wins; same-transport extras and closed producers do not');
})().catch((err) => { console.error(err); process.exit(1); });
