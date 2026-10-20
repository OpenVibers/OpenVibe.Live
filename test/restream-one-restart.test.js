/**
 * One FFmpeg per restream session (production, 10-19). An audio producer appearing restarted goosely's Twitch
 * restream: the restart and the killed run's exit handler each queued a restart, both fired, the first FFmpeg was
 * orphaned holding the stream key, and Twitch refused every later attempt as a second publisher for 13 minutes.
 *
 *   node test/restream-one-restart.test.js
 */
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

// A fake ffmpeg: killing it closes it on the next tick, like a real one.
const spawned = [];
childProcess.spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.destroy = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.destroy = () => {};
    proc.stdin = { end() {}, destroy() {} };
    proc.killed = false;
    proc.kill = () => { if (!proc.killed) { proc.killed = true; setImmediate(() => proc.emit('close', null)); } return true; };
    spawned.push(proc);
    return proc;
};

process.env.NODE_ENV = 'test';
const logs = [];
console.log = (...a) => logs.push(a.join(' '));
console.warn = (...a) => logs.push(a.join(' '));
console.error = () => {};

const manager = require('../server/streaming/restream-manager');
const scheduled = () => logs.filter((l) => l.includes('Scheduling restart for 7:1')).length;
const tick = () => new Promise((r) => setImmediate(r));

function session() {
    return {
        key: '7:1', streamId: 7, destId: 1, destination: { platform: 'twitch' },
        streamInfo: { protocol: 'webrtc' }, webrtcState: { hasAudio: false },
        status: 'live', restartAttempts: 0, restartDelay: 10_000, restartTimer: null, stableTimer: null,
        process: null, dataTapCleanup: null,
    };
}

(async () => {
    // An audio producer appears: one restart queued, and the killed run's exit adds none.
    const s = session();
    manager.sessions.set(s.key, s);
    manager._spawnFFmpeg(s, ['-i', 'in.sdp', 'rtmp://ingest.example/app/key']);
    const first = s.process;
    assert.ok(first, 'a run is attached');
    s.status = 'live';
    manager._handleAudioProducerAdded('stream-7');
    await tick(); await tick();
    assert.ok(first.killed, 'the run without audio is stopped');
    assert.strictEqual(scheduled(), 1, 'exactly one restart is queued (the stopped run\'s exit queues none)');
    assert.ok(s.restartTimer, 'the restart is pending');
    assert.ok(logs.some((l) => /exited for 7:1 \(stopped for a restart\)/.test(l)), 'the stopped run\'s exit is logged as such');

    // A second request while one is pending changes nothing.
    await manager._scheduleRestart(s);
    assert.strictEqual(scheduled(), 1, 'one pending restart per session');

    // Spawning while a run is somehow still attached stops that run instead of orphaning it.
    clearTimeout(s.restartTimer); s.restartTimer = null;
    manager._spawnFFmpeg(s, ['-i', 'in.sdp', 'rtmp://ingest.example/app/key']);
    const second = s.process;
    manager._spawnFFmpeg(s, ['-i', 'in.sdp', 'rtmp://ingest.example/app/key']);
    assert.ok(second.killed, 'the attached run was stopped before the new one started');
    assert.notStrictEqual(s.process, second);
    await tick(); await tick();
    assert.strictEqual(scheduled(), 1, 'the replaced run\'s exit queues no restart either');

    // A run that dies on its own still restarts.
    const third = s.process;
    s.status = 'live';
    third.emit('close', 1);
    await tick();
    assert.strictEqual(scheduled(), 2, 'a failure of the attached run is restarted');

    s.status = 'stopped';
    manager._killProcess(s);
    manager.sessions.delete(s.key);
    process.stdout.write('✅ restream: one restart and one FFmpeg per session\n');
    process.exit(0);
})().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
