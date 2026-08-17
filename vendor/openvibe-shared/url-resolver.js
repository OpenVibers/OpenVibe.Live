'use strict';

const URL_DEFINITIONS = Object.freeze({
    OV_LIVE_URL: {
        key: 'OV_LIVE_URL',
        label: 'OpenVibe.Live Public URL',
        category: 'public_first_party_urls',
        service: 'live',
        scope: 'global',
        type: 'origin',
        default: 'https://openvibe.live',
        description: 'Canonical public origin for OpenVibe.Live.',
    },
    OV_TOOLS_URL: {
        key: 'OV_TOOLS_URL',
        label: 'OpenVibe.Tools Public URL',
        category: 'public_first_party_urls',
        service: 'tools',
        scope: 'global',
        type: 'origin',
        default: 'https://openvibe.tools',
        description: 'Canonical public origin for the OpenVibe.Tools gateway.',
    },
    OV_GAMES_URL: {
        key: 'OV_GAMES_URL',
        label: 'OpenVibe.Games Public URL',
        category: 'public_first_party_urls',
        service: 'games',
        scope: 'global',
        type: 'origin',
        default: 'https://openvibe.games',
        description: 'Canonical public origin for OpenVibe.Games.',
    },
    OV_MEDIA_URL: {
        key: 'OV_MEDIA_URL',
        label: 'OpenVibe.Media Public URL',
        category: 'public_first_party_urls',
        service: 'media',
        scope: 'global',
        type: 'origin',
        default: 'https://openvibe.media',
        description: 'Canonical public origin for OpenVibe.Media.',
    },
    WEBRTC_PUBLIC_URL: {
        key: 'WEBRTC_PUBLIC_URL',
        label: 'WebRTC Public URL',
        category: 'protocol_ingest_urls',
        service: 'live',
        scope: 'global',
        type: 'origin',
        default: 'http://localhost:3000',
        description: 'Public origin used for WebRTC endpoint discovery and browser consumers.',
    },
    WHIP_PUBLIC_URL: {
        key: 'WHIP_PUBLIC_URL',
        label: 'WHIP Public URL',
        category: 'protocol_ingest_urls',
        service: 'live',
        scope: 'global',
        type: 'origin',
        default: 'http://localhost:3000',
        description: 'Canonical WHIP ingestion origin for OBS and other WHIP clients.',
    },
    WHIP_PUBLIC_URL_ENABLED: {
        key: 'WHIP_PUBLIC_URL_ENABLED',
        label: 'Dedicated WHIP Host Enabled',
        category: 'protocol_ingest_urls',
        service: 'live',
        scope: 'global',
        type: 'boolean',
        default: false,
        description: 'Enable use of the dedicated WHIP hostname configured by WHIP_PUBLIC_URL. If disabled, the app falls back to the safe public WebRTC origin.',
    },
    JSMPEG_PUBLIC_URL: {
        key: 'JSMPEG_PUBLIC_URL',
        label: 'JSMPEG Public URL',
        category: 'protocol_ingest_urls',
        service: 'live',
        scope: 'global',
        type: 'origin',
        default: 'http://localhost:3000',
        description: 'Public origin used to construct JSMPEG relay endpoints for browsers and FFmpeg clients.',
    },
    TURN_URL: {
        key: 'TURN_URL',
        label: 'TURN URL',
        category: 'protocol_ingest_urls',
        service: 'live',
        scope: 'global',
        type: 'turn_url',
        default: '',
        description: 'TURN server connection string used for WebRTC NAT traversal.',
    },
    MEDIASOUP_ANNOUNCED_IP: {
        key: 'MEDIASOUP_ANNOUNCED_IP',
        label: 'Mediasoup Announced IP/Hostname',
        category: 'protocol_ingest_urls',
        service: 'live',
        scope: 'global',
        type: 'hostname',
        default: 'localhost',
        description: 'Hostname or public IP advertised in Mediasoup ICE candidates.',
    },
    RTMP_HOST: {
        key: 'RTMP_HOST',
        label: 'RTMP Host',
        category: 'protocol_ingest_urls',
        service: 'live',
        scope: 'global',
        type: 'rtmp_host',
        default: '',
        description: 'Hostname used for RTMP ingest. Do not include protocol or path.',
    },
    OV_NETWORK_URL: {
        key: 'OV_NETWORK_URL',
        label: 'OpenVibe.Network URL',
        category: 'public_first_party_urls',
        service: 'network',
        scope: 'global',
        type: 'origin',
        default: 'https://openvibe.network',
        description: 'Public URL for the OpenVibe.Network SSO, account, and registry service.',
    },
    OV_NETWORK_LOGIN_URL: {
        key: 'OV_NETWORK_LOGIN_URL',
        label: 'OpenVibe.Network Login URL',
        category: 'public_first_party_urls',
        service: 'network',
        scope: 'global',
        type: 'origin',
        default: 'https://openvibe.network',
        description: 'Public login URL for OpenVibe.Network. Typically the same as the public OpenVibe.Network origin.',
    },
    OV_NETWORK_INTERNAL_URL: {
        key: 'OV_NETWORK_INTERNAL_URL',
        label: 'OpenVibe.Network Internal URL',
        category: 'internal_service_urls',
        service: 'network',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4000',
        description: 'Internal URL used by services to call the OpenVibe.Network internal API.',
    },
    OV_LIVE_INTERNAL_URL: {
        key: 'OV_LIVE_INTERNAL_URL',
        label: 'OpenVibe.Live Internal URL',
        category: 'internal_service_urls',
        service: 'live',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:3000',
        description: 'Internal URL used by OpenVibe.Network or other OpenVibe services to reach OpenVibe.Live.',
    },
    OV_TOOLS_INTERNAL_URL: {
        key: 'OV_TOOLS_INTERNAL_URL',
        label: 'OpenVibe.Tools Internal URL',
        category: 'internal_service_urls',
        service: 'tools',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4001',
        description: 'Internal URL used by OpenVibe.Network to reach the OpenVibe.Tools gateway.',
    },
    OV_GAMES_INTERNAL_URL: {
        key: 'OV_GAMES_INTERNAL_URL',
        label: 'OpenVibe.Games Internal URL',
        category: 'internal_service_urls',
        service: 'games',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:8000',
        description: 'Internal URL used by OpenVibe.Network to reach OpenVibe.Games.',
    },
    OV_MEDIA_INTERNAL_URL: {
        key: 'OV_MEDIA_INTERNAL_URL',
        label: 'OpenVibe.Media Internal URL',
        category: 'internal_service_urls',
        service: 'media',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4100',
        description: 'Internal URL used by OpenVibe.Network to reach OpenVibe.Media.',
    },
    OV_MAPS_INTERNAL_URL: {
        key: 'OV_MAPS_INTERNAL_URL',
        label: 'Maps.OpenVibe Internal URL',
        category: 'internal_service_urls',
        service: 'maps',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4010',
        description: 'Internal URL of the Maps.OpenVibe tools satellite.',
    },
    OV_FOOD_INTERNAL_URL: {
        key: 'OV_FOOD_INTERNAL_URL',
        label: 'Food.OpenVibe Internal URL',
        category: 'internal_service_urls',
        service: 'food',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4011',
        description: 'Internal URL of the Food.OpenVibe tools satellite.',
    },
    OV_IMG_INTERNAL_URL: {
        key: 'OV_IMG_INTERNAL_URL',
        label: 'Img.OpenVibe Internal URL',
        category: 'internal_service_urls',
        service: 'img',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4012',
        description: 'Internal URL of the Img.OpenVibe tools satellite.',
    },
    OV_YT_INTERNAL_URL: {
        key: 'OV_YT_INTERNAL_URL',
        label: 'YT.OpenVibe Internal URL',
        category: 'internal_service_urls',
        service: 'yt',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4013',
        description: 'Internal URL of the YT.OpenVibe tools satellite.',
    },
    OV_AUDIO_INTERNAL_URL: {
        key: 'OV_AUDIO_INTERNAL_URL',
        label: 'Audio.OpenVibe Internal URL',
        category: 'internal_service_urls',
        service: 'audio',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4014',
        description: 'Internal URL of the Audio.OpenVibe tools satellite.',
    },
    OV_TEXT_INTERNAL_URL: {
        key: 'OV_TEXT_INTERNAL_URL',
        label: 'Text.OpenVibe Internal URL',
        category: 'internal_service_urls',
        service: 'text',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4015',
        description: 'Internal URL of the Text.OpenVibe tools satellite.',
    },
    OV_DOCS_INTERNAL_URL: {
        key: 'OV_DOCS_INTERNAL_URL',
        label: 'Docs.OpenVibe Internal URL',
        category: 'internal_service_urls',
        service: 'docs',
        scope: 'global',
        type: 'internal_base_url',
        default: 'http://127.0.0.1:4016',
        description: 'Internal URL of the Docs.OpenVibe tools satellite.',
    },

    // ── Brand / Site Identity ─────────────────────────────────────────────────
    // Configurable during first-time setup and editable in admin.
    // These values drive display names, JWT metadata, email copy, and CORS policy.
    // Defaults match the OpenVibe — change for white-label installs.

    NETWORK_NAME: {
        key: 'NETWORK_NAME',
        label: 'Network / Organization Name',
        category: 'brand_identity',
        service: 'network',
        scope: 'global',
        type: 'string',
        default: 'OpenVibe',
        description: 'Human-readable name for the overall platform (e.g. "OpenVibe" or your custom brand).',
    },
    TOOLS_SERVICE_NAME: {
        key: 'TOOLS_SERVICE_NAME',
        label: 'Tools Service Name',
        category: 'brand_identity',
        service: 'network',
        scope: 'global',
        type: 'string',
        default: 'OpenVibe.Tools',
        description: 'Display name for the SSO/tools service (e.g. "OpenVibe.Tools" or "CoolTools").',
    },
    STREAMER_SERVICE_NAME: {
        key: 'STREAMER_SERVICE_NAME',
        label: 'Streamer Service Name',
        category: 'brand_identity',
        service: 'live',
        scope: 'global',
        type: 'string',
        default: 'OpenVibe.Live',
        description: 'Display name for the streaming service (e.g. "OpenVibe.Live").',
    },
    GAMES_SERVICE_NAME: {
        key: 'GAMES_SERVICE_NAME',
        label: 'Games Service Name',
        category: 'brand_identity',
        service: 'games',
        scope: 'global',
        type: 'string',
        default: 'OpenVibe.Games',
        description: 'Display name for the games service (e.g. "OpenVibe.Games").',
    },
    MEDIA_SERVICE_NAME: {
        key: 'MEDIA_SERVICE_NAME',
        label: 'Media Service Name',
        category: 'brand_identity',
        service: 'media',
        scope: 'global',
        type: 'string',
        default: 'OpenVibe.Media',
        description: 'Display name for the media service (e.g. "OpenVibe.Media").',
    },

    // ── CORS / Origin Policy ──────────────────────────────────────────────────
    // Controls which additional origins are allowed cross-origin access.
    // The public service URLs above are always auto-allowed.

    TOOLS_SUBDOMAIN_BASE: {
        key: 'TOOLS_SUBDOMAIN_BASE',
        label: 'Tools Subdomain Base Domain',
        category: 'cors_policy',
        service: 'network',
        scope: 'global',
        type: 'string',
        default: 'openvibe.tools',
        description: 'Base domain for which all https://*.{domain} subdomains are trusted first-party origins (e.g. "openvibe.tools"). Leave empty to disable subdomain wildcarding.',
    },
    ALLOWED_EXTRA_ORIGINS: {
        key: 'ALLOWED_EXTRA_ORIGINS',
        label: 'Extra Allowed Origins (JSON array)',
        category: 'cors_policy',
        service: 'network',
        scope: 'global',
        type: 'json_array',
        default: '[]',
        description: 'JSON array of additional origins allowed by CORS across all services (e.g. ["https://my-cdn.com"]). Auto-includes all configured service public URLs.',
    },

    // ── Deploy Infrastructure ─────────────────────────────────────────────────
    // Certificate, DNS, and reverse-proxy management config.
    // These drive the automated TLS issuance and Nginx generation system.

    DEPLOY_ACME_EMAIL: {
        key: 'DEPLOY_ACME_EMAIL',
        label: 'ACME / Let\'s Encrypt Email',
        category: 'deploy_tls',
        service: 'network',
        scope: 'global',
        type: 'string',
        default: '',
        description: 'Email address used for Let\'s Encrypt certificate registration and expiry notifications.',
    },
    DEPLOY_CERT_MODE: {
        key: 'DEPLOY_CERT_MODE',
        label: 'Certificate Mode',
        category: 'deploy_tls',
        service: 'network',
        scope: 'global',
        type: 'string',
        default: 'manual',
        description: 'Certificate provisioning mode: "cloudflare" for automated DNS-01 via Cloudflare API, "manual" for manual DNS challenge, or "none" to skip.',
    },
    DEPLOY_CLOUDFLARE_TOKEN: {
        key: 'DEPLOY_CLOUDFLARE_TOKEN',
        label: 'Cloudflare API Token (DNS Edit)',
        category: 'deploy_tls',
        service: 'network',
        scope: 'global',
        type: 'secret',
        default: '',
        description: 'Cloudflare API token with Zone:DNS:Edit permissions. Used for automated DNS-01 wildcard certificate challenges.',
    },
    DEPLOY_DOMAINS: {
        key: 'DEPLOY_DOMAINS',
        label: 'Managed Domains (JSON)',
        category: 'deploy_tls',
        service: 'network',
        scope: 'global',
        type: 'json_array',
        default: '[]',
        description: 'JSON array of domain objects managed by the deploy system. Each entry: {"domain":"openvibe.network","wildcard":false,"certName":"openvibe.network","services":["network"]}.',
    },
    DEPLOY_NGINX_MODE: {
        key: 'DEPLOY_NGINX_MODE',
        label: 'Nginx Management Mode',
        category: 'deploy_nginx',
        service: 'network',
        scope: 'global',
        type: 'string',
        default: 'preview',
        description: 'Nginx config management mode: "preview" (generate only), "apply" (write + validate + reload), or "disabled".',
    },
    DEPLOY_NGINX_SITES_PATH: {
        key: 'DEPLOY_NGINX_SITES_PATH',
        label: 'Nginx sites-enabled Path',
        category: 'deploy_nginx',
        service: 'network',
        scope: 'global',
        type: 'string',
        default: '/etc/nginx/sites-enabled',
        description: 'Directory where Nginx site configs are written. Defaults to /etc/nginx/sites-enabled.',
    },
    DEPLOY_NGINX_BACKUP_PATH: {
        key: 'DEPLOY_NGINX_BACKUP_PATH',
        label: 'Nginx Backup Path',
        category: 'deploy_nginx',
        service: 'network',
        scope: 'global',
        type: 'string',
        default: '/etc/nginx/sites-backup',
        description: 'Directory for Nginx config backups before apply. Created automatically.',
    },
    DEPLOY_SERVICE_MAP: {
        key: 'DEPLOY_SERVICE_MAP',
        label: 'Service → Port / Domain Map (JSON)',
        category: 'deploy_nginx',
        service: 'network',
        scope: 'global',
        type: 'json_map',
        default: '{}',
        description: 'JSON map of service configurations for Nginx generation. Each key is a service ID, value has port, domains[], wildcardDomain, maxBodySize, etc.',
    },
});

