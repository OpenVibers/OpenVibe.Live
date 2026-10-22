'use strict';
/**
 * The first stream's follow-up (plan 2026-10-22, track C3). Of the 41 people whose first stream was in the last 30
 * days (to 2026-10-22), 10 streamed again within 14 days; most first streams ran 1 to 10 minutes. After someone's
 * first stream ends, they get one notification on the network: how long it ran, where the recording is (a public VOD
 * on OpenVibe.Video once Media has it, else the after-show report, else their channel), and the channel address to
 * share before going live again.
 *
 *   run()   every 5 minutes (server/index.js): first streams that ended 5 minutes to 2 hours ago, each notified once
 *           (app_state `first_stream_followup:<user id>`). A stream under 30 seconds is a test and gets nothing.
 */
const db = require('../db/database');

const SETTLE_MS = 5 * 60 * 1000;        // Media finalises the recording after the stream ends
const LOOKBACK_MS = 2 * 60 * 60 * 1000;
const MIN_SECONDS = 30;
const RECAP_MIN_SECONDS = 8 * 60;       // server/recap/recap.js MIN_DURATION_SEC
const LIVE_URL = 'https://openvibe.live';
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const stateKey = (userId) => `first_stream_followup:${userId}`;

function minutes(seconds) {
    const m = Math.round(seconds / 60);
    return m < 1 ? 'Under a minute' : m === 1 ? '1 minute' : `${m} minutes`;
}

/** The notification for a first stream: { title, message, url }. */
function messageFor({ username, seconds, vodUrl }) {
    const channel = `${LIVE_URL}/@${encodeURIComponent(username)}`;
    const where = vodUrl ? 'The recording is on OpenVibe.Video, ready to watch, clip and share.'
        : seconds >= RECAP_MIN_SECONDS ? 'Your after-show report is ready, and the recording follows on your channel.'
            : 'The recording appears on your channel once it is ready.';
    return {
        title: 'Your first stream is done 🎉',
        message: `${minutes(seconds)} live. ${where} Next time, share ${channel.replace('https://', '')} before you go live so people can find you.`,
        url: vodUrl || null,
    };
}

async function run({ now = Date.now, push = null, vodFor = null } = {}) {
    const send = push || require('../utils/notify').pushNotification;
    const findVod = vodFor || (async (stream) => {
        const [s] = await require('../media-proxy/lookups').attachPublicVods([{ id: stream.id }]);
        return s && s.vod_id ? require('../web/video-url').videoUrl('vod', s.vod_id) : null;
    });
    const rows = await db.all(`SELECT s.id, s.user_id, s.duration_seconds, s.started_at, s.ended_at, u.username
        FROM streams s JOIN users u ON u.id = s.user_id
        WHERE COALESCE(s.is_live, 0) = 0 AND s.ended_at IS NOT NULL AND s.ended_at >= ? AND s.ended_at <= ?
          AND NOT EXISTS (SELECT 1 FROM streams o WHERE o.user_id = s.user_id AND o.id < s.id)
        ORDER BY s.id LIMIT 50`, [sqlTime(now() - LOOKBACK_MS), sqlTime(now() - SETTLE_MS)]);
    let sent = 0;
    for (const s of rows) {
        if (await db.getState(stateKey(s.user_id))) continue;
        const seconds = Number(s.duration_seconds) > 0 ? Number(s.duration_seconds)
            : Math.max(0, Math.round((Date.parse(`${String(s.ended_at).replace(' ', 'T')}Z`) - Date.parse(`${String(s.started_at).replace(' ', 'T')}Z`)) / 1000)) || 0;
        // Recorded first, so a crash after this never sends twice (a missed one is better than a repeated one).
        await db.setState(stateKey(s.user_id), String(s.id));
        if (seconds < MIN_SECONDS) continue;
        let vodUrl = null;
        try { vodUrl = await findVod(s); } catch { /* Media unreachable: the channel link instead */ }
        const m = messageFor({ username: s.username, seconds, vodUrl });
        const url = m.url || (seconds >= RECAP_MIN_SECONDS ? `${LIVE_URL}/recap/${s.id}` : `${LIVE_URL}/@${encodeURIComponent(s.username)}`);
        send({ user_id: s.user_id, type: 'STREAM_SUMMARY', category: 'stream', title: m.title, message: m.message, url });
        sent++;
    }
    return { checked: rows.length, sent };
}

module.exports = { run, messageFor, stateKey, MIN_SECONDS };
