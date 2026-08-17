/**
 * stream-vision.js — Grab a single video frame from a LIVE stream as a base64
 * JPEG (data URL), for feeding into a vision-capable AI model so bots know what
 * is visibly happening on screen. Mirrors stream-audio.js: RTMP via HTTP-FLV,
 * WHIP via a mediasoup PlainRTP video consumer (same path the thumbnail uses).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const db = require('../db/database');

const FLV_PORT = (config.rtmp?.port || 1935) + 8000;
const FRAME_WIDTH = 640;

function tmpJpg(streamId) {
    return path.join(os.tmpdir(), `openvibe-aisee-${streamId}-${Date.now()}.jpg`);
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

function jpgToDataUrl(filePath) {
    try {
        const buf = fs.readFileSync(filePath);
        if (!buf || buf.length < 512) return null;
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch { return null; }
}

function formatFmtp(params) {
    if (!params || typeof params !== 'object') return '';
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
}

async function captureRtmp(stream) {
    const streamKey = resolveStreamKey(stream);
    if (!streamKey) return null;
    const out = tmpJpg(stream.id);
    const url = `http://127.0.0.1:${FLV_PORT}/live/${streamKey}.flv`;
    const ok = await runFfmpeg([
        '-y', '-rw_timeout', '10000000',
        '-analyzeduration', '3000000', '-probesize', '3000000',
        '-i', url,
        '-frames:v', '1', '-vf', `scale=${FRAME_WIDTH}:-1`, '-q:v', '5',
        out,
    ], 15000);
    const data = ok ? jpgToDataUrl(out) : null;
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch {}
    return data;
}

async function captureWebrtc(stream) {
    let webrtcSFU;
    try { webrtcSFU = require('../streaming/webrtc-sfu'); } catch { return null; }
    const roomId = `stream-${stream.id}`;

    let videoProducer;
    try { videoProducer = await webrtcSFU.waitForProducer(roomId, 'video', 6000); }
    catch { console.warn(`[AI-See] stream ${stream.id}: no video producer`); return null; }
    if (!videoProducer) return null;

    const rtpPort = 26700 + ((stream.id * 2 + Math.floor(Math.random() * 20) * 2) % 300);
    const rtcpPort = rtpPort + 1;

    let consumer;
    try {
        consumer = await webrtcSFU.createPlainConsumer(roomId, videoProducer.id, '127.0.0.1', rtpPort, rtcpPort);
    } catch (e) { console.warn(`[AI-See] stream ${stream.id}: plain consumer failed:`, e.message); return null; }

    const pt = consumer.payloadType;
    const codecName = (consumer.mimeType || 'video/VP8').split('/')[1] || 'VP8';
    const clockRate = consumer.clockRate || 90000;
    const vCodec = consumer.rtpParameters?.codecs?.[0] || {};
    const proto = Array.isArray(vCodec.rtcpFeedback) && vCodec.rtcpFeedback.length > 0 ? 'RTP/AVPF' : 'RTP/AVP';

    const sdpLines = [
        'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=OpenVibe.Live AI See',
        'c=IN IP4 127.0.0.1', 't=0 0',
        `m=video ${rtpPort} ${proto} ${pt}`,
        `a=rtpmap:${pt} ${codecName}/${clockRate}`,
        `a=rtcp:${rtcpPort} IN IP4 127.0.0.1`,
    ];
    if (consumer.ssrc) sdpLines.push(`a=ssrc:${consumer.ssrc} cname:aisee-video`);
    const fmtp = formatFmtp(consumer.codecParameters);
    if (fmtp) sdpLines.push(`a=fmtp:${pt} ${fmtp}`);
    if (Array.isArray(vCodec.rtcpFeedback)) {
        for (const fb of vCodec.rtcpFeedback) {
            if (fb && fb.type) sdpLines.push(`a=rtcp-fb:${pt} ${fb.type}${fb.parameter ? ` ${fb.parameter}` : ''}`);
        }
    }
    if (Array.isArray(consumer.headerExtensions)) {
        for (const ext of consumer.headerExtensions) {
            if (ext && ext.uri && ext.id) sdpLines.push(`a=extmap:${ext.id} ${ext.uri}`);
        }
    }
    sdpLines.push('a=recvonly');
    sdpLines.push('');
    const sdpPath = path.join(os.tmpdir(), `openvibe-aisee-${stream.id}-${Date.now()}.sdp`);
    const out = tmpJpg(stream.id);
    const cleanup = () => {
        try { webrtcSFU.closePlainConsumer(roomId, consumer.transportId); } catch {}
        try { fs.existsSync(sdpPath) && fs.unlinkSync(sdpPath); } catch {}
    };

    try { fs.writeFileSync(sdpPath, sdpLines.join('\r\n'), 'utf8'); }
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
        '-frames:v', '1', '-vf', `scale=${FRAME_WIDTH}:-1`, '-q:v', '5',
        out,
    ], 12000);

    cleanup();
    const data = ok ? jpgToDataUrl(out) : null;
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch {}
    if (!data) console.warn(`[AI-See] stream ${stream.id}: frame capture empty (ffmpeg ok=${ok})`);
    return data;
}

/**
 * Capture one frame from the live stream as a base64 JPEG data URL (or null).
 */
async function captureFrame(stream) {
    if (!stream) return null;
    const proto = String(stream.protocol || '').toLowerCase();
    try {
        if (proto === 'rtmp') return await captureRtmp(stream);
        const viaSfu = await captureWebrtc(stream);
        if (viaSfu) return viaSfu;
        return await captureRtmp(stream);
    } catch (err) {
        console.warn(`[AI-See] frame capture failed for stream ${stream.id}:`, err.message);
        return null;
    }
}

module.exports = { captureFrame };
