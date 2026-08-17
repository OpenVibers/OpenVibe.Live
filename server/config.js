/**
 * OpenVibe.Live — Config
 *
 * Loads defaults from env, then resolves registry overrides from openvibe.tools
 * when available. Registry overrides take precedence over env values.
 */
require('dotenv').config();

const { resolveRegistryValues, URL_DEFINITIONS } = require('openvibe-shared/url-resolver');

const DEFAULTS = {
    BASE_URL: 'http://localhost:3000',
    WEBRTC_PUBLIC_URL: 'http://localhost:3000',
    WHIP_PUBLIC_URL: 'http://localhost:3000',
    JSMPEG_PUBLIC_URL: 'http://localhost:3000',
    MEDIASOUP_ANNOUNCED_IP: 'localhost',
    // Public RTMP ingest host shown to streamers (rtmp://ingest.openvibe.live/live)
    RTMP_HOST: 'ingest.openvibe.live',
    TURN_URL: 'turn:turn.openvibe.live',
    OV_NETWORK_URL: 'https://openvibe.network',
    OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:4000',
};

function normalizeValue(value, type) {
    if (type === 'boolean') {
        if (value === undefined || value === null) return null;
        if (value === true || value === 'true' || value === '1' || value === 1) return true;
        if (value === false || value === 'false' || value === '0' || value === 0 || value === '') return false;
        return null;
    }
    return value;
}

