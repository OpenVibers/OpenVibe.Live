/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║              OpenVibe.Live — Main Server                  ║
 * ║        Open Live Streaming, Community Run · openvibe.live         ║
 * ║   Part of the OpenVibe network — Open Source & Community  ║
 * ╚═══════════════════════════════════════════════════════════╝
 *
 * Streaming: JSMPEG + WebRTC (Mediasoup) + RTMP
 * Media (VODs/clips/pastes/thumbnails): OpenVibe.Media (openvibe.media)
 * Identity/SSO + OpenCoins wallet: OpenVibe.Network (openvibe.network)
 * Chat: WebSocket with anon handling + word filter
 * Currencies: Vibes (tips/cashout, local) + OpenCoins (network wallet)
 * Controls: Interactive hardware API (Raspberry Pi)
 */

// Prevent sub-service port conflicts from crashing the main HTTP server
process.on('uncaughtException', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`[Server] Port ${err.port || '?'} already in use — sub-service skipped`);
    } else {
        console.error('[Server] Uncaught exception:', err);
        process.exit(1);
    }
});

// Node >=15 defaults to --unhandled-rejections=throw, i.e. ONE stray rejected promise
// anywhere kills the whole server. That is not a theoretical risk here: werift dispatches
// RTP to its sender through Event.execute(), which invokes an `async` subscriber WITHOUT
// awaiting or catching it (werift/lib/common/src/event.js). So every rs-passthrough-relay
// videoTrack.writeRtp() spawns a floating promise, and any DTLS/SRTP hiccup inside
// RTCRtpSender.sendRtp() surfaces here — taking down streaming, chat and the API with it,
// and skipping rsPassthroughRelay.stopAll() so RobotStreamer is left holding stale
// producers (black video, audio still playing) until its own ICE timeout reaps them.
// A rejected promise is a bug to fix, never a reason to drop every live viewer: log it
// loudly with the stack and keep serving.
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(`Non-error rejection: ${String(reason)}`);
    console.error('[Server] Unhandled promise rejection (kept alive):', err.stack || err.message);
});

const path = require('path');
const fs = require('fs');

// Load env before anything else
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Restore-drill mode (LIVE_DRILL=1, `ovhost drill live`): refuse an unsafe environment before
// anything opens a file, then cut every way out of the process but its own HTTP port. The instance
// serves reads from a restored copy of the database and starts nothing else (server/drill.js).
const drill = require('./drill');
if (drill.enabled) {
    try {
        drill.assertSafe();
    } catch (err) {
        console.error(`[Drill] ${err.message}`);
        process.exit(1);
    }
    drill.installGuards();
    console.log(`[Drill] LIVE_DRILL: restore-drill instance on ${process.env.HOST}:${process.env.PORT}, database ${path.resolve(process.env.DB_PATH)}, data ${path.resolve(process.env.DATA_DIR)}. Reads only; no background work, sockets or outbound connections.`);
}
const paths = require('./paths');

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
// A restore drill has one loopback client and answers reads only: no limiter (and so no limiter timers).
const rateLimit = drill.enabled ? () => (req, res, next) => next() : require('express-rate-limit');
const config = require('./config');
const assets = require('./web/assets');
// Starts the event-loop delay histogram at boot so the first diagnostics window is complete.
require('./diagnostics');

/**
 * Send an HTML document from public/ with its asset URLs content-versioned. Returns false when the
 * file does not exist so a caller can fall through. Documents are never cached (they name the asset
 * versions), unless the route already chose a stricter policy.
 */
function sendDocument(res, relPath, urlPath) {
    let doc = null;
    try { doc = assets.document(relPath); } catch { doc = null; }
    if (!doc) return false;
    if (!res.getHeader('Cache-Control')) assets.setNoCache(res);
    // The SPA shell carries only the assets of the route being opened (see public/features.json).
    const html = relPath === 'index.html' ? assets.renderRoute(doc.html, urlPath || '/') : doc.html;
    try { res.setHeader('Content-Security-Policy-Report-Only', assets.cspReportOnly(html)); } catch { /* */ }
    res.type('html').send(html);
    return true;
}

// Database
const db = require('./db/database');

// Streaming
const jsmpegRelay = require('./streaming/jsmpeg-relay');
const webrtcSFU = require('./streaming/webrtc-sfu');
const rtmpServer = require('./streaming/rtmp-server');

// Real-time
const chatServer = require('./chat/chat-server');
const controlServer = require('./controls/control-server');
const broadcastServer = require('./streaming/broadcast-server');
const callServer = require('./streaming/call-server');
const VibeCodingPublishServer = require('./vibe-coding/publish-server');

// Routes
const authRoutes = require('./auth/routes');
const streamRoutes = require('./streaming/routes');
const chatRoutes = require('./chat/routes');
const monetizationRoutes = require('./monetization/routes');
const coinsRoutes = require('./monetization/coins-routes');
const cosmeticsRoutes = require('./monetization/cosmetics-routes');
const cosmeticsModule = require('./monetization/cosmetics');
// Media subsystem (VODs/clips/pastes/thumbnails) lives in OpenVibe.Media now —
// these thin proxy routers preserve the public API paths the SPA calls.
const mediaClient = require('./media-client');
const vodRoutes = require('./media-proxy/vods');
const clipRoutes = require('./media-proxy/clips');
const commentRoutes = require('./media-proxy/comments');
const thumbnailRoutes = require('./media-proxy/thumbnails');
const liveThumbs = require('./media-proxy/live-thumbs');
const pasteRoutes = require('./media-proxy/pastes');
const recorder = require('./streaming/recorder');
const controlRoutes = require('./controls/routes');
const onvifRoutes = require('./controls/onvif-routes');
const adminRoutes = require('./admin/routes');
const { requireAuth } = require('./auth/auth');
const permissions = require('./auth/permissions');
const robotStreamerRoutes = require('./integrations/routes');
const themeRoutes = require('./themes/routes');
const emoteRoutes = require('./emotes/routes');
const metaRoutes = require('./meta/routes');
const robotStreamerService = require('./integrations/robotstreamer-service');
const chatRelayService = require('./integrations/chat-relay-service');
const vibeCodingRoutes = require('./vibe-coding/routes');

// Restream
const restreamRoutes = require('./streaming/restream-routes');
const restreamManager = require('./streaming/restream-manager');
const analyticsModule = require('openvibe-shared/analytics'); // ADR-021: no IP/user id, route templates, 30-day raw retention; Sec-GPC/DNT not recorded

// WHIP (WebRTC-HTTP Ingestion Protocol)
const whipHandler = require('./streaming/whip-handler');

// Game & Canvas — migrated to openvibe.games (game/canvas code removed)

// ── Express App ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// What this server runs (ADR-016): GET /release.json below, and release_info in /metrics.
// In the release layout (/opt/openvibe.live/releases/<time>-<sha8>, a root-owned git worktree) the
// service user cannot run git there, so the release id also comes from the directory's name.
const release = require('openvibe-shared/release').createRelease({ service: 'live', root: path.join(__dirname, '..'), env: releaseEnv() });
function releaseEnv() {
    if (process.env.RELEASE_COMMIT) return process.env;
    let dir = path.join(__dirname, '..');
    try { dir = require('fs').realpathSync(dir); } catch { /* keep */ }
    const m = /-([0-9a-f]{7,40})$/.exec(path.basename(dir));
    return m ? { ...process.env, RELEASE_COMMIT: m[1] } : process.env;
}
// Metrics first, so every request is counted (by route template, never by raw URL). GET /metrics
// answers direct loopback callers only; through nginx it is a 404 (server/web/observability.js).
const observability = require('./web/observability');
const { registry: metricsRegistry } = observability.mountMetrics(app, { release });
const vibeCodingPublishServer = new VibeCodingPublishServer(chatServer, db);

function normalizeOrigin(origin) {
    if (!origin || typeof origin !== 'string') return null;
    try {
        return new URL(origin).origin;
    } catch {
        return null;
    }
}

function getAllowedOrigins() {
    const allowed = new Set();
    const baseOrigin = normalizeOrigin(config.baseUrl);
    if (baseOrigin) {
        allowed.add(baseOrigin);
        // Auto-add www variant (and vice versa) to prevent WS rejection when
        // accessing via www.openvibe.live vs openvibe.live
        try {
            const url = new URL(baseOrigin);
            if (url.hostname.startsWith('www.')) {
                allowed.add(`${url.protocol}//${url.hostname.slice(4)}${url.port ? ':' + url.port : ''}`);
            } else {
                allowed.add(`${url.protocol}//www.${url.hostname}${url.port ? ':' + url.port : ''}`);
            }
        } catch {}

        // Warn loudly when BASE_URL wasn't set and we're in production
        if (process.env.NODE_ENV === 'production' && baseOrigin.includes('localhost')) {
            console.error('[CORS] CRITICAL: config.baseUrl is localhost in production — CORS will reject all browser requests!');
            console.error('[CORS] CRITICAL: Set BASE_URL in .env or configure it via the openvibe.network admin URL registry.');
        }
    }

    // Add the SSO provider origin (openvibe.network) for OAuth callbacks and cross-domain API calls
    const openvibeToolsOrigin = normalizeOrigin(config.openvibeToolsUrl || process.env.OV_NETWORK_URL);
    if (openvibeToolsOrigin) {
        allowed.add(openvibeToolsOrigin);
    } else {
        // OpenVibe default — allows openvibe.network and admin panel to call this service
        allowed.add('https://openvibe.network');
    }

    // openvibe.games game client calls cosmetics API cross-origin
    allowed.add('https://openvibe.games');

    // openvibe.tools + its satellites (pastes., dev., net., img., text., …) call this
    // API from the browser — pastes.openvibe.tools hosts the paste UI and was being
    // CORS-rejected outright, so every paste action from there failed. Subdomains are
    // matched by suffix in isAllowedOrigin() rather than enumerated, since satellites
    // are added over time; the apex is listed here for the exact-match fast path.
    allowed.add('https://openvibe.tools');

    if (config.nodeEnv !== 'production') {
        [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:3200',
        ].forEach(origin => allowed.add(origin));
    }

    return allowed;
}

let allowedOrigins = getAllowedOrigins();

function getStreamKey(stream) {
    return stream.managed_stream_key || db.getUserById(stream.user_id)?.stream_key;
}

function webrtcStreamHasActiveProducer(streamId) {
    const roomId = `stream-${streamId}`;
    const producers = webrtcSFU.getProducers(roomId);
    return producers.some((producer) => {
        const isConnected = ['connected', 'completed'].includes(producer.dtlsState) && ['connected', 'completed'].includes(producer.iceState);
        return !producer.paused && isConnected;
    });
}

