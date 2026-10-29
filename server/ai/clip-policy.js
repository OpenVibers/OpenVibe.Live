/**
 * clip-policy.js — ONE freshness policy for every automated cutter.
 *
 * The owner (2026-10-29): "the AI clipping system seems to clip old videos. Maybe only make
 * clips of fresh stuff, unless the site's dead." Both the live clip job and the AI moments job
 * mined the most-VIEWED back catalogue with no age cutoff, so old VODs kept being clipped.
 *
 *   fresh      footage captured in the last 48 hours
 *   archive    only when the site has been quiet for 72 hours (no new footage AND no human
 *              pageviews) OR the channel itself has had no new stream in 48 hours (then only its
 *              newest VODs), and the upstream service is healthy; then at most one archival clip
 *              per UTC day, from the previous 90 days, newest first, labelled archival.
 *
 * Footage time is the CAPTURE time, not the upload/import time: a VOD that is one part of a
 * long stream (or of a broadcaster who reconnected) starts at streams.started_at + part.at
 * (stream_history), so a five-day stream that is still recording is still fresh.
 *
 *   footageStart({ vod, stream, part })            → epoch ms of the source's first frame, or null
 *   streamEndedAt({ vod, stream, now })            → epoch ms the producing stream last had footage
 *   classifySource({ vod, stream, part, now, site, channel }) → { ok, archival, ageHours, … }
 *   siteActivity(db, { now })                       → { lastFootageAt, lastHumanActivityAt }
 *   siteStatus({ now, … })                          → { quiet, hours, why }
 *   channelStatus({ now, lastStreamAt })            → { quiet, hours, why }
 *   archiveAllowed(log, now)                        → one archival clip per UTC day
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
 * When the stream that produced a VOD last had footage. This is what the brief calls "the stream
 * ended": a finished stream's ended_at, a still-live stream's now, or the VOD's own creation time
 * when Live has no stream row (an imported recording).
 */
function streamEndedAt({ vod, stream, now = Date.now() } = {}) {
    if (stream) {
        if (Number(stream.is_live) > 0) return now;
        const ended = parseTs(stream.ended_at);
        if (ended != null) return ended;
        const started = parseTs(stream.started_at);
        if (started != null) return started;
    }
    const created = parseTs(vod && (vod.created_at || vod.createdAt));
    if (created != null) return created;
    return parseTs(vod && (vod.captured_at || vod.recorded_at || vod.recording_started_at));
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

/**
 * Fresh, or archival when the site (or this channel) is quiet and the source is inside the
 * archive window. A channel exception applies only to the channel's newest VODs (`channel.newest`),
 * so a quiet channel does not reopen its whole back catalogue.
 */
function classifySource({ vod, stream, part, now = Date.now(), site = { quiet: false }, channel = null } = {}) {
    const capturedAt = footageStart({ vod, stream, part });
    const ageHours = capturedAt == null ? null : (now - capturedAt) / HOUR_MS;
    if (ageHours == null) return { ok: false, archival: false, capturedAt, ageHours, why: 'unknown source age' };
    if (ageHours <= FRESH_HOURS) return { ok: true, archival: false, capturedAt, ageHours, why: 'fresh' };
    const channelQuiet = !!(channel && channel.quiet && channel.newest !== false);
    const quiet = !!(site && site.quiet) || channelQuiet;
    if (quiet && ageHours <= ARCHIVE_DAYS * 24) {
        return { ok: true, archival: true, capturedAt, ageHours, why: site && site.quiet ? 'quiet site: archive' : 'quiet channel: archive' };
    }
    return { ok: false, archival: false, capturedAt, ageHours, why: quiet ? 'older than the archive window' : 'stale source' };
}

const _day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The clip log has already spent today's one archival clip? */
function archiveAllowed(log, now = Date.now()) {
    const day = _day(now);
    const used = (Array.isArray(log) ? log : []).filter((e) => e && e.archival && e.ts && _day(e.ts) === day).length;
    return used < ARCHIVE_PER_DAY;
}

module.exports = {
    FRESH_HOURS, QUIET_HOURS, CHANNEL_QUIET_HOURS, ARCHIVE_DAYS, ARCHIVE_PER_DAY,
    parseTs, footageStart, streamEndedAt, siteStatus, siteActivity, channelStatus, classifySource, archiveAllowed,
};
