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

const THUMB_DIR = path.resolve(process.env.LIVE_THUMBS_PATH || './data/live-thumbs');
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
