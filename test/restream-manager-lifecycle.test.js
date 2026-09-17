/**
 * ffmpeg restreams: destination URLs, per-transport output flags, human-readable failure text,
 * the progress-based live acknowledgement and the status the dashboard polls.
 *
 *   node test/restream-manager-lifecycle.test.js
 */
'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const manager = require('../server/streaming/restream-manager');
const Manager = manager.constructor;

// ── Destination URLs ─────────────────────────────────────────────────────────────
assert.strictEqual(manager._buildDestUrl({ id: 1, platform: 'custom', server_url: 'rtmp://a.example/live/', stream_key: 'k1' }), 'rtmp://a.example/live/k1');
assert.strictEqual(manager._buildDestUrl({ id: 2, platform: 'twitch', server_url: 'rtmp://live.twitch.tv/app', stream_key: 'k2' }), 'rtmps://live.twitch.tv/app/k2', 'twitch is upgraded to rtmps');
assert.strictEqual(manager._buildDestUrl({ id: 3, platform: 'kick', server_url: 'rtmps://x.kick.com', stream_key: 'k3' }), 'rtmps://x.kick.com/app/k3', 'kick gets /app');
assert.strictEqual(manager._buildDestUrl({ id: 4, platform: 'custom', server_url: 'http://evil/', stream_key: 'k' }), null, 'non-ingest protocols are refused');

const srt = new URL(manager._buildDestUrl({ id: 5, platform: 'custom', server_url: 'srt://ingest.example:9000', stream_key: 'publish/abc', srt_latency_ms: 250, srt_passphrase: 'correct horse battery' }));
assert.strictEqual(srt.protocol, 'srt:');
assert.strictEqual(srt.host, 'ingest.example:9000');
assert.strictEqual(srt.searchParams.get('streamid'), 'publish/abc', 'stream key becomes the streamid');
assert.strictEqual(srt.searchParams.get('latency'), '250000', 'latency in microseconds');
assert.strictEqual(srt.searchParams.get('passphrase'), 'correct horse battery');
assert.strictEqual(srt.searchParams.get('mode'), 'caller');
assert.strictEqual(srt.searchParams.get('pkt_size'), '1316');
const srtDefault = new URL(manager._buildDestUrl({ id: 6, platform: 'custom', server_url: 'srt://h:1?streamid=given', stream_key: 'ignored-when-url-has-one' }));
assert.strictEqual(srtDefault.searchParams.get('streamid'), 'given');
assert.strictEqual(srtDefault.searchParams.get('latency'), '120000', 'libsrt default latency');
assert.ok(!srtDefault.searchParams.has('passphrase'));

// ── Output flags per transport ───────────────────────────────────────────────────
const flv = manager._outputArgs('rtmps://live.twitch.tv/app/k');
assert.ok(flv.includes('flv') && flv.includes('-rtmp_live') && flv.includes('-flush_packets'), 'RTMP → FLV, real-time flags');
const ts = manager._outputArgs('srt://h:1?streamid=x');
assert.ok(ts.includes('mpegts') && !ts.includes('flv') && !ts.includes('-rtmp_live'), 'SRT → MPEG-TS, no RTMP-only flags');
assert.strictEqual(ts[ts.length - 1], 'srt://h:1?streamid=x', 'destination is the last argument (the spawn path masks it by position)');
assert.ok(Manager.isSrtUrl('SRT://x') && !Manager.isSrtUrl('rtmp://x'));

// ── 1x VBV (latency) ─────────────────────────────────────────────────────────────
const presets = Manager.getQualityPresets();
for (const [k, p] of Object.entries(presets)) {
    if (!p.bufsize || !p.videoBitrate) continue;
    assert.strictEqual(p.bufsize, p.videoBitrate, `${k}: bufsize equals bitrate`);
}
const custom = manager._getEncodingArgs(presets.medium, { customOverrides: { videoBitrate: '3000k' } });
assert.strictEqual(custom[custom.indexOf('-bufsize') + 1], '3000k', 'custom bitrate keeps 1x VBV');
assert.strictEqual(custom[custom.indexOf('-preset') + 1], presets.medium.preset);
const withPreset = manager._getEncodingArgs(presets.medium, { customOverrides: { encoderPreset: 'faster' } });
assert.strictEqual(withPreset[withPreset.indexOf('-preset') + 1], 'faster', 'encoder preset override reaches ffmpeg');
assert.deepStrictEqual(manager._getCustomOverrides({ custom_encoder_preset: 'fast', custom_fps: 60 }), { fps: 60, encoderPreset: 'fast' });
assert.deepStrictEqual(manager._getCustomOverrides({ custom_encoder_preset: 'placebo' }), {}, 'unknown preset ignored');

