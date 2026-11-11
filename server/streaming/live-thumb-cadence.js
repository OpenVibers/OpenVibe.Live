/**
 * OpenVibe.Live — live pictures (plan 355)
 *
 * Every live stream has a picture within 15 s of going live, and a fresh one about every 30 s while someone is
 * watching the channel page or the home/list pages. The browser/WHIP publisher posts its own frame every 15 s; this
 * server-side tick is the fallback for RTMP/JSMPEG and for a browser whose tab is hidden or whose publisher is OBS.
 *
 * Cost: one ffmpeg grab per stream per interval, never one per page. The grabbers already dedupe concurrent work
 * (live-thumbs.js activeLiveThumbnailJobs) and only a frame taken from a keyframe becomes the picture.
 *
 *   - no picture yet            → grab on the first tick after go-live (watched or not: a card must never be blank)
 *   - picture, watched          → grab when it is 30 s old
 *   - picture, nobody watching  → leave it alone (the live thumbnail of an unwatched stream is not being looked at)
 *   - a grab in the last 15 s   → wait (a failing source is not hammered every 5 s)
 *
 * "Watching" is the player sockets in the stream's room (broadcast-server), the viewer count Chat reports, or the
 * stream appearing in a public live list in the last 90 s (the home page and the channel lists call those).
 */
'use strict';
const db = require('../db/database');

const TICK_MS = 5000;
const PICTURE_INTERVAL_MS = 30000;
const ATTEMPT_GAP_MS = 15000;
const LISTED_FRESH_MS = 90000;

const lastAttempt = new Map();   // streamId → when the last grab started
const listed = new Map();        // streamId → when a public live list last named it

/** A public live list just named these streams: someone may be looking at their cards. */
function markListed(ids, now = Date.now()) {
    for (const id of ids || []) {
        const n = Number(id);
        if (Number.isSafeInteger(n) && n > 0) listed.set(n, now);
    }
    if (listed.size > 5000) {
        for (const [id, at] of listed) if (now - at > 10 * 60 * 1000) listed.delete(id);
    }
}

/** Pure: is anyone watching this stream, by any of the cheap signals? */
function isWatched({ viewerCount = 0, socketCount = 0, listedAt = 0, now = Date.now() } = {}) {
    return Number(viewerCount) > 0 || Number(socketCount) > 0 || (Number(listedAt) > 0 && now - Number(listedAt) <= LISTED_FRESH_MS);
}

/** Pure: should this stream be grabbed now? */
function shouldGrab({ hasPicture, ageMs = Infinity, watched = false, sinceAttemptMs = Infinity } = {}) {
    if (sinceAttemptMs < ATTEMPT_GAP_MS) return false;
    if (!hasPicture) return true;                       // first picture: always
    if (!watched) return false;                         // fresh enough and nobody is looking
    return !(Number(ageMs) >= 0 && Number(ageMs) < PICTURE_INTERVAL_MS);
}

/** The video grab for one stream, by protocol; the Media in-progress recording is the WebRTC/WHIP backup. */
async function grab(stream) {
    const liveThumbs = require('../media-proxy/live-thumbs');
    const protocol = String(stream.protocol || '').toLowerCase();
    if (protocol === 'rtmp') {
        const rtmpServer = require('./rtmp-server');
        if (!stream.stream_key || !rtmpServer.isReceiving(stream.stream_key)) return null;
        return await liveThumbs.generateLiveStreamThumbnail(stream.id, stream.stream_key, { minAgeMs: PICTURE_INTERVAL_MS });
    }
    if (protocol === 'jsmpeg') {
        const relay = require('./jsmpeg-relay');
        const info = stream.stream_key ? relay.getChannelInfo(stream.stream_key) : null;
        if (!info || !info.videoPort) return null;
        return await liveThumbs.generateJSMPEGThumbnail(stream.id, info.videoPort);
    }
    const grabbed = await liveThumbs.generateWebrtcThumbnail(stream.id, { minAgeMs: PICTURE_INTERVAL_MS }).catch(() => null);
    if (grabbed) return grabbed;
    // No SFU producer (OBS/WHIP in a shape the grabber cannot tap): a frame from Media's in-progress recording.
    try {
        const rec = require('./recorder').activeRecordings.get(Number(stream.id));
        if (!rec || !rec.vodId) return null;
        const mediaClient = require('../media-client');
        const out = await mediaClient.generateThumbnail('vod', rec.vodId);
        const url = mediaClient.publicUrl(out && out.url);
        if (url) await db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', [url, stream.id]);
        return url;
    } catch { return null; }
}

/** One pass over the live streams. Never throws (the timer logs). */
async function tick({ now = Date.now(), deps = {} } = {}) {
    if (require('../drill').enabled) return { checked: 0, grabbed: 0 };
    const liveThumbs = deps.liveThumbs || require('../media-proxy/live-thumbs');
    const broadcast = deps.broadcast || require('./broadcast-server');
    const rows = await (deps.liveStreams ? deps.liveStreams()
        : db.all(`SELECT s.id, s.protocol, s.thumbnail_url, s.viewer_count, COALESCE(ms.stream_key, u.stream_key) AS stream_key
            FROM streams s JOIN users u ON s.user_id = u.id
            LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
            WHERE s.is_live = 1`));
    let grabbed = 0;
    for (const stream of rows || []) {
        let socketCount = 0;
        try { socketCount = broadcast.getViewerCount(stream.id) || 0; } catch { /* no signaling */ }
        const watched = isWatched({ viewerCount: stream.viewer_count, socketCount, listedAt: listed.get(Number(stream.id)) || 0, now });
        let ageMs = Infinity;
        try { const state = await liveThumbs.getStreamThumbnailState(stream.id); if (state.exists) ageMs = state.ageMs; } catch { /* no file */ }
        const hasPicture = !!stream.thumbnail_url;
        const sinceAttemptMs = now - (lastAttempt.get(Number(stream.id)) || 0);
        if (!shouldGrab({ hasPicture, ageMs, watched, sinceAttemptMs })) continue;
        lastAttempt.set(Number(stream.id), now);
        grabbed++;
        grab(stream).catch((err) => console.warn(`[Thumbnails] live picture for stream ${stream.id}:`, err.message));
    }
    // Forget ended streams: their timers must not keep a decision for a later session.
    const liveIds = new Set((rows || []).map((r) => Number(r.id)));
    for (const id of lastAttempt.keys()) if (!liveIds.has(id)) lastAttempt.delete(id);
    for (const id of listed.keys()) if (!liveIds.has(id)) listed.delete(id);
    return { checked: (rows || []).length, grabbed };
}

/** Test seam: forget the in-memory decisions. */
function reset() { lastAttempt.clear(); listed.clear(); }

module.exports = {
    TICK_MS, PICTURE_INTERVAL_MS, ATTEMPT_GAP_MS, LISTED_FRESH_MS,
    markListed, isWatched, shouldGrab, tick, reset,
};
