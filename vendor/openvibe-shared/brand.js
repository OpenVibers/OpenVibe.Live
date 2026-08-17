'use strict';

// ═══════════════════════════════════════════════════════════════
// OpenVibe — Brand Constants
// Shared across all OpenVibe services for consistent branding.
// Values are seeded with OpenVibe defaults and can be
// overridden at runtime via the URL registry / admin panel.
// ═══════════════════════════════════════════════════════════════

// ── Default (OpenVibe) values ────────────────────────────
// These are the canonical defaults for the OpenVibe deployment.
// White-label installs override via the URL registry.

const BRAND_DEFAULTS = Object.freeze({
    networkName:        'OpenVibe',
    networkServiceName: 'OpenVibe.Network',
    toolsServiceName:   'OpenVibe.Tools',
    streamerServiceName:'OpenVibe.Live',
    gamesServiceName:   'OpenVibe.Games',
    mediaServiceName:   'OpenVibe.Media',
    tagline:            'One Account. All of OpenVibe.',
    campTagline:        'Free & Open Live Streaming',
    toolsSubdomainBase: 'openvibe.tools',
    discord:            'https://discord.gg/M6MuRUaeJj',
    github:             'https://github.com/OpenVibe.Live',
});

function getDefaultBrandUrls(env = process.env) {
    return {
        network:  env.OV_NETWORK_URL || 'https://openvibe.network',
        login:    env.LOGIN_URL || env.OV_NETWORK_LOGIN_URL || env.OV_NETWORK_URL || 'https://openvibe.network',
        tools:    env.OV_TOOLS_URL || 'https://openvibe.tools',
        live:     env.OV_LIVE_URL || 'https://openvibe.live',
        games:    env.OV_GAMES_URL || 'https://openvibe.games',
        media:    env.OV_MEDIA_URL || 'https://openvibe.media',
        community:env.OV_COMMUNITY_URL || 'https://openvibe.community',
        // Tool satellites (Host-routed under openvibe.tools)
        maps:     env.OV_MAPS_URL || 'https://maps.openvibe.tools',
        food:     env.OV_FOOD_URL || 'https://food.openvibe.tools',
        img:      env.OV_IMG_URL || 'https://img.openvibe.tools',
        yt:       env.OV_YT_URL || 'https://yt.openvibe.tools',
        audio:    env.OV_AUDIO_URL || 'https://audio.openvibe.tools',
        text:     env.OV_TEXT_URL || 'https://text.openvibe.tools',
        logo:     env.OV_LOGO_URL || 'https://logo.openvibe.tools',
        docs:     env.OV_DOCS_URL || 'https://docs.openvibe.tools',
        net:      env.OV_NET_URL || 'https://net.openvibe.tools',
        dev:      env.OV_DEV_URL || 'https://dev.openvibe.tools',
        pastes:   env.OV_PASTES_URL || 'https://pastes.openvibe.tools',
        // Legacy aliases (older callers) — same targets as above
        streamer: env.OV_LIVE_URL || 'https://openvibe.live',
        quest:    env.OV_GAMES_URL || 'https://openvibe.games',
        discord:  BRAND_DEFAULTS.discord,
        github:   BRAND_DEFAULTS.github,
    };
}

const DEFAULT_URLS = Object.freeze(getDefaultBrandUrls());

function resolveBrandUrls(overrides = {}, env = process.env) {
    return Object.freeze({
        ...getDefaultBrandUrls(env),
        ...overrides,
    });
}

/**
 * Build a brand object from a resolved URL registry map.
 * Call this server-side when the canonical registry has been loaded.
 *
 * @param {Object} registry - resolved registry map from resolveRegistryValues()
 * @param {Object} [env]    - process.env fallback
 * @returns {Object}         brand object with names, urls, colors, services, oauth
 */
