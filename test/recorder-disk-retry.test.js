'use strict';

// When Media refuses a recording because its VOD volume is critically low, the
// recorder must (a) drop the empty VOD shell it created and (b) keep retrying while
// the stream is live, because Media's offload sweep frees space within minutes.
// Anything that is not a disk refusal must not be retried.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-rec-')), 'live.db');
const db = require('../server/db/database');
const media = require('../server/media-client');
const recorder = require('../server/streaming/recorder');

// Stubs: the recorder only needs to know the stream exists and whether it is live.
let live = true;
db.getStreamById = (id) => ({ id, user_id: 1, title: 'T', is_live: live ? 1 : 0, managed_stream_key: 'k' });
db.resolveStreamVodVisibility = () => 'public';
const deleted = [];
media.deleteVod = async (id) => { deleted.push(id); };

// _abort is what drops the shell; make sure the failure path reaches it.
const abortCalls = [];
const origAbort = recorder._abort.bind(recorder);
recorder._abort = async (streamId, rec) => { abortCalls.push({ streamId, vodId: rec.vodId }); return origAbort(streamId, rec); };

// A disk refusal schedules a retry and clears the active slot.
recorder._maybeRetryAfterDiskRefusal(42, 'rtmp', { streamKey: 'k' }, {}, new Error('Disk critically low — recording refused'));
assert.ok(recorder._diskRetryTimers.has(42), 'disk refusal schedules a retry timer');
console.log('✅ disk-space refusal schedules a retry');

// The stream ending cancels the retry.
recorder.stopRecording(42);
assert.ok(!recorder._diskRetryTimers.has(42), 'stopRecording cancels the pending retry');
console.log('✅ stream end cancels the pending retry');

// Other failures are not retried.
recorder._maybeRetryAfterDiskRefusal(43, 'rtmp', { streamKey: 'k' }, {}, new Error('Media unreachable (POST /vods): fetch failed'));
assert.ok(!recorder._diskRetryTimers.has(43), 'non-disk failures are not retried');
console.log('✅ non-disk failures are not retried');

// Retries are capped.
recorder._maybeRetryAfterDiskRefusal(44, 'rtmp', { streamKey: 'k' }, { _diskRetries: 12 }, new Error('Disk critically low — recording refused'));
assert.ok(!recorder._diskRetryTimers.has(44), 'gives up after the retry cap');
console.log('✅ retry cap honoured');

// Rescheduling replaces rather than stacks timers.
recorder._maybeRetryAfterDiskRefusal(45, 'rtmp', { streamKey: 'k' }, {}, new Error('disk full'));
const first = recorder._diskRetryTimers.get(45);
recorder._maybeRetryAfterDiskRefusal(45, 'rtmp', { streamKey: 'k' }, { _diskRetries: 1 }, new Error('disk full'));
assert.notStrictEqual(recorder._diskRetryTimers.get(45), first, 'a new retry replaces the old timer');
recorder._clearDiskRetry(45);
console.log('✅ retries replace, never stack');

// The start-failure path drops the VOD shell in Media (the ghost-row fix).
media.createVod = async () => ({ id: 777 });
media.ingestRtmp = async () => { throw new Error('Disk critically low — recording refused'); };
recorder.startRecording(46, 'rtmp', { streamKey: 'k' }, { mode: 'vod' });
setTimeout(() => {
    assert.deepStrictEqual(abortCalls.map(a => a.vodId), [777], '_abort ran with the created VOD id');
    assert.deepStrictEqual(deleted, [777], 'the empty VOD shell was deleted in Media');
    assert.ok(!recorder.isRecording(46), 'no active recording is left behind');
    assert.ok(recorder._diskRetryTimers.has(46), 'and a retry is scheduled because the refusal was disk-related');
    recorder._clearDiskRetry(46);
    console.log('✅ start failure deletes the Media VOD shell and schedules a retry');
    console.log('\n✅ All recorder disk-retry tests passed');
    process.exit(0);
}, 200);
