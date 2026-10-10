'use strict';
/**
 * Process health for staff: event-loop delay, memory, connection counts, background jobs, bounded
 * work queues and migration state. Served at GET /api/admin/diagnostics (admin only) — nothing here
 * is public, and nothing is per-user, so it cannot grow without bound.
 *
 * Event-loop delay is the number that matters most on this box: chat fan-out, WebRTC signaling,
 * WHIP answers and RTMP callbacks all run on this one thread, so a 300ms stall is a 300ms freeze for
 * every one of them. A one-minute window is kept, and a stall is logged once per window.
 */
const { monitorEventLoopDelay } = require('perf_hooks');

const WINDOW_MS = 60 * 1000;
const WARN_P99_MS = 200;
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
let lastWindow = null;
// A restore drill (LIVE_DRILL) runs no timers at all; its delay window simply stays empty.
const windowTimer = require('./drill').enabled ? null : setInterval(() => {
    const ms = (ns) => Math.round(ns / 1e6);
    lastWindow = {
        endedAt: new Date().toISOString(),
        p50Ms: ms(histogram.percentile(50)),
        p99Ms: ms(histogram.percentile(99)),
        maxMs: ms(histogram.max),
        meanMs: Math.round(histogram.mean / 1e6),
    };
    if (lastWindow.p99Ms >= WARN_P99_MS) {
        console.warn(`[Diagnostics] event loop p99 ${lastWindow.p99Ms}ms (max ${lastWindow.maxMs}ms) over the last minute`);
    }
    histogram.reset();
}, WINDOW_MS);
if (windowTimer && windowTimer.unref) windowTimer.unref();

const safe = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };

async function snapshot(services = {}) {
    const mem = process.memoryUsage();
    const mb = (b) => Math.round(b / 1048576);
    const db = services.db;
    return {
        at: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        pid: process.pid,
        memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external) },
        eventLoop: { lastMinute: lastWindow },
        connections: {
            chat: await safe(() => services.chatDelivery.getTotalConnections()),
            broadcast: await safe(() => services.broadcastServer.clients.size),
            liveEventStreams: await safe(() => require('./streaming/live-events').clientCount()),
        },
        streams: {
            live: await safe(() => db.get('SELECT COUNT(*) AS n FROM streams WHERE is_live = 1').n),
            restreamSessions: await safe(() => services.restreamManager.sessions.size),
        },
        jobs: await safe(() => require('./utils/jobs').snapshot(), []),
        workQueues: await safe(() => require('./utils/limit').snapshot(), []),
        migrations: await safe(async () => await require('./db/migrations').getStatus(db.getDb()), []),
    };
}

module.exports = { snapshot };