function hasActiveLiveFeed(stream) {
    if (!stream) return false;
    // OpenRe.Stream holds the ingest (a mirrored session it confirmed recently): not stale.
    if (require('./openre/mirror').hasLiveSession(stream.id)) return true;
    const streamKey = getStreamKey(stream);
    if (stream.protocol === 'rtmp') {
        return !!streamKey && rtmpServer.isReceiving(streamKey);
    }
    if (stream.protocol === 'whip') {
        return whipHandler.hasActiveSessionsForStream(stream.id);
    }
    if (['webrtc', 'browser', 'screen'].includes(stream.protocol)) {
        return broadcastServer.isBroadcasterConnected(stream.id) || webrtcStreamHasActiveProducer(stream.id);
    }
    return false;
}

// ── Middleware ────────────────────────────────────────────────
app.set('trust proxy', 2); // Two hops: Cloudflare → nginx → Node

// A restore-drill instance answers reads only: 403 for every other method, on every path.
if (drill.enabled) app.use(drill.readOnly);

// RTMP FLV is now proxied same-origin via /api/streams/rtmp-proxy/:id.flv — no external CSP entry needed

// The hosted browser WHIP publisher (/whip-publisher.html) POSTs its SDP offer to the
// dedicated WHIP host when one is configured (whip.openvibe.live), which is a different
// origin from the page itself and would otherwise be blocked by connect-src 'self'.
// Resolved per request, not at boot: config.whip is (re)filled by the URL-registry refresh
// in start(), which runs after this middleware is built — a value captured here would be
// the env default, not the registry's. A duplicate 'self' is a valid no-op when unset.
const whipConnectSrc = () => (config.whip?.enabled && normalizeOrigin(config.whip?.publicUrl)) || "'self'";

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "https://openvibe.network", "https://jsmpeg.com", "https://esm.sh", "https://static.cloudflareinsights.com"],
            // esm.sh: mediasoup-client dynamic import for WebRTC SFU restreaming + RS restream
            styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            // i.ytimg.com / i.vimeocdn.com carry media-request thumbnails. Without them
            // every queued item renders as a broken image, which is what the media
            // request tab was doing for every YouTube link.
            imgSrc: ["'self'", "data:", "blob:", "image.tmdb.org", "https://openvibe.network", "https://openvibe.media", "cdn.frankerfacez.com", "cdn.betterttv.net", "cdn.7tv.app", "https://files.kick.com", "https://i.ytimg.com", "https://img.youtube.com", "https://i.vimeocdn.com"],
            connectSrc: ["'self'", "wss:", "https://openvibe.network", "https://openvibe.media", "https://openvibe.games", "https://cdn.jsdelivr.net", "https://esm.sh", "https://static.cloudflareinsights.com", whipConnectSrc],
            // VODs/clips play from openvibe.media (the /api proxies 302 there), which may
            // itself redirect to presigned B2/R2 object-store URLs — all must be allowed
            // or the browser blocks the media element.
            // data: — the mod TTS voice preview plays a data:audio/… URL; without it the browser
            // rejects the element ("no supported source") even though the backend returned audio.
            mediaSrc: ["'self'", "blob:", "data:", "https://openvibe.media", "https://s3.us-west-004.backblazeb2.com", "https://*.backblazeb2.com", "https://*.r2.cloudflarestorage.com"],
            frameSrc: ["'self'", "https://openvibe.network", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
            workerSrc: ["'self'", "blob:"],
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
// The cross-site go-live widget + its SSE feed must be loadable from other OpenVibe
// origins (openvibe.network / openvibe.games), so relax CORP for just those two paths.
app.use((req, res, next) => {
    if (req.path === '/live-notify.js' || req.path === '/api/live-events') {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    next();
});
/**
 * Origin check. Exact allowlist first, then a strict suffix rule for the openvibe.tools
 * satellites. Parsed with URL() and matched on hostname + https so a lookalike such as
 * https://evil-openvibe.tools or http://x.openvibe.tools cannot slip through a naive
 * endsWith on the raw origin string.
 */
function isAllowedOrigin(origin) {
    if (allowedOrigins.has(origin)) return true;
    try {
        const u = new URL(origin);
        if (u.protocol !== 'https:') return false;
        return u.hostname === 'openvibe.tools' || u.hostname.endsWith('.openvibe.tools');
    } catch { return false; }
}

// WHIP ingest is keyed by the stream key, not by a cookie, so it is open to every origin —
// that is what lets a static, backend-less site publish from the browser (docs/whip.md).
// It must therefore bypass the credentialed allowlist below, which would 403 the preflight.
app.use('/whip', whipHandler.whipCors);

const allowlistedCors = cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (isAllowedOrigin(origin)) return callback(null, true);
        console.warn(`[CORS] Rejected origin: "${origin}" | allowed: ${[...allowedOrigins].join(', ')} (+ *.openvibe.tools)`);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
});
app.use((req, res, next) => {
    if (req.path === '/whip' || req.path.startsWith('/whip/')) return next();
    return allowlistedCors(req, res, next);
});
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser());
app.use((err, req, res, next) => {
    if (err && err.message === 'Origin not allowed by CORS') {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    next(err);
});

// Rate limiting
// The SPA makes a lot of legitimate read-only API requests (channel data,
// media strip, weather, VOD pagination, polling, etc.), so GET/HEAD need a
// much higher ceiling than write operations.
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: (req) => {
        if (req.method === 'GET' || req.method === 'HEAD') return 900;
        return 180;
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down partner' },
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many auth attempts, please try again later' },
});
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many upload requests, please slow down' },
});
// ── Analytics Tracking ────────────────────────────────────────
const BetterSqlite3 = require('better-sqlite3');
// <data dir>/analytics.db (ANALYTICS_DB_PATH overrides it outside a drill; server/paths.js).
const analyticsDbPath = paths.analyticsDbPath();
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new BetterSqlite3(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
// A drill records no page views and runs no flush/aggregate timers (its analytics.db is its own, empty).
const analytics = new analyticsModule.AnalyticsTracker(analyticsDb, 'live', { retention: false, timers: !drill.enabled }); // prune: job 8b2 below
app.locals.analytics = analytics;
if (!drill.enabled) app.use(analytics.middleware());

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/avatar', uploadLimiter);
app.use('/api/thumbnails/live', uploadLimiter);
app.use('/api/vods/upload', uploadLimiter);
// Only rate-limit VOD upload chunk endpoint, not the read-only /live poll
app.use('/api/vods/stream/:streamId/chunk', uploadLimiter);
app.use('/api/vods/stream/:streamId/finalize', uploadLimiter);
app.use('/api/vods/clips', uploadLimiter);

// ── IP Ban Enforcement ───────────────────────────────────────
// Check if the requester's IP is globally banned. If so, return 404 for page requests
// and 403 for API requests. This makes the site appear to not exist for banned IPs.
// ── Ban page + owner exemption ───────────────────────────────
const escBanHtml = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_BAN_REASON = 'Repeated disrespect toward the owner of this site. Permanent.';
/** Resolve the signed-in user for an HTTP request (token cookie / Bearer / API token), cached per request. */
function banRequestUser(req) {
    if (req._ovBanUser !== undefined) return req._ovBanUser;
    let user = null;
    try {
        const { extractToken, verifyToken, resolveNetworkUser, authenticateApiToken } = require('./auth/auth');
        const token = extractToken(req);
        if (token) user = authenticateApiToken(token) || (() => { const d = verifyToken(token); return d ? resolveNetworkUser(d) : null; })();
    } catch { user = null; }
    req._ovBanUser = user || null;
    return req._ovBanUser;
}
/** Admins (the site owner) pass IP / network bans — they may live on the same network as a banned person. */
function isBanExemptAdmin(req) { const u = banRequestUser(req); return !!(u && !u.is_banned && require('./auth/permissions').can(u, 'staff.limits.exempt')); }
function isBanExemptAdminUser(u) { return !!(u && !u.is_banned && require('./auth/permissions').can(u, 'staff.limits.exempt')); }
/** Paths a banned network may still reach: health, the ban page's assets, SSO (so an admin can sign in), WHIP (stream-key auth, checks bans itself). */
function banPassPath(p) {
    return p === '/api/health' || p.startsWith('/banned') || p.startsWith('/assets/') || p.startsWith('/api/auth/sso') || p === '/api/auth/callback' || p === '/api/auth/logout' || p.startsWith('/whip');
}
function banNameFor(ban) {
    try { if (ban && ban.user_id) { const u = db.getUserById(ban.user_id); if (u) return u.display_name || u.username; } } catch { /* */ }
    return null;
}
function renderBannedPage(req, res, { name, reason } = {}) {
    let html = '';
    try { html = require('fs').readFileSync(path.join(assets.PUBLIC_DIR, 'banned.html'), 'utf8'); } catch { html = '<h1>Banned</h1>'; }
    html = html
        .replace('{{HEADLINE}}', name ? `${escBanHtml(name)}, you are banned from OpenVibe.Live.` : 'You are banned from OpenVibe.Live.')
        .replace('{{REASON}}', escBanHtml(reason || DEFAULT_BAN_REASON));
    res.status(403).set('Cache-Control', 'no-store').type('html').send(html);
}

app.use((req, res, next) => {
    // Skip health check so monitoring still works
    if (req.url === '/api/health') return next();
    // Banned network (single address or a whole home / carrier block). The site owner and admins
    // may share an address with a banned person, so a request that authenticates as a non-banned
    // admin passes; SSO + assets pass so an admin can sign in from a banned network and the ban
    // page can render. Everyone else on that network gets the ban screen (API: 403).
    try {
        const ipBan = db.getIpBan(req.ip, null);
        if (ipBan && !banPassPath(req.path) && !isBanExemptAdmin(req)) {
            if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
                return res.status(403).json({ error: 'Access denied' });
            }
            return renderBannedPage(req, res, { name: banNameFor(ipBan), reason: ipBan.reason });
        }
    } catch (e) { /* DB error — let request through rather than block everyone */ }
    // A browser that has been shown the ban screen keeps seeing it (cookie set by GET /banned),
    // signed in or not. Assets still load so the page itself can render.
    if (req.cookies && req.cookies.ov_banned === '1' && !req.path.startsWith('/banned') && !banPassPath(req.path)) {
        if (isBanExemptAdmin(req)) { res.clearCookie('ov_banned'); res.clearCookie('ov_banned_name'); return next(); }
        if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return res.status(403).json({ error: 'Account is banned' });
        return res.redirect(302, '/banned');
    }
    next();
});

// ── Static Files ─────────────────────────────────────────────
// Serve openvibe-shared browser assets at /shared/ — straight from node_modules/openvibe-shared,
// the OpenVibe.Shared release package.json pins (the public/ directory is read-only under
// systemd ProtectSystem=strict on production). The package lists its own browser files.
const sharedFiles = require('openvibe-shared/files');
const SHARED_BROWSER_FILES = sharedFiles.BROWSER;
const sharedServePath = sharedFiles.dir;
assets.setSharedDir(sharedServePath);
console.log(`[Server] /shared: serving ${SHARED_BROWSER_FILES.length} browser file(s) from ${sharedServePath}`);

