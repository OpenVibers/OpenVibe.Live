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
const { allocateRtpPair } = require('../streaming/rtp-ports');
const db = require('../db/database');

const FLV_PORT = (config.rtmp?.port || 1935) + 8000;

function tmpWav(streamId) {
    return path.join(os.tmpdir(), `openvibe-aihear-${streamId}-${Date.now()}.wav`);
}

async function resolveStreamKey(stream) {
    if (stream.managed_stream_key) return stream.managed_stream_key;
    try { return (await db.getUserById(stream.user_id))?.stream_key || null; } catch { return null; }
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
    const streamKey = await resolveStreamKey(stream);
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

    // RTP port range distinct from recorder (25100) and thumbnail (26100). Probe for a
    // genuinely free pair rather than deriving one from stream.id — the old arithmetic
    // jittered across only 20 slots and never checked, so overlapping captures could aim
    // mediasoup at a socket another capture already owned.
    let rtpPort, rtcpPort;
    try { ({ rtpPort, rtcpPort } = await allocateRtpPair(26300)); }
    catch (e) { console.warn(`[AI-Hear] stream ${stream.id}: ${e.message}`); return null; }

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
    return { sdpPath, cleanup, producerId: audioProducer.id };
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
const SPOOL_ROOT = require('../paths').data('asr');
// Hard cap on spooled audio per stream. The box has ~34GB free on a filesystem that
// openvibe.media is actively growing into, so an unbounded spool is not an option.
const MAX_SPOOL_FILES = Math.max(4, parseInt(process.env.AI_HEAR_MAX_SPOOL, 10) || 40);

const _capturing = new Map();   // streamId -> { ff, dir, cleanup, startedAt, producerId, firstIndex }
// Streams whose spool this process has started: only the first start drops leftover segments (a previous process's,
// numbered from 0 again); a restart in this process continues the numbering and keeps what was captured.
const _startedHere = new Set();
// streamId → [{ firstIndex, baseSec }]: each capture run's first segment number and when it began in stream time
// (seconds since streams.started_at). A capture that restarts (the broadcaster reconnected) numbers on from the last
// segment, but the seconds it missed are not in any segment: offsets counted from the index alone fell behind the
// stream by every gap, and started a few seconds after it went live. With each run's start, a segment's offset is
// stream time, the time the stream's history measures recording parts in (streaming/stream-history.js).
const _runs = new Map();
function noteRun(streamId, firstIndex, baseSec) {
    if (baseSec == null) return;
    const runs = (_runs.get(streamId) || []).filter((r) => r.firstIndex < firstIndex);
    runs.push({ firstIndex, baseSec });
    _runs.set(streamId, runs);
}
// ffmpeg that ends soon after it started (no RTP from a dead producer, an input it cannot probe) is retried after a
// growing pause instead of every timeline tick, and logged once per streak with its last error line.
const _retry = new Map();       // streamId -> { at, delayMs, fails, reason }
const RETRY_MIN_MS = 20_000, RETRY_MAX_MS = 5 * 60_000, SHORT_RUN_MS = 60_000;

function spoolDir(streamId) { return path.join(SPOOL_ROOT, String(streamId)); }

function isCapturing(streamId) { return _capturing.has(streamId); }

function _segmentIndexes(dir) {
    try { return fs.readdirSync(dir).filter(n => /^seg-\d{6}\.wav$/.test(n)).map(n => parseInt(n.slice(4, 10), 10)); }
    catch { return []; }
}

// A broadcaster who produces audio again on a new transport (a phone changing networks) leaves the capture reading
// the old, dead producer: stop it so the next timeline tick starts again on the new one (webrtc-sfu picks it).
let _producerWatch = null;
function _watchProducers() {
    if (_producerWatch) return;
    let webrtcSFU;
    try { webrtcSFU = require('../streaming/webrtc-sfu'); } catch { return; }
    _producerWatch = ({ roomId, producerId, kind }) => {
        if (kind !== 'audio') return;
        const m = /^stream-(\d+)$/.exec(String(roomId || ''));
        const entry = m && _capturing.get(Number(m[1]));
        if (!entry || !entry.producerId || entry.producerId === producerId) return;
        console.log(`[AI-Hear] stream ${m[1]}: the broadcaster produced audio again — moving capture to the new producer`);
        _retry.delete(Number(m[1]));
        stopContinuousCapture(Number(m[1]), { quiet: true });
    };
    webrtcSFU.on('producer-added', _producerWatch);
}

/**
 * Start continuous audio capture for a live stream. Idempotent.
 * Segments land in data/asr/<streamId>/seg-NNNNNN.wav, each SEGMENT_SEC long, already
 * 16kHz mono and loudness-normalised — i.e. exactly what the recogniser wants.
 * @returns {Promise<boolean>} true if capture is running
 */
async function startContinuousCapture(stream) {
    if (!stream || !stream.id) return false;
    if (_capturing.has(stream.id)) return true;
    const retry = _retry.get(stream.id);
    if (retry && Date.now() < retry.at) return false;
    _watchProducers();

    const dir = spoolDir(stream.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }
    // A previous process (deploy restart) may have left segments here. Their indexes
    // restart at 0 for the new ffmpeg, so old files would be mis-ordered against new ones
    // — the "newest file is still being written" rule then skipped a stale file and fed a
    // half-written one to whisper. Drop them; the VOD transcript covers that audio.
    // A restart within this process instead numbers on from the last segment, so the audio
    // the previous ffmpeg wrote is still transcribed (on 2026-10-22 a capture restarting
    // every 22 s dropped its own segment each time).
    let firstIndex = 0;
    if (!_startedHere.has(stream.id)) {
        _runs.delete(stream.id);
        try {
            const stale = fs.readdirSync(dir).filter(n => /^seg-\d{6}\.wav$/.test(n));
            for (const n of stale) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* */ } }
            if (stale.length) console.log(`[AI-Hear] stream ${stream.id}: dropped ${stale.length} stale spool segment(s) from a previous run`);
        } catch { /* */ }
    } else {
        const indexes = _segmentIndexes(dir);
        if (indexes.length) firstIndex = Math.max(...indexes) + 1;
    }

    // Resolve an input the same way the one-shot grab does: WHIP/WebRTC via a plain RTP
    // consumer, RTMP via the local HTTP-FLV output.
    let inputArgs = null;
    let cleanup = () => {};
    let producerId = null;
    const src = await _prepareWebrtcSource(stream).catch(() => null);
    if (src) {
        inputArgs = [...SDP_INPUT_ARGS, '-i', src.sdpPath];
        cleanup = src.cleanup;
        producerId = src.producerId;
    } else {
        const streamKey = await resolveStreamKey(stream);
        if (!streamKey) return false;
        inputArgs = ['-thread_queue_size', '2048', '-i', `http://127.0.0.1:${FLV_PORT}/live/${streamKey}.flv`];
    }

    const args = [
        '-y', ...inputArgs,
        '-vn', '-ac', '1', '-ar', '16000', '-af', LOUDNORM,
        '-f', 'segment', '-segment_time', String(SEGMENT_SEC),
        '-segment_start_number', String(firstIndex),
        '-reset_timestamps', '0',          // keep timestamps continuous across segments
        '-segment_format', 'wav',
        '-strftime', '0',
        path.join(dir, 'seg-%06d.wav'),
    ];

    let ff;
    try { ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { cleanup(); return false; }

    const entry = { ff, dir, cleanup, startedAt: Date.now(), producerId, firstIndex };
    _capturing.set(stream.id, entry);
    _startedHere.add(stream.id);
    noteRun(stream.id, firstIndex, require('../streaming/stream-history').streamSeconds(stream, entry.startedAt));
    let lastErr = '';
    ff.stderr.on('data', (d) => { const lines = String(d).trim().split('\n'); lastErr = (lines[lines.length - 1] || lastErr).slice(0, 200); });
    let exited = false;
    const onExit = (code) => {
        if (exited) return;
        exited = true;
        const mine = _capturing.get(stream.id) === entry;
        if (mine) _capturing.delete(stream.id);
        try { cleanup(); } catch { /* */ }
        if (!mine || entry.stopped) return;
        // ffmpeg ended by itself while the stream is live: pause before the next try when it did not last.
        const ran = Date.now() - entry.startedAt;
        const prev = _retry.get(stream.id);
        if (ran >= SHORT_RUN_MS) { _retry.delete(stream.id); return; }
        const delayMs = prev ? Math.min(RETRY_MAX_MS, prev.delayMs * 2) : RETRY_MIN_MS;
        const reason = lastErr || (typeof code === 'number' ? `exit ${code}` : String(code || 'ended'));
        _retry.set(stream.id, { at: Date.now() + delayMs, delayMs, fails: (prev ? prev.fails : 0) + 1, reason });
        if (!prev || prev.reason !== reason) console.warn(`[AI-Hear] stream ${stream.id}: capture ended after ${Math.round(ran / 1000)}s (${reason}); retrying in ${Math.round(delayMs / 1000)}s, then less often`);
    };
    ff.on('close', onExit);
    ff.on('error', (e) => onExit(e && e.message));
    if (!retry) console.log(`[AI-Hear] stream ${stream.id}: continuous capture started (${SEGMENT_SEC}s segments → ${dir})`);
    return true;
}

