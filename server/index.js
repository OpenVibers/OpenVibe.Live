/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║              OpenVibe.Live — Main Server                  ║
 * ║        Free & Open Live Streaming · openvibe.live         ║
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

const path = require('path');
const fs = require('fs');

// Load env before anything else
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');

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
const { AnalyticsTracker } = require('openvibe-shared/analytics');

// WHIP (WebRTC-HTTP Ingestion Protocol)
const whipHandler = require('./streaming/whip-handler');

// Game & Canvas — migrated to openvibe.games (game/canvas code removed)

// ── Express App ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
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

// RTMP FLV is now proxied same-origin via /api/streams/rtmp-proxy/:id.flv — no external CSP entry needed

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "https://openvibe.network", "https://jsmpeg.com", "https://esm.sh", "https://static.cloudflareinsights.com"],
            // esm.sh: mediasoup-client dynamic import for WebRTC SFU restreaming + RS restream
            styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "image.tmdb.org", "https://openvibe.network", "https://openvibe.media", "cdn.frankerfacez.com", "cdn.betterttv.net", "cdn.7tv.app", "https://files.kick.com"],
            connectSrc: ["'self'", "wss:", "https://openvibe.network", "https://openvibe.media", "https://openvibe.games", "https://cdn.jsdelivr.net", "https://esm.sh", "https://static.cloudflareinsights.com"],
            // VODs/clips play from openvibe.media (the /api proxies 302 there), which may
            // itself redirect to presigned B2/R2 object-store URLs — all must be allowed
            // or the browser blocks the media element.
            mediaSrc: ["'self'", "blob:", "https://openvibe.media", "https://s3.us-west-004.backblazeb2.com", "https://*.backblazeb2.com", "https://*.r2.cloudflarestorage.com"],
            frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
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
app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        console.warn(`[CORS] Rejected origin: "${origin}" | allowed: ${[...allowedOrigins].join(', ')}`);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
}));
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
const analyticsDbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const analyticsDb = new BetterSqlite3(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'live');
app.locals.analytics = analytics;
app.use(analytics.middleware());

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
app.use((req, res, next) => {
    // Skip health check so monitoring still works
    if (req.url === '/api/health') return next();
    try {
        if (db.isIpBanned(req.ip, null)) {
            if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
                return res.status(403).json({ error: 'Access denied' });
            }
            return res.status(404).send('<!DOCTYPE html><html><head><title>404</title></head><body><h1>404 Not Found</h1></body></html>');
        }
    } catch (e) { /* DB error — let request through rather than block everyone */ }
    next();
});

// ── Static Files ─────────────────────────────────────────────
// Serve openvibe-shared browser assets at /shared/ — serve directly from the
// resolved source directory to avoid write operations (the public/ directory
// is read-only under systemd ProtectSystem=strict on production).
const SHARED_BROWSER_FILES = ['theme-loader.js', 'notification-ui.js', 'account-switcher.js'];
let sharedServePath = null;

(function resolveSharedAssets() {
    const candidates = [
        () => path.dirname(require.resolve('openvibe-shared/package.json')),
        () => path.resolve(__dirname, '../node_modules/openvibe-shared'),
        () => path.resolve(__dirname, '..', '..', 'OpenVibeApp', 'packages', 'openvibe-shared'),
        () => path.resolve(__dirname, '..', '..', 'packages', 'openvibe-shared'),
    ];
    for (const getPath of candidates) {
        try {
            const p = getPath();
            if (p && fs.existsSync(p)) {
                // Verify at least one required browser file exists
                const found = SHARED_BROWSER_FILES.filter(f => fs.existsSync(path.join(p, f)));
                if (found.length > 0) {
                    sharedServePath = p;
                    console.log(`[Server] /shared: serving ${found.length}/${SHARED_BROWSER_FILES.length} browser file(s) from ${p}`);
                    const missing = SHARED_BROWSER_FILES.filter(f => !found.includes(f));
                    if (missing.length) console.warn(`[Server] /shared: missing files: ${missing.join(', ')}`);
                    return;
                }
            }
        } catch (_) {}
    }
    console.error('[Server] /shared: openvibe-shared source not found — shared browser assets will return 404');
})();