{
    // Web-push service worker must be same-origin with scope "/" → expose it at the root.
    app.get('/openvibe-sw.js', (req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(sharedServePath, 'openvibe-sw.js'));
    });
    // Serve only the whitelisted browser files — don't expose the entire package
    const sharedFileSet = new Set(SHARED_BROWSER_FILES);
    app.use('/shared', (req, res, next) => {
        const fileName = path.basename(req.path);
        if (!sharedFileSet.has(fileName)) {
            return res.status(404).type('text/plain').send('Not found');
        }
        const filePath = path.join(sharedServePath, fileName);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        // Same deal as /js and /css: only a ?v= that matches the file's content hash is immutable.
        if (req.query.v && req.query.v === assets.hashOf('/shared/' + fileName)) assets.setImmutable(res);
        else res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.sendFile(filePath, (err) => {
            if (err && !res.headersSent) {
                res.status(404).type('text/plain').send('Not found');
            }
        });
    });
}

const soundsPath = path.join(assets.PUBLIC_DIR, 'assets/sounds');
app.use('/assets/sounds', express.static(soundsPath, {
    fallthrough: false,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'public, max-age=300');
    },
}));

// JS/CSS/HTML caching — see server/web/assets.js.
//
// Asset URLs in every HTML document are rewritten to ?v=<content hash> when the document is served,
// so nobody bumps a ?v= counter by hand any more. A request whose ?v= matches the current bytes is
// immutable for a year at the browser and at Cloudflare; a request for an earlier release's hash is
// served from that release's directory when it still exists; anything else is served no-cache so no
// cache can pin the wrong bytes under that URL. HTML is always no-cache — it names the versions.
const noCacheHeaders = assets.setNoCache;
const assetOpts = { etag: true, lastModified: true, setHeaders: assets.staticHeaders };
app.use('/js', assets.versionedStatic('/js'), express.static(path.join(assets.PUBLIC_DIR, 'js'), assetOpts));
app.use('/css', assets.versionedStatic('/css'), express.static(path.join(assets.PUBLIC_DIR, 'css'), assetOpts));
// Page markup that is fetched when a route is first opened instead of shipping inside index.html.
app.use('/fragments', assets.versionedStatic('/fragments'), express.static(path.join(assets.PUBLIC_DIR, 'fragments'), { ...assetOpts, fallthrough: false }));
// SEO: per-route <head> meta/OG/JSON-LD injection + dynamic sitemap. MUST be before the public
// static below (so it can intercept "/") and before the SPA catch-all. Only touches the SPA
// HTML routes (home, vods/clips/pastes lists, vod/clip/paste detail); everything else falls through.
// Pastes on openvibe.community (PASTES_ON_COMMUNITY=1): /p/<slug> redirects there, and it is mounted
// before SEO so crawlers and people get the same redirect and Community is the one canonical page.
require('./web/paste-handover').register(app);
try { require('./seo/seo').register(app); } catch (e) { console.warn('[SEO] not registered:', e.message); }
// Standalone HTML pages (popout chat, kiosk, legal, OBS overlays…) go through the same asset rewrite
// as the SPA shell, so their script and stylesheet URLs can never drift out of date again.
app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.path.endsWith('.html')) return next();
    if (!sendDocument(res, req.path.slice(1))) return next();
});
// index: false — "/" must reach sendDocument (the SPA fallback), never the raw index.html with its
// unfilled route markers and unversioned asset URLs (a request without Accept: text/html skips SEO).
app.use(express.static(assets.PUBLIC_DIR, { index: false, setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) noCacheHeaders(res); } }));

// Ensure data directories exist (all under the data directory, server/paths.js). VOD/clip/paste/
// thumbnail files live in OpenVibe.Media now; what remains is Live-local state (live thumbs, emotes,
// avatars, offline screens) + the local song-request media cache.
[paths.dataDir(), paths.data('live-thumbs'), paths.data('emotes'), paths.data('avatars'), paths.data('offline'), paths.data('media'), paths.data('media', 'cache')].forEach(fullPath => {
    if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// Serve locally-cached song-request media files (media player page)
// Locally cached song-request media. Only the cache subtree is public: this directory has held
// operational files before (the yt-dlp cookie jar, which was therefore downloadable by anyone),
// and a static mount over a directory that other code writes into is a standing invitation.
app.use('/media', express.static(paths.data('media'), {
    dotfiles: 'deny',
    index: false,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// AI moment frames (one small JPEG per stream memory, see server/ai/stream-memory-job.js)
app.use('/data/ai-moments', express.static(paths.dir('AI_MOMENTS_PATH', 'ai-moments'), {
    maxAge: '30d', immutable: true, index: false, dotfiles: 'deny',
}));

// Arena portraits (AI-generated fighting-game character art, see server/arena)
app.use('/data/arena', express.static(paths.dir('ARENA_IMAGE_PATH', 'arena'), {
    maxAge: '7d', immutable: true, index: false, dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('Content-Type', 'image/png'),
}));

// OpenVibe.Media → Live outcomes (vod.ready / clip.ready …), two ways during the Wave 3
// transition, applied once whichever arrives first; MEDIA_EVENTS_AUTHORITY=webhook|both|events
// picks the one that acts (server/media-proxy/outcomes.js). Mounted BEFORE the /internal router
// because they authenticate with HMAC signatures, not X-Internal-Key.
//   direct webhook (MEDIA_WEBHOOK_SECRET), to be removed once Events is proven
app.post('/internal/media-webhook', require('./media-proxy/webhook'));
//   OpenVibe.Events delivery of media.vod.* / media.clip.* / media.storage.* (MEDIA_EVENTS_SECRET)
app.post('/internal/media-events', require('./media-proxy/media-events').handler);
// Network identity events (signed out everywhere, password changed, banned): Live refuses older tokens.
app.post('/internal/network-events', require('./auth/network-events').handler);
// OpenVibe.Events → Live: OpenRe session lifecycle mirrored into `streams` (signed delivery,
// OPENRE_EVENTS_SECRET; server/openre/mirror.js). Also before /internal (no X-Internal-Key).
app.post('/internal/openre-events', require('./openre/mirror').webhookHandler);

// Internal (server-to-server) routes — allow openvibe.network to call into this service
// Summary numbers for the Network's navigation service (ordering sites by real use).
// Internal key only; returns totals, never rows.
app.get('/internal/analytics-summary', (req, res) => {
    if (!require('./net/internal-key').internalKeyOk(req)) return res.status(401).json({ ok: false });
    try {
        const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
        const st = analytics.getStats({ days }) || {};
        res.json({ ok: true, summary: st.summary || {} });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// OpenVibe.Chat reads Live data and asks for side effects here, with Network service tokens
// (server/chat/live-context-routes.js); mounted before the X-Internal-Key routes below.
const chatLiveContext = require('./chat/live-context-routes');
app.use('/internal/chat-context', chatLiveContext.contextRouter);
app.use('/internal/chat-effects', chatLiveContext.effectsRouter);
// OpenVibe.Tips announces settled tips in the creator's chat here (service token, live.tips_delivery.write).
app.use('/internal/tips', require('./tips/delivery-routes'));
// OpenVibe.Network sends go-live notifications from live.stream.started and asks here who follows
// the channel (service token, live.follower.read).
app.use('/internal/followers', require('./streaming/followers-internal'));
// The canonical channel/owner resolver for other services (roadmap D20; service token, live.lineage.resolve).
app.use('/internal/lineage', require('./lineage/routes'));
app.use('/internal', require('./internal/routes'));


// Map file extensions to forced image MIME types
const IMAGE_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };

// Serve avatar files (force image Content-Type, prevent XSS via spoofed extensions)
app.use('/data/avatars', express.static(paths.data('avatars'), {
    setHeaders: (res, filePath) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        const ext = path.extname(filePath).toLowerCase();
        if (IMAGE_EXT_MIME[ext]) res.setHeader('Content-Type', IMAGE_EXT_MIME[ext]);
    },
}));

// Paste screenshots live in OpenVibe.Media now — legacy /data/pastes/screenshots/<name>
// URLs (avatars, old pastes, hero moments) 302-redirect to the Media public host.
app.get('/data/pastes/screenshots/:filename', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.redirect(302, mediaClient.screenshotUrl(path.basename(req.params.filename)));
});

// The SPA renders Media's relative paste URLs (/p/<slug>/screenshot, /raw)
// against THIS origin — bounce them to the Media public host, where the
// canonical paste page lives.
app.get('/p/:slug/screenshot', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.redirect(302, `${mediaClient.MEDIA_PUBLIC_URL}/p/${encodeURIComponent(req.params.slug)}/screenshot`);
});
app.get('/p/:slug/raw', (req, res) => {
    res.redirect(302, mediaClient.pasteRawUrl(req.params.slug));
});

// Offline-screen assets (channel offline background: webp images + transcoded webm)
app.use('/data/offline', express.static(paths.data('offline'), {
    maxAge: '1h',
    setHeaders: (res, filePath) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        if (filePath.endsWith('.webm')) res.setHeader('Content-Type', 'video/webm');
        else if (filePath.endsWith('.webp')) res.setHeader('Content-Type', 'image/webp');
    },
}));

// ── API Routes ───────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/streams', streamRoutes);
// Cross-site "streamer went live" SSE feed (consumed by /live-notify.js everywhere).
const liveEvents = require('./streaming/live-events');
app.get('/api/live-events', (req, res) => liveEvents.subscribe(req, res));
// CHAT_AUTHORITY=chat: OpenVibe.Chat serves the chat REST routes (nginx sends /api/chat/, /api/dm/,
// /api/tts/, /api/sounds there). One that still reaches Live must not write to the mirror.
const chatRemote = require('./chat/chat-authority').isRemote();
const chatMoved = (req, res) => res.status(503).set('Retry-After', '2').json({ error: 'Chat is served by OpenVibe.Chat' });
app.use('/api/chat', chatRemote ? chatMoved : chatRoutes);
app.use('/api/funds', monetizationRoutes);
app.use('/api/coins', coinsRoutes);
app.use('/api/payments', require('./monetization/payments-routes'));
app.use('/api/cosmetics', cosmeticsRoutes);
// Live's VOD and clip pages in OpenVibe.Search follow every change made here (events/search-media-documents.js).
const searchMedia = require('./events/search-media-documents');
app.use('/api/vods', searchMedia.afterChange('vod'), vodRoutes);
app.use('/api/clips', searchMedia.afterChange('clip'), clipRoutes);
app.use('/api/chat-ai', require('./ai/chat-ai-routes'));
app.use('/api/easter-egg', require('./ai/easter-egg-routes'));
app.use('/api/arena', require('./arena/routes'));            // streamer vs streamer (docs/arena.md)
app.use('/api/recap', require('./recap/routes'));            // after-show reports (docs/recap.md)
app.use('/api/comments', commentRoutes);
app.use('/api/controls', controlRoutes);
app.use('/api/onvif', onvifRoutes);
app.use('/api/admin/openre', require('./openre/routes'));
app.use('/api/admin', adminRoutes);
app.use('/api/mod', require('./admin/mod-routes'));
app.use('/api/channels', require('./admin/channel-mod-routes'));
app.use('/api/robotstreamer', robotStreamerRoutes);
app.use('/api/restream', restreamRoutes);
app.use('/api/thumbnails', thumbnailRoutes);
app.use('/api/themes', themeRoutes);
app.use('/api/emotes', emoteRoutes);
app.use('/api/sounds', chatRemote ? chatMoved : require('./chat/sounds-routes'));
app.use('/api/ai-viewers', require('./ai/viewers/routes'));
app.use('/api/powerchat', require('./integrations/powerchat-routes'));
// Game & Canvas — migrated to openvibe.games
app.get('/game', (req, res) => res.redirect(301, 'https://openvibe.games/game'));
app.get('/canvas', (req, res) => res.redirect(301, 'https://openvibe.games/canvas'));
app.use('/api/game', (req, res) => res.status(410).json({ error: 'Game has moved to https://openvibe.games/game' }));
app.use('/api/meta', metaRoutes);
app.use('/api/pastes', pasteRoutes);
app.use('/api/content', require('./content/routes'));    // Content (people's work) + Moments (AI) feeds
app.use('/api/home', require('./home/routes'));
app.use('/api/i18n', require('./i18n/routes'));                 // on-demand translation for viewers (any line → your language)
app.use('/api/kiosk', require('./kiosk/routes'));
// Song-request queue (watch-party) — stays Live-local (OpenVibe.Media does not
// carry the downloader/queue subsystem). Spends OpenCoins via the Network wallet.
app.use('/api/media', require('./media/routes'));
// Privacy proxy for third-party images (offline-screen HTML, panels): fetched server-side so a
// viewer's IP/UA never reaches a host a streamer chose. SSRF-guarded, image-only, cache-forever.
app.use('/api/img-proxy', require('./media/external-image-proxy'));
app.use('/api/vibe-coding', vibeCodingRoutes);
const ttsRoutes = require('./chat/tts-routes');
app.use('/api/tts', chatRemote ? chatMoved : ttsRoutes);
const dmRoutes = require('./chat/dm-routes');
app.use('/api/dm', chatRemote ? chatMoved : dmRoutes);
const analyticsRoutes = require('./streaming/analytics-routes');
app.use('/api/analytics', analyticsRoutes);
const newsRoutes = require('./news/news-routes');
app.use('/api/news', newsRoutes);

// ── Internal Analytics API ───────────────────────────────────
// Called by openvibe-tools admin panel to fetch this service's analytics
app.get('/api/admin/analytics', requireAuth, permissions.requireAdmin, (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days) || 30, 365);
        const hours = req.query.hours ? Math.min(parseInt(req.query.hours), 8760) : null;
        res.json({ ok: true, analytics: analytics.getStats({ days, hours }) });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});
app.get('/api/admin/analytics/bots', requireAuth, permissions.requireAdmin, (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days) || 30, 365);
        res.json({ ok: true, bots: analytics.getBotAnalysis(days) });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── Health Check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        name: 'OpenVibe.Live',
        version: '1.0.0',
        uptime: process.uptime(),
        chat_connections: chatServer.getTotalConnections(),
    });
});

