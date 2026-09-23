/**
 * OpenVibe.Live — live-stream thumbnails (Live-local, ephemeral)
 *
 * VOD/clip/paste thumbnails moved to OpenVibe.Media, but LIVE stream thumbnails
 * are transient live-state (refreshed every ~2 min, deleted an hour after the
 * stream ends), so they stay local: captured here (client canvas POST, RTMP FLV
 * grab, or JSMPEG relay tap), written to data/live-thumbs/, and served from
 * /api/thumbnails/stream-<id>-<ts>.jpg by the thumbnails proxy router.
 *
 * Also exports extractFrameToFile() — the shared ffmpeg one-frame extractor the
 * AI jobs use (accepts local paths OR http(s) URLs, e.g. Media playback URLs).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const config = require('../config');
const db = require('../db/database');

const THUMB_DIR = require('../paths').dir('LIVE_THUMBS_PATH', 'live-thumbs');
const THUMB_WIDTH = 640;
const THUMB_QUALITY = 6;
const LIVE_THUMB_MIN_INTERVAL_MS = 120000;
const CLIENT_THUMB_WRITE_MIN_INTERVAL_MS = 15000;
const activeLiveThumbnailJobs = new Set();

if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

function getStreamThumbnailState(streamId) {
    const row = db.get('SELECT thumbnail_url FROM streams WHERE id = ?', [streamId]);
    const thumbUrl = row?.thumbnail_url || null;
    if (!thumbUrl) return { thumbUrl: null, filePath: null, exists: false, ageMs: Infinity };
    const filePath = path.join(THUMB_DIR, path.basename(thumbUrl));
    if (!fs.existsSync(filePath)) return { thumbUrl, filePath, exists: false, ageMs: Infinity };
    const stat = fs.statSync(filePath);
    return { thumbUrl, filePath, exists: true, ageMs: Date.now() - stat.mtimeMs };
}

function shouldRefreshLiveThumbnail(streamId, minAgeMs = LIVE_THUMB_MIN_INTERVAL_MS) {
    const state = getStreamThumbnailState(streamId);
    return !state.exists || state.ageMs >= minAgeMs;
}

function getCurrentLiveThumbnailUrl(streamId) {
    return getStreamThumbnailState(streamId).thumbUrl || null;
}

function _replaceThumb(streamId, filename) {
    const oldThumb = db.get('SELECT thumbnail_url FROM streams WHERE id = ?', [streamId]);
    if (oldThumb?.thumbnail_url) {
        const oldFile = path.join(THUMB_DIR, path.basename(oldThumb.thumbnail_url));
        if (fs.existsSync(oldFile)) { try { fs.unlinkSync(oldFile); } catch { /* */ } }
    }
    const thumbUrl = `/api/thumbnails/${filename}`;
    db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', [thumbUrl, streamId]);
    return thumbUrl;
}

/** Save a broadcaster-posted live thumbnail (Buffer or base64 JPEG/PNG string). */
function saveLiveThumbnail(streamId, imageData) {
    try {
        const current = getStreamThumbnailState(streamId);
        if (current.exists && current.ageMs < CLIENT_THUMB_WRITE_MIN_INTERVAL_MS) {
            return current.thumbUrl;
        }
        let buffer;
        if (Buffer.isBuffer(imageData)) buffer = imageData;
        else if (typeof imageData === 'string') {
            buffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        } else return null;
        // Validate JPEG (FF D8) or PNG (89 50)
        if (buffer.length < 4 || !((buffer[0] === 0xFF && buffer[1] === 0xD8) || (buffer[0] === 0x89 && buffer[1] === 0x50))) {
            console.warn('[Thumbnails] Invalid image data for stream', streamId);
            return null;
        }
        const filename = `stream-${streamId}-${Date.now()}.jpg`;
        fs.writeFileSync(path.join(THUMB_DIR, filename), buffer);
        return _replaceThumb(streamId, filename);
    } catch (err) {
        console.error('[Thumbnails] Save live thumbnail error:', err.message);
        return null;
    }
}