if (sharedServePath) {
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
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.sendFile(filePath, (err) => {
            if (err && !res.headersSent) {
                res.status(404).type('text/plain').send('Not found');
            }
        });
    });
} else {
    console.error('[Server] /shared: serving unavailable — shared browser assets will return 404');
    app.use('/shared', (req, res) => {
        res.status(404).type('text/plain').send('Shared assets unavailable');
    });
}

const soundsPath = path.resolve(__dirname, '../public/assets/sounds');
app.use('/assets/sounds', express.static(soundsPath, {
    fallthrough: false,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'public, max-age=300');
    },
}));

// JS/CSS/HTML: no-cache + tell Cloudflare CDN not to cache at edge
// Browsers revalidate with etag (304 Not Modified), CDN always fetches fresh from origin
const noCacheHeaders = (res) => { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('CDN-Cache-Control', 'no-store'); };
app.use('/js', express.static(path.join(__dirname, '../public/js'), { maxAge: 0, etag: true, lastModified: true, setHeaders: noCacheHeaders }));
app.use('/css', express.static(path.join(__dirname, '../public/css'), { maxAge: 0, etag: true, lastModified: true, setHeaders: noCacheHeaders }));
// SEO: per-route <head> meta/OG/JSON-LD injection + dynamic sitemap. MUST be before the public
// static below (so it can intercept "/") and before the SPA catch-all. Only touches the SPA
// HTML routes (home, vods/clips/pastes lists, vod/clip/paste detail); everything else falls through.
try { require('./seo/seo').register(app); } catch (e) { console.warn('[SEO] not registered:', e.message); }
app.use(express.static(path.join(__dirname, '../public'), { setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) noCacheHeaders(res); } }));

