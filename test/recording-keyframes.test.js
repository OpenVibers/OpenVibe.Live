'use strict';
// A WebRTC recording keeps asking the broadcaster for keyframes (server/streaming/webrtc-sfu.js createPlainConsumer,
// keyframeEverySec; the recorder passes VOD_KEYFRAME_SEC). Stream 2795 (2026-10-26) went 100 s between keyframes, so
// the growing recording lagged live by as much: a live clip of the last 30 s was cut 80 s short of the moment.
// - With keyframeEverySec the consumer is asked again and again, and closing it stops the asking.
// - Without it (AI audio, thumbnails, restreams) only the start-up burst is sent.
// - The recorder's interval: 4 s by default, VOD_KEYFRAME_SEC overrides, 0 turns it off, an empty value is the default.

const assert = require('assert');
const sfu = require('../server/streaming/webrtc-sfu');
const StreamRecorder = require('../server/streaming/recorder').constructor;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function room() {
    let n = 0;
    const consumers = [];
    const r = {
        transports: new Map(), consumers: new Map(), plainRecordingTimers: new Map(), plainRecordingTransportConsumers: new Map(),
        router: {
            rtpCapabilities: { codecs: [] },
            createPlainTransport: async () => {
                const t = { id: `t${++n}`, closed: false, handlers: {}, connect: async () => {}, close() { this.closed = true; (this.handlers.close || []).forEach((f) => f()); } };
                t.consume = async () => {
                    const c = { id: `c${n}`, kind: 'video', closed: false, keyframes: 0, handlers: {},
                        rtpParameters: { codecs: [{ payloadType: 102, clockRate: 90000, mimeType: 'video/H264' }], encodings: [{ ssrc: 1 }] },
                        on(ev, f) { (this.handlers[ev] = this.handlers[ev] || []).push(f); },
                        async requestKeyFrame() { this.keyframes++; } };
                    consumers.push(c);
                    return c;
                };
                return t;
            },
        },
    };
    return { r, consumers };
}

(async () => {
    // Asked steadily while it lives; nothing more after it closes.
    {
        const { r, consumers } = room();
        sfu.rooms.set('stream-90', r);
        const info = await sfu.createPlainConsumer('stream-90', 'video-1', '127.0.0.1', 12000, 12001, { keyframeEverySec: 0.05 });
        const c = consumers[0];
        await wait(3200);                          // the start-up burst (0, 0.5, 1.5, 3 s) is over
        const afterBurst = c.keyframes;
        assert.ok(afterBurst >= 4 + 20, `the recording consumer is asked steadily (got ${afterBurst})`);
        sfu.closePlainConsumer('stream-90', info.transportId);
        const atClose = c.keyframes;
        await wait(200);
        assert.strictEqual(c.keyframes, atClose, 'closing the consumer stops the requests');
        assert.ok(!r.plainRecordingTimers.size, 'no timers are left behind');
        sfu.rooms.delete('stream-90');
    }

    // Other plain consumers keep the start-up burst only.
    {
        const { r, consumers } = room();
        sfu.rooms.set('stream-91', r);
        const info = await sfu.createPlainConsumer('stream-91', 'video-1', '127.0.0.1', 12010, 12011);
        await wait(3200);
        assert.strictEqual(consumers[0].keyframes, 4, 'a consumer without the option gets the four start-up requests');
        sfu.closePlainConsumer('stream-91', info.transportId);
        sfu.rooms.delete('stream-91');
    }

    // The recorder's interval.
    const env = process.env.VOD_KEYFRAME_SEC;
    delete process.env.VOD_KEYFRAME_SEC;
    assert.strictEqual(StreamRecorder.KEYFRAME_SEC, 4);
    process.env.VOD_KEYFRAME_SEC = '';
    assert.strictEqual(StreamRecorder.KEYFRAME_SEC, 4, 'an empty value is the default');
    process.env.VOD_KEYFRAME_SEC = '2.5';
    assert.strictEqual(StreamRecorder.KEYFRAME_SEC, 2.5);
    process.env.VOD_KEYFRAME_SEC = '0';
    assert.strictEqual(StreamRecorder.KEYFRAME_SEC, 0, '0 turns it off');
    process.env.VOD_KEYFRAME_SEC = 'often';
    assert.strictEqual(StreamRecorder.KEYFRAME_SEC, 4, 'nonsense falls back to the default');
    if (env == null) delete process.env.VOD_KEYFRAME_SEC; else process.env.VOD_KEYFRAME_SEC = env;

    console.log('recording-keyframes: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