/** Grab one frame from an RTMP stream's local HTTP-FLV endpoint. */
function generateLiveStreamThumbnail(streamId, streamKey, opts = {}) {
    return new Promise((resolve) => {
        const minAgeMs = Number.isFinite(opts.minAgeMs) ? opts.minAgeMs : LIVE_THUMB_MIN_INTERVAL_MS;
        if (!shouldRefreshLiveThumbnail(streamId, minAgeMs)) return resolve(getCurrentLiveThumbnailUrl(streamId));
        const jobKey = `rtmp:${streamId}`;
        if (activeLiveThumbnailJobs.has(jobKey)) return resolve(getCurrentLiveThumbnailUrl(streamId));
        activeLiveThumbnailJobs.add(jobKey);

        const rtmpHttpPort = opts.rtmpHttpPort || ((config.rtmp?.port || 1935) + 8000);
        const flvUrl = `http://127.0.0.1:${rtmpHttpPort}/live/${streamKey}.flv`;
        const filename = `stream-${streamId}-${Date.now()}.jpg`;
        const outPath = path.join(THUMB_DIR, filename);
        const ff = spawn('ffmpeg', [
            '-y', '-i', flvUrl, '-vframes', '1',
            '-vf', `scale=${THUMB_WIDTH}:-1`, '-q:v', String(THUMB_QUALITY), outPath,
        ], { stdio: 'ignore' });
        const killTimer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 8000);
        ff.on('close', (code) => {
            activeLiveThumbnailJobs.delete(jobKey);
            clearTimeout(killTimer);
            if (code === 0 && fs.existsSync(outPath)) return resolve(_replaceThumb(streamId, filename));
            if (fs.existsSync(outPath)) { try { fs.unlinkSync(outPath); } catch { /* */ } }
            resolve(null);
        });
        ff.on('error', () => { activeLiveThumbnailJobs.delete(jobKey); clearTimeout(killTimer); resolve(null); });
    });
}

/**
 * Grab one frame from a WebRTC / WHIP stream straight out of the SFU: a short-lived
 * PlainRTP consumer feeds ffmpeg over loopback, ffmpeg writes one JPEG and exits. No
 * dependency on the broadcaster's browser tab (hidden tabs and OBS/WHIP send nothing) and
 * none on the recording (which can be refused when the disk is low).
 */