function normalizeTurnUrl(turnUrl) {
    const raw = String(turnUrl || '').trim();
    if (!raw) return '';

    // Accept both turn://host and turn:host forms, normalizing to the
    // canonical WebRTC ICE URL form without double slashes.
    let candidate = raw;
    if (/^turns?:[^/]/i.test(candidate)) {
        candidate = candidate.replace(/^turns?:/i, (s) => s + '//');
    }
    if (!/^turns?:\/\//i.test(candidate)) return '';

    try {
        const url = new URL(candidate);
        if (!url.hostname) return '';
        const protocol = url.protocol.toLowerCase();
        if (protocol !== 'turn:' && protocol !== 'turns:') return '';
        if (url.username || url.password) return '';
        return `${protocol}${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}`;
    } catch {
        return '';
    }
}

function normalizeRtmpHost(host) {
    const raw = String(host || '').trim();
    if (!raw) return '';
    let cleaned = raw.replace(/^rtmp:\/\//i, '');
    cleaned = cleaned.replace(/\/.*$/, '');
    return cleaned;
}

function buildConfig(registryValues) {
    registryValues = registryValues || {};
    const getRegistryEntry = (key) => {
        const entry = registryValues[key];
        return entry && typeof entry === 'object' ? entry : { value: null, source: 'default' };
    };

    // Registry renamed this key from BASE_URL to OV_LIVE_URL; accept both plus the env var.
    let baseEntry = getRegistryEntry('OV_LIVE_URL');
    if (baseEntry.source === 'default') baseEntry = getRegistryEntry('BASE_URL');
    if (baseEntry.source === 'default' && process.env.BASE_URL) baseEntry = { value: process.env.BASE_URL, source: 'env' };
    const whipEntry = getRegistryEntry('WHIP_PUBLIC_URL');
    const webRtcEntry = getRegistryEntry('WEBRTC_PUBLIC_URL');
    const jsmpegEntry = getRegistryEntry('JSMPEG_PUBLIC_URL');
    const mediaSoupEntry = getRegistryEntry('MEDIASOUP_ANNOUNCED_IP');
    const openvibeToolsEntry = getRegistryEntry('OV_NETWORK_INTERNAL_URL');
    const openvibeToolsPublicEntry = getRegistryEntry('OV_NETWORK_URL');
    const whipEnabledEntry = getRegistryEntry('WHIP_PUBLIC_URL_ENABLED');
    const rtmpEntry = getRegistryEntry('RTMP_HOST');
    const turnEntry = getRegistryEntry('TURN_URL');
    const turnUrl = normalizeTurnUrl(turnEntry.value || process.env.TURN_URL || DEFAULTS.TURN_URL);
    const allowP2pFallback = normalizeValue(process.env.ALLOW_P2P_FALLBACK, 'boolean') === true;

    if (turnEntry.source !== 'default' && !turnUrl) {
        console.warn('[Config] Invalid TURN_URL configured; ICE metadata will be skipped. Expected a turn: or turns: URL with hostname and optional port/path.');
    }
    if (allowP2pFallback) {
        console.warn('[Config] ALLOW_P2P_FALLBACK is enabled. Legacy peer-to-peer viewer relays may expose client IP addresses and should be used only for emergency rollback.');
    }

    const baseUrl = baseEntry.source !== 'default' ? baseEntry.value : DEFAULTS.BASE_URL;
    // Derive the public URL for openvibe.network (the SSO/auth provider).
    // Used by getNetworkBase() in auth/routes.js and by issuer verification.
    const openvibeToolsUrl = (openvibeToolsPublicEntry.source !== 'default' && openvibeToolsPublicEntry.value)
        ? openvibeToolsPublicEntry.value
        : (process.env.OV_NETWORK_URL || DEFAULTS.OV_NETWORK_URL);
    const whipPublicUrl = whipEntry.source !== 'default'
        ? whipEntry.value
        : (baseEntry.source !== 'default' ? baseEntry.value : DEFAULTS.WHIP_PUBLIC_URL);
    const webRtcPublicUrl = webRtcEntry.source !== 'default'
        ? webRtcEntry.value
        : (baseEntry.source !== 'default'
            ? baseEntry.value
            : (whipEntry.source !== 'default'
                ? whipEntry.value
                : DEFAULTS.WEBRTC_PUBLIC_URL));
    const jsmpegPublicUrl = jsmpegEntry.source !== 'default'
        ? jsmpegEntry.value
        : (baseEntry.source !== 'default' ? baseEntry.value : DEFAULTS.JSMPEG_PUBLIC_URL);
    const mediasoupAnnouncedIp = process.env.MEDIASOUP_ANNOUNCED_IP
        || (mediaSoupEntry.source !== 'default' ? mediaSoupEntry.value : new URL(baseUrl).hostname);
    const whipEnabledEnv = normalizeValue(process.env.WHIP_PUBLIC_URL_ENABLED, 'boolean');
    const hasExplicitWhipPublicUrl = whipEntry.source !== 'default' || Boolean(process.env.WHIP_PUBLIC_URL);
    const whipEnabled = whipEnabledEnv !== null
        ? whipEnabledEnv
        : (whipEnabledEntry.source !== 'default'
            ? normalizeValue(whipEnabledEntry.value, 'boolean') ?? false
            : (hasExplicitWhipPublicUrl ? true : false));

    const baseUrlSource = baseEntry.source || 'default';
    const webRtcSource = webRtcEntry.source !== 'default'
        ? webRtcEntry.source
        : (baseEntry.source !== 'default'
            ? baseEntry.source
            : (whipEntry.source !== 'default'
                ? whipEntry.source
                : 'default'));
    const whipSource = whipEntry.source !== 'default'
        ? whipEntry.source
        : (baseEntry.source || 'default');
    const mediaSoupSource = mediaSoupEntry.source !== 'default'
        ? mediaSoupEntry.source
        : 'default';

    console.log('[Config] Effective URLs:');
    console.log('[Config]  BASE_URL=', baseUrl, `(${baseUrlSource})`);
    console.log('[Config]  WEBRTC_PUBLIC_URL=', webRtcPublicUrl, `(${webRtcSource})`);
    console.log('[Config]  WHIP_PUBLIC_URL=', whipPublicUrl, `(${whipSource})`);
    console.log('[Config]  MEDIASOUP_ANNOUNCED_IP=', mediasoupAnnouncedIp, `(${mediaSoupSource})`);
    console.log('[Config]  OV_NETWORK_URL=', openvibeToolsUrl || '(not set — SSO base will fall back to https://openvibe.network)');

    if (process.env.NODE_ENV === 'production' && baseUrl.includes('localhost')) {
        console.error('[Config] CRITICAL: BASE_URL is localhost in production! CORS will reject all browser requests.');
        console.error('[Config] CRITICAL: Set BASE_URL env var or configure it in the openvibe.tools admin registry.');
    }

    return {
        port: parseInt(process.env.PORT || '3000', 10),
        host: process.env.HOST || '0.0.0.0',
        baseUrl,
        openvibeToolsUrl,   // public-facing URL of the SSO provider (e.g. https://openvibe.network)
        nodeEnv: process.env.NODE_ENV || 'development',
        internalApiKey: process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY || '',
        webrtc: {
            publicUrl: webRtcPublicUrl,
        },
        whip: {
            publicUrl: whipPublicUrl,
            enabled: whipEnabled,
        },
        openvibeToolsInternalUrl: openvibeToolsEntry.value || DEFAULTS.OV_NETWORK_INTERNAL_URL,
        rtmp: {
            port: parseInt(process.env.RTMP_PORT || '1935', 10),
            chunkSize: parseInt(process.env.RTMP_CHUNK_SIZE || '60000', 10),
            host: normalizeRtmpHost(process.env.RTMP_HOST || rtmpEntry.value || DEFAULTS.RTMP_HOST),
        },
        // OpenVibe.Media (VOD/clip/paste/thumbnail service) — media-client.js reads the
        // same env vars directly; mirrored here for logging/diagnostics.
        media: {
            url: process.env.MEDIA_URL || 'http://127.0.0.1:4100',
            publicUrl: process.env.MEDIA_PUBLIC_URL || 'https://openvibe.media',
            appId: process.env.MEDIA_APP_ID || 'live',
        },
        turn: {
            url: turnUrl,
            username: process.env.TURN_USERNAME || '',
            credential: process.env.TURN_CREDENTIAL || '',
        },
        allowP2pFallback,
        mediasoup: {
            listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
            announcedIp: mediasoupAnnouncedIp,
            minPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '10000', 10),
            maxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '10100', 10),
            webrtcPort: parseInt(process.env.WEBRTC_PORT || '4443', 10),
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    // Start high so viewers reach full sharpness immediately instead of
                    // ramping up from a soft low-bitrate image over the first few seconds.
                    parameters: { 'x-google-start-bitrate': 2500 },
                },
                {
                    kind: 'video',
                    mimeType: 'video/H264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',
                        'level-asymmetry-allowed': 1,
                    },
                },
            ],
        },
        adminUsername: process.env.ADMIN_USERNAME || 'admin',
        adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',
        jwt: {
            secret: process.env.JWT_SECRET || 'openvibelive-dev-secret-change-me',
            expiresIn: '7d',
        },
        db: {
            path: process.env.DB_PATH || './data/live.db',
        },
        jsmpeg: {
            publicUrl: jsmpegPublicUrl,
            videoPort: parseInt(process.env.JSMPEG_VIDEO_PORT || '9710', 10),
            audioPort: parseInt(process.env.JSMPEG_AUDIO_PORT || '9711', 10),
        },
        robotstreamer: {
            // Raw passthrough relay: forward the source's already-encoded RTP to RobotStreamer
            // with ZERO re-encode (werift + mediasoup), instead of the browser's second encode /
            // the ffmpeg transcode worker. This is now the ONLY restream path and is ON by
            // default; set RS_PASSTHROUGH=0 only as an emergency kill-switch.
            passthrough: process.env.RS_PASSTHROUGH !== '0',
            passthroughRobots: (process.env.RS_PASSTHROUGH_ROBOTS || '').split(',').map(s => s.trim()).filter(Boolean),
        },
        openvibeBucks: {
            // Bit-style currency: integer bucks, 100 bucks = $1.00 streamer cashout
            // (so 1 buck = $0.01 = one USD cent). Viewers buy at a premium with volume
            // discounts (see openvibe-bucks.js pricing tiers) — the spread is the platform margin.
            cashoutBucksPerUsd: 100,
            minCashoutBucks: parseInt(process.env.MIN_CASHOUT_BUCKS || '500', 10), // $5.00
            escrowDays: parseInt(process.env.ESCROW_HOLD_DAYS || '14', 10),
        },
        vod: {
            path: process.env.VOD_PATH || './data/vods',
            coldPath: process.env.COLD_STORAGE_PATH || '',
            clipsPath: process.env.CLIPS_PATH || './data/clips',
            maxSizeMb: parseInt(process.env.MAX_VOD_SIZE_MB || '2048', 10),
        },
        thumbnails: {
            path: process.env.THUMBNAILS_PATH || './data/thumbnails',
        },
        emotes: {
            path: process.env.EMOTES_PATH || './data/emotes',
            maxSizeKb: parseInt(process.env.MAX_EMOTE_SIZE_KB || '2048', 10),
            maxPerUser: parseInt(process.env.MAX_EMOTES_PER_USER || '30', 10),
            // A channel holds up to 30 emotes total (streamer + viewer uploads), first-come until
            // full — then the streamer removes some. No per-uploader sub-cap.
            maxPerChannel: parseInt(process.env.MAX_EMOTES_PER_CHANNEL || '30', 10),
            maxPerUploaderPerChannel: parseInt(process.env.MAX_EMOTES_PER_UPLOADER_PER_CHANNEL || '30', 10),
            ffzCacheTtl: parseInt(process.env.FFZ_CACHE_TTL || '3600', 10),
            bttvCacheTtl: parseInt(process.env.BTTV_CACHE_TTL || '3600', 10),
            sevenTvCacheTtl: parseInt(process.env.SEVENTV_CACHE_TTL || '3600', 10),
        },
        sounds: {
            path: process.env.SOUNDS_PATH || './data/sounds',
            maxSizeKb: parseInt(process.env.MAX_SOUND_SIZE_KB || '2048', 10),   // 2MB per clip
            defaultMaxSeconds: parseInt(process.env.SOUND_DEFAULT_MAX_SECONDS || '10', 10),
            maxPerChannel: parseInt(process.env.MAX_SOUNDS_PER_CHANNEL || '150', 10),
            maxPerUploaderPerChannel: parseInt(process.env.MAX_SOUNDS_PER_UPLOADER_PER_CHANNEL || '10', 10),
        },
        paypal: {
            clientId: process.env.PAYPAL_CLIENT_ID || '',
            clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
            mode: process.env.PAYPAL_MODE || 'sandbox',
        },
    };
}

