'use strict';
// A browser stream records from its first picture or sound (server/streaming/recorder.js startOnProduce, called by
// broadcast-server's sfu-produce). That path had no start of its own, so a browser stream waited for the 45 s reconcile:
// on 2026-11-19 stream 3060's recording began 28 s after the stream (74 of its 95 s recorded). What this proves:
//   - video and audio arriving together start one recording, with the stream's recording mode;
//   - the reconcile does not start a second one while that start is under way;
//   - a stream that is not live, an RTMP stream, one set not to record, and one already recording start nothing;
//   - the SFU produce handler calls it.
//   node test/recorder-start-on-produce.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../server/db/database');
const recorder = require('../server/streaming/recorder');

(async () => {
    const streams = {
        1: { id: 1, is_live: 1, protocol: 'webrtc' },
        2: { id: 2, is_live: 0, protocol: 'webrtc' },
        3: { id: 3, is_live: 1, protocol: 'rtmp' },
        4: { id: 4, is_live: 1, protocol: 'webrtc', none: true },
        5: { id: 5, is_live: 1, protocol: 'browser' },
    };
    let release;
    const slow = new Promise((ok) => { release = ok; });
    db.getStreamById = async (id) => { if (id === 1) await slow; return streams[id] || null; };
    db.resolveStreamRecordingMode = async (s) => (s.none ? 'none' : 'vod');
    db.getLiveStreams = async () => [streams[1]];   // the reconcile below sees the stream being started
    const started = [];
    recorder.startRecording = async (id, protocol, endpoint, opts) => { started.push([id, protocol, opts.mode]); recorder.activeRecordings.set(id, { protocol, mode: opts.mode }); };

    // Video and audio together, and the reconcile in the middle of the start.
    const both = Promise.all([recorder.startOnProduce(1), recorder.startOnProduce(1)]);
    recorder._healAttempts.clear();
    const healed = recorder.reconcileLiveRecordings();
    release();
    await both; await healed;
    assert.deepStrictEqual(started.filter(([id]) => id === 1), [[1, 'webrtc', 'vod']], 'one start for the stream, from the produce');
    assert.ok(!recorder._produceStarts.has(1), 'the start is no longer under way');

    started.length = 0;
    await recorder.startOnProduce(1);   // already recording
    await recorder.startOnProduce(2);   // not live
    await recorder.startOnProduce(3);   // RTMP: its own ingest starts it
    await recorder.startOnProduce(4);   // set not to record
    await recorder.startOnProduce(99);  // no such stream
    assert.deepStrictEqual(started, [], 'nothing else starts');
    await recorder.startOnProduce(5);
    assert.deepStrictEqual(started, [[5, 'browser', 'vod']], 'a browser-protocol stream starts too');

    db.getStreamById = async () => { throw new Error('db down'); };
    await recorder.startOnProduce(6);   // never rejects
    assert.ok(!recorder._produceStarts.has(6));

    const src = fs.readFileSync(path.join(__dirname, '../server/streaming/broadcast-server.js'), 'utf8');
    const at = src.indexOf('async _handleSfuProduce(');
    const produce = src.slice(at, src.indexOf('\n    }\n', at));
    assert.match(produce, /startOnProduce\(client\.streamId\)/, 'the SFU produce handler starts the recording');

    for (const id of [1, 5]) recorder.activeRecordings.delete(id);
    console.log('recorder start on produce: a browser stream records from its first picture, once');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