// ── Friendly errors ──────────────────────────────────────────────────────────────
const fe = Manager.friendlyFfmpegError;
assert.match(fe('rtmp://x: Server error: NetStream.Publish.BadName', 'twitch'), /Twitch rejected the stream key/);
assert.match(fe('tcp://x: Connection refused', 'kick'), /Could not connect to Kick/);
assert.match(fe('Failed to resolve hostname live.example: Name or service not known', 'custom'), /resolve the ingest host/);
assert.match(fe('gnutls: The TLS connection was non-properly terminated', 'youtube'), /TLS handshake/);
assert.match(fe('av_interleaved_write_frame(): Broken pipe | End of file', 'twitch'), /closed the connection/);
assert.match(fe('[srt @ 0x1] Wrong password: passphrase', 'custom'), /SRT passphrase/);
assert.strictEqual(fe('', 'custom'), 'Restream process stopped without a message');
assert.ok(fe('x'.repeat(500), 'custom').length <= 160, 'unknown text is truncated');

// ── Status fields ────────────────────────────────────────────────────────────────
manager.sessions.set('1:9', {
    key: '1:9', streamId: 1, destId: 9, destination: { platform: 'custom', server_url: 'srt://h:1' },
    status: 'live', startedAt: Date.now() - 5000, liveAt: Date.now() - 4000, restartAttempts: 2,
    nextRestartAt: null, lastError: null, progress: { fps: 30, bitrate_kbps: 2500.5, speed: 1.0, dropped: 0, frame: 120 },
});
const [st] = manager.getStreamStatus(1);
assert.strictEqual(st.status, 'live');
assert.strictEqual(st.transport, 'srt');
assert.ok(st.uptimeMs >= 3900 && st.uptimeMs < 6000, 'uptime from liveAt');
assert.strictEqual(st.maxRestartAttempts, 30);
assert.deepStrictEqual(st.progress, { fps: 30, bitrate_kbps: 2500.5, speed: 1.0, dropped: 0, frame: 120 });
manager.sessions.delete('1:9');

// ── Progress-based live ACK against a real ffmpeg (skipped when none is installed) ──
(async () => {
    const have = spawnSync('ffmpeg', ['-version']).status === 0;
    if (!have) { console.log = quiet; console.log('restream-manager lifecycle: checks passed (ffmpeg not installed — ACK test skipped)'); process.exit(0); }

    const events = [];
    const session = {
        key: 't:1', streamId: 7, destId: 1, destination: { platform: 'custom', server_url: 'rtmp://x' },
        status: 'starting', process: null, startedAt: null, restartAttempts: 0, restartDelay: 5000,
        restartTimer: null, stableTimer: null, lastError: null, dataTapCleanup: null, streamInfo: { protocol: 'rtmp' },
    };
    manager.sessions.set(session.key, session);
    manager.on('status-change', (e) => { if (e.destId === 1 && e.streamId === 7) events.push(e.status); });
    // A 1-second synthetic source into the null muxer: ffmpeg reports progress with frame>0,
    // which must flip the session to live; exit 0 then makes it idle (not an error/restart).
    manager._spawnFFmpeg(session, ['-hide_banner', '-loglevel', 'warning', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-f', 'null', '-']);
    const proc = session.process;
    assert.ok(proc.spawnargs.includes('-progress') && proc.spawnargs.includes('pipe:1'), 'progress goes to stdout');
    await new Promise((r) => proc.on('close', () => setTimeout(r, 50)));
    assert.deepStrictEqual(events, ['live', 'idle'], `live acknowledged from progress, clean exit → idle (got ${events})`);
    assert.ok(session.progress && session.progress.frame >= 10, `progress captured: ${JSON.stringify(session.progress)}`);
    assert.strictEqual(session.lastError, null);
    manager.sessions.delete(session.key);

    // Failure path: an output that cannot be opened ends with a friendly error and a scheduled restart.
    const bad = { ...session, key: 't:2', destId: 2, status: 'starting', process: null, progress: null, destination: { platform: 'custom', server_url: 'rtmp://127.0.0.1:1' } };
    manager.sessions.set(bad.key, bad);
    manager._spawnFFmpeg(bad, ['-hide_banner', '-loglevel', 'warning', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'flv', 'rtmp://127.0.0.1:1/live/k']);
    await new Promise((r) => bad.process.on('close', () => setTimeout(r, 50)));
    assert.strictEqual(bad.status, 'error');
    assert.match(bad.lastError, /Could not connect to the destination/, bad.lastError);
    assert.ok(bad.restartTimer, 'restart scheduled');
    assert.ok(bad.nextRestartAt > Date.now(), 'dashboard can count down to the retry');
    bad.status = 'stopped'; clearTimeout(bad.restartTimer); manager.sessions.delete(bad.key);

    console.log = quiet;
    console.log('restream-manager lifecycle: all checks passed');
    process.exit(0);
})().catch((err) => { console.log = quiet; console.error = process.stderr.write.bind(process.stderr); console.error(err.stack + '\n'); process.exit(1); });
