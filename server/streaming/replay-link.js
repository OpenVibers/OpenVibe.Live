'use strict';
/**
 * GET /replay/:streamId — where a stream lives once it has ended (2026-11-20; the owner's register #331: "live
 * notifications should switch to the VOD once the streamer goes offline").
 *
 * Network's "X is live" notice points here when the stream ends (live.stream.ended), so the bell opens the recording,
 * not an offline channel. Still live → the channel; a public, finished recording → its page (/vod/<id>, which goes on
 * to openvibe.video); neither yet (Media is still finishing it, the recording is private or there is none) → the
 * channel, whose offline page lists the latest videos. Never a private or unlisted recording's id.
 */
const db = require('../db/database');

async function replayTarget(streamId, { lookups = require('../media-proxy/lookups') } = {}) {
    const s = await db.get(`SELECT s.id, s.is_live, u.username FROM streams s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, [Number(streamId)]);
    if (!s || !s.username) return '/';
    const channel = `/@${encodeURIComponent(s.username)}`;
    if (Number(s.is_live) === 1) return channel;
    try {
        const vods = await lookups.publicVodsForStreams([s.id], { budgetMs: 3000 });
        const v = vods.get(Number(s.id));
        if (v && /^\d{1,15}$/.test(String(v.id))) return `/vod/${v.id}`;
    } catch { /* Media did not answer: the channel */ }
    return channel;
}

async function handler(req, res) {
    let to = '/';
    try { to = await replayTarget(req.params[0]); } catch { /* the home page */ }
    // Where it goes changes when the recording is ready: never cached.
    res.set('Cache-Control', 'no-store');
    res.redirect(302, to);
}

module.exports = { replayTarget, handler };
