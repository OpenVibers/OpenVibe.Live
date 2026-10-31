'use strict';
// A browser stream's recording has its sound (server/streaming/recorder.js _startRtpRecording, _installProducerWatch).
// VOD 5986 (goosely, 2026-10-25) was silent: the recorder found the video producer and asked for the audio one in the
// same instant, a moment before the browser produced it, and recorded video only for seven minutes.
// - Audio a moment after video: the recording waits for it and has sound.
// - No microphone at all: after the wait it records video only.
// - A microphone that comes later: the recording rolls to a new part that has the sound.
// - A second microphone beside a live one, or the recorded one again: nothing happens.

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

process.env.VOD_AUDIO_WAIT_MS = '300';
process.env.VOD_VIDEO_WAIT_MS = '300';

// A small SFU: rooms of producers, the real findProducerByKind/waitForProducer behaviour, plain consumers recorded.
const sfu = new EventEmitter();
sfu.rooms = new Map();
sfu.consumers = [];
let nextId = 0;
sfu.produce = (roomId, kind, transportId = 't1') => {
    if (!sfu.rooms.has(roomId)) sfu.rooms.set(roomId, { producers: new Map(), router: { rtpCapabilities: { codecs: [] } } });
    const id = `${kind}-${++nextId}`;
    const producer = { id, kind, closed: false, rtpParameters: { codecs: [kind === 'video' ? { mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 } : { mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }] } };
    sfu.rooms.get(roomId).producers.set(id, { producer, transportId });
    sfu.emit('producer-added', { roomId, producerId: id, kind });
    return producer;
};
sfu.findProducerByKind = (roomId, kind) => {
    const room = sfu.rooms.get(roomId);
    if (!room) return null;
    for (const [id, e] of [...room.producers.entries()].reverse()) if (e.producer.kind === kind && !e.producer.closed) return { id };
    return null;
};
sfu.waitForProducer = (roomId, kind, timeoutMs) => {
    const existing = sfu.findProducerByKind(roomId, kind);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
        const handler = (ev) => { if (ev.roomId === roomId && ev.kind === kind) { clearTimeout(timer); sfu.removeListener('producer-added', handler); resolve({ id: ev.producerId }); } };
        const timer = setTimeout(() => { sfu.removeListener('producer-added', handler); reject(new Error('timeout')); }, timeoutMs);
        sfu.on('producer-added', handler);
    });
};
sfu.createPlainConsumer = async (roomId, producerId, ip, port) => { sfu.consumers.push({ roomId, producerId, port }); return { transportId: `plain-${producerId}`, payloadType: producerId.startsWith('video') ? 96 : 111 }; };
sfu.closePlainConsumer = () => {};
require.cache[path.resolve(__dirname, '../server/streaming/webrtc-sfu.js')] = { id: 'sfu', filename: 'sfu', loaded: true, exports: sfu };

const db = require('../server/db/database');
const media = require('../server/media-client');
const recorder = require('../server/streaming/recorder');
db.getStreamById = async (id) => ({ id, user_id: 1, title: 'Seattle', is_live: 1 });
db.resolveStreamVodVisibility = async () => 'public';
let vodSeq = 6000;
const ingests = [];
media.createVod = async () => ({ id: ++vodSeq });
media.ingestRtpStart = async (vodId, { video, audio }) => { ingests.push({ vodId, video, audio }); return { videoPort: video ? 12000 : null, audioPort: audio ? 12002 : null }; };
media.ingestRtpStop = async () => {};
media.finalizeVod = async () => {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await wait(20); } };

