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

async function captureWebrtc(stream, seconds) {
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
    const out = tmpWav(stream.id);

    const cleanup = () => {
        try { webrtcSFU.closePlainConsumer(roomId, consumer.transportId); } catch {}
        try { fs.existsSync(sdpPath) && fs.unlinkSync(sdpPath); } catch {}
    };

    try { fs.writeFileSync(sdpPath, sdpContent, 'utf8'); }
    catch { cleanup(); return null; }

    const ok = await runFfmpeg([
        '-y',
        '-protocol_whitelist', 'file,rtp,udp',
        '-thread_queue_size', '2048',
        '-analyzeduration', '5000000', '-probesize', '5000000',
        '-use_wallclock_as_timestamps', '1',
        '-fflags', '+genpts+discardcorrupt+igndts',
        '-err_detect', 'ignore_err',
        '-i', sdpPath,
        '-t', String(seconds),
        '-vn', '-ac', '1', '-ar', '16000',
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

module.exports = { captureAudioChunk };
