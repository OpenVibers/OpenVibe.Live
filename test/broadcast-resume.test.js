/**
 * Back in front after another app (public/js/broadcast.js _bcResumeAfterBackground; owner, 2026-10-27: "it froze after
 * I switched apps real quick"). A phone gives the camera to the other app; on return the same camera is opened again
 * and swapped in place (_switchActiveCamera force), never a full restart, and only when it is actually stale. The phone
 * watchdog (broadcast-state.js) does nothing while the tab is hidden, and a recovery waits for the tab to be in front.
 *
 *   node test/broadcast-resume.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast.js'), 'utf8');
const fn = (name) => {
    const start = src.search(new RegExp(`(async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
};

function harness({ track, frames, mic, switchFails = false }) {
    const calls = { switched: [], recovery: [], signalling: 0, played: 0, mix: [], status: [] };
    const preview = { srcObject: {}, paused: true, offsetParent: {}, play: async () => { calls.played++; } };
    const env = {
        WebSocket: { OPEN: 1 },
        document: { getElementById: (id) => (id === 'bc-video-preview' ? preview : null) },
        broadcastState: { activeStreamId: 5, settings: { screenShare: false, forceAudio: 'default' } },
        console: { log() {}, warn() {} },
        _trackFrameCount: () => null,
        _getPreferredCameraId: () => 'cam-main',
        connectSignaling: () => { calls.signalling++; },
        updateBroadcastStatus: (s) => calls.status.push(s),
        updateBroadcastStatusFromConnections: () => calls.status.push('from-connections'),
        _switchActiveCamera: async (id, opts) => { calls.switched.push([id, opts]); if (switchFails) throw new Error('NotReadableError'); },
        scheduleMediaRecovery: (id, reason) => calls.recovery.push(reason),
        _getUserMediaWithTimeout: async () => ({ getAudioTracks: () => [{ readyState: 'live' }] }),
        buildAudioConstraints: () => ({}),
        _mixSetSource: (ss, key) => calls.mix.push(key),
    };
    const ss = {
        localStream: { getVideoTracks: () => [track] },
        signalingWs: { readyState: 3 }, signalingReconnectTimer: null, signalingIntentionalClose: false,
        _audioMix: { ctx: { state: 'running' }, mic: mic ? { stream: { getAudioTracks: () => [mic] } } : null },
    };
    env.getActiveStreamState = () => ss;
    // _bcFramesFlowing asks the preview for its next frame: answer as the test says.
    preview.requestVideoFrameCallback = (cb) => { if (frames) setTimeout(cb, 5); };
    const run = new Function(...Object.keys(env), `${fn('_bcFramesFlowing')}\n${fn('_bcResumeAfterBackground')}\nreturn _bcResumeAfterBackground;`)(...Object.values(env));
    return { run, calls, ss };
}

(async () => {
    // A track that ended: the same camera is opened again in place, quietly; the signalling socket comes back now.
    let h = harness({ track: { readyState: 'ended', enabled: true, getSettings: () => ({ deviceId: 'cam-back' }) }, frames: false });
    await h.run(20000);
    assert.deepStrictEqual(h.calls.switched, [['cam-back', { force: true, quiet: true }]]);
    assert.strictEqual(h.calls.recovery.length, 0, 'no full restart');
    assert.strictEqual(h.calls.signalling, 1, 'a closed signalling socket reconnects at once');
    assert.strictEqual(h.calls.played, 1, 'the paused preview plays again');

    // Live but sending nothing (frozen): opened again too.
    h = harness({ track: { readyState: 'live', enabled: true, getSettings: () => ({ deviceId: 'cam-front' }) }, frames: false });
    await h.run(5000);
    assert.deepStrictEqual(h.calls.switched.map((c) => c[0]), ['cam-front']);

    // Frames flowing: nothing is touched.
    h = harness({ track: { readyState: 'live', enabled: true, getSettings: () => ({ deviceId: 'cam-front' }) }, frames: true });
    await h.run(5000);
    assert.deepStrictEqual(h.calls.switched, [], 'a working camera is left alone');

    // A camera the streamer turned off sends nothing on purpose: left alone.
    h = harness({ track: { readyState: 'live', enabled: false, getSettings: () => ({ deviceId: 'cam-front' }) }, frames: false });
    await h.run(5000);
    assert.deepStrictEqual(h.calls.switched, []);

    // The microphone the other app took is opened again into the mix.
    h = harness({ track: { readyState: 'live', enabled: true, getSettings: () => ({}) }, frames: true, mic: { readyState: 'ended', getSettings: () => ({ deviceId: 'mic-1' }) } });
    await h.run(5000);
    assert.deepStrictEqual(h.calls.mix, ['mic']);

    // Reopening fails: the full recovery runs now, its 60 s cooldown cleared (a second app switch used to never recover).
    h = harness({ track: { readyState: 'ended', enabled: true, getSettings: () => ({ deviceId: 'cam-back' }) }, frames: false, switchFails: true });
    h.ss._lastRecoveryCompletedAt = Date.now();
    await h.run(5000);
    assert.deepStrictEqual(h.calls.recovery, ['camera lost while away']);
    assert.strictEqual(h.ss._lastRecoveryCompletedAt, 0, 'the cooldown does not apply');

    // The phone watchdog sits out the background, and a recovery waits for the tab to be in front.
    const state = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-state.js'), 'utf8');
    assert.ok(/if \(mobile && typeof document !== 'undefined' && document\.hidden\) \{\s*lastSuccessfulFrame = Date\.now\(\);/.test(state), 'the watchdog pauses while hidden on a phone');
    assert.ok(src.includes("if (document.hidden && isMobileBroadcaster()) {"), 'a recovery is not started from the background');
    // Chat reconnects the moment the tab is in front.
    const chat = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
    assert.ok(/visibilitychange[\s\S]{0,500}_chatReconnectDelay = CHAT_RECONNECT_BASE;\s*_reconnectChatWs\(chatStreamId \?\? null\);/.test(chat), 'chat reconnects on return');
    console.log('broadcast resume: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
