'use strict';
// Dead air (server/streaming/dead-air.js, 2026-10-23): a stream whose SFU producers receive nothing for the limit ends;
// any change in the byte count (more media, or a new producer starting from 0) restarts the clock; a stream that is
// no longer live is forgotten. And the SFU sums its open producers' received bytes (webrtc-sfu.js producerBytes).
const assert = require('assert');
const { createDeadAir } = require('../server/streaming/dead-air');

(async () => {
    let t = 0;
    const MIN = 60 * 1000;
    const d = createDeadAir({ limitMs: 30 * MIN, now: () => t });
    assert.strictEqual(d.observe(1, 0), false, 'first sight starts the clock');
    t = 29 * MIN;
    assert.strictEqual(d.observe(1, 0), false, 'under the limit');
    t = 30 * MIN;
    assert.strictEqual(d.observe(1, 0), true, 'unchanged for the limit: dead air');
    assert.strictEqual(d.observe(1, 0), false, 'once said, the stream is forgotten (a new clock if it is still there)');

    // Media keeps the stream alive; a new producer (a lower count) is media too.
    t = 0;
    const e = createDeadAir({ limitMs: 30 * MIN, now: () => t });
    e.observe(2, 1000);
    t = 20 * MIN; e.observe(2, 5000);
    t = 45 * MIN; assert.strictEqual(e.observe(2, 5000), false, 'the clock restarted when the count changed at 20 min');
    t = 46 * MIN; e.observe(2, 120);
    t = 75 * MIN; assert.strictEqual(e.observe(2, 120), false, 'a new producer counts as media');
    t = 76 * MIN; assert.strictEqual(e.observe(2, 120), true);

    // A stream that ended is forgotten, so a new stream with its id starts fresh.
    t = 0;
    const f = createDeadAir({ limitMs: 30 * MIN, now: () => t });
    f.observe(3, 0);
    f.keep(new Set());
    t = 31 * MIN;
    assert.strictEqual(f.observe(3, 0), false, 'forgotten when it was no longer live');

    // The SFU's sum over a room's open producers.
    const sfu = require('../server/streaming/webrtc-sfu');
    const producer = (bytes, closed = false) => ({ closed, getStats: async () => [{ byteCount: bytes }] });
    sfu.rooms.set('stream-dead-air-test', { producers: new Map([['a', { producer: producer(700) }], ['b', { producer: producer(300) }], ['c', { producer: producer(5000, true) }]]) });
    assert.strictEqual(await sfu.producerBytes('stream-dead-air-test'), 1000, 'open producers only');
    assert.strictEqual(await sfu.producerBytes('stream-none'), 0, 'no room: 0');
    sfu.rooms.delete('stream-dead-air-test');
    console.log('dead air: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
