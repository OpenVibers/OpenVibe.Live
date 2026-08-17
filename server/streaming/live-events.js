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

// Announce a go-live to every subscribed page (once per slot per hour).
function announceGoLive(stream, streamer) {
    if (!stream) return;
    const slotKey = String(stream.managed_stream_id || `s${stream.id}`);
    const now = Date.now();
    if (now - (lastAnnounced.get(slotKey) || 0) < ONE_HOUR_MS) return;
    lastAnnounced.set(slotKey, now);
    // occasional cleanup so the Map can't grow unbounded
    if (lastAnnounced.size > 500) {
        for (const [k, t] of lastAnnounced) if (now - t > ONE_HOUR_MS) lastAnnounced.delete(k);
    }
    try {
        broadcast('stream-live', {
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
}

module.exports = { subscribe, broadcast, announceGoLive, clientCount: () => clients.size };