(async () => {
    // 1. VOD 5986's race: the recording is waiting for video; audio comes just after it.
    recorder.startRecording(101, 'webrtc', {}, { mode: 'vod' });
    await wait(20);
    sfu.produce('stream-101', 'video');
    setTimeout(() => sfu.produce('stream-101', 'audio'), 30);
    await until(() => ingests.length === 1);
    assert.ok(ingests[0].audio && ingests[0].audio.codec === 'opus', 'the recording waited for the microphone and has sound');
    assert.deepStrictEqual(sfu.consumers.filter((c) => c.roomId === 'stream-101').map((c) => c.producerId.split('-')[0]).sort(), ['audio', 'video']);
    console.log('✅ audio a moment after video is recorded');

    // A second microphone beside the live one, and the recorded one again: nothing happens.
    sfu.produce('stream-101', 'audio');
    sfu.emit('producer-added', { roomId: 'stream-101', producerId: recorder.activeRecordings.get(101).audioProducerId, kind: 'audio' });
    await wait(50);
    assert.strictEqual(recorder.activeRecordings.get(101).part, 1, 'no roll for a second microphone beside a live one');
    console.log('✅ a second microphone beside a live one is not followed');

    // 2. No microphone: video only after the wait.
    sfu.produce('stream-102', 'video');
    recorder.startRecording(102, 'webrtc', {}, { mode: 'vod' });
    await until(() => ingests.length === 2, 2000);
    assert.strictEqual(ingests[1].audio, undefined, 'a stream with no microphone records video only');
    console.log('✅ no microphone: video only after a short wait');

    // 3. The microphone comes later: the recording rolls to a part with sound.
    const before = recorder.activeRecordings.get(102);
    assert.strictEqual(before.part, 1);
    sfu.produce('stream-102', 'audio');
    await until(() => ingests.length === 3, 4000);
    assert.ok(ingests[2].audio, 'the next part has the sound');
    assert.strictEqual(recorder.activeRecordings.get(102).part, 2);
    console.log('✅ a late microphone rolls the recording to a part with sound');

    // 4. The recorded microphone dies and a new one comes (same camera): roll again.
    const rec = recorder.activeRecordings.get(102);
    sfu.rooms.get('stream-102').producers.get(rec.audioProducerId).producer.closed = true;
    sfu.produce('stream-102', 'audio');
    await until(() => ingests.length === 4, 4000);
    assert.strictEqual(recorder.activeRecordings.get(102).part, 3);
    console.log('✅ a new microphone after the recorded one died rolls too');

    // 5. Stream 2827 (2026-10-30): the camera never reached the server. The sound is recorded on its own instead of
    //    nothing at all, and when the camera arrives the recording rolls to a part with the picture.
    sfu.produce('stream-103', 'audio');
    recorder.startRecording(103, 'webrtc', {}, { mode: 'vod' });
    await until(() => ingests.length === 5, 3000);
    assert.strictEqual(ingests[4].video, undefined, 'no camera: no video section asked of Media');
    assert.ok(ingests[4].audio && ingests[4].audio.codec === 'opus', 'but the sound is recorded');
    assert.strictEqual(recorder.activeRecordings.get(103).audioOnly, true);
    assert.deepStrictEqual(sfu.consumers.filter((c) => c.roomId === 'stream-103').map((c) => c.producerId.split('-')[0]), ['audio'], 'one plain consumer, for the sound');
    console.log('✅ no camera: the sound is recorded instead of nothing');
    sfu.produce('stream-103', 'video');
    await until(() => ingests.length === 6, 4000);
    assert.ok(ingests[5].video && ingests[5].audio, 'the camera arrived: the next part has the picture and the sound');
    assert.strictEqual(recorder.activeRecordings.get(103).part, 2);
    assert.ok(!recorder.activeRecordings.get(103).audioOnly, 'and is no longer sound only');
    console.log('✅ a camera that arrives late rolls the recording to a part with the picture');

    // 6. Neither picture nor sound: nothing is recorded, and nothing is left waiting.
    recorder.startRecording(104, 'webrtc', {}, { mode: 'vod' });
    await wait(500);
    assert.strictEqual(ingests.length, 6, 'nothing to record, no VOD');
    assert.ok(!recorder.activeRecordings.has(104));
    console.log('✅ neither picture nor sound: no recording');

    for (const id of [101, 102, 103]) recorder.stopRecording(id);
    console.log('\n✅ recorder audio: waits for the microphone, video-only without one, sound-only without a camera, rolls when either comes later');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
