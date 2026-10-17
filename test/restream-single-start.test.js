/**
 * Going live starts restreams from two paths at once (autoStartForStream and resumeForStream, and WHIP resumes too).
 * Each awaited the database before its session existed, so both passed startRestream's "already active" check and
 * spawned two FFmpeg pushing one stream key (production 2026-10-17 02:15: 2615:1 and 2615:2 each spawned twice; the
 * platform refuses a second publisher). startRestream now runs one start per stream and destination at a time.
 *
 *   node test/restream-single-start.test.js
 */
'use strict';
const assert = require('assert');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const Manager = require('../server/streaming/restream-manager').constructor;

(async () => {
    const m = new Manager();
    const dest = { id: 2, platform: 'kick', enabled: 1, auto_start: 1, server_url: 'rtmps://x.kick.com', stream_key: 'k' };
    m._getDestinationsForStream = async () => [dest];
    const starts = [];
    let release;
    m._startRestream = async (key) => {
        starts.push(key);
        await new Promise((r) => { release = r; });   // the database and SFU awaits of a real start
        const session = { key, streamId: 2615, destId: 2, status: 'starting' };
        m.sessions.set(key, session);
        return session;
    };

    // The go-live race: both paths at once, on the same stream and destination.
    const a = m.autoStartForStream(2615, 7, { protocol: 'webrtc' });
    const b = m.resumeForStream(2615, 7, { protocol: 'webrtc' });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(starts, ['2615:2'], 'one start, whichever paths ask');
    release();
    await Promise.all([a, b]);
    assert.deepStrictEqual(starts, ['2615:2']);
    assert.strictEqual(m._starting.size, 0, 'the in-flight entry is gone once the start finished');

    // A later start (after a stop) goes through, and a start that fails does not block the next one.
    m.sessions.clear();
    m._startRestream = async () => { starts.push('fails'); throw new Error('no SFU'); };
    await assert.rejects(m.startRestream(2615, dest, { protocol: 'webrtc' }), /no SFU/);
    assert.strictEqual(m._starting.size, 0);
    m._startRestream = async (key) => { starts.push(key); return { key, status: 'starting' }; };
    await m.startRestream(2615, dest, { protocol: 'webrtc' });
    assert.deepStrictEqual(starts, ['2615:2', 'fails', '2615:2']);
    quiet('restream single start: all checks passed');
})().catch((err) => { quiet(err); process.exit(1); });
