/**
 * OpenVibe.Live — a live stream's cheap preview_url
 *
 * A live card's hover preview does not need a second encode: while a stream is being recorded, Media already serves the
 * recording's DVR as an EVENT HLS playlist at the live edge (GET /v/<vod>/dvr.m3u8, server/public/routes.js in
 * OpenVibe.Media). It is full-resolution, not a low-bitrate ladder, but it costs one request and no extra copy — the
 * closest thing Live already has to a live preview, so that is what a live stream's preview_url names.
 *
 * The playlist exists only for an MP4 recording in progress (a browser MediaRecorder stream may be WebM), and never
 * for a private one: Media answers 404 then and the player keeps the thumbnail/recording URL. Null when there is no
 * active recording to preview.
 */
'use strict';
const media = require('../media-client');

/** The preview URL for one live stream right now, or null. */
function previewUrlFor(streamId, { recorder = null } = {}) {
    try {
        const rec = (recorder || require('../streaming/recorder')).activeRecordings.get(Number(streamId));
        if (!rec || !rec.vodId) return null;
        if (String(rec.protocol || '').toLowerCase() === 'jsmpeg') return null;
        return media.vodDvrPlaylistUrl(rec.vodId);
    } catch { return null; }
}

/** Set preview_url on each stream row (null when there is nothing to preview). */
function attach(streams, opts = {}) {
    for (const s of streams || []) {
        if (s && s.id != null) s.preview_url = previewUrlFor(s.id, opts);
    }
    return streams;
}

module.exports = { previewUrlFor, attach };
