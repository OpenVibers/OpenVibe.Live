'use strict';
/**
 * The first stream's follow-up (plan 2026-10-22, track C3). Of the 41 people whose first stream was in the last 30
 * days (to 2026-10-22), 10 streamed again within 14 days; most first streams ran 1 to 10 minutes. After someone's
 * first stream ends, they get one notification on the network: how long it ran, how many signed-in viewers watched
 * (watch_time: one row per person per stream, the streamer left out; peak_viewers counts connections, not people),
 * where the recording is (a public VOD on OpenVibe.Video once Media has it, else the after-show report, else their
 * channel), and the channel address to share before going live again. 10-23: it also names up to three people who
 * chatted (chat is public; a viewer who only watched is never named), links the stream's most-viewed public clip when
 * one exists (an auto-clip of a chat spike, or a viewer's), and carries the recording's thumbnail as its picture, the
 * share card the notification list shows.
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

/** '@a', '@a and @b', '@a, @b and @c', '@a, @b, @c and others' (at most three names). */
function names(list) {
    const at = list.slice(0, 3).map((n) => `@${n}`);
    if (list.length > 3) return `${at.join(', ')} and others`;
    return at.length > 1 ? `${at.slice(0, -1).join(', ')} and ${at[at.length - 1]}` : at[0];
}

/** The notification for a first stream: { title, message, url }. */
function messageFor({ username, seconds, vodUrl, watchers = 0, chatters = [], clipUrl = null }) {
    const channel = `${LIVE_URL}/@${encodeURIComponent(username)}`;
    const where = vodUrl ? 'The recording is on OpenVibe.Video, ready to watch, clip and share.'
        : seconds >= RECAP_MIN_SECONDS ? 'Your after-show report is ready, and the recording follows on your channel.'
            : 'The recording appears on your channel once it is ready.';
    const said = chatters.length ? ` ${names(chatters)} chatted with you.` : '';
    const clip = clipUrl ? ` A clip of it is up too: ${clipUrl.replace('https://', '')}.` : '';
    return {
        title: 'Your first stream is done 🎉',
        message: `${minutes(seconds)} live${watchers > 0 ? `, watched by ${watchers} signed-in ${watchers === 1 ? 'viewer' : 'viewers'}` : ''}.${said} ${where}${clip} Next time, share ${channel.replace('https://', '')} before you go live so people can find you.`,
        url: vodUrl || null,
    };
}

/**
 * The stream's public recording: { id, url, thumbnail } or null. A test's stand-in may answer the URL alone.
 */
async function publicVod(stream) {
    const [s] = await require('../media-proxy/lookups').attachPublicVods([{ id: stream.id }]);
    return s && s.vod_id ? { id: s.vod_id, url: require('../web/video-url').videoUrl('vod', s.vod_id), thumbnail: s.vod_thumbnail_url || null } : null;
}

/** The stream's most-viewed public, ready clip (by the stream or its recording), as its OpenVibe.Video URL. */
async function bestClip(stream, vodId) {
    const lookups = require('../media-proxy/lookups');
    const best = (await lookups.streamClips(stream.id, vodId))
        .filter((c) => lookups.isPublic(c) && (!c.status || c.status === 'ready'))
        .sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0) || Number(b.id) - Number(a.id))[0];
    return best ? require('../web/video-url').videoUrl('clip', best.id) : null;
}

/** Up to four people who chatted on the stream, busiest first, the streamer left out. */
async function chattersOf(stream) {
    const top = (await require('../chat/chat-reads').topChatters({ streamId: stream.id, limit: 5 })) || [];
    return top.filter((r) => r.username && (r.user_id == null || Number(r.user_id) !== Number(stream.user_id))).map((r) => r.username).slice(0, 4);
}

async function run({ now = Date.now, push = null, vodFor = null, clipFor = null, chattersFor = null } = {}) {
    const send = push || require('../utils/notify').pushNotification;
    const findVod = vodFor || publicVod;
    const findClip = clipFor || bestClip;
    const findChatters = chattersFor || chattersOf;
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
        let vod = null;
        try { vod = await findVod(s); } catch { /* Media unreachable: the channel link instead */ }
        if (typeof vod === 'string') vod = { url: vod };
        let clipUrl = null;
        try { clipUrl = await findClip(s, vod && vod.id); } catch { /* no clip named */ }
        let chatters = [];
        try { chatters = await findChatters(s); } catch { /* Chat unreachable: nobody named */ }
        const seen = await db.get('SELECT COUNT(*) AS n FROM watch_time WHERE stream_id = ? AND user_id <> ?', [s.id, s.user_id]);
        const m = messageFor({ username: s.username, seconds, vodUrl: vod && vod.url, watchers: Number(seen && seen.n) || 0, chatters, clipUrl });
        const url = m.url || (seconds >= RECAP_MIN_SECONDS ? `${LIVE_URL}/recap/${s.id}` : `${LIVE_URL}/@${encodeURIComponent(s.username)}`);
        // The recording's thumbnail is the notification's picture (Network's list shows rich_content.thumbnail).
        const thumbnail = vod && /^https:\/\//.test(String(vod.thumbnail || '')) ? vod.thumbnail : null;
        send({
            user_id: s.user_id, type: 'STREAM_SUMMARY', category: 'stream', title: m.title, message: m.message, url,
            rich_content: { thumbnail, context: { stream_id: s.id, vod_url: (vod && vod.url) || null, clip_url: clipUrl } },
        });
        sent++;
    }
    return { checked: rows.length, sent };
}

module.exports = { run, messageFor, names, stateKey, MIN_SECONDS };
