'use strict';
/**
 * Viewer health (plan L23, 2026-10-31).
 *
 * The owner watched stream 2833 and the picture froze a few seconds in; a reload played fine.
 * Without a number, "it froze" is a story. These are the numbers and the ladder:
 *
 *   A. The recovery ladder, driven by a fake clock: ask for a keyframe, then restart the
 *      transport, then rebuild the session — in that order, and never a page reload.
 *   B. A frame that arrives puts the ladder back to zero and closes the freeze.
 *   C. The telemetry message: the decoder's own numbers, cleaned up.
 *   D. The debug report the viewer copies: the stream, the time, the browser, the codec, the
 *      decoder, the last sample and the steps — and nothing that identifies the viewer.
 *   E. The server: a freeze is one log line and one count, and the count reaches the metric.
 *   F. The server's rate limit on keyframe asks (one per consumer every 2 s).
 *   G. The server's telemetry handler: one line per freeze, not one per sample.
 *
 *   node test/viewer-health.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── the player's own module, in a sandbox ────────────────────────────────────────────────────────
const playerSrc = fs.readFileSync(path.join(__dirname, '../public/js/ov-viewer-health.js'), 'utf8');
const sandbox = {
    window: {},
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Object, Array, String, Number, isFinite, parseInt,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(playerSrc, sandbox, { filename: 'ov-viewer-health.js' });
const VH = sandbox.window.OVViewerHealth;
assert.ok(VH, 'ov-viewer-health.js must expose window.OVViewerHealth');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// ── A: the ladder, with a fake clock ────────────────────────────────────────────────────────────
check('A1 the ladder asks for a keyframe after 1.5 s of a still picture', () => {
    let t = 10000;
    const ladder = VH.createLadder({ now: () => t });
    ladder.setConnected(true);
    assert.equal(ladder.tick().action, 'none', 'a moving picture asks for nothing');
    t += 1600;
    const step = ladder.tick();
    assert.equal(step.action, 'keyframe', 'a still picture asks for a keyframe');
    assert.equal(ladder.stage, 1);
});

check('A2 the ladder asks three times, then restarts the transport, then rebuilds', () => {
    let t = 10000;
    const ladder = VH.createLadder({ now: () => t });
    ladder.setConnected(true);
    t += 1600;
    assert.equal(ladder.tick().action, 'keyframe');
    t += 2000;
    assert.equal(ladder.tick().action, 'keyframe');
    assert.equal(ladder.keyframeAsks, 2);
    t += 2000;
    assert.equal(ladder.tick().action, 'keyframe');
    assert.equal(ladder.keyframeAsks, 3);
    t += 2000;
    const restart = ladder.tick();
    assert.equal(restart.action, 'restart-transport', 'three keyframe asks and the transport is restarted');
    assert.equal(ladder.stage, 2);
    t += 8000;
    const rebuild = ladder.tick();
    assert.equal(rebuild.action, 'rebuild', 'a restarted transport that stays frozen rebuilds the session');
    assert.equal(ladder.stage, 3);
});

check('A3 the ladder restarts the transport after 8 s of asking, even with fewer asks', () => {
    let t = 10000;
    const ladder = VH.createLadder({ now: () => t });
    ladder.setConnected(true);
    t += 1600;
    assert.equal(ladder.tick().action, 'keyframe');
    // The player asks again only every 2 s, so the asks are few: the 8 s rule must still fire.
    t += 8000;
    const step = ladder.tick();
    assert.equal(step.action, 'restart-transport');
});

check('A4 the ladder asks again no more often than every 2 s', () => {
    let t = 10000;
    const ladder = VH.createLadder({ now: () => t });
    ladder.setConnected(true);
    t += 1600;
    assert.equal(ladder.tick().action, 'keyframe');
    t += 500;                       // too soon for another ask
    assert.equal(ladder.tick().action, 'wait');
    assert.equal(ladder.keyframeAsks, 1);
    t += 1500;
    assert.equal(ladder.tick().action, 'keyframe');
    assert.equal(ladder.keyframeAsks, 2);
});

check('A5 a transport that is not connected never escalates', () => {
    let t = 10000;
    const ladder = VH.createLadder({ now: () => t });
    // Not connected: the ladder has nothing to say.
    t += 60000;
    assert.equal(ladder.tick().action, 'none');
    ladder.setConnected(true);
    t += 1600;
    assert.equal(ladder.tick().action, 'keyframe');
});

check('A6 a transport restarted by the ladder starts at the rebuild step', () => {
    let t = 10000;
    const ladder = VH.createLadder({ now: () => t, startStage: 2 });
    ladder.setConnected(true);
    t += 1600;
    assert.equal(ladder.tick().action, 'wait', 'the keyframe asks were already spent on the old transport');
    t += 7000;
    assert.equal(ladder.tick().action, 'rebuild', 'a restarted transport that stays frozen rebuilds the session');
    assert.equal(ladder.stage, 3);
    // A frame that arrives after all that puts the ladder back to zero.
    ladder.markFrame();
    assert.equal(ladder.stage, 0);
});

// ── B: a frame that arrives ──────────────────────────────────────────────────────────────────────
check('B1 a new frame puts the ladder back to zero and closes the freeze', () => {
    let t = 10000;
    const ladder = VH.createLadder({ now: () => t });
    ladder.setConnected(true);
    t += 1600;
    ladder.tick();
    assert.equal(ladder.stage, 1);
    assert.equal(ladder.freezeCount, 1, 'one freeze so far');
    t += 1000;
    ladder.markFrame();
    assert.equal(ladder.stage, 0, 'the picture moved: the ladder is back to zero');
    assert.ok(ladder.freezeMs >= 1000, 'the freeze duration is counted');
    t += 1600;
    ladder.tick();
    assert.equal(ladder.freezeCount, 2, 'a second freeze is a second freeze');
});

check('B2 the duration counts the freeze that is still running', () => {
    let t = 10000;
    const ladder = VH.createLadder({ now: () => t });
    ladder.setConnected(true);
    t += 1600;
    ladder.tick();
    assert.ok(ladder.freezeMs >= 1600, 'the running freeze is already part of the total');
    t += 2000;
    assert.ok(ladder.freezeMs >= 3600, 'and it keeps growing until a frame arrives');
    ladder.markFrame();
    t += 1000;
    assert.ok(ladder.freezeMs >= 3600, 'a frame closes it without losing the time');
});

// ── C: the telemetry message ────────────────────────────────────────────────────────────────────
check('C1 the telemetry carries the decoder numbers and nothing else', () => {
    const stats = VH.readStats({
        framesDecoded: 120, framesDropped: 3, packetsReceived: 900, packetsLost: 2,
        jitter: 0.01, jitterBufferDelay: 0.05, decoderImplementation: 'FFmpegVideoDecoder',
        codecId: 'H264', somethingElse: 'ignored', framesDecodedX: 'nope',
    });
    assert.equal(stats.framesDecoded, 120);
    assert.equal(stats.decoderImplementation, 'FFmpegVideoDecoder');
    assert.equal(stats.somethingElse, undefined, 'an unknown field is not carried over');
    const msg = VH.buildTelemetry({ streamId: 2833, stats, freezeCount: 1, freezeMs: 2500, codec: 'video/H264' });
    assert.equal(msg.type, 'sfu-viewer-telemetry');
    assert.equal(msg.streamId, '2833');
    assert.equal(msg.data.codec, 'video/H264');
    assert.equal(msg.data.decoder, 'FFmpegVideoDecoder');
    assert.equal(msg.data.freezeCount, 1);
    assert.equal(msg.data.freezeMs, 2500);
    assert.ok(msg.data.at > 0);
});

check('C2 a browser that reports nothing still sends a usable message', () => {
    const msg = VH.buildTelemetry({ streamId: '7', stats: {} });
    assert.equal(msg.type, 'sfu-viewer-telemetry');
    assert.equal(msg.data.framesDecoded, null);
    assert.equal(msg.data.freezeCount, 0);
    assert.equal(msg.data.codec, '');
});

// ── D: the report the viewer copies ─────────────────────────────────────────────────────────────
check('D1 the report names the stream, the codec, the decoder, the sample and the steps', () => {
    const text = VH.buildDebugReport({
        streamId: 2833,
        codec: 'video/H264',
        decoder: 'VideoToolboxVideoDecoder',
        telemetry: { framesDecoded: 10, packetsLost: 1, freezeCount: 1, freezeMs: 900 },
        steps: ['asked for a keyframe', 'restarted the receive transport'],
        browser: 'TestBrowser/1.0',
        at: Date.UTC(2026, 9, 31, 4, 6, 22),
    });
    assert.ok(text.includes('stream_id=2833'));
    assert.ok(text.includes('browser=TestBrowser/1.0'));
    assert.ok(text.includes('codec=video/H264'));
    assert.ok(text.includes('decoder=VideoToolboxVideoDecoder'));
    assert.ok(text.includes('framesDecoded=10'));
    assert.ok(text.includes('freezeCount=1'));
    assert.ok(text.includes('asked for a keyframe'));
    assert.ok(text.includes('restarted the receive transport'));
    assert.ok(text.includes('2026-10-31T04:06:22'), 'the time of the freeze is in the report');
});

check('D2 the report carries no token, no cookie and no personal data', () => {
    const text = VH.buildDebugReport({
        streamId: 2833, codec: 'video/H264', decoder: 'x', telemetry: {}, steps: [], browser: 'UA',
    });
    for (const forbidden of ['token', 'cookie', 'Bearer', 'authorization', 'password']) {
        assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `the report must not mention ${forbidden}`);
    }
});

// ── E: the server's freeze detection and its metric ─────────────────────────────────────────────
const viewerHealth = require('../server/streaming/viewer-health');

check('E1 a moving picture is not a freeze', () => {
    const tracker = new viewerHealth.ViewerTracker();
    let seen = tracker.observe({ framesDecoded: 10, packetsReceived: 100, codec: 'video/H264' }, 1000);
    assert.equal(seen.freeze, false);
    seen = tracker.observe({ framesDecoded: 40, packetsReceived: 400, codec: 'video/H264' }, 6000);
    assert.equal(seen.freeze, false);
});

check('E2 no new frame for 2 s while packets arrive is a freeze, logged once', () => {
    const tracker = new viewerHealth.ViewerTracker();
    tracker.observe({ framesDecoded: 40, packetsReceived: 400, codec: 'video/H264' }, 1000);
    // The frames stop but the packets keep coming: the media flows, the picture is stuck.
    let seen = tracker.observe({ framesDecoded: 40, packetsReceived: 500, codec: 'video/H264' }, 2000);
    assert.equal(seen.freeze, false, 'one second of silence is not yet a freeze');
    seen = tracker.observe({ framesDecoded: 40, packetsReceived: 600, codec: 'video/H264' }, 3500);
    assert.equal(seen.freeze, true, '2.5 s without a frame while packets arrive is a freeze');
    assert.equal(seen.first, true, 'the freeze is logged the first time it is seen');
    assert.ok(seen.reason.includes('no new frame'));
    // The next sample is the same freeze: it is not logged again.
    seen = tracker.observe({ framesDecoded: 40, packetsReceived: 700, codec: 'video/H264' }, 5000);
    assert.equal(seen.freeze, true);
    assert.equal(seen.first, false, 'the same freeze is not logged twice');
});

check('E3 a picture that moves again ends the freeze', () => {
    const tracker = new viewerHealth.ViewerTracker();
    tracker.observe({ framesDecoded: 40, packetsReceived: 400 }, 1000);
    tracker.observe({ framesDecoded: 40, packetsReceived: 500 }, 3500);
    tracker.observe({ framesDecoded: 90, packetsReceived: 900 }, 4000);
    const seen = tracker.observe({ framesDecoded: 130, packetsReceived: 950 }, 9000);
    assert.equal(seen.freeze, false, 'the picture kept moving: no freeze');
});

check('E4 the player saying it saw a freeze is a freeze too', () => {
    const tracker = new viewerHealth.ViewerTracker();
    tracker.observe({ framesDecoded: 40, packetsReceived: 400, freezeCount: 0 }, 1000);
    const seen = tracker.observe({ framesDecoded: 40, packetsReceived: 500, freezeCount: 1 }, 6000);
    assert.equal(seen.freeze, true);
    assert.ok(seen.reason.includes('player'));
});

check('E5 a freeze is counted per stream and reaches the metric', () => {
    viewerHealth.reset();
    const series = [];
    const registry = {
        counter(opts) {
            const s = {};
            const c = {
                name: opts.name,
                inc(labels) {
                    const key = JSON.stringify(labels || {});
                    s[key] = (s[key] || 0) + 1;
                    series.push({ key, count: s[key] });
                },
            };
            return c;
        },
    };
    viewerHealth.attachCounter(registry);
    const total = viewerHealth.noteFreeze({ streamId: 2833, peerId: 'peer-4', codec: 'video/H264', reason: 'no new frame', detail: 'framesDecoded=40' });
    assert.equal(total, 1);
    assert.equal(viewerHealth.streamFreezes(2833), 1);
    assert.equal(viewerHealth.streamFreezes(9999), 0);
    assert.equal(series.length, 1);
    assert.equal(series[0].key, JSON.stringify({ codec: 'video/H264' }));
    assert.equal(series[0].count, 1);
    viewerHealth.noteFreeze({ streamId: 2833, peerId: 'peer-5', codec: 'video/H264' });
    assert.equal(viewerHealth.streamFreezes(2833), 2);
    viewerHealth.reset();
    assert.equal(viewerHealth.streamFreezes(2833), 0);
});

check('E6 a telemetry payload from the browser is cleaned up before it is counted', () => {
    const s = viewerHealth.normalize({ framesDecoded: 'many', packetsLost: 3, codec: 'x'.repeat(200), freezeCount: null });
    assert.equal(s.framesDecoded, null, 'a number that is not a number is dropped');
    assert.equal(s.packetsLost, 3);
    assert.equal(s.codec.length, 32, 'a long codec name is cut');
    assert.equal(s.freezeCount, null);
});

// ── F: the server's rate limit on keyframe asks ─────────────────────────────────────────────────
const broadcastServer = require('../server/streaming/broadcast-server');
const webrtcSFU = require('../server/streaming/webrtc-sfu');
const { WebSocket } = require('ws');

check('F1 one keyframe ask per consumer every 2 s', () => {
    const asked = [];
    const room = {
        consumers: new Map(),
        transports: new Map(),
        producers: new Map(),
    };
    room.consumers.set('c-video', {
        consumer: { kind: 'video', closed: false, requestKeyFrame: async () => { asked.push('c-video'); } },
    });
    room.consumers.set('c-audio', {
        consumer: { kind: 'audio', closed: false, requestKeyFrame: async () => { asked.push('c-audio'); } },
    });
    webrtcSFU.rooms.set('stream-4242', room);
    const sent = [];
    const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => sent.push(JSON.parse(raw)) };
    const client = {
        role: 'viewer', peerId: 'peer-test', streamId: 4242,
        _sfuViewerRoomId: 'stream-4242', _sfuViewerConsumerIds: ['c-video', 'c-audio'],
    };

    broadcastServer._handleSfuViewerKeyframe(ws, client);
    assert.deepEqual(asked, ['c-video'], 'only the video consumer is asked, and only once');

    // Straight away: the 2 s rate limit holds.
    broadcastServer._handleSfuViewerKeyframe(ws, client);
    assert.deepEqual(asked, ['c-video'], 'a second ask inside the window is throttled');
    assert.ok(sent.length === 2);
    assert.equal(sent[1].throttled, 1, 'the viewer is told the ask was throttled');

    // After the window: the ask goes through again.
    const last = client._lastKeyframeAskAt.get('c-video');
    client._lastKeyframeAskAt.set('c-video', last - 2000);
    broadcastServer._handleSfuViewerKeyframe(ws, client);
    assert.deepEqual(asked, ['c-video', 'c-video'], 'after 2 s the ask goes through');
    webrtcSFU.rooms.delete('stream-4242');
});

// ── G: the server's telemetry handler ───────────────────────────────────────────────────────────
check('G1 the server logs one line per freeze and counts it', () => {
    viewerHealth.reset();
    const logged = [];
    const realLog = console.log;
    console.log = (...args) => { logged.push(args.join(' ')); };
    try {
        const sent = [];
        const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => sent.push(JSON.parse(raw)) };
        const client = { role: 'viewer', peerId: 'peer-4', streamId: 2833 };
        broadcastServer._handleSfuViewerTelemetry(ws, client, { data: { framesDecoded: 40, packetsReceived: 400, codec: 'video/H264' } }, 1000);
        // Three seconds later the frames stop but the packets keep coming.
        broadcastServer._handleSfuViewerTelemetry(ws, client, { data: { framesDecoded: 40, packetsReceived: 500, codec: 'video/H264' } }, 4000);
        broadcastServer._handleSfuViewerTelemetry(ws, client, { data: { framesDecoded: 40, packetsReceived: 600, codec: 'video/H264' } }, 7000);

        const freezeLines = logged.filter((l) => l.includes('froze on stream 2833'));
        assert.equal(freezeLines.length, 1, 'the freeze is logged once, not once per sample');
        assert.ok(freezeLines[0].includes('peer-4'));
        assert.ok(freezeLines[0].includes('video/H264'));
        assert.equal(viewerHealth.streamFreezes(2833), 1);
    } finally {
        console.log = realLog;
        viewerHealth.reset();
    }
});

check('G2 a telemetry message that arrives too fast is ignored', () => {
    viewerHealth.reset();
    const logged = [];
    const realLog = console.log;
    console.log = (...args) => { logged.push(args.join(' ')); };
    try {
        const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: () => {} };
        const client = { role: 'viewer', peerId: 'peer-5', streamId: 2834 };
        broadcastServer._handleSfuViewerTelemetry(ws, client, { data: { framesDecoded: 1, packetsReceived: 1, codec: 'video/VP8' } }, 1000);
        broadcastServer._handleSfuViewerTelemetry(ws, client, { data: { framesDecoded: 1, packetsReceived: 2, codec: 'video/VP8' } }, 1500);
        const freezeLines = logged.filter((l) => l.includes('froze on stream 2834'));
        assert.equal(freezeLines.length, 0, 'a flood of telemetry does not invent freezes');
    } finally {
        console.log = realLog;
        viewerHealth.reset();
    }
});

if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nviewer health: all checks passed');
