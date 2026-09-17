/**
 * RobotStreamer passthrough lifecycle: the relay must never outlive its source.
 *
 * The reported bug: a streamer stops, and robotstreamer.com keeps showing the robot live with a
 * black picture. The relay kept its werift peer open (RS keeps a robot live as long as our
 * producers exist) and its restart loop ran flat-out, forever, with no look at whether the
 * OpenVibe stream was still live. These checks pin the new behaviour:
 *
 *   - a restart is refused, and the session stopped, when the source stream is not live
 *   - restarts back off and are counted per session; the cap turns the session into `failed`
 *   - a failed session stays visible through status() and an explicit start() relaunches it
 *   - stop() clears every timer and removes the session
 *
 *   node test/rs-passthrough-lifecycle.test.js
 */
'use strict';
const assert = require('assert');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const relay = require('../server/integrations/rs-passthrough-relay');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

(async () => {
    assert.ok(relay.available(), 'werift is installed in this checkout');
    const stream = { id: 4242 };
    const integration = { robot_id: 'r-1', token: 't-1' };

    // 1. Source not live → the first failure stops the session instead of restarting it.
    //    (_run throws at once here: the SFU is not initialised in tests, which is a real
    //    failure mode — "mediasoup SFU not ready" — and exercises the same path.)
    relay._sourceLiveOverride = () => false;
    assert.strictEqual(await relay.start(stream, integration), true);
    await tick();
    assert.strictEqual(relay.isActive(stream.id), false, 'session stopped because the source is not live');
    assert.strictEqual(relay.status(stream.id), null);

    // 2. Source live → restart is scheduled with backoff and reported through status().
    relay._sourceLiveOverride = () => true;
    await relay.start(stream, integration);
    await tick();
    let st = relay.status(stream.id);
    assert.ok(st, 'session exists');
    assert.strictEqual(st.state, 'restarting');
    assert.strictEqual(st.restarts, 1);
    assert.ok(st.next_restart_at > Date.now() + 1000, 'first retry is ~3s out');
    assert.ok(/SFU not ready/.test(st.last_restart_reason), `reason names the cause: ${st.last_restart_reason}`);
    assert.strictEqual(st.active, true);
    const session = relay.sessions.get(stream.id);
    assert.ok(session.restartTimer, 'restart timer armed');

    // 3. The source ends while a restart is pending → the timer fires into stop().
    relay._sourceLiveOverride = () => false;
    clearTimeout(session.restartTimer); session.restartTimer = null;
    relay._scheduleRestart(session, 'second failure');
    await tick();
    assert.strictEqual(relay.isActive(stream.id), false, 'a restart attempt after the source ended stops the session');

    // 4. Cap: too many consecutive restarts → failed, still visible, not active.
    relay._sourceLiveOverride = () => true;
    await relay.start(stream, integration);
    await tick();
    const s2 = relay.sessions.get(stream.id);
    clearTimeout(s2.restartTimer); s2.restartTimer = null;
    s2.restarts = 12;
    relay._scheduleRestart(s2, 'werift connectionState=failed');
    st = relay.status(stream.id);
    assert.strictEqual(st.state, 'failed');
    assert.strictEqual(st.active, false);
    assert.ok(/gave up after 12 restarts/.test(st.last_error), st.last_error);
    assert.strictEqual(s2.restartTimer, null, 'no timer left behind after giving up');

    // 5. Explicit start() on a failed session relaunches it from zero.
    await relay.start(stream, integration);
    await tick();
    st = relay.status(stream.id);
    assert.strictEqual(st.restarts, 1, 'counter reset by the relaunch');
    assert.strictEqual(st.state, 'restarting');

    // 6. Backoff grows and is capped.
    const s3 = relay.sessions.get(stream.id);
    clearTimeout(s3.restartTimer); s3.restartTimer = null;
    s3.restarts = 5;
    relay._scheduleRestart(s3, 'x');
    const delay6 = s3.nextRestartAt - Date.now();
    assert.ok(delay6 > 25000 && delay6 <= 30000, `6th retry is capped at 30s (got ${delay6}ms)`);

    // 7. stop() clears everything.
    relay.stop(stream.id);
    assert.strictEqual(relay.isActive(stream.id), false);
    assert.strictEqual(s3.restartTimer, null);
    assert.strictEqual(s3.stopped, true);

    // 8. status() never leaks the RS token.
    await relay.start(stream, integration);
    await tick();
    assert.ok(!JSON.stringify(relay.status(stream.id)).includes('t-1'), 'token not in status');
    relay.stop(stream.id);

    delete relay._sourceLiveOverride;
    console.log = quiet;
    console.log('rs-passthrough lifecycle: all checks passed');
    process.exit(0);
})().catch((err) => { console.log = quiet; console.error(err); process.exit(1); });