/**
 * GET /api/ready — readiness, which is not the same thing as liveness.
 *
 * /api/health answers "is a process listening". That is true from the moment the socket is
 * accepted, which during a deploy is *before* the database is open and before the request paths
 * this server actually serves will work. A deploy script that waits on /api/health therefore
 * declares success while the site is still returning errors.
 *
 * This answers "can this process serve a real request": the database responds, the schema is
 * initialised, and boot has completed. 503 until all of that is true, so a health gate can be a
 * genuine gate.
 */
let _bootComplete = false;
// The shared navbar loads /shared/release-watch.js, which polls this and prompts open tabs after a
// deploy; it never reloads a tab that is watching, broadcasting or typing. GET /release.json, and
// POST /release-metrics: open tabs' update reports into /metrics (release_client_updates_total).
release.mount(app, { registry: metricsRegistry });

// Required: boot finished and the database answers. Optional (a failure is "degraded", still 200):
// the WebRTC SFU, OpenVibe.Media and the Network signing key — Live serves channels, chat and RTMP
// without them, so they must neither pass silently nor take the whole service out of rotation.
const readiness = observability.createLiveReadiness({
    release,
    bootComplete: () => _bootComplete,
    dbQuery: () => db.get('SELECT 1 AS ok'),
    sfuReady: () => webrtcSFU.ready === true && !!webrtcSFU.worker,
    // A drill asks no other service anything, Media's health included.
    mediaUrl: drill.enabled ? null : mediaClient.MEDIA_URL,
    networkKey: () => require('./auth/auth').getNetworkPublicKey(),
    drill: drill.enabled,
});
app.get('/api/ready', readiness.handler);

observability.registerDomainGauges(metricsRegistry, {
    liveStreams: () => db.getLiveStreams().length,
    wsServers: { chat: chatServer, broadcast: broadcastServer, control: controlServer, call: callServer },
    outboxStatus: () => require('./events/stream-events').status(),
});

// ── Updates / Changelog ──────────────────────────────────────
const { execFile } = require('child_process');
const REPO_DIR = path.resolve(__dirname, '..');

/**
 * GET /api/updates — recent commit history for the updates page.
 *
 * This used to shell out with execSync on the request path. execSync blocks the entire event
 * loop: for however long git takes — up to its 5s timeout — no other request on the box is
 * served, no WebSocket frame is read, and no chat message is delivered. The home page fetches
 * this on every load, so a cold git call after a deploy stalled everyone at once.
 *
 * Now: one async read, memoised, shared by concurrent callers. The history only changes when we
 * deploy, so a minute of staleness is free.
 */
const UPDATES_TTL_MS = 60_000;
let _updatesCache = { at: 0, commits: null, inflight: null };
function readCommits(limit) {
    if (_updatesCache.commits && Date.now() - _updatesCache.at < UPDATES_TTL_MS) {
        return Promise.resolve(_updatesCache.commits);
    }
    // Coalesce: a burst of first-loads after a deploy must not spawn a git process each.
    if (_updatesCache.inflight) return _updatesCache.inflight;
    _updatesCache.inflight = new Promise((resolve) => {
        // -c safe.directory=*: the release layout's worktrees are root-owned; the service user only reads them.
        execFile('git', ['-c', 'safe.directory=*', '--no-pager', 'log', '--pretty=format:%H||%h||%s||%an||%aI', `-${limit}`],
            { cwd: REPO_DIR, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
            (err, stdout) => {
                _updatesCache.inflight = null;
                if (err) return resolve(_updatesCache.commits || null);
                const commits = String(stdout).trim().split('\n').filter(Boolean).map(line => {
                    const [hash, short, subject, author, date] = line.split('||');
                    return { hash, short, subject, author, date };
                });
                _updatesCache = { at: Date.now(), commits, inflight: null };
                resolve(commits);
            });
    });
    return _updatesCache.inflight;
}
app.get('/api/updates', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
    // Always read the widest window we serve, so one cache entry answers every limit.
    const commits = await readCommits(100);
    if (!commits) return res.status(503).json({ error: 'Update history unavailable' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ commits: commits.slice(0, limit) });
});

/**
 * POST /api/admin/broadcast — admin sends a message to all chat clients.
 * Body: { type: 'system'|'server_restart'|'update', message, summary, url }
 */
