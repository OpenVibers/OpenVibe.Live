'use strict';
/**
 * AI viewers wait for a browser stream's first picture or sound (11-28 replay re-measure: streams 3096 and 3097 sent
 * nothing for minutes while twelve AI viewers chatted at an empty page). A webrtc stream with no producer waits, starts
 * on the SFU's first producer-added for its room (not another room's), and stops waiting when the stream stops; RTMP
 * streams and streams that already send media start as before.
 */
const assert = require('assert');
const { EventEmitter } = require('events');

const engine = require('../server/ai/viewers/engine');

function fakeSfu(producers = {}) {
    const sfu = new EventEmitter();
    sfu.findProducerByKind = (room, kind) => producers[`${room}|${kind}`] || null;
    return sfu;
}

(async () => {
    const started = [];
    const realStart = engine.startForStream.bind(engine);
    engine.startForStream = async (stream) => { started.push(stream.id); };
    try {
        // RTMP never waits; a webrtc stream that already sends media never waits.
        assert.strictEqual(engine._waitsForMedia({ id: 1, protocol: 'rtmp' }, fakeSfu()), false);
        assert.strictEqual(engine._waitsForMedia({ id: 2, protocol: 'webrtc' }, fakeSfu({ 'stream-2|video': { id: 'p' } })), false);

        // A webrtc stream with nothing yet waits, once.
        const sfu = fakeSfu();
        assert.strictEqual(engine._waitsForMedia({ id: 3, protocol: 'webrtc' }, sfu), true);
        assert.strictEqual(engine._waitsForMedia({ id: 3, protocol: 'webrtc' }, sfu), true, 'a second call does not add a second listener');
        assert.strictEqual(sfu.listenerCount('producer-added'), 1);
        sfu.emit('producer-added', { roomId: 'stream-99', kind: 'video' });
        assert.deepStrictEqual(started, [], 'another room\'s picture does not start it');
        sfu.emit('producer-added', { roomId: 'stream-3', kind: 'audio' });
        assert.deepStrictEqual(started, [3], 'its first sound starts it');
        assert.strictEqual(sfu.listenerCount('producer-added'), 0, 'and the wait is over');
        assert.strictEqual(engine.waiting.has(3), false);

        // A stream that stops while waiting stops waiting.
        const sfu2 = fakeSfu();
        assert.strictEqual(engine._waitsForMedia({ id: 4, protocol: 'webrtc' }, sfu2), true);
        await engine.stopForStream(4);
        assert.strictEqual(sfu2.listenerCount('producer-added'), 0);
        sfu2.emit('producer-added', { roomId: 'stream-4', kind: 'video' });
        assert.deepStrictEqual(started, [3], 'a stopped stream never starts');
    } finally {
        engine.startForStream = realStart;
    }
    console.log('ai-viewers-wait-media: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