function normalizeOrigin(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        const url = new URL(value.trim());
        if (!url.protocol || !url.hostname) return null;
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return null;
    }
}

function normalizeInternalBaseUrl(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        const url = new URL(value.trim());
        if (!url.protocol || !url.hostname) return null;
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return null;
    }
}

function normalizeWsOrigin(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        const url = new URL(value.trim());
        if (!url.hostname) return null;
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return null;
    }
}

function normalizeHostname(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (/^\w+:\/\//.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            return url.hostname || null;
        } catch {
            return null;
        }
    }
    if (/[^a-zA-Z0-9.\-:]/.test(trimmed)) return null;
    return trimmed;
}

function normalizeTurnUrl(value) {
    if (!value || typeof value !== 'string') return null;
    let trimmed = value.trim();
    if (/^turns?:[^/]/i.test(trimmed)) {
        trimmed = trimmed.replace(/^turns?:/i, (s) => s + '//');
    }
    if (!/^turns?:\/\//i.test(trimmed)) return null;
    try {
        const url = new URL(trimmed);
        if (!url.hostname) return null;
        const protocol = url.protocol.toLowerCase();
        if (protocol !== 'turn:' && protocol !== 'turns:') return null;
        if (url.username || url.password) return null;
        return `${protocol}${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}`;
    } catch {
        return null;
    }
}

function normalizeBoolean(value) {
    if (value === true || value === 1 || value === '1' || value === 'true' || value === 'TRUE' || value === 'True') {
        return true;
    }
    if (value === false || value === 0 || value === '0' || value === 'false' || value === 'FALSE' || value === 'False') {
        return false;
    }
    return null;
}

function normalizeJson(value, type) {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (type === 'json_map' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value;
    }
    if (type === 'json_array' && Array.isArray(value)) {
        return value;
    }
    return null;
}

function normalizeValue(value, type) {
    if (value === undefined || value === null) return null;
    switch (type) {
        case 'origin': return normalizeOrigin(value);
        case 'internal_base_url': return normalizeInternalBaseUrl(value);
        case 'ws_origin': return normalizeWsOrigin(value);
        case 'hostname': return normalizeHostname(value);
        case 'rtmp_host': return normalizeHostname(value);
        case 'turn_url': return normalizeTurnUrl(value);
        case 'json_map': return normalizeJson(value, 'json_map');
        case 'json_array': return normalizeJson(value, 'json_array');
        case 'boolean': return normalizeBoolean(value);
        case 'secret': return typeof value === 'string' ? value.trim() : String(value);
        case 'string': return typeof value === 'string' ? value.trim() : String(value);
        default: return typeof value === 'string' ? value.trim() : String(value);
    }
}

function validateValue(value, type) {
    return normalizeValue(value, type) !== null;
}

function resolveRegistryValues(env = {}, overrides = {}, bootstrap = {}, definitions = URL_DEFINITIONS) {
    const resolved = {};
    for (const [key, def] of Object.entries(definitions)) {
        let rawValue = def.default;
        let source = 'default';
        if (env[key]) {
            rawValue = env[key];
            source = 'env';
        }
        if (bootstrap[key] != null && bootstrap[key] !== '') {
            rawValue = bootstrap[key];
            source = 'bootstrap';
        }
        if (overrides[key] != null && overrides[key] !== '') {
            rawValue = overrides[key];
            source = 'admin';
        }
        const normalized = normalizeValue(rawValue, def.type);
        resolved[key] = {
            key,
            label: def.label,
            category: def.category,
            service: def.service,
            scope: def.scope,
            type: def.type,
            description: def.description,
            value: normalized,
            source,
        };
    }
    return resolved;
}

function formatRegistryEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        key: entry.key,
        label: entry.label,
        category: entry.category,
        service: entry.service,
        scope: entry.scope,
        type: entry.type,
        description: entry.description,
        value: entry.value || null,
        source: entry.source || 'admin',
        updatedBy: entry.updated_by || null,
        updatedAt: entry.updated_at || null,
    };
}

module.exports = {
    URL_DEFINITIONS,
    normalizeValue,
    validateValue,
    resolveRegistryValues,
    formatRegistryEntry,
};
