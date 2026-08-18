/**
 * stream-audio.js — Capture a short audio chunk from a LIVE stream to a wav file,
 * for feeding into speech-to-text. Supports both ingest paths:
 *   - RTMP:  pull the HTTP-FLV output (http://127.0.0.1:<flvPort>/live/<key>.flv)
 *   - WHIP:  create a mediasoup PlainRTP consumer off the live audio producer
 *            (mirrors the thumbnail service's video grabber).
 *
 * Returns a path to a 16kHz mono wav on success, or null. Caller deletes the file.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const db = require('../db/database');

const FLV_PORT = (config.rtmp?.port || 1935) + 8000;

function tmpWav(streamId) {
    return path.join(os.tmpdir(), `openvibe-aihear-${streamId}-${Date.now()}.wav`);
}

function resolveStreamKey(stream) {
    if (stream.managed_stream_key) return stream.managed_stream_key;
    try { return db.getUserById(stream.user_id)?.stream_key || null; } catch { return null; }
}

function runFfmpeg(args, killMs) {
    return new Promise((resolve) => {
        let ff;
        try { ff = spawn('ffmpeg', args, { stdio: 'ignore' }); }
        catch { return resolve(false); }
        const killTimer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, killMs);
        ff.on('close', (code) => { clearTimeout(killTimer); resolve(code === 0); });
        ff.on('error', () => { clearTimeout(killTimer); resolve(false); });
    });
}

async function captureRtmp(stream, seconds) {
    const streamKey = resolveStreamKey(stream);
    if (!streamKey) return null;
    const out = tmpWav(stream.id);
    const url = `http://127.0.0.1:${FLV_PORT}/live/${streamKey}.flv`;
    const ok = await runFfmpeg([
        '-y',
        '-rw_timeout', '10000000',
        '-analyzeduration', '3000000', '-probesize', '2000000',
        '-i', url,
        '-t', String(seconds),
        '-vn', '-ac', '1', '-ar', '16000',
        '-f', 'wav', out,
    ], (seconds + 10) * 1000);
    if (ok && fs.existsSync(out) && fs.statSync(out).size > 1024) return out;
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch {}
    return null;
}

function formatFmtp(params) {
    if (!params || typeof params !== 'object') return '';
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
}

// Open a long-lived mediasoup PlainRTP consumer on the stream's audio producer and write
// the SDP ffmpeg needs to decode it. Shared by the one-shot chunk grab and the continuous
// capture, so there is exactly one copy of the SDP construction.
// Returns { sdpPath, cleanup } or null.
async function _prepareWebrtcSource(stream) {
    let webrtcSFU;
    try { webrtcSFU = require('../streaming/webrtc-sfu'); } catch { return null; }
    const roomId = `stream-${stream.id}`;

    let audioProducer;
    try { audioProducer = await webrtcSFU.waitForProducer(roomId, 'audio', 6000); }
    catch { console.warn(`[AI-Hear] stream ${stream.id}: no audio producer (waitForProducer timeout)`); return null; }
    if (!audioProducer) { console.warn(`[AI-Hear] stream ${stream.id}: no audio producer`); return null; }

    // RTP port range distinct from recorder (25100) and thumbnail (26100). Jitter
    // by a few ports so overlapping captures don't collide on the same UDP port.
    const rtpPort = 26300 + ((stream.id * 2 + Math.floor(Math.random() * 20) * 2) % 300);
    const rtcpPort = rtpPort + 1;

    let consumer;
    try {
        consumer = await webrtcSFU.createPlainConsumer(roomId, audioProducer.id, '127.0.0.1', rtpPort, rtcpPort);
    } catch (e) { console.warn(`[AI-Hear] stream ${stream.id}: plain consumer failed:`, e.message); return null; }

    const pt = consumer.payloadType;
    const codecName = (consumer.mimeType || 'audio/opus').split('/')[1] || 'opus';
    const clockRate = consumer.clockRate || 48000;
    const channels = consumer.channels || 2;
    const aCodec = consumer.rtpParameters?.codecs?.[0] || {};
    const audioProtocol = Array.isArray(aCodec.rtcpFeedback) && aCodec.rtcpFeedback.length > 0 ? 'RTP/AVPF' : 'RTP/AVP';

    // Build the SDP the SAME way the (working) VOD recorder does — including the
    // opus fmtp params and the rtcp line, which ffmpeg needs to decode cleanly.
    const sdpLines = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=OpenVibe.Live AI Hear',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=audio ${rtpPort} ${audioProtocol} ${pt}`,
        `a=rtpmap:${pt} ${codecName}/${clockRate}/${channels}`,
        `a=rtcp:${rtcpPort} IN IP4 127.0.0.1`,
    ];
    if (consumer.ssrc) sdpLines.push(`a=ssrc:${consumer.ssrc} cname:aihear-audio`);
    const fmtp = formatFmtp(consumer.codecParameters);
    if (fmtp) sdpLines.push(`a=fmtp:${pt} ${fmtp}`);
    if (Array.isArray(consumer.headerExtensions)) {
        for (const ext of consumer.headerExtensions) {
            if (ext && ext.uri && ext.id) sdpLines.push(`a=extmap:${ext.id} ${ext.uri}`);
        }
    }
    sdpLines.push('a=recvonly');
    sdpLines.push('');
    const sdpContent = sdpLines.join('\r\n');
    const sdpPath = path.join(os.tmpdir(), `openvibe-aihear-${stream.id}-${Date.now()}.sdp`);

    const cleanup = () => {
        try { webrtcSFU.closePlainConsumer(roomId, consumer.transportId); } catch {}
        try { fs.existsSync(sdpPath) && fs.unlinkSync(sdpPath); } catch {}
    };

    try { fs.writeFileSync(sdpPath, sdpContent, 'utf8'); }
    catch { cleanup(); return null; }
    return { sdpPath, cleanup };
}

// Common ffmpeg input flags for reading an RTP/SDP source. Tolerant of the packet loss and
// timestamp weirdness that shows up on a live ingest.
const SDP_INPUT_ARGS = [
    '-protocol_whitelist', 'file,rtp,udp',
    '-thread_queue_size', '2048',
    '-analyzeduration', '5000000', '-probesize', '5000000',
    '-use_wallclock_as_timestamps', '1',
    '-fflags', '+genpts+discardcorrupt+igndts',
    '-err_detect', 'ignore_err',
];

// Loudness normalisation. Measured capture level on this stream was mean -32.8dB /
// max -4.4dB — plenty of headroom but a low average, which is exactly the signal a
// recogniser struggles with. loudnorm brought a real 60s clip from -31.1dB to -26.2dB.
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';

async function captureWebrtc(stream, seconds) {
    const src = await _prepareWebrtcSource(stream);
    if (!src) return null;
    const { sdpPath, cleanup } = src;
    const out = tmpWav(stream.id);

    const ok = await runFfmpeg([
        '-y', ...SDP_INPUT_ARGS,
        '-i', sdpPath,
        '-t', String(seconds),
        '-vn', '-ac', '1', '-ar', '16000', '-af', LOUDNORM,
        '-f', 'wav', out,
    ], (seconds + 12) * 1000);

    cleanup();
    const size = (ok && fs.existsSync(out)) ? fs.statSync(out).size : 0;
    if (size > 8000) { // >~0.25s of 16k mono; smaller = effectively empty
        // Size proves nothing: WAV is uncompressed, so 12s of pure SILENCE is the same
        // 384KB as 12s of speech. Measure the actual level — an empty transcript on a
        // silent capture is an audio-path bug, on a loud capture it is a model problem,
        // and until now we could not tell the two apart.
        try {
            // volumedetect reports on STDERR, so spawnSync (execFileSync returns stdout).
            const { spawnSync } = require('child_process');
            const r = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'],
                { encoding: 'utf8', timeout: 15000 });
            const err = (r && r.stderr) || '';
            const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
            const max = /max_volume:\s*(-?[\d.]+) dB/.exec(err);
            console.log(`[AI-Hear] stream ${stream.id}: capture level mean=${mean ? mean[1] : '?'}dB max=${max ? max[1] : '?'}dB (${size} bytes)`);
        } catch (e) { console.log(`[AI-Hear] stream ${stream.id}: volumedetect failed: ${e.message}`); }
        return out;
    }
    console.warn(`[AI-Hear] stream ${stream.id}: capture produced ${size} bytes (ffmpeg ok=${ok}) — treating as empty`);
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch {}
    return null;
}

/**
 * Capture ~`seconds` of the stream's audio to a 16kHz mono wav.
 * Picks the ingest path from the stream protocol, with a fallback.
 * @returns {Promise<string|null>} wav path (caller unlinks) or null.
 */