app.post('/api/admin/broadcast', requireAuth, permissions.requireAdmin, (req, res) => {
    try {
        const { type = 'system', message, summary, url } = req.body;
        if (!message && !summary) return res.status(400).json({ error: 'message or summary required' });
        chatServer.broadcastAll({
            type,
            message: message || summary,
            summary,
            url,
            timestamp: new Date().toISOString(),
        });
        res.json({ ok: true, clients: chatServer.getTotalConnections() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── CSP violation reports (from the report-only policy on HTML documents) ──
// Counted per directive + blocked origin and logged at most once a minute per key, so a noisy page
// cannot fill the journal. Counts are visible in /api/admin/diagnostics.
const _cspCounts = new Map();
app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }), (req, res) => {
    try {
        const r = (req.body && (req.body['csp-report'] || (Array.isArray(req.body) && req.body[0] && req.body[0].body))) || {};
        const directive = String(r['violated-directive'] || r.effectiveDirective || 'unknown').split(' ')[0].slice(0, 40);
        let blocked = String(r['blocked-uri'] || r.blockedURL || 'inline');
        try { blocked = new URL(blocked).origin; } catch { blocked = blocked.slice(0, 40); }
        const key = `${directive} ${blocked}`;
        const e = _cspCounts.get(key) || { n: 0, loggedAt: 0 };
        e.n++;
        if (Date.now() - e.loggedAt > 60000) { e.loggedAt = Date.now(); console.warn(`[CSP report-only] ${key} (${e.n} so far)`); }
        _cspCounts.set(key, e);
        if (_cspCounts.size > 500) _cspCounts.delete(_cspCounts.keys().next().value);
    } catch { /* malformed report */ }
    res.status(204).end();
});
app.locals.cspCounts = _cspCounts;

// ── Docs ─────────────────────────────────────────────────────
// docs/*.md rendered as HTML at /docs/<name> (+ /docs/<name>.md) with GitHub-compatible
// heading anchors, so https://openvibe.live/docs/whip#publishing-from-a-browser is a
// link people can be sent to without leaving the site.
app.use('/docs', require('./docs/routes'));

// ── OBS Overlay Widgets ──────────────────────────────────────
// Modular system: /obs/<widget>/<username>
// Each widget is a standalone HTML page designed for OBS browser sources.
app.get('/obs/chat/:username', (req, res) => {
    sendDocument(res, 'obs/chat.html');
});

// New overlay routes — per-slot and global
app.get('/overlay/chat/:username/:slotIdOrSlug', (req, res) => {
    sendDocument(res, 'obs/chat.html');
});
app.get('/overlay/chat/:username', (req, res) => {
    sendDocument(res, 'obs/chat.html');
});

app.get('/media/:username', (req, res) => {
    sendDocument(res, 'media-player.html');
});

// DM notifications sent before 2026-09-23 linked to /dm/<conversation id>, a page Live never had;
// the messenger opens the thread from /?dm=<id> now.
app.get(/^\/dm\/(\d{1,12})\/?$/, (req, res) => res.redirect(302, `/?dm=${req.params[0]}`));

// ── Legal Pages ───────────────────────────────────────────────
app.get('/dmca', (req, res) => {
    sendDocument(res, 'dmca.html');
});
app.get('/tos', (req, res) => {
    sendDocument(res, 'tos.html');
});
app.get('/terms', (req, res) => {
    res.redirect(302, '/tos');
});
app.get('/privacy', (req, res) => {
    sendDocument(res, 'privacy.html');
});

// ── WHIP Endpoint (WebRTC-HTTP Ingestion Protocol) ───────────
// OBS and other WHIP-compatible encoders send WebRTC media via HTTP POST.
// Body is raw SDP (application/sdp), auth via Bearer token.
app.options('/whip/:streamId', whipHandler.handleWhipOptions);
app.options('/whip/:streamId/:resourceId', whipHandler.handleWhipOptions);
app.post('/whip/:streamId', express.text({ type: 'application/sdp', limit: '64kb' }), whipHandler.handleWhipPost);
app.patch('/whip/:streamId/:resourceId', express.text({ type: 'application/trickle-ice-sdpfrag', limit: '16kb' }), whipHandler.handleWhipPatch);
app.delete('/whip/:streamId/:resourceId', whipHandler.handleWhipDelete);

// ── Kiosk / new-tab page ─────────────────────────────────────
// Standalone one-pager (NOT the SPA) with live network data + all the domain links —
// meant to be set as a browser's default new-tab URL for on-stream promo. Served for
// both /kiosk and /kiosk.html so either URL works.
app.get(['/kiosk', '/kiosk.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    sendDocument(res, 'kiosk.html');
});

// Popout chat pretty URLs: /popout/global, /popout/:username (channel chat) and
// /popout/:username/:streamId (pinned stream, auto-follows the channel's live state).
// NOT /chat/… — the SPA's global chat page (voice channels et al) lives there.
// The legacy /popout-chat.html?mode=…&stream=… form keeps working (static file) and
// self-upgrades to the pretty URL client-side.
// /popout-chat/… works as an alias; with no username both prefixes mean global chat.
app.get(['/popout', '/popout/*', '/popout-chat', '/popout-chat/*'], (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    sendDocument(res, 'popout-chat.html');
});

// ── Ban screen ───────────────────────────────────────────────
// A banned account is sent here by the client the moment /api/auth/me answers 403 (see
// loadUser in public/js/app.js). The page is rendered with the banned user's name and the
// reason on record, so they see exactly why every time they open the site.
/**
 * The "Continue" button on the ban page: the site owner chose to let the banned person back in.
 * Lifts the account ban and every network ban attached to them, clears the sticky cookie.
 */
function signBannedUid(id) {
    const mac = require('crypto').createHmac('sha256', String(config.jwt && config.jwt.secret || '')).update(`ban:${id}`).digest('base64url');
    return `${id}.${mac}`;
}
function verifyBannedUidCookie(value) {
    const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(value || ''));
    if (!m) return null;
    const expected = signBannedUid(Number(m[1])).split('.')[1];
    const a = Buffer.from(m[2]), b = Buffer.from(expected);
    return a.length === b.length && require('crypto').timingSafeEqual(a, b) ? Number(m[1]) : null;
}
app.post('/banned/continue', (req, res) => {
    const user = banRequestUser(req);
    const ipBan = (() => { try { return db.getIpBan(req.ip, null); } catch { return null; } })();
    let subject = null;
    if (user && user.is_banned) subject = db.getUserById(user.id);
    else if (ipBan && ipBan.user_id) subject = db.getUserById(ipBan.user_id);
    else {
        // A browser that was signed in as the banned account when it saw the ban page carries a
        // signed id. It used to be the display name in plain text, looked up as a username, so
        // anyone could lift any account's ban by sending a made-up cookie.
        const uid = verifyBannedUidCookie(req.cookies && req.cookies.ov_banned_uid);
        if (uid) subject = db.getUserById(uid) || null;
    }
    res.clearCookie('ov_banned'); res.clearCookie('ov_banned_name'); res.clearCookie('ov_banned_uid');
    if (!subject) {
        // Nothing to lift for this visitor (stray cookie) — just let them through.
        return res.json({ ok: true, name: null, lifted: 0 });
    }
    let lifted = [];
    try {
        lifted = db.forgiveBan(subject.id);
        db.logModerationAction({ scope_type: 'site', target_user_id: subject.id, action_type: 'unban', details: { via: 'ban-page-continue', ip: req.ip, lifted: lifted.map(r => r.ip_address || 'account') } });
        console.log(`[Ban] ${subject.username} (id ${subject.id}) pressed Continue on the ban page from ${req.ip} — ${lifted.length} ban row(s) lifted`);
    } catch (e) {
        console.error('[Ban] continue failed:', e.message);
        return res.status(500).json({ ok: false, error: 'Could not lift the ban right now' });
    }
    res.json({ ok: true, name: subject.display_name || subject.username, lifted: lifted.length });
});

app.get('/banned', (req, res) => {
    const user = banRequestUser(req);
    const ipBan = (() => { try { return db.getIpBan(req.ip, null); } catch { return null; } })();
    if (user && !user.is_banned && (!ipBan || isBanExemptAdminUser(user))) { res.clearCookie('ov_banned'); res.clearCookie('ov_banned_name'); return res.redirect('/'); }
    // Make the ban stick to this browser: from now on every visit — signed in or not — lands here.
    const isSecure = String(config.baseUrl || '').startsWith('https');
    const tenYears = 10 * 365 * 24 * 3600 * 1000;
    if (user && user.is_banned) {
        res.cookie('ov_banned', '1', { httpOnly: true, maxAge: tenYears, sameSite: 'Lax', secure: isSecure });
        res.cookie('ov_banned_name', String(user.display_name || user.username).slice(0, 60), { httpOnly: true, maxAge: tenYears, sameSite: 'Lax', secure: isSecure });
        res.cookie('ov_banned_uid', signBannedUid(user.id), { httpOnly: true, maxAge: tenYears, sameSite: 'Lax', secure: isSecure });
    }
    const name = (user && user.is_banned) ? (user.display_name || user.username)
        : (req.cookies && req.cookies.ov_banned_name ? String(req.cookies.ov_banned_name) : banNameFor(ipBan));
    const reason = (user && user.is_banned && user.ban_reason) || (ipBan && ipBan.reason) || DEFAULT_BAN_REASON;
    renderBannedPage(req, res, { name, reason });
});

// ── SPA Fallback ─────────────────────────────────────────────
// Every page gets the SPA shell, but a path that names nothing (unknown route, channel, VOD, clip,
// paste or stream, or a private item this visitor may not see) gets it with a 404 status, so
// search engines and monitors see a real 404; the client renders its not-found view either way.
// API paths still get the JSON 404. See server/web/page-status.js for the page list.
// The shell comes from server/seo/seo.js shellHtml: a 404 is noindex with no canonical (the shell's
// own head describes the home page), and no other page claims the home page as its canonical.
let _shellHtml = null;
try { _shellHtml = require('./seo/seo').shellHtml; } catch { _shellHtml = null; }
function sendShell(res, urlPath) {
    let html = null;
    try { html = _shellHtml ? _shellHtml(urlPath, res.statusCode) : null; } catch { html = null; }
    if (!html) return sendDocument(res, 'index.html', urlPath);
    if (!res.getHeader('Cache-Control')) assets.setNoCache(res);
    try { res.setHeader('Content-Security-Policy-Report-Only', assets.cspReportOnly(html)); } catch { /* */ }
    res.type('html').send(html);
    return true;
}
app.get('*', require('./web/page-status').spaFallback((res, urlPath) => sendShell(res, urlPath)));

// ── Global Error Handler ─────────────────────────────────────
app.use((err, req, res, _next) => {
    // Multer file-filter / size-limit errors → 400
    if (err.name === 'MulterError' || (err.message && err.message.includes('file'))) {
        return res.status(400).json({ error: err.message || 'File upload error' });
    }
    console.error('[Server] Unhandled route error:', err.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ── WebSocket Upgrade Handler ────────────────────────────────
server.on('upgrade', (req, socket, head) => {
    // A restore-drill instance has no WebSocket servers: chat, broadcast, calls and controls are live
    // traffic, and a drill only answers reads.
    if (drill.enabled) return drill.refuseUpgrade(socket);
    const url = req.url || '';
    const origin = normalizeOrigin(req.headers.origin);

    if (origin && !allowedOrigins.has(origin)) {
        console.warn(`[Server] WebSocket upgrade rejected — origin "${origin}" not in allowed origins [${[...allowedOrigins].join(', ')}]`);
        socket.destroy();
        return;
    }

    // Block banned IPs from WebSocket connections
    try {
        const wsIp = chatServer.getClientIp(req);
        if (db.isIpBanned(wsIp, null)) {
            // Admins pass network bans (shared home network) — see isBanExemptAdmin.
            let exempt = false;
            try { const { extractWsToken, authenticateWs } = require('./auth/auth'); exempt = isBanExemptAdminUser(authenticateWs(extractWsToken(req))); } catch { exempt = false; }
            if (!exempt) { socket.destroy(); return; }
        }
    } catch (e) { /* non-critical — allow through on DB error */ }

    if (url.startsWith('/ws/chat')) {
        chatServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/vibe-coding/publish')) {
        vibeCodingPublishServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/broadcast')) {
        broadcastServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/control')) {
        controlServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/call')) {
        callServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/game') || url.startsWith('/ws/canvas')) {
        socket.destroy(); // migrated to openvibe.games
    } else if (url.startsWith('/ws/robotstreamer-publish')) {
        robotStreamerService.handleUpgrade(req, socket, head);
    } else {
        socket.destroy();
    }
});

// ── Initialize & Start ──────────────────────────────────────
async function start() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║        OpenVibe.Live  v1.0.0             ║');
    console.log('  ║   Open Live Streaming, Community Run ▶((( • )))  ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');

    if (drill.enabled) return startDrill();

    await config.refreshRegistry();
    allowedOrigins = getAllowedOrigins();
    console.log('[Server] Effective BASE_URL:', config.baseUrl);
    console.log('[Server] Effective OV_NETWORK_URL:', config.openvibeToolsUrl);
    console.log('[Server] Allowed CORS/WebSocket origins:', [...allowedOrigins].join(', '));

    // 1. Initialize database
    db.initDb();
    // Initialize cosmetics tables
    cosmeticsModule.ensureTables();
    // Chat tag tables (read-only tags, server/chat/tags.js)
    require('./chat/tags').ensureTagTables();
    // Initialize DM tables
    const dm = require('./chat/dm');
    dm.ensureTables();
    // Back from CHAT_AUTHORITY=chat (rollback): chat writes OpenVibe.Chat never acknowledged land here.
    if (!require('./chat/chat-authority').isRemote()) require('./chat/chat-remote').drainToLocal();
    // Migrate: add last_heartbeat column if missing
    try { db.run("ALTER TABLE streams ADD COLUMN last_heartbeat DATETIME"); console.log('[DB] Added last_heartbeat column'); } catch { /* already exists */ }
    // Migrate: add theme_id to users table if missing
    try { db.run("ALTER TABLE users ADD COLUMN theme_id INTEGER"); console.log('[DB] Added theme_id column'); } catch { /* already exists */ }
    // Migrate: add call_mode column to streams table for group calls
    try { db.run("ALTER TABLE streams ADD COLUMN call_mode TEXT DEFAULT NULL"); console.log('[DB] Added streams.call_mode column'); } catch { /* already exists */ }
    console.log('[Server] Database ready');

    // Seed/refresh built-in themes on every start (upserts by slug, so re-tuned
    // palettes always take effect; IDs stay stable).
    try {
        require('./themes/theme-service').seedBuiltinThemes();
        console.log('[Themes] Built-in themes seeded/refreshed');
    } catch (err) {
        console.warn('[Themes] Seed error:', err.message);
    }

    // 2. Create admin from .env config if none exists (first-time setup only)
    const adminExists = db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (!adminExists) {
        const { v4: uuidv4 } = require('uuid');
        const adminUser = config.adminUsername || 'admin';
        db.createUser({
            username: adminUser,
            email: null,
            // Live keeps no passwords (sign-in is the OpenVibe account's): this account signs in through SSO once
            // an openvibe.network account with its username exists; ADMIN_PASSWORD is not used.
            password_hash: '$sso$' + require('crypto').randomBytes(32).toString('hex'),
            display_name: adminUser,
            stream_key: uuidv4().replace(/-/g, ''),
        });
        db.run("UPDATE users SET role = 'admin' WHERE username = ?", [adminUser]);
        console.log(`[Server] Admin user "${adminUser}" created from ADMIN_USERNAME; sign in with the openvibe.network account of that name`);
    }

    // Game & Canvas migrated to openvibe.games — no local init needed

    // 3. Initialize chat server
    chatServer.init(server);
    vibeCodingPublishServer.init(server);

    // 3b. Initialize breaking news service
    const newsService = require('./news/news-service');
    newsService.setChatServer(chatServer);
    newsService.start();

    // 4. Initialize control server
    controlServer.init(server);

    // 4b. Initialize broadcast server
    broadcastServer.init(server);

    // Game & Canvas WebSocket servers migrated to openvibe.games

    // 4d. Initialize group call signaling server
    callServer.init(server);

    for (const stream of db.getLiveStreams()) {
        robotStreamerService.startForStream(stream).catch((err) => {
            console.warn(`[RS] Restore failed for stream ${stream.id}:`, err.message);
        });
        chatRelayService.startForStream(stream).catch((err) => {
            console.warn(`[ChatRelay] Restore failed for stream ${stream.id}:`, err.message);
        });
        try { require('./integrations/ai-chatbot-service').startForStream(stream); } catch (err) { console.warn(`[AI-Bots] Restore failed for stream ${stream.id}:`, err.message); }
    }

    // 4e. Refresh heartbeats for streams surviving a server restart
    // After a deploy/restart, is_live=1 streams have stale heartbeats from before
    // the server went down. Without this, the stale-stream cleanup (every 60s) would
    // kill them before the broadcaster's client can reconnect and resume heartbeating.
    // This gives broadcasters a fresh 5-minute window to reconnect.
    const survivingStreams = db.all('SELECT id FROM streams WHERE is_live = 1');
    if (survivingStreams.length > 0) {
        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE is_live = 1');
        console.log(`[Server] Refreshed heartbeats for ${survivingStreams.length} surviving stream(s) — broadcasters have 5 min to reconnect`);
    }

    // 5. Initialize WebRTC SFU (may fail if mediasoup not installed)
    try {
        await webrtcSFU.init();
    } catch (err) {
        console.warn('[Server] WebRTC SFU not available:', err.message);
    }

    // 5b. Resume enabled restreams for streams that survived the restart.
    // WHIP/RTMP broadcasters have no browser session to re-start them manually.
    for (const stream of db.getLiveStreams()) {
        // OpenRe restreams its own sessions; Live must not start a second push for them.
        if (require('./openre/mirror').ownsStream(stream.id)) continue;
        restreamManager.resumeForStream(stream.id, stream.user_id, {
            protocol: stream.protocol,
            streamKey: stream.managed_stream_key,
        }).catch((err) => {
            console.warn(`[Restream] Boot resume failed for stream ${stream.id}:`, err.message);
        });
    }

    // 6. Start RTMP server (may fail if node-media-server not installed)
    try {
        // node-media-server registers process.on('uncaughtException') that calls process.exit()
        // We need to remove it so port conflicts don't crash the main HTTP server
        const listenersBefore = process.listeners('uncaughtException').slice();
        rtmpServer.start();
        const listenersAfter = process.listeners('uncaughtException');
        for (const fn of listenersAfter) {
            if (!listenersBefore.includes(fn)) {
                process.removeListener('uncaughtException', fn);
            }
        }
    } catch (err) {
        console.warn('[Server] RTMP server not available:', err.message);
    }

    // 6b. Hook RTMP events for auto-start/stop restreams
    rtmpServer.on('publish', ({ streamId, userId, streamKey }) => {
        restreamManager.autoStartForStream(streamId, userId, { protocol: 'rtmp', streamKey }).catch(err => {
            console.warn(`[Restream] RTMP auto-start error for stream ${streamId}:`, err.message);
        });
    });
    rtmpServer.on('unpublish', ({ streamId }) => {
        restreamManager.stopAllForStream(streamId);
        // OBS stopped: the RS chat mirror/passthrough, chat relays and AI bots end with the ingest.
        try { robotStreamerService.stopForStream(streamId); } catch (err) { console.warn('[RS] stop on unpublish failed:', err.message); }
        try { chatRelayService.stopForStream(streamId); } catch { /* non-critical */ }
        try { require('./integrations/ai-chatbot-service').stopForStream(streamId); } catch { /* non-critical */ }
    });

    // 6c. Hook WebRTC SFU events for auto-start restreams
    // When a broadcaster produces into the SFU (triggered by restream request),
    // the first video producer signals that media is available for restreaming.
    webrtcSFU.on('producer-added', ({ roomId, kind }) => {
        if (kind !== 'video') return; // Only trigger on video producer
        const match = roomId.match(/^stream-(\d+)$/);
        if (!match) return;
        const streamId = parseInt(match[1]);
        const stream = db.getStreamById(streamId);
        if (!stream?.is_live || stream.protocol !== 'webrtc') return;
        restreamManager.autoStartForStream(streamId, stream.user_id, { protocol: 'webrtc' }).catch(err => {
            console.warn(`[Restream] WebRTC auto-start error for stream ${streamId}:`, err.message);
        });
    });

    // 6d. Hook broadcaster connection for WebRTC restream resume
    // When a broadcaster connects (or reconnects after server restart), resume ALL enabled
    // restreams — not just auto_start ones. If the stream is live, all restreams should run.
    broadcastServer.on('broadcaster-connected', ({ streamId, userId }) => {
        const stream = db.getStreamById(streamId);
        if (!stream?.is_live || stream.protocol !== 'webrtc') return;
        restreamManager.resumeForStream(streamId, userId, { protocol: 'webrtc' }).catch(err => {
            console.warn(`[Restream] Broadcaster-connect resume error for stream ${streamId}:`, err.message);
        });
    });

    // 6e. Start periodic viewer count polling for restream destinations
    restreamManager.startViewerCountPolling();

    // 6g. OpenRe mirror reconcile (only runs when OPENRE_URL is set; idle with nothing mirrored).
    try { require('./openre/mirror').start(); } catch (e) { console.warn('[OpenRe] mirror reconcile not started:', e.message); }

    // 6f. VOD storage/offload is owned by OpenVibe.Media now — nothing to start here.

    // 7. Start HTTP server.
    //
    // Zero-downtime restarts: when systemd owns the listening socket (a .socket unit with
    // Accept=no) it hands it to us as file descriptor 3. Connections that arrive while we are
    // restarting then wait in the kernel's accept queue instead of being refused, so a deploy
    // costs a handful of slow requests rather than a wall of 502s for everyone mid-page.
    // Without the socket unit this is a normal listen on the configured port, so the code is
    // identical to run by hand, in dev, or on a box that has not been switched over.
    const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
    if (socketActivated) console.log('[Server] socket-activated: listening on the socket systemd handed us (fd 3)');
    server.listen(socketActivated ? { fd: 3 } : { port: config.port, host: config.host }, () => {
        console.log('');
        console.log(`[Server] HTTP server:  http://${config.host}:${config.port}`);
        console.log(`[Server] WebSocket:    ws://${config.host}:${config.port}/ws/chat`);
        console.log(`[Server] WebSocket:    ws://${config.host}:${config.port}/ws/broadcast`);
        console.log(`[Server] WebSocket:    ws://${config.host}:${config.port}/ws/control`);
        console.log(`[Server] WebSocket:    ws://${config.host}:${config.port}/ws/call`);
        console.log(`[Server] Game/Canvas:  migrated to openvibe.games`);
        console.log(`[Server] Environment:  ${config.nodeEnv}`);
        console.log(`[Server] BASE_URL:     ${config.baseUrl}`);
        console.log(`[Server] WHIP_PUBLIC_URL: ${config.whip?.publicUrl}`);
        console.log(`[Server] WHIP_PUBLIC_URL_ENABLED: ${config.whip?.enabled}`);
        console.log(`[Server] WEBRTC_PUBLIC_URL: ${config.webrtc?.publicUrl}`);
        console.log(`[Server] MEDIASOUP_ANNOUNCED_IP: ${config.mediasoup?.announcedIp}`);
        console.log(`[Server] CORS origins: ${[...allowedOrigins].join(', ')}`);
        if (config.whip?.publicUrl && !config.whip?.enabled) {
            console.warn('[Server] NOTE: WHIP_PUBLIC_URL is configured but disabled. OpenVibe.Live will fall back to WEBRTC_PUBLIC_URL for client WHIP endpoints.');
        }
        if (config.turn?.url) {
            console.log(`[Server] TURN server:  ${config.turn.url}`);
        } else {
            console.log(`[Server] TURN server:  not configured (STUN-only — some viewers may fail to connect)`);
        }
        if (config.nodeEnv === 'production' && config.whip?.publicUrl?.startsWith('http://')) {
            console.warn('[Server] WARNING: WHIP_PUBLIC_URL is using http:// in production. WHIP/WebRTC should use TLS so OBS can connect securely.');
        }
        if (config.rtmp?.host && config.whip?.publicUrl) {
            try {
                const rtmpHost = new URL(`https://${config.rtmp.host}`).hostname;
                const whipHost = new URL(config.whip.publicUrl).hostname;
                if (rtmpHost === whipHost) {
                    console.warn('[Server] WARNING: RTMP_HOST and WHIP_PUBLIC_URL host are identical. This may route WHIP/WebRTC traffic to the RTMP hostname and cause TLS/certificate mismatch errors. Use a dedicated WebRTC/WHIP host.');
                }
            } catch (e) {
                // ignore malformed host
            }
        }
        // No check of MEDIASOUP_ANNOUNCED_IP against the WHIP host: ICE candidates carry the announced
        // IP whatever host the signaling reached, and whip.openvibe.live is behind Cloudflare.
        if (config.nodeEnv === 'production' && config.mediasoup?.announcedIp && ['127.0.0.1', 'localhost', '::1'].includes(config.mediasoup.announcedIp)) {
            console.warn('[Server] WARNING: Mediasoup announcedIp is configured as a local address. External WebRTC clients may be unable to connect. Set MEDIASOUP_ANNOUNCED_IP to your public WHIP/WebRTC hostname.');
        }
        console.log('');
        // Flip readiness only once everything the request paths depend on is up. /api/ready
        // returns 503 before this line, which is what makes a deploy health gate meaningful.
        _bootComplete = true;
        console.log('[Server] Ready. Good vibes only. ▶');
        console.log('');

        // AI stream-memory job (no-op until enabled in openvibe.network/admin → AI).
        try { require('./ai/stream-memory-job').start(); } catch (e) { console.warn('[AI] memory job not started:', e.message); }
        try { (() => { try { const d = require('./ai/transcribe').describe(); console.log(`[AI] whisper ${d.available ? 'available' : 'UNAVAILABLE'} — bin=${d.bin} model=${d.model}${d.modelExists ? '' : ' (MISSING)'} live=${d.modelLive}${d.modelLiveExists ? '' : ' (MISSING)'} vad=${d.vadModel || 'off'} threads=${d.threads}`); } catch (e) { console.warn('[AI] whisper probe failed:', e.message); } })();
    require('./ai/backfill-job').start(); } catch (e) { console.warn('[AI] backfill job not started:', e.message); }
    // AI viewers activity log: keep a week.
    setInterval(() => { try { const n = db.pruneAiViewerLog(7); if (n) console.log(`[AI-Viewers] pruned ${n} log row(s)`); } catch { /* */ } }, 6 * 3600 * 1000);
        try { require('./ai/streamer-overview-job').start(); } catch (e) { console.warn('[AI] streamer-overview job not started:', e.message); }
        try { require('./ai/chat-ai').start(); } catch (e) { console.warn('[AI] chat-ai job not started:', e.message); }
        try { require('./ai/slogan-job').start(); } catch (e) { console.warn('[AI] slogan job not started:', e.message); }
        try { require('./ai/ai-moments-job').start(); } catch (e) { console.warn('[AI] moments job not started:', e.message); }
        try { require('./ai/auto-clip-job').start(); } catch (e) { console.warn('[AI] auto-clip job not started:', e.message); }
        try { require('./ai/easter-egg-job').start(); } catch (e) { console.warn('[AI] easter-egg job not started:', e.message); }
        try { require('./arena/arena-job').start(); } catch (e) { console.warn('[Arena] job not started:', e.message); }
        try { require('./recap/recap').start(); } catch (e) { console.warn('[Recap] job not started:', e.message); }
        // Continuous audio → stream_timeline_events. Gated behind ai_timeline_enabled
        // (default off), so starting it is a no-op until switched on in admin.
        try { require('./ai/timeline-job').start(); } catch (e) { console.warn('[AI] timeline job not started:', e.message); }
        // Heal server-side recordings for live streams (resume after restart / Media restart)
        // so clipping always has a source. First pass delayed to let broadcasters reconnect.
        // VOD health scanning, disk guardianship and storage tiering moved to OpenVibe.Media.
        try {
            setTimeout(() => { try { recorder.reconcileLiveRecordings(); } catch (e) { console.warn('[VOD] reconcile:', e.message); } }, 20000);
            setInterval(() => { try { recorder.reconcileLiveRecordings(); } catch (e) { console.warn('[VOD] reconcile:', e.message); } }, 45000);
            console.log('[VOD] Recording reconciler started (ingest via OpenVibe.Media)');
        } catch (e) { console.warn('[VOD] recording reconciler not started:', e.message); }
        // Announce newly-created clips in the source channel's chat. Scheduling comes
        // from the OpenVibe.Media clip.ready webhook; the sweeper fires the message.
        try { require('./media-proxy/clip-notify').startClipNotifySweeper(); } catch (e) { console.warn('[ClipNotify] not started:', e.message); }
        try { require('./media-proxy/asset-sync').start(); } catch (e) { console.warn('[AssetSync] not started:', e.message); }
        // Feed connected streamers' viewer counts into PowerChat overlays (platform mode).
        try { require('./integrations/powerchat-platform').startViewerCountSweeper(); } catch (e) { console.warn('[PowerChat] viewer sweeper not started:', e.message); }
        // Batched channel-point earns → PowerChat leaderboard feed.
        try { require('./integrations/powerchat-platform').startCurrencyEarnFlusher(); } catch (e) { console.warn('[PowerChat] earn flusher not started:', e.message); }
        // Read /chat/history back so a 202-accepted relay that moderation dropped is visible.
        try { require('./integrations/powerchat-platform').startChatVerifier(); } catch (e) { console.warn('[PowerChat] chat verifier not started:', e.message); }
        // Backfill checkout orders whose donation.completed webhook never arrived (/paid-messages).
        try { require('./integrations/powerchat-reconcile').startReconciler(); } catch (e) { console.warn('[PowerChat] reconciler not started:', e.message); }
        // Auto-renew lapsed channel subs (Vibes-balance renewal; Stripe renews natively).
        try { require('./monetization/payments').startRenewalSweeper(); } catch (e) { console.warn('[Payments] renewal sweeper not started:', e.message); }
        // 5-minute live-viewer samples → the home hero's 24h sparkline.
        try { require('./home/routes').startViewerSampler(); } catch (e) { console.warn('[Home] viewer sampler not started:', e.message); }
        try { require('./home/star-job').start(); } catch (e) { console.warn('[Home] star picker not started:', e.message); }
        // PowerChat: prune the webhook-dedupe log daily so it can't grow unbounded.
        try {
            const _pcClean = () => { try { db.cleanupPowerchatDeliveries(3); } catch { /* */ } };
            setTimeout(_pcClean, 120000);
            const _pcT = setInterval(_pcClean, 24 * 60 * 60 * 1000); if (_pcT.unref) _pcT.unref();
        } catch { /* */ }

        // Deploy notice in chat: only commits not announced before, folded into one rolling message
        // (server/chat/deploy-notice.js). A restart with no new code says nothing.
        require('./chat/deploy-notice').announce({ db, chatServer }).catch((err) => console.warn('[Deploy notice] failed:', err.message));
    });

    // 8. Start stale stream heartbeat cleanup (every 60 seconds)
    let heartbeatCleanupRunning = false;
    const liveVodThumbGeneratedAt = new Map();   // streamId → last Media frame-grab time
    const maintenanceInterval = setInterval(async () => {
        if (heartbeatCleanupRunning) return;
        heartbeatCleanupRunning = true;
        try {
            const staleStreams = db.all(
                `SELECT id, user_id, protocol FROM streams
                 WHERE is_live = 1
                 AND (
                     (last_heartbeat IS NOT NULL AND last_heartbeat < datetime('now', '-5 minutes'))
                     OR (last_heartbeat IS NULL AND started_at < datetime('now', '-6 minutes'))
                 )`
            );
            for (const stream of staleStreams) {
                if (hasActiveLiveFeed(stream)) {
                    console.log(`[Heartbeat] Skipping stale cleanup for stream ${stream.id} because active ingest feed exists (${stream.protocol})`);
                    continue;
                }
                console.log(`[Heartbeat] Ending stale stream ${stream.id} (no heartbeat for 5+ minutes)`);
                db.endStream(stream.id);
                try { db.computeAndCacheStreamAnalytics(stream.id); } catch {}
                // Auto-finalize any active VOD recording for this stream (via OpenVibe.Media)
                if (!recorder.isFinalizingStream(stream.id)) {
                    recorder.finalizeStream(stream.id).catch(err => {
                        console.warn(`[VOD] Auto-finalize failed for stale stream ${stream.id}:`, err.message);
                    });
                }
                // Stop RS chat bridge for this stream (prevents zombie bridges)
                robotStreamerService.stopForStream(stream.id);
                // Stop chat relay bridges for this stream
                chatRelayService.stopForStream(stream.id);
                // Stop AI chatbots for this stream
                try { require('./integrations/ai-chatbot-service').stopForStream(stream.id); } catch { /* non-critical */ }
                // Stop any active restreams for this stream
                restreamManager.stopAllForStream(stream.id);
                // Close signaling room and notify viewers
                broadcastServer.endStream(stream.id);
                const user = db.getUserById(stream.user_id);
                if (stream.protocol === 'jsmpeg' && user) {
                    jsmpegRelay.destroyChannel(user.stream_key);
                } else if (stream.protocol === 'webrtc') {
                    webrtcSFU.closeRoom(`stream-${stream.id}`);
                }
            }

            // Also finalize recordings whose stream already ended (finalize was never called)
            try {
                for (const [sid] of recorder.activeRecordings) {
                    const s = db.getStreamById(sid);
                    if (s && s.is_live) continue;
                    if (recorder.isFinalizingStream(sid)) continue;
                    console.log(`[VOD] Finalizing orphaned recording for ended stream ${sid}`);
                    recorder.finalizeStream(sid).catch(() => {});
                }
            } catch (err) {
                console.warn('[VOD] Orphan cleanup error:', err.message);
            }

            // Also clean up old live-stream thumbnails (>1 hour)
            liveThumbs.cleanupOldThumbnails();

            // Generate server-side thumbnails for RTMP streams (no client capture available).
            // A managed-slot "Go Live" publishes under the SLOT's stream key, so prefer
            // managed_streams.stream_key over the personal users.stream_key — the RTMP
            // server's activeStreams map (and the HTTP-FLV URL) are keyed by the publish key.
            const rtmpStreams = db.all(
                `SELECT s.id, COALESCE(ms.stream_key, u.stream_key) AS stream_key FROM streams s
                 JOIN users u ON s.user_id = u.id
                 LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
                 WHERE s.is_live = 1 AND s.protocol = 'rtmp'`
            );
            for (const rs of rtmpStreams) {
                if (!rs.stream_key || !rtmpServer.isReceiving(rs.stream_key)) continue;
                if (!liveThumbs.shouldRefreshLiveThumbnail(rs.id, 120000)) continue;
                liveThumbs.generateLiveStreamThumbnail(rs.id, rs.stream_key, { minAgeMs: 120000 }).catch(() => {});
            }

            // Generate server-side thumbnails for JSMPEG streams (broadcaster uses FFmpeg, no browser preview)
            const jsmpegStreams = db.all(
                `SELECT s.id, u.stream_key FROM streams s
                 JOIN users u ON s.user_id = u.id
                 WHERE s.is_live = 1 AND s.protocol = 'jsmpeg'`
            );
            for (const js of jsmpegStreams) {
                if (!liveThumbs.shouldRefreshLiveThumbnail(js.id, 120000)) continue;
                const channelInfo = jsmpegRelay.getChannelInfo(js.stream_key);
                if (channelInfo && channelInfo.videoPort) {
                    liveThumbs.generateJSMPEGThumbnail(js.id, channelInfo.videoPort).catch(() => {});
                }
            }

            // WebRTC/WHIP/browser live thumbnails: the broadcaster client's periodic
            // canvas-capture POST covers browser publishers with a visible tab, but WHIP
            // publishers (OBS) and hidden tabs send nothing. Fallback: have Media extract
            // a frame from the in-progress recording (fragmented mp4 — readable while
            // growing) and use that as both the live card and RECORDING-card thumbnail.
            const webrtcStreams = db.all(
                `SELECT id FROM streams WHERE is_live = 1 AND protocol NOT IN ('rtmp', 'jsmpeg')`
            );
            for (const wsStream of webrtcStreams) {
                if (liveThumbs.shouldRefreshLiveThumbnail(wsStream.id, 120000)) {
                    const lastGen = liveVodThumbGeneratedAt.get(wsStream.id) || 0;
                    if (Date.now() - lastGen < 120000) continue;
                    liveVodThumbGeneratedAt.set(wsStream.id, Date.now());
                    // First choice: a frame straight from the SFU (works for OBS/WHIP and hidden
                    // tabs, and needs no recording). The Media in-progress-VOD frame is the backup.
                    const grabbed = await liveThumbs.generateWebrtcThumbnail(wsStream.id, { minAgeMs: 120000 }).catch(() => null);
                    if (grabbed) continue;
                    const rec = recorder.activeRecordings.get(wsStream.id);
                    if (!rec || !rec.vodId) continue;
                    mediaClient.generateThumbnail('vod', rec.vodId)
                        .then((out) => {
                            const url = mediaClient.publicUrl(out?.url);
                            if (url) db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', [url, wsStream.id]);
                        })
                        .catch(() => {});
                }
            }
            for (const [sid] of liveVodThumbGeneratedAt) {
                if (!webrtcStreams.some(s => s.id === sid)) liveVodThumbGeneratedAt.delete(sid);
            }
        } catch (err) {
            console.error('[Heartbeat] Cleanup error:', err.message);
        } finally {
            heartbeatCleanupRunning = false;
        }
    }, 60000);
    if (typeof maintenanceInterval.unref === 'function') maintenanceInterval.unref();

    // 8b. Canonical identity: report every Live<->Network link to Network's identity_legacy_map
    // (roadmap Wave 1). Idempotent on Network's side; daily, first run a few minutes after boot.
    // Then fill in the subject of every linked account no token has told Live about yet.
    require('./utils/jobs').every('identity-legacy-sync', 24 * 60 * 60 * 1000, async () => {
        const sync = require('./auth/identity-sync');
        await sync.syncLegacyMap();
        return sync.backfillSubjects();
    },
        { initialDelayMs: 3 * 60 * 1000, jitterMs: 60 * 1000 });

    // 8b2. Raw analytics retention (ADR-021): events older than 30 days go, in bounded batches;
    // hourly/daily rollups stay. Nightly, first run a few minutes after boot.
    require('./utils/jobs').every('analytics-prune', 24 * 60 * 60 * 1000, async () => {
        const out = await analyticsModule.retention.pruneRawEvents(analyticsDb, { days: analyticsModule.retention.MAX_DAYS });
        if (out.deleted) console.log(`[Analytics] pruned ${out.deleted} raw events older than ${out.cutoff}`);
    }, { initialDelayMs: 5 * 60 * 1000, jitterMs: 60 * 1000 });

    // 8b3. Media requests whose OpenCoins charge never got an answer: charged again with the same
    // key (a replay if it landed) and refunded, so no viewer pays for a request that failed.
    require('./utils/jobs').every('media-charge-reconcile', 5 * 60 * 1000, () => require('./media/media-queue').reconcileCharges(),
        { initialDelayMs: 2 * 60 * 1000, jitterMs: 30 * 1000 });

    // 8c. Durable events (roadmap Wave 3): stream lifecycle goes to OpenVibe.Events through the
    // transactional outbox (server/events/stream-events.js). Off unless EVENTS_URL is set.
    try { require('./events/stream-events').init(); } catch (err) { console.warn('[Events] not started:', err.message); }
    // Channels in OpenVibe.Search (WS-O task 10): live.index_document.* through the same outbox.
    try { require('./events/search-documents').init(); } catch (err) { console.warn('[Search] channel documents not started:', err.message); }
    try { require('./events/search-media-documents').init(); } catch (err) { console.warn('[Search] VOD and clip documents not started:', err.message); }

    // 8d. User modules on Network (Contracts 0.41.0): live.profile and live.stats, written when they
    // change (server/auth/module-summaries.js). Off without OV_OAUTH_CLIENT_SECRET.
    try { require('./auth/module-summaries').init(); } catch (err) { console.warn('[Modules] summaries not started:', err.message); }

    // 9. Periodic registry refresh — re-syncs config with openvibe.network every 5 minutes.
    // This is a safety net: if the startup refresh failed (openvibe.network was temporarily
    // unreachable), subsequent refreshes will fix CORS, issuer, and other URL config.
    require('./utils/jobs').every('registry-refresh', 5 * 60 * 1000, async () => {
        try {
            await config.refreshRegistry();
            const freshOrigins = getAllowedOrigins();
            if ([...freshOrigins].join(',') !== [...allowedOrigins].join(',')) {
                allowedOrigins = freshOrigins;
                console.log(`[Config] CORS origins updated after registry refresh: ${[...allowedOrigins].join(', ')}`);
            }
        } catch (err) {
            console.warn('[Config] Periodic registry refresh failed:', err.message);
        }
    }, { jitterMs: 30 * 1000 });
}

/**
 * Boot a restore-drill instance (LIVE_DRILL): open the restored database, bring its schema up to
 * this release the way any boot does, and serve HTTP on HOST:PORT. Nothing else from start() runs:
 * no registry refresh (config comes from the env), no seeding, no chat drain, no socket servers, no
 * RTMP/SFU/JSMPEG, no restream or relay resume, no heartbeat refresh, no jobs of any kind.
 */
function startDrill() {
    db.initDb();
    cosmeticsModule.ensureTables();
    require('./chat/tags').ensureTagTables();
    require('./chat/dm').ensureTables();
    console.log(`[Drill] Database ready: ${paths.dbPath()}`);
    // Its port taken: stop (the process-wide handler would log EADDRINUSE and keep running unready).
    server.once('error', (err) => { console.error(`[Drill] HTTP server: ${err.message}`); process.exit(1); });
    // Never fd 3: a drill does not serve on a socket systemd handed over (assertSafe refuses that too).
    server.listen({ port: config.port, host: config.host }, () => {
        _bootComplete = true;
        console.log(`[Drill] Ready: http://${config.host}:${config.port} (reads only)`);
    });
}

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    if (drill.enabled) {
        // Nothing was started but the HTTP server and the two databases.
        console.log('[Drill] Shutting down');
        _bootComplete = false;
        try { analytics.destroy(); analyticsDb.close(); } catch { /* */ }
        server.close(() => { try { db.close(); } catch { /* */ } process.exit(0); });
        try { server.closeAllConnections(); } catch { /* */ }
        setTimeout(() => process.exit(0), 3000).unref();
        return;
    }
    console.log('\n[Server] Shutting down...');

    // Notify all chat clients before closing connections
    try {
        chatServer.broadcastAll({
            type: 'server_restart',
            message: '⚙️ Chat server restarting — you will be reconnected automatically.',
            timestamp: new Date().toISOString(),
        });
    } catch { /* non-critical */ }

    // Kill any in-flight whisper/ffmpeg transcription children so they don't orphan
    // (and so their temp files get cleaned by the close handlers). The interrupted VOD
    // is left in 'processing' → re-queued to 'pending' on next boot (crash recovery).
    try { const n = require('./ai/transcribe').killActive(); if (n) console.log(`[Server] Killed ${n} transcription child(ren)`); } catch { /* */ }
    try { const n = require('./ai/timeline-job').stopAll(); if (n) console.log(`[Server] Stopped ${n} continuous audio capture(s)`); } catch { /* */ }
    try { require('./ai/media-analysis').killActive(); } catch { /* */ }

    // Cleanly END RobotStreamer passthrough streams FIRST (before the exit races the reconnect).
    // This closes our protoo peers so RS's SFU closes the producers now and tells its viewers,
    // instead of leaving stale producers that black out RS video (audio still playing) on the next
    // go-live until viewers refresh. Done up-front so RS has the whole shutdown window to propagate.
    try { const n = require('./integrations/rs-passthrough-relay').stopAll(); if (n) console.log(`[Server] Closed ${n} RobotStreamer passthrough(s)`); } catch { /* */ }

    // Stop advertising readiness immediately: from here on this process is draining, and anything
    // gating on /api/ready should see that before the socket actually closes.
    _bootComplete = false;
    // No new background runs from here on (the jobs helper's loops); and end SSE streams so
    // server.close() can actually complete instead of always hitting the forced exit.
    try { require('./utils/jobs').stopAll(); } catch { /* */ }
    try { require('./streaming/live-events').closeAll(); } catch { /* */ }

    // Small delay to let the message reach clients before closing sockets
    setTimeout(() => {
        restreamManager.stopViewerCountPolling();
        restreamManager.stopAll();
        try { recorder.stopAll(); } catch {}
        // canvasServer + gameServer migrated to openvibe.games
        callServer.close();
        chatServer.close();
        controlServer.close();
        broadcastServer.close();
        jsmpegRelay.closeAll();
        webrtcSFU.closeAll();
        rtmpServer.stop();
        analytics.destroy();
        analyticsDb.close();
        db.close();

        server.close(() => {
            console.log('[Server] Goodbye — keep the vibe alive.');
            process.exit(0);
        });

        // Force exit after 5s
        setTimeout(() => process.exit(1), 5000);
    }, 300);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start Server ─────────────────────────────────────────────
start().catch(err => {
    console.error('[Server] Fatal error:', err);
    process.exit(1);
});
