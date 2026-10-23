'use strict';
// The AI moments job's chat spikes (chat-reads.spikeOffsets) ask Chat's timeline for the stream's own span: from
// started_at to ended_at, never more than Chat's 10,000 buckets. Asked up to now, a stream from two months ago needed
// 184,000 thirty-second buckets and Chat answered 400 "Invalid bucket_ms" (2026-10-23: 12 recordings had no spikes).
const assert = require('assert');
console.warn = () => {};

const client = require('../server/chat/chat-client');
const calls = [];
client.available = () => true;
client.readTimeline = async (q) => { calls.push(q); return { buckets: [{ t: q.since + 60000, count: 3 }, { t: q.since + 30000, count: 9 }] }; };
const chatReads = require('../server/chat/chat-reads');

(async () => {
    const started = Date.parse('2026-08-20T12:00:00Z');
    const ended = started + 2 * 3600 * 1000;
    const spikes = await chatReads.spikeOffsets(2125, 30, 8, started, ended);
    assert.deepStrictEqual(spikes, [{ offset: 30, count: 9 }, { offset: 60, count: 3 }]);
    assert.deepStrictEqual(calls.pop(), { stream_id: 2125, since: started, until: ended, bucket_ms: 30000 }, 'an ended stream is read up to its end');

    // A stream still live (no end): up to now, as before; the client leaves a null `until` out of the query.
    await chatReads.spikeOffsets(2126, 30, 8, started);
    assert.strictEqual(calls.pop().until, null);

    // An end past Chat's limit is held to 10,000 buckets from the start.
    await chatReads.spikeOffsets(2127, 30, 8, started, started + 400 * 86400 * 1000);
    const q = calls.pop();
    assert.strictEqual((q.until - q.since) / q.bucket_ms, 10000);

    // An end before the start is ignored (asked up to now).
    await chatReads.spikeOffsets(2128, 30, 8, started, started - 1000);
    assert.strictEqual(calls.pop().until, null);
    console.log('chat-spike-window: ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
