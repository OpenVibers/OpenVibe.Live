/**
 * clip-policy.js — ONE freshness policy for every automated cutter.
 *
 * The owner (2026-10-29): "the AI clipping system seems to clip old videos. Maybe only make
 * clips of fresh stuff, unless the site's dead." Both the live clip job and the AI moments job
 * mined the most-VIEWED back catalogue with no age cutoff, so old VODs kept being clipped.
 *
 *   fresh      the producing stream ended (or is still running) in the last 48 hours
 *   archive    only when the site has been quiet for 72 hours (no new footage AND no human
 *              pageviews) OR the channel itself has had no new stream in 48 hours (then only its
 *              newest VODs), and the upstream service is healthy; then at most one archival clip
 *              per UTC day, from the previous 90 days, newest first, labelled archival.
 *
 * The 48-hour clock starts when the producing STREAM ended, not when it started and not when
 * the VOD was uploaded: a five-day stream that finished an hour ago is fresh even with no part
 * row. A still-running stream is fresh; a source with no ended_at falls back to its capture/part
 * time, and an old imported recording is never fresh just because it was uploaded recently.
 *
 *   footageStart({ vod, stream, part })            → epoch ms of the source's first frame, or null
 *   streamEndedAt({ vod, stream, now })            → epoch ms the producing stream last had footage
 *   classifySource({ vod, stream, part, now, site, channel }) → { ok, archival, ageHours, … }
 *   siteActivity(db, { now })                       → { lastFootageAt, lastHumanActivityAt }
 *   siteStatus({ now, … })                          → { quiet, hours, why }
 *   latestStreamForUser(db, userId)                 → the user's newest stream row (live first)
 *   streamActivityAt(stream, now)                   → epoch ms of that stream's latest activity
 *   channelStatus({ now, lastStreamAt })            → { quiet, hours, why }
 *   archiveAllowed(log, now)                        → one archival clip per UTC day
 *   reserveArchive(log, now) / releaseArchive(now)  → atomic in-process reservation of that slot
 *
 * An outage is never quietness: without a healthy upstream (`upstreamHealthy: false`) or a known
 * activity timestamp, the archive stays closed.
 */
'use strict';

const HOUR_MS = 3600_000;
const FRESH_HOURS = 48;
const QUIET_HOURS = 72;
const CHANNEL_QUIET_HOURS = 48;   // a channel with no new stream in the freshness window is quiet
const ARCHIVE_DAYS = 90;
const ARCHIVE_PER_DAY = 1;

/** Parse the DB's `YYYY-MM-DD HH:MM:SS` UTC text, ISO text, Date, or epoch (s/ms) → ms or null. */
function parseTs(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return value > 1e12 ? value : value * 1000;   // epoch seconds vs milliseconds
    }
    const s = String(value).trim();
    if (!s) return null;
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * When the footage was captured. Media may name it directly; otherwise the stream's part row
 * gives the exact start of this recording (stream start + part offset), which is why a long
 * stream recorded in parts does not look old. `created_at` is the last resort — for recordings
 * Live itself opened it is the recorder's start time.
 */
function footageStart({ vod, stream, part } = {}) {
    for (const field of ['captured_at', 'recorded_at', 'recording_started_at']) {
        const t = parseTs(vod && vod[field]);
        if (t != null) return t;
    }
    const streamStart = parseTs(stream && stream.started_at);
    if (streamStart != null && part && Number.isFinite(Number(part.at))) return streamStart + Number(part.at) * 1000;
    const created = parseTs(vod && (vod.created_at || vod.createdAt));
    if (created != null) return created;
    return streamStart;
}

/**
 * When the stream that produced a VOD last had footage — the reference for the 48-hour window.
 * A finished stream's ended_at governs; a still-live stream is "now". Without a trusted end
 * (an import or a stream row that never got ended_at), the capture/part time stands in, and only
 * then the VOD's created_at: an old file uploaded today must not look fresh because of upload time.
 */
function streamEndedAt({ vod, stream, now = Date.now() } = {}) {
    if (stream) {
        if (Number(stream.is_live) > 0) return now;
        const ended = parseTs(stream.ended_at);
        if (ended != null) return ended;
    }
    // Capture metadata before created_at: created_at is the upload/import time for a recording
    // Live did not open itself.
    const captured = parseTs(vod && (vod.captured_at || vod.recorded_at || vod.recording_started_at));
    if (captured != null) return captured;
    if (stream) {
        const started = parseTs(stream.started_at);
        if (started != null) return started;
    }
    return parseTs(vod && (vod.created_at || vod.createdAt));
}

/**
 * Site quietness from the two signals we have in Live: new footage (a live stream, a stream that
 * ended, a VOD capture) and human pageviews. Both are required; an unknown signal is not quiet.
 * `upstreamHealthy` comes from the caller (its Media listing answered).
 */
function siteStatus({ now = Date.now(), lastFootageAt = null, lastHumanActivityAt = null, upstreamHealthy = false } = {}) {
    if (!upstreamHealthy) return { quiet: false, hours: null, lastAt: null, why: 'upstream not healthy' };
    if (lastFootageAt == null || lastHumanActivityAt == null) return { quiet: false, hours: null, lastAt: null, why: 'site activity unknown' };
    const lastAt = Math.max(lastFootageAt, lastHumanActivityAt);
    const hours = (now - lastAt) / HOUR_MS;
    return { quiet: hours >= QUIET_HOURS, hours, lastAt, why: hours >= QUIET_HOURS ? 'site quiet' : 'recent activity' };
}

/**
 * A channel's quietness: no new stream in the freshness window (48h). Unknown activity is not
 * quietness, and an outage is never quietness. `newest` on the per-VOD channel object limits the
 * channel exception to the newest VODs, so a quiet channel does not reopen its whole archive.
 */
