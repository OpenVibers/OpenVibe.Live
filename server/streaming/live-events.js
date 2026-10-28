/**
 * live-events.js — a tiny Server-Sent-Events hub that pushes "a streamer went
 * live" events to any page (on any OpenVibe site) that loads /live-notify.js. This is
 * the cross-site traffic driver: openvibe.live, openvibe.tools, openvibe.games, etc.
 * all subscribe to this one feed (CORS-open) and show an on-screen notification.
 *
 * Rate-limited to once per stream slot per hour so a flappy stream can't spam.
 */
'use strict';

const clients = new Set();          // Set<http.ServerResponse>
const lastAnnounced = new Map();    // slotKey -> timestamp(ms)
const HEARTBEAT_MS = 25000;
const ONE_HOUR_MS = 3600 * 1000;

// SSE subscribe handler (GET /api/live-events).
function subscribe(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 10000\n\n');
    res.write(': connected\n\n');
    clients.add(res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* */ } }, HEARTBEAT_MS);
    const done = () => { clearInterval(hb); clients.delete(res); };
    req.on('close', done);
    req.on('error', done);
}

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch { clients.delete(res); }
    }
}

// Announce a go-live to every subscribed page.
//
// The once-per-slot-per-hour rate limit exists so a flappy stream can't spam the
// on-screen toast. It must NOT suppress the event itself: viewers already sitting
// on the channel page rely on this to swap a dead player back to the live feed the
// instant the streamer returns, and a streamer bouncing offline→online is by
// definition inside the hour window. So we always broadcast, and mark repeats with
// `repeat: true` — the client shows a toast only for non-repeats but always acts on
// the event.
function announceGoLive(stream, streamer) {
    if (!stream) return;
    const slotKey = String(stream.managed_stream_id || `s${stream.id}`);
    const now = Date.now();
    const repeat = now - (lastAnnounced.get(slotKey) || 0) < ONE_HOUR_MS;
    if (!repeat) lastAnnounced.set(slotKey, now);
    // occasional cleanup so the Map can't grow unbounded
    if (lastAnnounced.size > 500) {
        for (const [k, t] of lastAnnounced) if (now - t > ONE_HOUR_MS) lastAnnounced.delete(k);
    }
    try {
        broadcast('stream-live', {
            repeat,
            username: (streamer && streamer.username) || stream.username || null,
            display_name: (streamer && streamer.display_name) || stream.display_name || null,
            avatar_url: (streamer && streamer.avatar_url) || stream.avatar_url || null,
            title: stream.title || null,
            stream_id: stream.id,
            slug: stream.managed_stream_slug || null,
            managed_id: stream.managed_stream_id || null,
            at: now,
        });
        console.log(`[LiveEvents] Announced go-live: ${(streamer && streamer.username) || stream.username} (${clients.size} subscribers)`);
    } catch (e) { console.warn('[LiveEvents] announce failed:', e.message); }
    if (!repeat) postLiveLink(stream, streamer);
}

/**
 * The channel's own chat says where to watch, the moment a stream goes live: openvibe.live/@name, plain and easy to copy
 * (the owner, 2026-10-28: "maybe it says it in chat… their live URL… not the slug… easier to copy paste"). Not on a
 * quick reconnect within the hour (the repeat above), and once per stream (Chat keeps the key).
 */
function postLiveLink(stream, streamer) {
    const username = (streamer && streamer.username) || stream.username;
    const channelUserId = stream.user_id || (streamer && streamer.id);
    if (!username || !channelUserId || !stream.id) return;
    let base = 'https://openvibe.live';
    try { base = String(require('../config').baseUrl || base).replace(/\/$/, ''); } catch { /* the public address */ }
    const url = `${base}/@${encodeURIComponent(username)}`;
    const name = (streamer && streamer.display_name) || stream.display_name || username;
    try {
        const delivery = require('../chat/chat-delivery');
        delivery.after(delivery.message({
            stream_id: stream.id, channel_user_id: channelUserId, user_id: null, username: 'OpenVibe.Live',
            message: `\u{1F534} ${name} is live. Share the stream: ${url}`.slice(0, 480), message_type: 'system',
            metadata: { kind: 'live_link', url }, key: `live:link:${stream.id}`,
        }), () => {});
    } catch (e) { console.warn('[LiveEvents] live link line failed:', e.message); }
}

/** End every open SSE stream. Without this, server.close() never called back on shutdown. */
function closeAll() {
    for (const res of clients) { try { res.end(); } catch { /* */ } }
    clients.clear();
}

module.exports = { subscribe, broadcast, announceGoLive, postLiveLink, closeAll, clientCount: () => clients.size };