// Ensure data directories exist. VOD/clip/paste/thumbnail files live in
// OpenVibe.Media now; what remains is Live-local state (live thumbs, emotes,
// avatars, offline screens) + the local song-request media cache.
['./data', './data/live-thumbs', './data/emotes', './data/avatars', './data/offline', './data/media', './data/media/cache'].forEach(dir => {
    const fullPath = path.resolve(dir);
    if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// Serve locally-cached song-request media files (media player page)
app.use('/media', express.static(path.resolve('./data/media')));

// OpenVibe.Media → Live webhook (vod.ready / clip.ready …). Mounted BEFORE the
// /internal router because it authenticates with an HMAC signature, not X-Internal-Key.
app.post('/internal/media-webhook', require('./media-proxy/webhook'));

// Internal (server-to-server) routes — allow openvibe.network to call into this service
app.use('/internal', require('./internal/routes'));


// Map file extensions to forced image MIME types
const IMAGE_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };

// Serve avatar files (force image Content-Type, prevent XSS via spoofed extensions)
app.use('/data/avatars', express.static(path.resolve('./data/avatars'), {
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
app.use('/data/offline', express.static(path.resolve('./data/offline'), {
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
app.use('/api/chat', chatRoutes);
app.use('/api/funds', monetizationRoutes);
app.use('/api/coins', coinsRoutes);
app.use('/api/payments', require('./monetization/payments-routes'));
app.use('/api/cosmetics', cosmeticsRoutes);
app.use('/api/vods', vodRoutes);
app.use('/api/clips', clipRoutes);
app.use('/api/chat-ai', require('./ai/chat-ai-routes'));
app.use('/api/easter-egg', require('./ai/easter-egg-routes'));
app.use('/api/comments', commentRoutes);
app.use('/api/controls', controlRoutes);
app.use('/api/onvif', onvifRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/mod', require('./admin/mod-routes'));
app.use('/api/channels', require('./admin/channel-mod-routes'));
app.use('/api/robotstreamer', robotStreamerRoutes);
app.use('/api/restream', restreamRoutes);
app.use('/api/thumbnails', thumbnailRoutes);
app.use('/api/themes', themeRoutes);
app.use('/api/emotes', emoteRoutes);
app.use('/api/sounds', require('./chat/sounds-routes'));
app.use('/api/ai-viewers', require('./ai/viewers/routes'));
app.use('/api/powerchat', require('./integrations/powerchat-routes'));
// Game & Canvas — migrated to openvibe.games
app.get('/game', (req, res) => res.redirect(301, 'https://openvibe.games/game'));
app.get('/canvas', (req, res) => res.redirect(301, 'https://openvibe.games/canvas'));
app.use('/api/game', (req, res) => res.status(410).json({ error: 'Game has moved to https://openvibe.games/game' }));
app.use('/api/meta', metaRoutes);
app.use('/api/pastes', pasteRoutes);
app.use('/api/home', require('./home/routes'));
app.use('/api/kiosk', require('./kiosk/routes'));
// Song-request queue (watch-party) — stays Live-local (OpenVibe.Media does not
// carry the downloader/queue subsystem). Spends OpenCoins via the Network wallet.
app.use('/api/media', require('./media/routes'));
app.use('/api/vibe-coding', vibeCodingRoutes);
const ttsRoutes = require('./chat/tts-routes');
app.use('/api/tts', ttsRoutes);
const dmRoutes = require('./chat/dm-routes');
app.use('/api/dm', dmRoutes);
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

// ── Updates / Changelog ──────────────────────────────────────
const { execSync } = require('child_process');
const REPO_DIR = path.resolve(__dirname, '..');

/**
 * GET /api/updates — returns recent git commit history for the updates page.
 * Query params: ?limit=30 (default 30, max 100)
 */
app.get('/api/updates', (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
        const raw = execSync(
            `git --no-pager log --pretty=format:'%H||%h||%s||%an||%aI' -${limit}`,
            { cwd: REPO_DIR, encoding: 'utf8', timeout: 5000 }
        );
        const commits = raw.trim().split('\n').filter(Boolean).map(line => {
            const [hash, short, subject, author, date] = line.split('||');
            return { hash, short, subject, author, date };
        });
        res.json({ commits });
    } catch (err) {
        console.error('[Updates] git log error:', err.message);
        res.status(500).json({ error: 'Failed to read update history' });
    }
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

// ── OBS Overlay Widgets ──────────────────────────────────────
// Modular system: /obs/<widget>/<username>
// Each widget is a standalone HTML page designed for OBS browser sources.
app.get('/obs/chat/:username', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/obs/chat.html'));
});

// New overlay routes — per-slot and global
app.get('/overlay/chat/:username/:slotIdOrSlug', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/obs/chat.html'));
});
app.get('/overlay/chat/:username', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/obs/chat.html'));
});

app.get('/media/:username', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/media-player.html'));
});

// ── Legal Pages ───────────────────────────────────────────────
app.get('/dmca', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dmca.html'));
});
app.get('/tos', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/tos.html'));
});
app.get('/terms', (req, res) => {
    res.redirect(302, '/tos');
});
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/privacy.html'));
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
    res.sendFile(path.join(__dirname, '../public/kiosk.html'));
});

// ── SPA Fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
    // Don't serve HTML for API routes
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

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
            socket.destroy();
            return;
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
    console.log('  ║   Free & Open Live Streaming ▶((( • )))  ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');

    await config.refreshRegistry();
    allowedOrigins = getAllowedOrigins();
    console.log('[Server] Effective BASE_URL:', config.baseUrl);
    console.log('[Server] Effective OV_NETWORK_URL:', config.openvibeToolsUrl);
    console.log('[Server] Allowed CORS/WebSocket origins:', [...allowedOrigins].join(', '));

    // 1. Initialize database
    db.initDb();
    // Initialize cosmetics tables
    cosmeticsModule.ensureTables();
    // Initialize tags tables
    const tagsModule = require('./game/tags');
    tagsModule.ensureTagTables();
    // Initialize DM tables
    const dm = require('./chat/dm');
    dm.ensureTables();
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
        const bcrypt = require('bcryptjs');
        const { v4: uuidv4 } = require('uuid');
        const adminUser = config.adminUsername || 'admin';
        const adminPass = config.adminPassword || 'changeme123';
        db.createUser({
            username: adminUser,
            email: null,
            password_hash: bcrypt.hashSync(adminPass, 10),
            display_name: adminUser,
            stream_key: uuidv4().replace(/-/g, ''),
        });
        db.run("UPDATE users SET role = 'admin' WHERE username = ?", [adminUser]);
        console.log(`[Server] Admin user "${adminUser}" created from ADMIN_USERNAME — change password after first login!`);
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

    // 6f. VOD storage/offload is owned by OpenVibe.Media now — nothing to start here.

    // 7. Start HTTP server
    server.listen(config.port, config.host, () => {
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
        function hostsEquivalent(a, b) {
            const normalize = (value) => String(value || '').toLowerCase().replace(/^[\[\]]+/g, '').replace(/[\[\]]+$/g, '');
            const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
            const na = normalize(a);
            const nb = normalize(b);
            if (na === nb) return true;
            return localHosts.has(na) && localHosts.has(nb);
        }

        if (config.whip?.publicUrl && config.mediasoup?.announcedIp) {
            try {
                const whipHost = new URL(config.whip.publicUrl).hostname;
                if (!hostsEquivalent(config.mediasoup.announcedIp, whipHost)) {
                    console.warn('[Server] WARNING: MEDIASOUP_ANNOUNCED_IP does not match WHIP_PUBLIC_URL host. This may cause incorrect ICE candidate advertisement for WHIP/WebRTC.');
                }
            } catch (e) {
                // ignore malformed host
            }
        }
        if (config.nodeEnv === 'production' && config.mediasoup?.announcedIp && ['127.0.0.1', 'localhost', '::1'].includes(config.mediasoup.announcedIp)) {
            console.warn('[Server] WARNING: Mediasoup announcedIp is configured as a local address. External WebRTC clients may be unable to connect. Set MEDIASOUP_ANNOUNCED_IP to your public WHIP/WebRTC hostname.');
        }
        console.log('');
        console.log('[Server] Ready. Good vibes only. ▶');
        console.log('');

        // AI stream-memory job (no-op until enabled in openvibe.network/admin → AI).
        try { require('./ai/stream-memory-job').start(); } catch (e) { console.warn('[AI] memory job not started:', e.message); }
        try { require('./ai/backfill-job').start(); } catch (e) { console.warn('[AI] backfill job not started:', e.message); }
        try { require('./ai/streamer-overview-job').start(); } catch (e) { console.warn('[AI] streamer-overview job not started:', e.message); }
        try { require('./ai/chat-ai').start(); } catch (e) { console.warn('[AI] chat-ai job not started:', e.message); }
        try { require('./ai/slogan-job').start(); } catch (e) { console.warn('[AI] slogan job not started:', e.message); }
        try { require('./ai/ai-moments-job').start(); } catch (e) { console.warn('[AI] moments job not started:', e.message); }
        try { require('./ai/auto-clip-job').start(); } catch (e) { console.warn('[AI] auto-clip job not started:', e.message); }
        try { require('./ai/easter-egg-job').start(); } catch (e) { console.warn('[AI] easter-egg job not started:', e.message); }
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
        // PowerChat: prune the webhook-dedupe log daily so it can't grow unbounded.
        try {
            const _pcClean = () => { try { db.cleanupPowerchatDeliveries(3); } catch { /* */ } };
            setTimeout(_pcClean, 120000);
            const _pcT = setInterval(_pcClean, 24 * 60 * 60 * 1000); if (_pcT.unref) _pcT.unref();
        } catch { /* */ }

        // Broadcast recent git changes to all chat clients after startup.
        // Uses a retry loop — clients reconnect with backoff after a restart,
        // so a single 5s broadcast misses most of them. We broadcast at 5s,
        // 15s, and 30s intervals, tracking which clients already received it.
        // The message is also persisted to chat_messages so it shows in history.
        const _changelogSentTo = new Set();
        let _changelogBroadcasts = 0;
        const _changelogMaxBroadcasts = 3;
        const _changelogDelays = [5000, 15000, 30000];

        function broadcastChangelog() {
            try {
                // Get git describe for a human-readable version tag
                let versionTag = '';
                try {
                    versionTag = execSync('git describe --always --tags', { cwd: REPO_DIR, encoding: 'utf8', timeout: 3000 }).trim();
                } catch { versionTag = ''; }

                const raw = execSync(
                    `git --no-pager log --pretty=format:'%H||%h||%s||%an||%aI' -10`,
                    { cwd: REPO_DIR, encoding: 'utf8', timeout: 5000 }
                );
                const commits = raw.trim().split('\n').filter(Boolean).map(line => {
                    const [hash, short, subject, author, date] = line.split('||');
                    return { hash, short, subject, author, date };
                });
                if (commits.length === 0) return;

                // Build summary: use version tag if available, otherwise top 3 subjects
                const top3 = commits.slice(0, 3).map(c => c.subject).join(' · ');
                const versionPrefix = versionTag ? `(${versionTag}) ` : '';
                // Include relative time since the most recent commit
                const latestDate = commits[0].date ? new Date(commits[0].date) : null;
                let timeSuffix = '';
                if (latestDate) {
                    const ago = Date.now() - latestDate.getTime();
                    if (ago < 60_000) timeSuffix = ' (just now)';
                    else if (ago < 3_600_000) timeSuffix = ` (${Math.round(ago / 60_000)}m ago)`;
                    else if (ago < 86_400_000) timeSuffix = ` (${Math.round(ago / 3_600_000)}h ago)`;
                    else timeSuffix = ` (${Math.round(ago / 86_400_000)}d ago)`;
                }

                const payload = {
                    type: 'update',
                    summary: `Server restarted ${versionPrefix}— ${top3}${timeSuffix}`,
                    commits,
                    url: '/updates',
                    timestamp: new Date().toISOString(),
                };
                const msg = JSON.stringify(payload);

                // Persist to chat_messages on the FIRST broadcast only
                if (_changelogBroadcasts === 0) {
                    try {
                        const summaryText = `🚀 Server restarted ${versionPrefix}— ${top3}${timeSuffix}`;
                        db.saveChatMessage({
                            stream_id: null,
                            user_id: null,
                            anon_id: null,
                            username: 'OpenVibe.Live',
                            message: summaryText,
                            message_type: 'system',
                            is_global: true,
                        });
                    } catch (dbErr) {
                        console.warn('[Server] Failed to persist changelog to chat:', dbErr.message);
                    }
                }

                // Send only to clients that haven't received it yet
                let newRecipients = 0;
                for (const [ws, client] of chatServer.clients) {
                    const clientKey = client.user?.id ? `u:${client.user.id}` : `a:${client.anonId || ws._socket?.remoteAddress}`;
                    if (_changelogSentTo.has(clientKey)) continue;
                    if (ws.readyState === 1 /* WebSocket.OPEN */ && ws.bufferedAmount <= 256 * 1024) {
                        ws.send(msg);
                        _changelogSentTo.add(clientKey);
                        newRecipients++;
                    }
                }

                _changelogBroadcasts++;
                console.log(`[Server] Changelog broadcast #${_changelogBroadcasts}: ${newRecipients} new recipients (${_changelogSentTo.size} total, ${chatServer.getTotalConnections()} connected)`);

                // Schedule next broadcast if we haven't hit the max
                if (_changelogBroadcasts < _changelogMaxBroadcasts) {
                    const nextDelay = (_changelogDelays[_changelogBroadcasts] || 30000) - (_changelogDelays[_changelogBroadcasts - 1] || 0);
                    setTimeout(broadcastChangelog, nextDelay);
                }
            } catch (err) {
                console.warn('[Server] Failed to broadcast startup changelog:', err.message);
            }
        }

        setTimeout(broadcastChangelog, _changelogDelays[0]);
    });

    // 8. Start stale stream heartbeat cleanup (every 60 seconds)
    let heartbeatCleanupRunning = false;
    const liveVodThumbGeneratedAt = new Map();   // streamId → last Media frame-grab time
    const maintenanceInterval = setInterval(() => {
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
                    const rec = recorder.activeRecordings.get(wsStream.id);
                    if (!rec || !rec.vodId) continue;
                    liveVodThumbGeneratedAt.set(wsStream.id, Date.now());
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

    // 9. Periodic registry refresh — re-syncs config with openvibe.network every 5 minutes.
    // This is a safety net: if the startup refresh failed (openvibe.network was temporarily
    // unreachable), subsequent refreshes will fix CORS, issuer, and other URL config.
    const registryRefreshInterval = setInterval(async () => {
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
    }, 5 * 60 * 1000);
    if (typeof registryRefreshInterval.unref === 'function') registryRefreshInterval.unref();
}

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
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