function stopContinuousCapture(streamId, { quiet = false } = {}) {
    const entry = _capturing.get(streamId);
    if (!entry) return false;
    entry.stopped = true;
    _capturing.delete(streamId);
    try { entry.ff.kill('SIGKILL'); } catch { /* */ }
    try { entry.cleanup(); } catch { /* */ }
    if (!quiet) console.log(`[AI-Hear] stream ${streamId}: continuous capture stopped`);
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
    if (overflow) console.warn(`[AI-Hear] stream ${streamId}: transcriber ${overflow * SEGMENT_SEC}s behind — dropped ${overflow} oldest segment(s)`);
    const cur = _capturing.get(streamId) || {};
    const startedAt = cur.startedAt || null;
    const firstIndex = cur.firstIndex || 0;
    const runs = _runs.get(streamId) || [];
    return ready.slice(overflow).map(name => {
        const index = parseInt(name.slice(4, 10), 10);
        let run = null;
        for (const r of runs) if (r.firstIndex <= index) run = r;
        return {
            name,
            path: path.join(dir, name),
            index,
            offsetSec: run ? Math.round((run.baseSec + (index - run.firstIndex) * SEGMENT_SEC) * 10) / 10 : index * SEGMENT_SEC,
            // Wall-clock instant this segment's audio ENDED, so the job can report how far
            // behind live the transcript actually is.
            endedAtMs: startedAt && index >= firstIndex ? startedAt + (index - firstIndex + 1) * SEGMENT_SEC * 1000 : null,
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
    _startedHere.delete(streamId);
    _runs.delete(streamId);
    _retry.delete(streamId);
    try { fs.rmSync(spoolDir(streamId), { recursive: true, force: true }); return true; }
    catch { return false; }
}

module.exports = {
    captureAudioChunk,
    startContinuousCapture, stopContinuousCapture, stopAllCaptures, isCapturing,
    pendingSegments, discardSegment, purgeSpool, spoolDir, spooledStreamIds,
    SEGMENT_SEC, _noteRun: noteRun,
};
