/**
 * OpenVibe.Live — the live stream's last picture as a recording's thumbnail
 *
 * A recording can finish without a picture: the frame grab failed, the file is too short or damaged at the seek point,
 * or the recording started before the source had video. When the recording came from a live stream, Live already has a
 * picture of it — the last frame its live grab captured, still on disk for an hour after the stream ends. Media's own
 * thumbnail wins whenever it has one; this only fills a hole, so a recording made from a live stream never shows the
 * grey placeholder when a real frame of that stream exists.
 *
 * Called from the vod.ready outcome (server/media-proxy/outcomes.js), after the recording's row is committed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const media = require('../media-client');
const liveThumbs = require('./live-thumbs');

/** A local live-picture file from a streams.thumbnail_url value, or null. */
function livePictureFile(url) {
    const m = /^\/api\/thumbnails\/(stream-[A-Za-z0-9_.-]+\.(?:jpg|png))$/.exec(String(url || ''));
    if (!m) return null;
    const file = path.join(liveThumbs.THUMB_DIR, m[1]);
    try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

/**
 * Give a finished recording the live stream's last picture when it has no thumbnail of its own.
 * → { adopted: boolean, reason? }
 */
async function adoptForVod(vodId, data = {}) {
    const id = Number(vodId);
    if (!Number.isSafeInteger(id) || id <= 0) return { adopted: false, reason: 'no_id' };
    let vod;
    try { vod = await media.getVod(id); } catch { return { adopted: false, reason: 'media_unreachable' }; }
    if (!vod) return { adopted: false, reason: 'no_row' };
    if (vod.thumbnail_url) return { adopted: false, reason: 'has_picture' };
    if (Number(vod.audio_only)) return { adopted: false, reason: 'audio_only' };
    const streamId = Number(vod.stream_id || data.stream_id || data.streamId);
    if (!Number.isSafeInteger(streamId) || streamId <= 0) return { adopted: false, reason: 'no_stream' };
    let stream = null;
    try { stream = await db.getStreamById(streamId); } catch { /* no row */ }
    const file = livePictureFile(stream && stream.thumbnail_url);
    if (!file) return { adopted: false, reason: 'no_live_picture' };
    try {
        const out = await media.uploadThumbnail('vod', id, fs.readFileSync(file));
        if (!out || !out.url) return { adopted: false, reason: 'media_refused' };
        console.log(`[VOD] Recording ${id} took the live picture of stream ${streamId} as its thumbnail`);
        return { adopted: true };
    } catch (err) {
        return { adopted: false, reason: err.message };
    }
}

module.exports = { adoptForVod, livePictureFile };