function channelStatus({ now = Date.now(), lastStreamAt = null } = {}) {
    if (lastStreamAt == null) return { quiet: false, hours: null, lastAt: null, why: 'channel activity unknown' };
    const hours = (now - lastStreamAt) / HOUR_MS;
    return { quiet: hours >= CHANNEL_QUIET_HOURS, hours, lastAt: lastStreamAt, why: hours >= CHANNEL_QUIET_HOURS ? 'channel quiet' : 'channel active' };
}

async function siteActivity(db, { now = Date.now() } = {}) {
    let lastFootageAt = null, lastHumanActivityAt = null;
    try {
        const s = await db.get(`SELECT MAX(started_at) AS started, MAX(ended_at) AS ended,
                                       MAX(CASE WHEN is_live = 1 THEN 1 ELSE 0 END) AS live
                                FROM streams`);
        const started = parseTs(s && s.started), ended = parseTs(s && s.ended);
        if (Number(s && s.live) > 0) lastFootageAt = now;   // footage is being recorded right now
        else lastFootageAt = Math.max(started || 0, ended || 0) || null;
    } catch { /* unknown is not quiet */ }
    try {
        const a = await db.get(`SELECT MAX(created_at) AS t FROM analytics_events WHERE COALESCE(is_bot, 0) = 0`);
        lastHumanActivityAt = parseTs(a && a.t);
    } catch { /* unknown is not quiet */ }
    return { lastFootageAt, lastHumanActivityAt };
}

/** A user's newest stream row (an active one wins), for the channel-quiet exception. */
async function latestStreamForUser(db, userId) {
    try {
        return await db.get(`SELECT id, started_at, ended_at, is_live
                             FROM streams WHERE user_id = ?
                             ORDER BY (CASE WHEN is_live = 1 THEN 1 ELSE 0 END) DESC,
                                      COALESCE(ended_at, started_at, created_at) DESC, id DESC
                             LIMIT 1`, [userId]);
    } catch { return null; }   // unknown activity is not quietness
}

/** Epoch ms of a stream's latest activity: now while it is live, otherwise its last end/start. */
function streamActivityAt(stream, now = Date.now()) {
    if (!stream) return null;
    if (Number(stream.is_live) > 0) return now;
    return Math.max(parseTs(stream.ended_at) || 0, parseTs(stream.started_at) || 0) || null;
}

/**
 * Fresh, or archival when the site (or this channel) is quiet and the source is inside the
 * archive window. A channel exception applies only to the channel's newest VODs (`channel.newest`),
 * so a quiet channel does not reopen its whole back catalogue.
 */
function classifySource({ vod, stream, part, now = Date.now(), site = { quiet: false }, channel = null } = {}) {
    const capturedAt = footageStart({ vod, stream, part });
    const endedAt = streamEndedAt({ vod, stream, now });
    // Freshness follows the stream's end (see streamEndedAt), not the first frame: a long stream
    // that finished recently is eligible even when its VOD was opened five days ago.
    const ageHours = endedAt == null ? null : (now - endedAt) / HOUR_MS;
    if (ageHours == null) return { ok: false, archival: false, capturedAt, endedAt, ageHours, why: 'unknown source age' };
    if (ageHours <= FRESH_HOURS) return { ok: true, archival: false, capturedAt, endedAt, ageHours, why: 'fresh' };
    // The 90-day archive window is about the footage itself, not an upload that happened later.
    const archiveHours = capturedAt == null ? ageHours : (now - capturedAt) / HOUR_MS;
    const channelQuiet = !!(channel && channel.quiet && channel.newest !== false);
    const quiet = !!(site && site.quiet) || channelQuiet;
    if (quiet && archiveHours <= ARCHIVE_DAYS * 24) {
        return { ok: true, archival: true, capturedAt, endedAt, ageHours, why: site && site.quiet ? 'quiet site: archive' : 'quiet channel: archive' };
    }
    return { ok: false, archival: false, capturedAt, endedAt, ageHours, why: quiet ? 'older than the archive window' : 'stale source' };
}

const _day = (ms) => new Date(ms).toISOString().slice(0, 10);

// One archive clip per UTC day, shared by the AI moments job and the VOD backfill. Both can pass
// archiveAllowed() before either writes auto_clip_log, so the slot is reserved synchronously here:
// reserveArchive() is a single check-and-set (no await between), and archiveAllowed() sees the
// reservation before the clip log is written.
let _archiveReservedDay = null;

/** The clip log (or a reservation this process already holds) has spent today's archive clip? */
function archiveAllowed(log, now = Date.now()) {
    const day = _day(now);
    if (_archiveReservedDay === day) return false;
    const used = (Array.isArray(log) ? log : []).filter((e) => e && e.archival && e.ts && _day(e.ts) === day).length;
    return used < ARCHIVE_PER_DAY;
}

/** Atomically claim today's archival clip slot for this process; false when it is taken. */
function reserveArchive(log, now = Date.now()) {
    if (!archiveAllowed(log, now)) return false;
    _archiveReservedDay = _day(now);
    return true;
}

/** Give the slot back after a cut that did not happen. */
function releaseArchive(now = Date.now()) {
    if (_archiveReservedDay === _day(now)) _archiveReservedDay = null;
}

module.exports = {
    FRESH_HOURS, QUIET_HOURS, CHANNEL_QUIET_HOURS, ARCHIVE_DAYS, ARCHIVE_PER_DAY,
    parseTs, footageStart, streamEndedAt, siteStatus, siteActivity, latestStreamForUser, streamActivityAt,
    channelStatus, classifySource, archiveAllowed, reserveArchive, releaseArchive,
    _resetArchiveReservation: () => { _archiveReservedDay = null; },
};