function buildBrandFromRegistry(registry = {}, env = process.env) {
    const get = (key) => (registry[key]?.value) || null;

    const networkName        = get('NETWORK_NAME')         || BRAND_DEFAULTS.networkName;
    const toolsServiceName   = get('TOOLS_SERVICE_NAME')   || BRAND_DEFAULTS.toolsServiceName;
    const streamerServiceName= get('STREAMER_SERVICE_NAME')|| BRAND_DEFAULTS.streamerServiceName;
    const gamesServiceName   = get('GAMES_SERVICE_NAME')   || BRAND_DEFAULTS.gamesServiceName;
    const mediaServiceName   = get('MEDIA_SERVICE_NAME')   || BRAND_DEFAULTS.mediaServiceName;
    const defaults           = getDefaultBrandUrls(env);
    const networkUrl         = get('OV_NETWORK_URL')       || defaults.network;
    const liveUrl            = get('OV_LIVE_URL')          || defaults.live;
    const toolsUrl           = get('OV_TOOLS_URL')         || defaults.tools;
    const gamesUrl           = get('OV_GAMES_URL')         || defaults.games;
    const mediaUrl           = get('OV_MEDIA_URL')         || defaults.media;

    const urls = resolveBrandUrls({
        network:  networkUrl,
        login:    get('OV_NETWORK_LOGIN_URL') || networkUrl,
        live:     liveUrl,
        streamer: liveUrl,
        tools:    toolsUrl,
        games:    gamesUrl,
        quest:    gamesUrl,
        media:    mediaUrl,
    }, env);

    // Build service list using registry URLs where available
    const services = [
        { id: 'live',    name: streamerServiceName,             url: liveUrl,    description: 'Free & Open Live Streaming' },
        { id: 'tools',   name: toolsServiceName,                url: toolsUrl,   description: 'Free Online Tools' },
        { id: 'games',   name: gamesServiceName,                url: gamesUrl,   description: 'Games & Community Canvas' },
        { id: 'media',   name: mediaServiceName,                url: mediaUrl,   description: 'VODs, Clips, Pastes & Files' },
        { id: 'network', name: BRAND_DEFAULTS.networkServiceName, url: networkUrl, description: 'Accounts, SSO & OpenCoins' },
    ];

    return Object.freeze({
        name:        networkName,
        toolsName:   toolsServiceName,
        streamerName:streamerServiceName,
        gamesName:   gamesServiceName,
        mediaName:   mediaServiceName,
        tagline:     BRAND_DEFAULTS.tagline,
        campTagline: BRAND_DEFAULTS.campTagline,
        toolsSubdomainBase: get('TOOLS_SUBDOMAIN_BASE') || BRAND_DEFAULTS.toolsSubdomainBase,
        urls:        Object.freeze(urls),
        colors:      BRAND.colors,
        oauth:       BRAND.oauth,
        services:    Object.freeze(services),
    });
}

const BRAND = Object.freeze({
    name: BRAND_DEFAULTS.networkName,
    tagline: BRAND_DEFAULTS.tagline,
    campTagline: BRAND_DEFAULTS.campTagline,

    urls: resolveBrandUrls(),

    // Palette per CONTRACTS.md
    colors: Object.freeze({
        accent:      '#8b5cf6',
        accentLight: '#a78bfa',
        accentDark:  '#6d28d9',
        secondary:   '#22d3ee',
        bgDark:      '#131318',
        flame:       '#a78bfa', // legacy alias for accentLight
        signalRed:   '#e74c3c',
        success:     '#2ecc71',
        warning:     '#f39c12',
        danger:      '#e74c3c',
        info:        '#3498db',
    }),

    // OAuth2 client IDs for each service (seeded in the Network DB)
    oauth: Object.freeze({
        live:  'live',
        tools: 'tools',
        games: 'games',
        media: 'media',
    }),

    // Primary services in the network (for dashboard display, health checks, etc.)
    // Static list with OpenVibe defaults — use buildBrandFromRegistry() for live values.
    services: Object.freeze([
        { id: 'live',    name: 'OpenVibe.Live',    url: 'https://openvibe.live',    description: 'Free & Open Live Streaming' },
        { id: 'tools',   name: 'OpenVibe.Tools',   url: 'https://openvibe.tools',   description: 'Free Online Tools' },
        { id: 'games',   name: 'OpenVibe.Games',   url: 'https://openvibe.games',   description: 'Games & Community Canvas' },
        { id: 'media',   name: 'OpenVibe.Media',   url: 'https://openvibe.media',   description: 'VODs, Clips, Pastes & Files' },
        { id: 'network', name: 'OpenVibe.Network', url: 'https://openvibe.network', description: 'Accounts, SSO & OpenCoins' },
    ]),

    // Tool sub-brands hosted by OpenVibe.Tools (<Name>.OpenVibe naming)
    toolBrands: Object.freeze([
        { id: 'net',   name: 'Net.OpenVibe',   url: 'https://net.openvibe.tools',   description: 'Network & Internet Diagnostics' },
        { id: 'dev',   name: 'Dev.OpenVibe',   url: 'https://dev.openvibe.tools',   description: 'Developer & SEO Tools' },
        { id: 'paste', name: 'Paste.OpenVibe', url: 'https://pastes.openvibe.tools',description: 'Code & Text Sharing' },
        { id: 'maps',  name: 'Maps.OpenVibe',  url: 'https://maps.openvibe.tools',  description: 'Camp & Shelter Locator' },
        { id: 'food',  name: 'Food.OpenVibe',  url: 'https://food.openvibe.tools',  description: 'Food Resource Finder' },
        { id: 'img',   name: 'Img.OpenVibe',   url: 'https://img.openvibe.tools',   description: 'Image Converter & Tools' },
        { id: 'yt',    name: 'YT.OpenVibe',    url: 'https://yt.openvibe.tools',    description: 'YouTube Downloader' },
        { id: 'audio', name: 'Audio.OpenVibe', url: 'https://audio.openvibe.tools', description: 'Audio Converter & Effects' },
        { id: 'text',  name: 'Text.OpenVibe',  url: 'https://text.openvibe.tools',  description: 'Text Generation & Unicode' },
        { id: 'logo',  name: 'Logo.OpenVibe',  url: 'https://logo.openvibe.tools',  description: 'Logo & Title Card Maker' },
        { id: 'docs',  name: 'Docs.OpenVibe',  url: 'https://docs.openvibe.tools',  description: 'PDF & Document Tools' },
    ]),
});

module.exports = { BRAND, BRAND_DEFAULTS, resolveBrandUrls, buildBrandFromRegistry };
