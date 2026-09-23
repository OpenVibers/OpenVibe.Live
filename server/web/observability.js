'use strict';
/**
 * Metrics and readiness for Live (roadmap Track O, §15.19), on openvibe-shared/metrics and
 * openvibe-shared/ready.
 *
 *   GET /metrics    Prometheus text, direct loopback callers only (404 through nginx or any proxy):
 *                   http_requests_total{method,route,status_class}, http_request_duration_seconds,
 *                   http_requests_in_flight, process/event-loop metrics, release_info{service,release},
 *                   live_streams_live, live_ws_connections{server}, live_events_outbox{status}
 *   GET /api/ready  200 while Live can serve (boot finished, the database answers); 503 otherwise.
 *                   Media, the WebRTC SFU and the Network signing key are optional: when one is
 *                   missing the answer stays 200 with status "degraded" and names it, because Live
 *                   still serves channels, chat and RTMP without them.
 *
 * Everything the checks and gauges read is injected, so the test drives this module without booting
 * the whole server.
 */
const metrics = require('openvibe-shared/metrics');
const { createReadiness } = require('openvibe-shared/ready');

// Long-lived responses whose "duration" is a viewing session, not a request.
const STREAMING_PATHS = [/^\/api\/live-events$/, /^\/api\/streams\/rtmp-proxy\//];
// Static mounts: served by express.static (no route), labelled by mount instead of 'unmatched'.
const STATIC_MOUNT = /^\/(js|css|fragments|shared|assets|data|media|docs-assets|images|img|fonts|sounds)\//;

function normalize(req) {
    if (req.route) return null;   // the matched route's template (openvibe-shared/metrics routeLabel)
    const m = STATIC_MOUNT.exec(String(req.originalUrl || req.url || '').split('?')[0]);
    return m ? `/${m[1]}/*` : null;
}

/**
 * Mount the HTTP metrics middleware and GET /metrics. Call before any other middleware.
 * @returns {{ registry }}
 */
function mountMetrics(app, { release }) {
    const m = metrics.instrument(app, {
        service: 'live',
        release: release && release.release,
        normalize,
        skip: (req) => STREAMING_PATHS.some((re) => re.test(req.path)),
    });
    return m;
}

/**
 * Domain gauges, read at scrape time. A source that throws is left out of that scrape.
 *   liveStreams()    -> number of live streams (the rows /api/streams lists)
 *   wsServers        -> { chat, broadcast, control, call } objects with a `wss` (ws.Server) once initialised
 *   outboxStatus()   -> server/events/stream-events.js status()
 */
function registerDomainGauges(registry, { liveStreams, wsServers = {}, outboxStatus }) {
    registry.gauge({ name: 'live_streams_live', help: 'Streams currently marked live (the list /api/streams serves)', collect: () => liveStreams() });
    registry.gauge({
        name: 'live_ws_connections', help: 'Open WebSocket connections per WebSocket server', labelNames: ['server'],
        collect: () => Object.entries(wsServers)
            .filter(([, s]) => s && s.wss && s.wss.clients)     // a server that never initialised reports nothing
            .map(([server, s]) => ({ labels: { server }, value: s.wss.clients.size })),
    });
    registry.gauge({
        name: 'live_events_outbox', help: 'Stream lifecycle events in the transactional outbox, by status (absent while the outbox is disabled)', labelNames: ['status'],
        collect: () => {
            const s = outboxStatus();
            if (!s || !s.enabled) return null;
            return [{ labels: { status: 'pending' }, value: Number(s.pending) || 0 }, { labels: { status: 'rejected' }, value: Number(s.rejected) || 0 }];
        },
    });
}

/**
 * The /api/ready handler.
 *   bootComplete() -> boolean       required
 *   dbQuery()      -> row           required (a real query; throws when the database cannot answer)
 *   sfuReady()     -> boolean       optional (WebRTC broadcasting/viewing through mediasoup)
 *   mediaUrl                        optional (OpenVibe.Media: VODs, clips, thumbnails), checked by
 *                                   GET <mediaUrl>/healthz, cached 30 s
 *   networkKey()   -> PEM or null   optional (sign-in: RS256 key from OpenVibe.Network)
 */
function createLiveReadiness({ release, bootComplete, dbQuery, sfuReady, mediaUrl, networkKey, drill = false, fetchImpl = globalThis.fetch }) {
    return createReadiness({
        service: 'live',
        release: release && release.release,
        checks: [
            { name: 'boot', required: true, description: 'boot finished', check: () => (bootComplete() ? true : 'boot not finished') },
            { name: 'db', required: true, description: 'SQLite answers a query', check: () => { const row = dbQuery(); return row ? true : 'no row'; } },
            { name: 'sfu', required: false, description: 'WebRTC SFU (mediasoup worker)', check: () => (sfuReady() ? true : 'mediasoup worker not running') },
            {
                name: 'media', required: false, cacheMs: 30000, timeoutMs: 2000, description: 'OpenVibe.Media (VODs, clips, thumbnails)',
                check: async () => {
                    // No URL: not asked (a restore drill talks to no other service).
                    if (!mediaUrl) return 'not checked (restore drill)';
                    const res = await fetchImpl(`${mediaUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
                    return res.ok ? true : `Media answered ${res.status}`;
                },
            },
            { name: 'network_key', required: false, description: 'OpenVibe.Network RS256 key (sign-in)', check: () => (/BEGIN [A-Z ]*PUBLIC KEY/.test(String(networkKey() || '')) ? true : 'Network public key not loaded: sign-in cannot be verified') },
        ],
        // Fields the previous /api/ready served, so nothing that read them breaks.
        details: (body) => ({
            // A restore-drill instance (LIVE_DRILL) says so: it serves reads from a restored copy only.
            ...(drill ? { mode: 'drill' } : {}),
            uptime: Math.round(process.uptime()),
            optional: {
                sfu: body.checks.sfu.status === 'ok',
                media: body.checks.media.status === 'ok',
                network_key: body.checks.network_key.status === 'ok',
            },
        }),
    });
}

module.exports = { mountMetrics, registerDomainGauges, createLiveReadiness, normalize };
