'use strict';
// When Media refuses to record a live stream (its disk is critically low), the person streaming is told at once, on
// their broadcast socket, and told again when recording starts (2026-11-17: Maticus streamed 16 minutes not knowing
// the server could not record; two streams were lost).
//   node test/recording-refused-notice.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const bs = require('../server/streaming/broadcast-server');
const db = require('../server/db/database');
const recorder = require('../server/streaming/recorder');

(async () => {
    // The broadcast server: a stream's broadcaster gets the message (the room key is the numeric stream id).
    const sent = [];
    bs.safeSend = (ws, msg) => sent.push(msg);
    bs.rooms.set(77, { broadcaster: { readyState: 1 }, viewers: new Map() });
    assert.strictEqual(bs.notifyBroadcaster('77', { type: 'recording-status', state: 'recording' }), true);
    assert.strictEqual(bs.notifyBroadcaster(78, { type: 'recording-status', state: 'recording' }), false, 'no broadcaster socket: nothing sent');
    sent.length = 0;

    // The recorder: Media's disk refusal is said to the broadcaster; another failure is not.
    db.getStreamById = async (id) => ({ id, title: 'OPEN ROBOT', is_live: 1 });
    recorder._installProducerWatch = () => {};
    recorder._abort = async () => {};
    recorder._maybeRetryAfterDiskRefusal = () => {};
    let failWith = 'Disk critically low — recording refused';
    recorder._startRtpRecording = async () => { throw new Error(failWith); };
    await recorder.startRecording(77, 'webrtc', {}, {});
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(sent.map((m) => [m.type, m.state, m.reason]), [['recording-status', 'refused', 'disk']]);
    assert.match(sent[0].message, /not being recorded right now: the server is short of space\. You are still live/);
    recorder.activeRecordings.delete(77);
    sent.length = 0;
    failWith = 'Media answered 500';
    await recorder.startRecording(77, 'webrtc', {}, {});
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(sent, [], 'only the disk refusal is a notice');
    recorder.activeRecordings.delete(77);

    // The studio shows it once, and says when recording is back.
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast.js'), 'utf8');
    const at = page.indexOf("case 'recording-status':");
    assert.ok(at > 0, 'the studio handles recording-status');
    const body = page.slice(at, at + 700);
    assert.match(body, /msg\.state === 'refused' && !ss\._recordWarned/);
    assert.match(body, /Recording again from here on\./);
    console.log('recording-refused-notice: the person streaming hears that the server cannot record, and when it can again');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
