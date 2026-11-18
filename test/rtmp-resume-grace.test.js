'use strict';
// An RTMP publisher that drops and comes back carries on the same stream (server/streaming/resume-grace.js, wired in
// rtmp-server.js; the owner, 2026-11-18: one broadcast "chunked … in weird ways": iZoR_One's encoder reconnecting made
// streams 3057 and 3058, two replays). What this proves:
//   - a held stream is taken back by the same key within the grace (and its expiry does nothing then);
//   - one not taken back ends after the grace, once; holding the key again restarts its grace;
//   - rtmp-server.js holds on donePublish instead of ending, takes the hold on prePublish, keeps a resumed stream's
//     start (held, or already recorded before a Live restart: wasFed), and ends after the grace at the last heartbeat.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createResumeGrace } = require('../server/streaming/resume-grace');

(async () => {
    // A hand-run clock: timers fire when the test says.
    const timers = new Map(); let n = 0;
    const setTimer = (fn, ms) => { const id = ++n; timers.set(id, { fn, ms }); return id; };
    const clearTimer = (id) => { timers.delete(id); };
    const fire = async () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } await new Promise((r) => setImmediate(r)); };
    const ended = [];
    const g = createResumeGrace({ graceMs: 90000, onExpire: (info) => ended.push(info.streamId), setTimer, clearTimer });

    g.hold('key-a', { streamId: 3057 });
    assert.deepStrictEqual(g.held('key-a'), { streamId: 3057 });
    assert.deepStrictEqual(g.take('key-a'), { streamId: 3057 }, 'the same key back within the grace takes its stream');
    assert.strictEqual(g.take('key-a'), null, 'taken once');
    await fire();
    assert.deepStrictEqual(ended, [], 'a stream taken back never ends');

    g.hold('key-b', { streamId: 3060 });
    g.hold('key-b', { streamId: 3060 });   // left again: one grace, from now
    assert.strictEqual(timers.size, 1, 'holding again restarts the grace');
    assert.strictEqual([...timers.values()][0].ms, 90000);
    await fire();
    assert.deepStrictEqual(ended, [3060], 'not back in time: ended once');
    assert.strictEqual(g.take('key-b'), null);
    assert.throws(() => createResumeGrace({}), /onExpire/);

    // The RTMP server's wiring.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'streaming', 'rtmp-server.js'), 'utf8');
    const done = src.slice(src.indexOf("this.nms.on('donePublish'"), src.indexOf("this.nms.on('prePlay'"));
    assert.ok(/this\.resumeGrace\.hold\(streamKey, \{ streamId: info\.streamId/.test(done), 'donePublish holds the stream for a reconnect');
    assert.ok(!/db\.endStream\(/.test(done), 'and no longer ends it on the spot');
    const pre = src.slice(src.indexOf("this.nms.on('prePublish'"), src.indexOf("this.nms.on('donePublish'"));
    assert.ok(/const held = this\.resumeGrace\.take\(streamKey\)/.test(pre), 'prePublish takes the hold');
    assert.ok(/const resuming = \(held && held\.streamId === streamId\) \|\| await wasFed\(streamId\)/.test(pre), 'a resumed stream keeps its start');
    assert.ok(/UPDATE streams SET is_live = 1 WHERE id = \?/.test(pre) && /UPDATE streams SET is_live = 1, started_at = ov_now\(\) WHERE id = \?/.test(pre));
    assert.ok(/db\.endStream\(info\.streamId, 'ingest_ended', \{ atLastHeartbeat: true \}\)/.test(src), 'after the grace it ends at the last heartbeat');
    console.log('rtmp-resume-grace: a publisher back within 90 s carries on its stream; one that is not ends once, at its last heartbeat');
})().catch((e) => { console.error(e); process.exit(1); });
