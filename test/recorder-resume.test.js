'use strict';
// A recording Media stopped resumes at once (server/streaming/recorder.js checkActiveRecordings; the owner, 2026-11-18:
// "the replay feature, the VODs, just sucks … it doesn't have the full VOD"). A Media restart ends every ingest while its
// rows stay "recording" until Media's orphan sweep, about four minutes; the recorder used to wait for that. What this
// proves:
//   - a part Media says it no longer records (recording: false) leaves the active set, is finalized now when its row
//     was left recording, and the reconciler runs at once (no 60 s heal pause) to start the next part;
//   - a part Media still records, one too young to judge, a Media that does not answer, and a browser chunk session are
//     all left alone;
//   - the recently-online and recently-ended lookups ask Media for every part (include_parts) and give the first part.

const assert = require('assert');
const db = require('../server/db/database');
const media = require('../server/media-client');
const recorder = require('../server/streaming/recorder');

(async () => {
    const now = 1_800_000_000_000;
    const old = now - 120_000;
    const status = { 101: { recording: false, row_recording: true }, 102: { recording: true, row_recording: true }, 103: { recording: false, row_recording: true }, 105: { recording: false, row_recording: false } };
    const asked = [];
    media.ingestStatus = async (vodId) => {
        asked.push(vodId);
        if (vodId === 104) throw new Error('Media unreachable');
        return status[vodId] || null;
    };
    const finalized = [];
    media.finalizeVod = async (id) => { finalized.push(id); return {}; };
    let reconciled = 0;
    recorder.reconcileLiveRecordings = async () => { reconciled++; };
    const closed = [];
    recorder._closePlainConsumers = (s) => { if (s) closed.push(s.roomId); };

    const set = (sid, rec) => recorder.activeRecordings.set(sid, { protocol: 'webrtc', mode: 'vod', part: 1, ...rec });
    set(1, { vodId: 101, type: 'rtp', startedAt: old, webrtcState: { roomId: 'stream-1' } });   // Media restarted: gone
    set(2, { vodId: 102, type: 'rtmp', startedAt: old });                                         // still recording
    set(3, { vodId: 103, type: 'rtmp', startedAt: now - 5000 });                                  // too young to judge
    set(4, { vodId: 104, type: 'rtmp', startedAt: old });                                         // Media does not answer
    set(5, { vodId: 105, type: 'rtmp', startedAt: old });                                         // ended, already finalized
    set(6, { vodId: 106, type: 'chunks', startedAt: old });                                       // browser upload: not an ingest
    recorder._healAttempts.set(1, now - 1000);

    const resumed = await recorder.checkActiveRecordings({ now });
    assert.deepStrictEqual(resumed.sort(), [1, 5], 'the parts Media no longer records');
    assert.ok(!recorder.activeRecordings.has(1) && !recorder.activeRecordings.has(5));
    assert.ok([2, 3, 4, 6].every((sid) => recorder.activeRecordings.has(sid)), 'the rest are left alone');
    assert.deepStrictEqual(finalized, [101], 'a part a restart left "recording" is finalized now; one already finished is not');
    assert.deepStrictEqual(closed, ['stream-1'], 'its PlainRTP consumers are closed');
    assert.ok(!recorder._healAttempts.has(1), 'no 60 s heal pause for it');
    assert.strictEqual(reconciled, 1, 'the next part starts now');
    assert.ok(!asked.includes(103) && !asked.includes(106), 'too young, and chunk sessions, are not asked about');

    // Nothing stopped: no reconcile.
    reconciled = 0;
    assert.deepStrictEqual(await recorder.checkActiveRecordings({ now }), []);
    assert.strictEqual(reconciled, 0);
    for (const sid of [2, 3, 4, 6]) recorder.activeRecordings.delete(sid);

    // The lookups: every part, the first one answering for the stream.
    const lookups = require('../server/media-proxy/lookups');
    const queries = [];
    media.listVods = async (q) => {
        queries.push(q);
        const sid = Number(q.stream_id);
        return { vods: sid === 3058
            ? [{ id: 6620, stream_id: 3058, duration_seconds: 1049, visibility: 'public', is_recording: false }, { id: 6619, stream_id: 3058, duration_seconds: 886, visibility: 'public', is_recording: false }]
            : [] };
    };
    const parts = await lookups.publicPartsForStreams([3058, 3057]);
    assert.ok(queries.every((q) => Number(q.include_parts) === 1), 'every part is asked for');
    assert.deepStrictEqual(parts.get(3058).map((v) => v.id), [6619, 6620]);
    assert.strictEqual(parts.get(3058).reduce((n, v) => n + v.duration_seconds, 0), 1935, '32:15 recorded, not 14:46');
    const first = await lookups.publicVodsForStreams([3058]);
    assert.strictEqual(first.get(3058).id, 6619, 'the first part, which plays the whole joined recording');
    console.log('recorder-resume: a part Media stopped is finished now and the next starts at once; the rest wait; lookups count every part');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