async function captureAudioChunk(stream, seconds = 12) {
    if (!stream) return null;
    const proto = String(stream.protocol || '').toLowerCase();
    try {
        if (proto === 'rtmp') {
            return await captureRtmp(stream, seconds);
        }
        // webrtc/whip (and jsmpeg, which also flows through the SFU room) → try SFU first
        const viaSfu = await captureWebrtc(stream, seconds);
        if (viaSfu) return viaSfu;
        // Fallback: some setups still expose an FLV mirror
        return await captureRtmp(stream, seconds);
    } catch (err) {
        console.warn(`[AI-Hear] audio capture failed for stream ${stream.id}:`, err.message);
        return null;
    }
}

// ── Continuous capture ────────────────────────────────────────────────────────────────
// The old model grabbed a 12s chunk every 120s. Measured against real stream audio that
// captures almost nothing: the stream is only ~13% speech, so sampling 10% of wall-clock
// caught roughly 1% of what was actually said — six of ten sampled slices contained no
// speech at all and produced only a bare "you", which the noise filter then deleted.
//
// Instead run ONE long-lived ffmpeg per stream that writes rolling WAV segments. Latency
// is explicitly not a concern here, so segments are consumed behind live at low priority.
// Cost is bounded by VAD: only the ~13% of audio containing a voice reaches the decoder.
// Segment length is the dominant term in transcription lag: audio at the START of a
// segment cannot be decoded until the whole segment has been written, so a 30s segment
// meant ~30s of latency before whisper even saw it. Shorter segments trade a little
// accuracy — a phrase spanning a boundary gets split in two — for much lower lag.
// 10s is the balance point; most boundaries land in silence anyway, since only ~13% of
// this audio is speech. Tune with AI_HEAR_SEGMENT_SEC.
const SEGMENT_SEC = Math.max(5, Math.min(120, parseInt(process.env.AI_HEAR_SEGMENT_SEC, 10) || 10));
const SPOOL_ROOT = path.join(__dirname, '../../data/asr');
// Hard cap on spooled audio per stream. The box has ~34GB free on a filesystem that
// openvibe.media is actively growing into, so an unbounded spool is not an option.
const MAX_SPOOL_FILES = Math.max(4, parseInt(process.env.AI_HEAR_MAX_SPOOL, 10) || 40);