const initialRegistry = resolveRegistryValues(process.env, {}, {}, URL_DEFINITIONS) || {};
const config = buildConfig(initialRegistry);

async function refreshRegistry() {
    if (!config.openvibeToolsInternalUrl || !config.internalApiKey) {
        console.warn('[Config] Skipping registry refresh: missing internal URL or internal API key');
        return config;
    }

    try {
        const url = `${config.openvibeToolsInternalUrl.replace(/\/$/, '')}/internal/url-registry/resolved`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'X-Internal-Key': config.internalApiKey,
                'Accept': 'application/json',
            },
        });
        if (!res.ok) {
            console.warn('[Config] Failed to refresh URL registry from openvibe.tools:', res.status);
            return config;
        }
        const body = await res.json();
        if (!body.registry || typeof body.registry !== 'object') {
            console.warn('[Config] Invalid registry response from openvibe.tools:', JSON.stringify(body).slice(0, 200));
            return config;
        }

        const registry = Object.fromEntries(
            Object.entries(body.registry).map(([key, entry]) => {
                if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) {
                    return [key, { value: entry.value, source: entry.source || 'admin' }];
                }
                return [key, { value: entry, source: 'admin' }];
            })
        );
        const updated = buildConfig(registry);
        Object.assign(config, updated);
        console.log('[Config] URL registry loaded from openvibe.tools resolved registry');
    } catch (err) {
        console.warn('[Config] Unable to load URL registry from openvibe.tools:', err.message);
    }
    return config;
}

config.refreshRegistry = refreshRegistry;
config._normalizeTurnUrl = normalizeTurnUrl;
module.exports = config;