let _rtpPort = 31000;
function _nextRtpPort() { const p = _rtpPort; _rtpPort += 2; if (_rtpPort > 31900) _rtpPort = 31000; return p; }
function generateWebrtcThumbnail(streamId, opts = {}) {
    return new Promise(async (resolve) => {
        const minAgeMs = Number.isFinite(opts.minAgeMs) ? opts.minAgeMs : LIVE_THUMB_MIN_INTERVAL_MS;
        if (!shouldRefreshLiveThumbnail(streamId, minAgeMs)) return resolve(getCurrentLiveThumbnailUrl(streamId));
        const jobKey = `webrtc:${streamId}`;
        if (activeLiveThumbnailJobs.has(jobKey)) return resolve(getCurrentLiveThumbnailUrl(streamId));
        let sfu; try { sfu = require('../streaming/webrtc-sfu'); } catch { return resolve(null); }
        const roomId = `stream-${streamId}`;
        const producer = (() => { try { return sfu.findProducerByKind(roomId, 'video'); } catch { return null; } })();
        if (!producer) return resolve(null);
        activeLiveThumbnailJobs.add(jobKey);
        const port = _nextRtpPort();
        const filename = `stream-${streamId}-${Date.now()}.jpg`;
        const outPath = path.join(THUMB_DIR, filename);
        const sdpPath = path.join(require('os').tmpdir(), `openvibe-thumb-${streamId}-${port}.sdp`);
        let consumer = null;
        const finish = (ok) => {
            activeLiveThumbnailJobs.delete(jobKey);
            try { if (consumer) sfu.closePlainConsumer(roomId, consumer.transportId); } catch { /* */ }
            try { fs.unlinkSync(sdpPath); } catch { /* */ }
            if (ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 2000) return resolve(_replaceThumb(streamId, filename));
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* */ }
            resolve(null);
        };
        try {
            consumer = await sfu.createPlainConsumer(roomId, producer.id, '127.0.0.1', port, port + 1);
        } catch (e) { console.warn(`[Thumbnails] webrtc grab: consumer failed for stream ${streamId}:`, e.message); return finish(false); }
        const pt = consumer.payloadType, codec = (consumer.mimeType || 'video/VP8').split('/')[1];
        const fmtp = consumer.codecParameters ? Object.entries(consumer.codecParameters).map(([k, v]) => `${k}=${v}`).join(';') : '';
        const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=OpenVibe.Live thumbnail', 'c=IN IP4 127.0.0.1', 't=0 0',
            `m=video ${port} RTP/AVP ${pt}`, `a=rtpmap:${pt} ${codec}/${consumer.clockRate}`,
            consumer.ssrc ? `a=ssrc:${consumer.ssrc} cname:thumb` : '', fmtp ? `a=fmtp:${pt} ${fmtp}` : '', 'a=recvonly', ''].filter(l => l !== '').join('\n') + '\n';
        try { fs.writeFileSync(sdpPath, sdp, 'utf8'); } catch { return finish(false); }
        // Only a frame decoded from a KEYFRAME may become the thumbnail: the first packets a fresh
        // consumer sees are delta frames with no reference, and decoding those gives the smeared,
        // streaky garbage that showed up on live cards. `-skip_frame nokey` drops everything until
        // the keyframe the consumer requests on creation arrives (≈0–3 s); corrupt/partial frames
        // are discarded too. Then take the SECOND keyframe-decoded output when we can (the first
        // can still be a partial keyframe after packet loss), falling back to the first.
        const ff = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,rtp,udp',
            '-analyzeduration', '4000000', '-probesize', '4000000', '-reorder_queue_size', '512',
            '-fflags', '+discardcorrupt', '-skip_frame', 'nokey', '-err_detect', 'crccheck+bitstream+buffer',
            '-i', sdpPath, '-vsync', '0', '-frames:v', '2', '-vf', `scale=${THUMB_WIDTH}:-1`, '-q:v', String(THUMB_QUALITY), outPath.replace(/\.jpg$/, '-%d.jpg'),
        ], { stdio: 'ignore' });
        const killTimer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 16000);
        const pick = () => {
            // Prefer the 2nd keyframe-decoded frame; accept the 1st; nothing → fail.
            const base = outPath.replace(/\.jpg$/, '');
            const second = `${base}-2.jpg`, first = `${base}-1.jpg`;
            try {
                if (fs.existsSync(second) && fs.statSync(second).size > 2000) { fs.renameSync(second, outPath); try { fs.unlinkSync(first); } catch { /* */ } return true; }
                if (fs.existsSync(first) && fs.statSync(first).size > 2000) { fs.renameSync(first, outPath); return true; }
            } catch { /* */ }
            try { fs.unlinkSync(first); } catch { /* */ } try { fs.unlinkSync(second); } catch { /* */ }
            return false;
        };
        ff.on('close', () => { clearTimeout(killTimer); finish(pick()); });
        ff.on('error', () => { clearTimeout(killTimer); finish(false); });
    });
}