const _capturing = new Map();   // streamId -> { ff, dir, cleanup, seq }

function spoolDir(streamId) { return path.join(SPOOL_ROOT, String(streamId)); }

function isCapturing(streamId) { return _capturing.has(streamId); }

/**
 * Start continuous audio capture for a live stream. Idempotent.
 * Segments land in data/asr/<streamId>/seg-NNNNNN.wav, each SEGMENT_SEC long, already
 * 16kHz mono and loudness-normalised — i.e. exactly what the recogniser wants.
 * @returns {Promise<boolean>} true if capture is running
 */
async function startContinuousCapture(stream) {
    if (!stream || !stream.id) return false;
    if (_capturing.has(stream.id)) return true;

    const dir = spoolDir(stream.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }

    // Resolve an input the same way the one-shot grab does: WHIP/WebRTC via a plain RTP
    // consumer, RTMP via the local HTTP-FLV output.
    let inputArgs = null;
    let cleanup = () => {};
    const src = await _prepareWebrtcSource(stream).catch(() => null);
    if (src) {
        inputArgs = [...SDP_INPUT_ARGS, '-i', src.sdpPath];
        cleanup = src.cleanup;
    } else {
        const streamKey = resolveStreamKey(stream);
        if (!streamKey) return false;
        inputArgs = ['-thread_queue_size', '2048', '-i', `http://127.0.0.1:${FLV_PORT}/live/${streamKey}.flv`];
    }

    const args = [
        '-y', ...inputArgs,
        '-vn', '-ac', '1', '-ar', '16000', '-af', LOUDNORM,
        '-f', 'segment', '-segment_time', String(SEGMENT_SEC),
        '-reset_timestamps', '0',          // keep timestamps continuous across segments
        '-segment_format', 'wav',
        '-strftime', '0',
        path.join(dir, 'seg-%06d.wav'),
    ];

    let ff;
    try { ff = spawn('ffmpeg', args, { stdio: 'ignore' }); }
    catch { cleanup(); return false; }

    const entry = { ff, dir, cleanup, startedAt: Date.now() };
    _capturing.set(stream.id, entry);
    const onExit = () => {
        if (_capturing.get(stream.id) === entry) _capturing.delete(stream.id);
        try { cleanup(); } catch { /* */ }
    };
    ff.on('close', onExit);
    ff.on('error', onExit);
    console.log(`[AI-Hear] stream ${stream.id}: continuous capture started (${SEGMENT_SEC}s segments → ${dir})`);
    return true;
}

