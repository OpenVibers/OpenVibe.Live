/**
 * OpenVibe.Live — a stream's rows in one of its VODs' own time.
 *
 * A stream can be recorded in parts (a broadcaster reconnecting), and each part is its own VOD; the
 * rows Live keeps (scene notes, speech, sound) are in stream time. The first part of a joined recording
 * answers for the whole video (streaming/recordings.js); a VOD that is one part of its stream keeps the
 * rows inside it, moved to its time (its chapters pointed eleven minutes late on part 2 of stream 2795).
 * `round` keeps whole seconds, which is what caption and description cues want.
 */
'use strict';

async function inVodTime(vod, rows, key, { round = true } = {}) {
    const fix = (v) => (round ? Math.round(v) : Math.round(v * 100) / 100);
    if (vod.recording && Number(vod.recording.vod_id) === Number(vod.id) && vod.recording.hls_url && (vod.recording.parts || []).length > 1) {
        const recordings = require('../streaming/recordings');
        const parts = await recordings.presentParts(vod.recording);
        return rows.map((r) => ({ r, at: recordings.toRecordingTime(parts, Number(r[key])) }))
            .filter((x) => x.at != null).map(({ r, at }) => ({ ...r, [key]: fix(at), ...(r.end != null ? { end: fix(at + (Number(r.end) - Number(r[key]))) } : {}) }));
    }
    const part = await require('../streaming/stream-history').partForVod(vod.id);
    if (!part) return rows;
    const len = part.end != null ? part.end - part.at : Infinity;
    return rows
        .filter((r) => Number(r[key]) >= part.at && Number(r[key]) - part.at <= len)
        .map((r) => ({ ...r, [key]: fix(Number(r[key]) - part.at), ...(r.end != null ? { end: fix(Number(r.end) - part.at) } : {}) }));
}

module.exports = { inVodTime };