/** Grab one frame from a JSMPEG stream by tapping the relay WebSocket. */
function generateJSMPEGThumbnail(streamId, videoPort) {
    return new Promise((resolve) => {
        if (!shouldRefreshLiveThumbnail(streamId, LIVE_THUMB_MIN_INTERVAL_MS)) return resolve(getCurrentLiveThumbnailUrl(streamId));
        const jobKey = `jsmpeg:${streamId}`;
        if (activeLiveThumbnailJobs.has(jobKey)) return resolve(getCurrentLiveThumbnailUrl(streamId));
        activeLiveThumbnailJobs.add(jobKey);

        const filename = `stream-${streamId}-${Date.now()}.jpg`;
        const outPath = path.join(THUMB_DIR, filename);
        let ws;
        try { ws = new WebSocket(`ws://127.0.0.1:${videoPort}`); } catch { activeLiveThumbnailJobs.delete(jobKey); return resolve(null); }
        ws.binaryType = 'arraybuffer';
        const chunks = [];
        let totalBytes = 0;
        const MAX_BYTES = 512 * 1024;
        const killTimer = setTimeout(() => { try { ws.close(); } catch { /* */ } }, 6000);
        ws.on('message', (data) => {
            if (data instanceof ArrayBuffer) data = Buffer.from(data);
            chunks.push(data);
            totalBytes += data.length;
            if (totalBytes >= MAX_BYTES) { try { ws.close(); } catch { /* */ } }
        });
        ws.on('error', () => { activeLiveThumbnailJobs.delete(jobKey); clearTimeout(killTimer); resolve(null); });
        ws.on('close', () => {
            clearTimeout(killTimer);
            if (!chunks.length) { activeLiveThumbnailJobs.delete(jobKey); return resolve(null); }
            const ff = spawn('ffmpeg', [
                '-y', '-f', 'mpegts', '-i', 'pipe:0', '-vframes', '1',
                '-vf', `scale=${THUMB_WIDTH}:-1`, '-q:v', String(THUMB_QUALITY), outPath,
            ], { stdio: ['pipe', 'ignore', 'ignore'] });
            for (const chunk of chunks) { try { ff.stdin.write(chunk); } catch { /* */ } }
            try { ff.stdin.end(); } catch { /* */ }
            const ffKill = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 5000);
            ff.on('close', (code) => {
                activeLiveThumbnailJobs.delete(jobKey);
                clearTimeout(ffKill);
                if (code === 0 && fs.existsSync(outPath)) return resolve(_replaceThumb(streamId, filename));
                if (fs.existsSync(outPath)) { try { fs.unlinkSync(outPath); } catch { /* */ } }
                resolve(null);
            });
            ff.on('error', () => { activeLiveThumbnailJobs.delete(jobKey); clearTimeout(ffKill); resolve(null); });
        });
    });
}

/** Remove live-stream thumbnails older than maxAgeMs (default 1h). */
function cleanupOldThumbnails(maxAgeMs = 3600000) {
    try {
        const files = fs.readdirSync(THUMB_DIR);
        const now = Date.now();
        let cleaned = 0;
        for (const file of files) {
            if (!file.startsWith('stream-')) continue;
            const filePath = path.join(THUMB_DIR, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAgeMs) { fs.unlinkSync(filePath); cleaned++; }
        }
        if (cleaned > 0) console.log(`[Thumbnails] Cleaned up ${cleaned} old live thumbnails`);
    } catch (err) {
        console.error('[Thumbnails] Cleanup error:', err.message);
    }
}

/**
 * Extract one frame to a file. `source` may be a local path OR an http(s) URL
 * (e.g. a Media playback_url) — with `-ss` before `-i`, ffmpeg range-seeks the
 * remote file and only pulls the bytes around the timestamp.
 */
function extractFrameToFile(source, seekSeconds, outAbsPath) {
    return new Promise((resolve) => {
        const isUrl = /^https?:\/\//i.test(String(source || ''));
        if (!source || (!isUrl && !fs.existsSync(source))) return resolve(false);
        try { fs.mkdirSync(path.dirname(outAbsPath), { recursive: true }); } catch { /* */ }
        const args = ['-y', '-ss', String(Math.max(0.5, Number(seekSeconds) || 1)), '-i', source,
            '-vframes', '1', '-vf', `scale=${THUMB_WIDTH}:-1`, '-q:v', String(THUMB_QUALITY), outAbsPath];
        const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
        const to = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } resolve(false); }, isUrl ? 35000 : 15000);
        ff.on('close', (code) => { clearTimeout(to); resolve(code === 0 && fs.existsSync(outAbsPath)); });
        ff.on('error', () => { clearTimeout(to); resolve(false); });
    });
}

module.exports = {
    generateWebrtcThumbnail,
    THUMB_DIR,
    getStreamThumbnailState,
    shouldRefreshLiveThumbnail,
    getCurrentLiveThumbnailUrl,
    saveLiveThumbnail,
    generateLiveStreamThumbnail,
    generateJSMPEGThumbnail,
    cleanupOldThumbnails,
    extractFrameToFile,
};