function stopContinuousCapture(streamId) {
    const entry = _capturing.get(streamId);
    if (!entry) return false;
    _capturing.delete(streamId);
    try { entry.ff.kill('SIGKILL'); } catch { /* */ }
    try { entry.cleanup(); } catch { /* */ }
    console.log(`[AI-Hear] stream ${streamId}: continuous capture stopped`);
    return true;
}

function stopAllCaptures() {
    let n = 0;
    for (const id of [..._capturing.keys()]) { if (stopContinuousCapture(id)) n++; }
    return n;
}

/**
 * List finished segments awaiting transcription, oldest first.
 * The most recent file is skipped — ffmpeg is still writing to it.
 * Each entry carries the absolute offset (seconds into the stream) its audio starts at,
 * derived from the segment index, so timeline timestamps stay correct.
 */
function pendingSegments(streamId, { includeLast = false } = {}) {
    const dir = spoolDir(streamId);
    let names;
    try { names = fs.readdirSync(dir).filter(n => /^seg-\d{6}\.wav$/.test(n)).sort(); }
    catch { return []; }
    // Normally the newest file is still being written by ffmpeg, so it is not eligible.
    // Once capture has STOPPED there is no writer, so the final segment is complete and
    // must be included — otherwise the last seconds of every stream are silently dropped.
    if (!includeLast && names.length <= 1) return [];
    const ready = includeLast ? names : names.slice(0, -1);
    // Drop the oldest if the spool has run away (slow transcriber / very long stream).
    const overflow = Math.max(0, ready.length - MAX_SPOOL_FILES);
    for (let i = 0; i < overflow; i++) {
        try { fs.unlinkSync(path.join(dir, ready[i])); } catch { /* */ }
    }
    const startedAt = (_capturing.get(streamId) || {}).startedAt || null;
    return ready.slice(overflow).map(name => {
        const index = parseInt(name.slice(4, 10), 10);
        return {
            name,
            path: path.join(dir, name),
            index,
            offsetSec: index * SEGMENT_SEC,
            // Wall-clock instant this segment's audio ENDED, so the job can report how far
            // behind live the transcript actually is.
            endedAtMs: startedAt ? startedAt + (index + 1) * SEGMENT_SEC * 1000 : null,
        };
    });
}

function discardSegment(streamId, name) {
    try { fs.unlinkSync(path.join(spoolDir(streamId), name)); return true; } catch { return false; }
}

/** Stream ids that currently have a spool directory on disk, live or not. */
function spooledStreamIds() {
    try {
        return fs.readdirSync(SPOOL_ROOT, { withFileTypes: true })
            .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
            .map(d => parseInt(d.name, 10));
    } catch { return []; }
}

/** Remove a stream's whole spool directory (call when the stream ends). */
function purgeSpool(streamId) {
    try { fs.rmSync(spoolDir(streamId), { recursive: true, force: true }); return true; }
    catch { return false; }
}

module.exports = {
    captureAudioChunk,
    startContinuousCapture, stopContinuousCapture, stopAllCaptures, isCapturing,
    pendingSegments, discardSegment, purgeSpool, spoolDir, spooledStreamIds,
    SEGMENT_SEC,
};
