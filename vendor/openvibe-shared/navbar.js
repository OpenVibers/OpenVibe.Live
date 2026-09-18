// ═══════════════════════════════════════════════════════════════
// OpenVibe — Universal Navbar
// Consistent top bar across all services with logo, navigation,
// notification bell, account switcher, and theme-aware styling.
// Usage: OpenVibeNavbar.init({ service, token, user, apiBase })
//   Optional: loginUrl (override the Sign In href), sessionUrl (same-origin
//   endpoint returning { user } — used only when no ov_token exists),
//   onLogin/onLogout callbacks. When no `user` is passed the navbar resolves
//   it itself: ov_token cookie → localStorage → token opt → sessionUrl, then
//   GET {apiBase}/api/auth/me with `Authorization: Bearer <token>`.
//
// Brand: derived from the hostname — `pastes.openvibe.tools` renders as
//   Pastes · OpenVibe · Tools (three segments, the subdomain first so the
//   context reads left-to-right), `openvibe.live` as OpenVibe · Live. Pass
//   brand: { sub, tld, name, icon, variant } to override any part, or the
//   legacy brandName/brandIcon. compact: 'auto' (default — the brand shortens
//   to the subdomain on narrow viewports), 'always', 'never'.
// Menus are modular: every site keeps the shared account menu and adds its own
//   pieces — links: [{label, href, icon?, active?}] replaces the service's top
//   links; menu: { before: [item], after: [item] } adds dropdown rows
//   ({label, href, icon, onClick, danger, external}); OpenVibeNavbar.addMenuItem()
//   / setLinks() do the same at runtime. Signed-in users also get a
//   "Recently used" row fed by the shared history module when it is loaded.
// ═══════════════════════════════════════════════════════════════

(function (root) {
    'use strict';

    let _config = {
        service: 'network', token: null, user: null, apiBase: 'https://openvibe.network',
        onLogin: null, onLogout: null, loginUrl: null, sessionUrl: null,
        brand: null, brandName: null, brandIcon: null, compact: 'auto',
        links: null, menu: null, recent: true,
        // history: { type: 'tool'|'stream'|'paste'|'page'|…, title, url, icon } — recorded for the
        // signed-in user once auth resolves (cross-site "Recently used" / History on the Network).
        history: null,
        // silentLogin: 'https://site/auth/login?silent=1&next={url}' — when nobody is signed in here
        // but this browser has signed in to the network before (ov_sso_hint), try one silent
        // prompt=none round trip per tab so a session on one site becomes a session on all.
        silentLogin: null,
        // fedcm: false to opt out; 'optional' (default) shows the browser's native chip the first
        // time and re-authenticates silently afterwards; 'silent' only re-authenticates.
        fedcm: 'optional',
        fedcmLogin: null,           // POST target for the assertion (default: this site's /auth/fedcm)
    };
    const _runtimeMenu = { before: [], after: [] };
    let _runtimeLinks = null;
    let _navEl = null;

    function injectStyles() {
        if (document.getElementById('openvibe-navbar-styles')) return;
        const s = document.createElement('style');
        s.id = 'openvibe-navbar-styles';
        s.textContent = `
            .openvibe-navbar {
                position: sticky; top: 0; z-index: 10000;
                height: 52px; display: flex; align-items: center; padding: 0 16px; gap: 8px;
                background: var(--bg-secondary, #252530);
                border-bottom: 1px solid var(--border, #333340);
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                color: var(--text-primary, #e0e0e0);
            }
            .openvibe-navbar-brand { display: flex; align-items: center; gap: 9px; text-decoration: none; color: inherit; margin-right: 8px; min-width: 0; }
            /* Brand group: mark + linked wordmark + launcher read as one control. Every property a host
               page might set on bare "nav a" / "a" is reset here, so the brand looks the same everywhere. */
            .openvibe-navbar .openvibe-navbar-brand a, .openvibe-navbar .openvibe-navbar-brand a:hover { all: unset; cursor: pointer; color: inherit; font: inherit; }
            .openvibe-navbar .openvibe-navbar-brand { gap: 8px; padding: 3px 4px 3px 3px; border-radius: 12px; margin-right: 2px; }
            .openvibe-navbar .openvibe-navbar-brand a.flame { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; transition: background .15s; }
            .openvibe-navbar .openvibe-navbar-brand a.flame:hover { background: var(--accent-glow, rgba(59,130,246,.14)); }
            .openvibe-navbar .openvibe-navbar-brand .name { align-items: center; gap: 0; font-size: 15.5px; letter-spacing: -.25px; }
            .openvibe-navbar .openvibe-navbar-brand .name a { padding: 3px 2px; border-radius: 6px; transition: color .15s, background .15s; }
            .openvibe-navbar .openvibe-navbar-brand .name a.b-sub { color: var(--text-primary, #e6edf7); font-weight: 750; }
            .openvibe-navbar .openvibe-navbar-brand .name a.b-core { color: var(--text-primary, #e6edf7); font-weight: 700; }
            .openvibe-navbar .openvibe-navbar-brand .name a.b-tld { color: var(--accent-light, var(--accent, #60a5fa)); font-weight: 700; }
            .openvibe-navbar .openvibe-navbar-brand.has-sub .name a.b-core, .openvibe-navbar .openvibe-navbar-brand.has-sub .name a.b-tld { color: var(--text-secondary, #a8b3c4); font-weight: 600; }
            .openvibe-navbar .openvibe-navbar-brand .name a:hover { color: var(--accent-light, var(--accent, #60a5fa)); background: var(--accent-glow, rgba(59,130,246,.12)); }
            .openvibe-navbar .openvibe-navbar-brand .b-dot { margin: 0; padding: 0 .5px; opacity: .55; }
            .openvibe-navbar .openvibe-navbar-brand a:focus-visible, .ovnav-launch:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 1px; }
            .ovnav-launch { all: unset; box-sizing: border-box; cursor: pointer; color: var(--text-secondary, #a8b3c4); width: 32px; height: 32px; border-radius: 10px; display: inline-grid; place-items: center; flex: none; margin-right: 10px; border: 1px solid transparent; transition: background .15s, color .15s, border-color .15s; }
            .ovnav-launch:hover, .ovnav-launch[aria-expanded="true"] { background: var(--accent-glow, rgba(59,130,246,.14)); color: var(--accent-light, var(--accent, #60a5fa)); border-color: color-mix(in srgb, var(--accent, #3b82f6) 35%, transparent); }
            .ovnav-launch svg { display: block; transition: transform .25s cubic-bezier(.2,1.4,.3,1); }
            .ovnav-launch[aria-expanded="true"] svg { transform: rotate(45deg) scale(.92); }
            .ovnav-launcher a { all: unset; cursor: pointer; box-sizing: border-box; }
            .openvibe-navbar .ovnav-sep { width: 1px; height: 18px; background: var(--border, rgba(255,255,255,.12)); margin: 0 6px; flex: none; align-self: center; }
            @media (max-width: 1180px) { .openvibe-navbar .ovnav-net, .openvibe-navbar .ovnav-sep { display: none; } }
            .ovnav-launcher { position: absolute; top: calc(100% + 6px); left: 12px; width: min(440px, calc(100vw - 24px)); max-height: min(560px, calc(100vh - 80px)); overflow: auto; background: var(--bg-elevated, var(--bg-secondary, #111826)); border: 1px solid var(--border, rgba(255,255,255,.12)); border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.5); padding: 12px; z-index: 1000; opacity: 0; transform: translateY(-6px) scale(.98); transform-origin: top left; pointer-events: none; transition: opacity .16s, transform .2s cubic-bezier(.2,1.2,.3,1); }
            .ovnav-launcher.open { opacity: 1; transform: none; pointer-events: auto; }
            .ovnav-launcher .ovl-q { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--border, rgba(255,255,255,.12)); background: var(--bg-primary, #0a0f18); color: var(--text-primary, #e6edf7); font: 500 14px/1.2 inherit; outline: none; }
            .ovnav-launcher .ovl-q:focus { border-color: var(--accent, #3b82f6); }
            .ovnav-launcher .ovl-h { display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; letter-spacing: .7px; text-transform: uppercase; color: var(--text-muted, #7d8aa0); margin: 12px 4px 6px; }
            .ovnav-launcher .ovl-h a { color: var(--accent-light, var(--accent, #60a5fa)); text-decoration: none; text-transform: none; letter-spacing: 0; }
            .ovnav-launcher .ovl-sites { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
            .ovnav-launcher .ovl-fams { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px; }
            .ovnav-launcher .ovl-site, .ovnav-launcher .ovl-fam { display: flex; align-items: center; gap: 9px; padding: 8px; border-radius: 10px; color: var(--text-primary, #e6edf7); text-decoration: none; min-width: 0; }
            .ovnav-launcher .ovl-site { flex-direction: column; text-align: center; gap: 6px; padding: 12px 6px; }
            .ovnav-launcher .ovl-site:hover, .ovnav-launcher .ovl-fam:hover, .ovnav-launcher a:focus-visible { background: var(--accent-glow, rgba(59,130,246,.14)); outline: none; }
            .ovnav-launcher b { display: block; font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .ovnav-launcher small { display: block; font-size: 11px; color: var(--text-muted, #7d8aa0); margin-top: 1px; }
            .ovnav-launcher .ovl-soon { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 4px; }
            .ovnav-launcher .ovl-soon a { font-size: 12px; font-weight: 600; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--border, rgba(255,255,255,.1)); color: var(--text-secondary, #a8b3c4); }
            .ovnav-launcher .ovl-soon a:hover { border-color: var(--accent, #3b82f6); color: var(--text-primary, #e6edf7); background: none; }
            .ovnav-launcher .ovl-empty { padding: 18px 8px; color: var(--text-secondary, #a8b3c4); font-size: 13px; }
            @media (max-width: 480px) { .ovnav-launcher { left: 8px; } .ovnav-launcher .ovl-fams { grid-template-columns: 1fr; } }
            @media (prefers-reduced-motion: reduce) { .ovnav-launcher { transition: none; } }
            .openvibe-navbar-brand .flame { font-size: 18px; text-decoration: none; color: var(--accent, #3b82f6); display: inline-grid; place-items: center; width: 28px; height: 28px; flex: none; }
            .openvibe-navbar-brand .name { display: inline-flex; align-items: baseline; font-size: 15px; font-weight: 700; letter-spacing: -.3px; white-space: nowrap; line-height: 1; }
            /* Segments: subdomain · OpenVibe · TLD. The part that names *this* site is the loud one. */
            .openvibe-navbar-brand .b-sub { color: var(--text-primary, #e0e0e0); }
            .openvibe-navbar-brand .b-core { color: var(--text-primary, #e0e0e0); }
            .openvibe-navbar-brand .b-tld { color: var(--accent-light, var(--accent, #60a5fa)); }
            .openvibe-navbar-brand.has-sub .b-core { color: var(--text-secondary, #b0b0b8); font-weight: 600; }
            .openvibe-navbar-brand.has-sub .b-tld { color: var(--text-secondary, #b0b0b8); font-weight: 600; }
            .openvibe-navbar-brand .b-dot { color: var(--accent, #3b82f6); opacity: .75; margin: 0 1px; font-weight: 800; }
            .openvibe-navbar-brand .b-sub, .openvibe-navbar-brand .b-core, .openvibe-navbar-brand .b-tld { transition: color .2s, opacity .2s; }
            .openvibe-navbar-brand:hover .b-tld, .openvibe-navbar-brand:hover .b-sub { color: var(--accent-light, #60a5fa); }
            .openvibe-navbar-brand:hover .b-dot { opacity: 1; }
            .openvibe-navbar-brand .b-tag { font-size: 9px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--accent-light, #60a5fa); background: var(--accent-glow, rgba(59,130,246,.14)); border-radius: 4px; padding: 2px 5px; margin-left: 6px; align-self: center; }
            /* Compact: drop the trailing segments on narrow viewports, keep what identifies the page. */
            .openvibe-navbar[data-compact="always"] .openvibe-navbar-brand.has-sub .b-core,
            .openvibe-navbar[data-compact="always"] .openvibe-navbar-brand.has-sub .b-tld,
            .openvibe-navbar[data-compact="always"] .openvibe-navbar-brand.has-sub .b-dot { display: none; }
            @media (max-width: 860px) {
                .openvibe-navbar[data-compact="auto"] .openvibe-navbar-brand.has-sub .b-core,
                .openvibe-navbar[data-compact="auto"] .openvibe-navbar-brand.has-sub .b-tld,
                .openvibe-navbar[data-compact="auto"] .openvibe-navbar-brand.has-sub .b-dot { display: none; }
            }
            @media (max-width: 420px) {
                .openvibe-navbar[data-compact="auto"] .openvibe-navbar-brand:not(.has-sub) .b-core,
                .openvibe-navbar[data-compact="auto"] .openvibe-navbar-brand:not(.has-sub) .b-dot { display: none; }
                .openvibe-navbar[data-compact="auto"] .openvibe-navbar-brand .b-tag { display: none; }
            }
            .openvibe-navbar-links a .icon { margin-right: 5px; opacity: .8; }
            .openvibe-navbar-dropdown-recent { padding: 6px 8px 2px; border-bottom: 1px solid var(--border, #333340); }
            .openvibe-navbar-dropdown-recent .label { font-size: 10px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--text-muted, #707080); padding: 2px 8px 4px; display: flex; justify-content: space-between; align-items: center; }
            .openvibe-navbar-dropdown-recent .label a { color: var(--accent-light, #60a5fa); text-decoration: none; font-weight: 600; letter-spacing: 0; text-transform: none; }
            .openvibe-navbar-dropdown-recent .item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; font-size: 12px; color: var(--text-secondary, #b0b0b8); text-decoration: none; transition: background .12s; min-width: 0; }
            .openvibe-navbar-dropdown-recent .item:hover { background: var(--bg-hover, #2f2f3d); color: var(--text-primary, #e0e0e0); }
            .openvibe-navbar-dropdown-recent .item .icon { width: 18px; text-align: center; color: var(--accent-light, #60a5fa); flex: none; }
            .openvibe-navbar-dropdown-recent .item .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .openvibe-navbar-dropdown-recent .item .s { margin-left: auto; font-size: 10px; color: var(--text-muted, #707080); flex: none; }
            .openvibe-navbar-dropdown-menu .sep { height: 1px; background: var(--border, #333340); margin: 4px -8px; }

            .openvibe-navbar-links { display: flex; align-items: center; gap: 4px; margin-left: 8px; }
            .openvibe-navbar-links a {
                padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 500;
                color: var(--text-secondary, #b0b0b8); text-decoration: none;
                transition: all .15s;
            }
            .openvibe-navbar-links a:hover { background: var(--bg-hover, #2f2f3d); color: var(--text-primary, #e0e0e0); }
            .openvibe-navbar-links a.active { background: var(--bg-tertiary, #2a2a38); color: var(--accent-light, #60a5fa); }

            .openvibe-navbar-spacer { flex: 1; }

            .openvibe-navbar-right { display: flex; align-items: center; gap: 6px; }

            .openvibe-navbar-avatar {
                width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
                border: 2px solid var(--border, #333340); transition: border-color .2s;
                object-fit: cover;
            }
            .openvibe-navbar-avatar:hover { border-color: var(--accent, #3b82f6); }

            .openvibe-navbar-login {
                padding: 6px 16px; border-radius: 6px; font-size: 13px; font-weight: 600;
                background: var(--accent, #3b82f6); color: #fff; border: none; cursor: pointer;
                transition: background .15s; text-decoration: none; display: inline-flex; align-items: center;
            }
            .openvibe-navbar-login:hover { background: var(--accent-dark, #2563eb); }

            .openvibe-navbar-dropdown {
                position: absolute; top: 48px; right: 8px;
                width: 260px; background: var(--bg-card, #22222c);
                border: 1px solid var(--border, #333340); border-radius: 10px;
                box-shadow: var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.5));
                display: none; flex-direction: column; overflow: hidden;
                animation: openvibe-slide-down .2s ease;
            }
            .openvibe-navbar-dropdown.open { display: flex; }
            @keyframes openvibe-slide-down { from { transform: translateY(-8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

            .openvibe-navbar-dropdown-header {
                padding: 14px 16px; border-bottom: 1px solid var(--border, #333340);
                display: flex; align-items: center; gap: 10px;
            }
            .openvibe-navbar-dropdown-header img { width: 36px; height: 36px; border-radius: 50%; }
            .openvibe-navbar-dropdown-header .info { line-height: 1.3; }
            .openvibe-navbar-dropdown-header .info .name { font-size: 14px; font-weight: 600; }
            .openvibe-navbar-dropdown-header .info .email { font-size: 11px; color: var(--text-muted, #707080); }
            .openvibe-navbar-dropdown-header .info .anon-tag { font-size: 10px; color: var(--accent-light, #60a5fa); }

            .openvibe-navbar-dropdown-accounts {
                padding: 6px 8px; border-bottom: 1px solid var(--border, #333340);
                max-height: 140px; overflow-y: auto;
            }
            .openvibe-navbar-dropdown-accounts .account-item {
                display: flex; align-items: center; gap: 8px; padding: 6px 8px;
                border-radius: 6px; cursor: pointer; font-size: 12px;
                color: var(--text-secondary, #b0b0b8); transition: background .12s;
            }
            .openvibe-navbar-dropdown-accounts .account-item:hover { background: var(--bg-hover, #2f2f3d); }
            .openvibe-navbar-dropdown-accounts .account-item img { width: 24px; height: 24px; border-radius: 50%; }
            .openvibe-navbar-dropdown-accounts .account-item.active { color: var(--accent-light, #60a5fa); font-weight: 600; }
            .openvibe-navbar-dropdown-accounts .add-account {
                display: flex; align-items: center; gap: 8px; padding: 6px 8px;
                border-radius: 6px; cursor: pointer; font-size: 12px;
                color: var(--text-muted, #707080); transition: background .12s;
                text-decoration: none;
            }
            .openvibe-navbar-dropdown-accounts .add-account:hover { background: var(--bg-hover, #2f2f3d); color: var(--text-primary, #e0e0e0); }

            .openvibe-navbar-dropdown-menu { padding: 6px 8px; }
            .openvibe-navbar-dropdown-menu a, .openvibe-navbar-dropdown-menu button {
                display: flex; align-items: center; gap: 8px; width: 100%;
                padding: 8px; border-radius: 6px; font-size: 12px; font-weight: 500;
                background: none; border: none; color: var(--text-primary, #e0e0e0);
                cursor: pointer; text-align: left; text-decoration: none;
                transition: background .12s;
            }
            .openvibe-navbar-dropdown-menu a:hover, .openvibe-navbar-dropdown-menu button:hover { background: var(--bg-hover, #2f2f3d); }
            .openvibe-navbar-dropdown-menu .danger { color: var(--live-red, #e74c3c); }
            .openvibe-navbar-dropdown-menu .icon { width: 18px; text-align: center; font-size: 14px; }

            .openvibe-navbar .openvibe-network-badge {
                font-size: 10px; padding: 2px 8px; border-radius: 4px;
                background: rgba(59,130,246,0.1); color: var(--accent-light, #60a5fa);
                font-weight: 500; cursor: pointer; border: 1px solid transparent;
                transition: all .15s;
            }
            .openvibe-navbar .openvibe-network-badge:hover { border-color: var(--accent-dark, #2563eb); }

            @media (max-width: 600px) {
                .openvibe-navbar-links { display: none; }
                .openvibe-navbar .openvibe-network-badge { display: none; }
            }
        `;
        document.head.appendChild(s);
    }

    // Primary services (per CONTRACTS branding) + tool sub-brands (<Name>.OpenVibe)
    const SERVICE_NAMES = {
        live: 'OpenVibe.Live', tools: 'OpenVibe.Tools', games: 'OpenVibe.Games',
        media: 'OpenVibe.Media', network: 'OpenVibe.Network',
        net: 'Net.OpenVibe', dev: 'Dev.OpenVibe', paste: 'Paste.OpenVibe',
        maps: 'Maps.OpenVibe', food: 'Food.OpenVibe', img: 'Img.OpenVibe',
        yt: 'YT.OpenVibe', audio: 'Audio.OpenVibe', text: 'Text.OpenVibe',
        logo: 'Logo.OpenVibe', docs: 'Docs.OpenVibe',
    };

    const SERVICE_ICONS = {
        live: 'fa-tower-broadcast', tools: 'fa-screwdriver-wrench', games: 'fa-gamepad',
        media: 'fa-photo-film', network: 'fa-circle-nodes',
        net: 'fa-network-wired', dev: 'fa-code', paste: 'fa-paste',
        maps: 'fa-map-location-dot', food: 'fa-utensils', img: 'fa-images',
        yt: 'fa-circle-play', audio: 'fa-headphones', text: 'fa-pen-fancy',
        logo: 'fa-wand-magic-sparkles', docs: 'fa-file-pdf',
    };

    // Subdomain → brand override for multi-subdomain services (Img.OpenVibe)
    const SUBDOMAIN_BRANDS = {
        'png.openvibe.tools':      { name: 'OpenVibePNG',      icon: 'fa-file-image' },
        'jpg.openvibe.tools':      { name: 'OpenVibeJPG',      icon: 'fa-file-image' },
        'jpeg.openvibe.tools':     { name: 'OpenVibeJPG',      icon: 'fa-file-image' },
        'webp.openvibe.tools':     { name: 'OpenVibeWebP',     icon: 'fa-file-image' },
        'avif.openvibe.tools':     { name: 'OpenVibeAVIF',     icon: 'fa-file-image' },
        'heic.openvibe.tools':     { name: 'OpenVibeHEIC',     icon: 'fa-file-image' },
        'heif.openvibe.tools':     { name: 'OpenVibeHEIC',     icon: 'fa-file-image' },
        'svg.openvibe.tools':      { name: 'OpenVibeSVG',      icon: 'fa-bezier-curve' },
        'gif.openvibe.tools':      { name: 'OpenVibeGIF',      icon: 'fa-film' },
        'ico.openvibe.tools':      { name: 'OpenVibeICO',      icon: 'fa-icons' },
        'tiff.openvibe.tools':     { name: 'OpenVibeTIFF',     icon: 'fa-file-image' },
        'bmp.openvibe.tools':      { name: 'OpenVibeBMP',      icon: 'fa-file-image' },
        'compress.openvibe.tools': { name: 'OpenVibeCompress',  icon: 'fa-compress' },
        'resize.openvibe.tools':   { name: 'OpenVibeResize',    icon: 'fa-up-right-and-down-left-from-center' },
        'crop.openvibe.tools':     { name: 'OpenVibeCrop',      icon: 'fa-crop-simple' },
        'convert.openvibe.tools':  { name: 'OpenVibeConvert',   icon: 'fa-arrows-rotate' },
        'favicon.openvibe.tools':  { name: 'OpenVibeFavicon',   icon: 'fa-icons' },
        'yt.openvibe.tools':       { name: 'YT.OpenVibe',        icon: 'fa-circle-play' },
        'maps.openvibe.tools':     { name: 'Maps.OpenVibe',      icon: 'fa-map-location-dot' },
        'food.openvibe.tools':     { name: 'Food.OpenVibe',      icon: 'fa-utensils' },
        // Audio tool subdomains
        'audio.openvibe.tools':    { name: 'Audio.OpenVibe',     icon: 'fa-headphones' },
        'mp3.openvibe.tools':      { name: 'OpenVibeMP3',       icon: 'fa-file-audio' },
        'wav.openvibe.tools':      { name: 'OpenVibeWAV',       icon: 'fa-file-audio' },
        'flac.openvibe.tools':     { name: 'OpenVibeFLAC',      icon: 'fa-file-audio' },
        'ogg.openvibe.tools':      { name: 'OpenVibeOGG',       icon: 'fa-file-audio' },
        'm4a.openvibe.tools':      { name: 'OpenVibeM4A',       icon: 'fa-file-audio' },
        'aac.openvibe.tools':      { name: 'OpenVibeAAC',       icon: 'fa-file-audio' },
        'opus.openvibe.tools':     { name: 'OpenVibeOPUS',      icon: 'fa-file-audio' },
        'wma.openvibe.tools':      { name: 'OpenVibeWMA',       icon: 'fa-file-audio' },
        'aiff.openvibe.tools':     { name: 'OpenVibeAIFF',      icon: 'fa-file-audio' },
        'ac3.openvibe.tools':      { name: 'OpenVibeAC3',       icon: 'fa-file-audio' },
        'trim.openvibe.tools':     { name: 'OpenVibeTrim',      icon: 'fa-scissors' },
        'pitch.openvibe.tools':    { name: 'OpenVibePitch',     icon: 'fa-wave-square' },
        'speed.openvibe.tools':    { name: 'OpenVibeSpeed',     icon: 'fa-gauge-high' },
        'normalize.openvibe.tools':{ name: 'OpenVibeNormalize', icon: 'fa-sliders' },
        'fade.openvibe.tools':     { name: 'OpenVibeFade',      icon: 'fa-volume-low' },
        'bass.openvibe.tools':     { name: 'OpenVibeBass',      icon: 'fa-volume-high' },
        'equalizer.openvibe.tools':{ name: 'OpenVibeEQ',        icon: 'fa-bars-staggered' },
        'echo.openvibe.tools':     { name: 'OpenVibeEcho',      icon: 'fa-tower-broadcast' },
        'reverb.openvibe.tools':   { name: 'OpenVibeReverb',    icon: 'fa-church' },
        'voice.openvibe.tools':    { name: 'OpenVibeVoiceFX',   icon: 'fa-user-astronaut' },
        'extract.openvibe.tools':  { name: 'OpenVibeExtract',   icon: 'fa-music' },
        'ringtone.openvibe.tools': { name: 'OpenVibeRingtone',  icon: 'fa-bell' },
        // Text tool subdomains
        'text.openvibe.tools':       { name: 'Text.OpenVibe',       icon: 'fa-pen-fancy' },
        'type.openvibe.tools':       { name: 'Text.OpenVibe',       icon: 'fa-pen-fancy' },
        'fonts.openvibe.tools':      { name: 'OpenVibeFonts',      icon: 'fa-font' },
        'fancy.openvibe.tools':      { name: 'OpenVibeFancy',      icon: 'fa-wand-sparkles' },
        'zalgo.openvibe.tools':      { name: 'OpenVibeZalgo',      icon: 'fa-skull' },
        'ascii.openvibe.tools':      { name: 'OpenVibeASCII',      icon: 'fa-terminal' },
        'symbols.openvibe.tools':    { name: 'OpenVibeSymbols',    icon: 'fa-icons' },
        'unicode.openvibe.tools':    { name: 'OpenVibeUnicode',    icon: 'fa-magnifying-glass' },
        'bubble.openvibe.tools':     { name: 'OpenVibeBubble',     icon: 'fa-circle' },
        'glitch.openvibe.tools':     { name: 'OpenVibeGlitch',     icon: 'fa-bug' },
        'smallcaps.openvibe.tools':  { name: 'OpenVibeSmallCaps',  icon: 'fa-text-height' },
        'cursive.openvibe.tools':    { name: 'OpenVibeCursive',    icon: 'fa-pen-nib' },
        'gothic.openvibe.tools':     { name: 'OpenVibeGothic',     icon: 'fa-book-skull' },
        'wide.openvibe.tools':       { name: 'OpenVibeWide',       icon: 'fa-arrows-left-right' },
        'monospaced.openvibe.tools': { name: 'OpenVibeMono',       icon: 'fa-code' },
        'braille.openvibe.tools':    { name: 'OpenVibeBraille',    icon: 'fa-braille' },
        'morse.openvibe.tools':      { name: 'OpenVibeMorse',      icon: 'fa-tower-broadcast' },
        'binary.openvibe.tools':     { name: 'OpenVibeBinary',     icon: 'fa-microchip' },
        'case.openvibe.tools':       { name: 'OpenVibeCase',       icon: 'fa-text-height' },
        'caps.openvibe.tools':       { name: 'OpenVibeCaps',       icon: 'fa-text-height' },
        'titlecase.openvibe.tools':  { name: 'OpenVibeTitleCase',  icon: 'fa-heading' },
        'reverse.openvibe.tools':    { name: 'OpenVibeReverse',    icon: 'fa-right-left' },
        'clean.openvibe.tools':      { name: 'OpenVibeClean',      icon: 'fa-broom' },
        'strip.openvibe.tools':      { name: 'OpenVibeStrip',      icon: 'fa-broom' },
        'count.openvibe.tools':      { name: 'OpenVibeCount',      icon: 'fa-calculator' },
        'lines.openvibe.tools':      { name: 'OpenVibeLines',      icon: 'fa-list-ol' },
        'sort.openvibe.tools':       { name: 'OpenVibeSort',       icon: 'fa-arrow-down-a-z' },
        'dedupe.openvibe.tools':     { name: 'OpenVibeDedupe',     icon: 'fa-filter' },
        'slug.openvibe.tools':       { name: 'OpenVibeSlug',       icon: 'fa-link' },
        'compare.openvibe.tools':    { name: 'OpenVibeCompare',    icon: 'fa-code-compare' },
        'diff.openvibe.tools':       { name: 'OpenVibeDiff',       icon: 'fa-code-compare' },
        'markdown.openvibe.tools':   { name: 'OpenVibeMarkdown',   icon: 'fa-file-lines' },
        'json.openvibe.tools':       { name: 'OpenVibeJSON',       icon: 'fa-brackets-curly' },
        'escape.openvibe.tools':     { name: 'OpenVibeEscape',     icon: 'fa-shield-halved' },
        'bio.openvibe.tools':        { name: 'OpenVibeBio',        icon: 'fa-id-card' },
        'nickname.openvibe.tools':   { name: 'OpenVibeNickname',   icon: 'fa-signature' },
        'username.openvibe.tools':   { name: 'OpenVibeUsername',   icon: 'fa-at' },
        'gamertag.openvibe.tools':   { name: 'OpenVibeGamertag',   icon: 'fa-gamepad' },
        'kaomoji.openvibe.tools':    { name: 'OpenVibeKaomoji',    icon: 'fa-face-smile' },
        'emojis.openvibe.tools':     { name: 'OpenVibeEmojis',     icon: 'fa-face-grin' },
        'copypaste.openvibe.tools':  { name: 'OpenVibeCopyPaste',  icon: 'fa-paste' },
        'banner.openvibe.tools':     { name: 'OpenVibeBanner',     icon: 'fa-rectangle-ad' },
        'textart.openvibe.tools':    { name: 'Text.OpenVibeArt',    icon: 'fa-border-all' },
        'figlet.openvibe.tools':     { name: 'OpenVibeFiglet',     icon: 'fa-terminal' },
        // Logo / design subdomains
        'logo.openvibe.tools':       { name: 'Logo.OpenVibe',       icon: 'fa-wand-magic-sparkles' },
        'title.openvibe.tools':      { name: 'OpenVibeTitle',      icon: 'fa-heading' },
        'wordmark.openvibe.tools':   { name: 'OpenVibeWordmark',   icon: 'fa-font' },
        'textlogo.openvibe.tools':   { name: 'Text.OpenVibeLogo',   icon: 'fa-font' },
        'transparent.openvibe.tools':{ name: 'OpenVibeTransparent', icon: 'fa-eye-slash' },
        'badge.openvibe.tools':      { name: 'OpenVibeBadge',      icon: 'fa-certificate' },
        'sticker.openvibe.tools':    { name: 'OpenVibeSticker',    icon: 'fa-note-sticky' },
        'thumbnail.openvibe.tools':  { name: 'OpenVibeThumbnail',  icon: 'fa-photo-film' },
        'cover.openvibe.tools':      { name: 'OpenVibeCover',      icon: 'fa-image' },
        'channelart.openvibe.tools': { name: 'OpenVibeChannelArt', icon: 'fa-panorama' },
        'watermark.openvibe.tools':  { name: 'OpenVibeWatermark',  icon: 'fa-droplet' },
        'neon.openvibe.tools':       { name: 'OpenVibeNeon',       icon: 'fa-lightbulb' },
        // Document / PDF subdomains
        'docs.openvibe.tools':       { name: 'Docs.OpenVibe',      icon: 'fa-file-pdf' },
        'pdf.openvibe.tools':        { name: 'OpenVibePDF',       icon: 'fa-file-pdf' },
        'mergepdf.openvibe.tools':   { name: 'MergePDF',      icon: 'fa-object-group' },
        'splitpdf.openvibe.tools':   { name: 'SplitPDF',      icon: 'fa-scissors' },
        'compresspdf.openvibe.tools':{ name: 'CompressPDF',   icon: 'fa-compress' },
        'rotatepdf.openvibe.tools':  { name: 'RotatePDF',     icon: 'fa-rotate' },
        'reorderpdf.openvibe.tools': { name: 'ReorderPDF',    icon: 'fa-sort' },
        'watermarkpdf.openvibe.tools':{ name: 'WatermarkPDF', icon: 'fa-stamp' },
        'protectpdf.openvibe.tools': { name: 'ProtectPDF',    icon: 'fa-lock' },
        'unlockpdf.openvibe.tools':  { name: 'UnlockPDF',     icon: 'fa-lock-open' },
        'image2pdf.openvibe.tools':  { name: 'Image2PDF',     icon: 'fa-file-image' },
        'jpg2pdf.openvibe.tools':    { name: 'JPG2PDF',       icon: 'fa-file-image' },
        'png2pdf.openvibe.tools':    { name: 'PNG2PDF',       icon: 'fa-file-image' },
        'pdf2jpg.openvibe.tools':    { name: 'PDF2JPG',       icon: 'fa-image' },
        'pdf2png.openvibe.tools':    { name: 'PDF2PNG',       icon: 'fa-image' },
        // Network tool subdomains
        'net.openvibe.tools':        { name: 'Net.OpenVibe',       icon: 'fa-network-wired' },
        'lookup.openvibe.tools':     { name: 'OpenVibeLookup',    icon: 'fa-magnifying-glass' },
        'myip.openvibe.tools':       { name: 'OpenVibeMyIP',      icon: 'fa-location-crosshairs' },
        'ip.openvibe.tools':         { name: 'OpenVibeIP',        icon: 'fa-at' },
        'geoip.openvibe.tools':      { name: 'OpenVibeGeoIP',     icon: 'fa-earth-americas' },
        'hostname.openvibe.tools':   { name: 'OpenVibeHostname',  icon: 'fa-server' },
        'isp.openvibe.tools':        { name: 'OpenVibeISP',       icon: 'fa-building' },
        'asn.openvibe.tools':        { name: 'OpenVibeASN',       icon: 'fa-diagram-project' },
        'ipv4.openvibe.tools':       { name: 'OpenVibeIPv4',      icon: 'fa-hashtag' },
        'ipv6.openvibe.tools':       { name: 'OpenVibeIPv6',      icon: 'fa-code' },
        'rdns.openvibe.tools':       { name: 'OpenVibeReverseDNS',icon: 'fa-rotate-left' },
        'whois.openvibe.tools':      { name: 'OpenVibeWhois',     icon: 'fa-address-book' },
        'rdap.openvibe.tools':       { name: 'OpenVibeRDAP',      icon: 'fa-id-card' },
        'dns.openvibe.tools':        { name: 'OpenVibeDNS',       icon: 'fa-sitemap' },
        'dig.openvibe.tools':        { name: 'OpenVibeDig',       icon: 'fa-terminal' },
        'nslookup.openvibe.tools':   { name: 'OpenVibeNSLookup',  icon: 'fa-magnifying-glass-arrow-right' },
        'dnspropagation.openvibe.tools': { name: 'OpenVibeDNSPropagation', icon: 'fa-globe' },
        'mx.openvibe.tools':         { name: 'OpenVibeMX',        icon: 'fa-envelope' },
        'txt.openvibe.tools':        { name: 'OpenVibeTXT',       icon: 'fa-file-lines' },
        'ns.openvibe.tools':         { name: 'OpenVibeNS',        icon: 'fa-server' },
        'spf.openvibe.tools':        { name: 'OpenVibeSPF',       icon: 'fa-shield-halved' },
        'dkim.openvibe.tools':       { name: 'OpenVibeDKIM',      icon: 'fa-key' },
        'dmarc.openvibe.tools':      { name: 'OpenVibeDMARC',     icon: 'fa-user-shield' },
        'ping.openvibe.tools':       { name: 'OpenVibePing',      icon: 'fa-satellite-dish' },
        'traceroute.openvibe.tools': { name: 'OpenVibeTraceroute', icon: 'fa-route' },
        'mtr.openvibe.tools':        { name: 'OpenVibeMTR',       icon: 'fa-chart-line' },
        'port.openvibe.tools':       { name: 'OpenVibePortCheck', icon: 'fa-door-open' },
        'headers.openvibe.tools':    { name: 'OpenVibeHeaders',   icon: 'fa-list' },
        'redirects.openvibe.tools':  { name: 'OpenVibeRedirects', icon: 'fa-share' },
        'ssl.openvibe.tools':        { name: 'OpenVibeSSL',       icon: 'fa-lock' },
        'curl.openvibe.tools':       { name: 'OpenVibeCurl',      icon: 'fa-download' },
        'httpstatus.openvibe.tools': { name: 'OpenVibeHTTPStatus', icon: 'fa-circle-check' },
        'latency.openvibe.tools':    { name: 'OpenVibeLatency',   icon: 'fa-gauge-high' },
        // Dev.OpenVibe subdomains
        'dev.openvibe.tools':        { name: 'Dev.OpenVibe',       icon: 'fa-code' },
        'code.openvibe.tools':       { name: 'Dev.OpenVibe',       icon: 'fa-code' },
        'json.openvibe.tools':       { name: 'OpenVibeJSON',      icon: 'fa-code' },
        'yaml.openvibe.tools':       { name: 'OpenVibeYAML',      icon: 'fa-file-code' },
        'xml.openvibe.tools':        { name: 'OpenVibeXML',       icon: 'fa-file-code' },
        'csv.openvibe.tools':        { name: 'OpenVibeCSV',       icon: 'fa-table' },
        'sql.openvibe.tools':        { name: 'OpenVibeSQL',       icon: 'fa-database' },
        'markdown.openvibe.tools':   { name: 'OpenVibeMarkdown',  icon: 'fa-file-lines' },
        'html.openvibe.tools':       { name: 'OpenVibeHTML',      icon: 'fa-file-code' },
        'base64.openvibe.tools':     { name: 'OpenVibeBase64',    icon: 'fa-lock' },
        'url.openvibe.tools':        { name: 'OpenVibeURL',       icon: 'fa-link' },
        'jwt.openvibe.tools':        { name: 'OpenVibeJWT',       icon: 'fa-key' },
        'uuid.openvibe.tools':       { name: 'OpenVibeUUID',      icon: 'fa-fingerprint' },
        'hash.openvibe.tools':       { name: 'OpenVibeHash',      icon: 'fa-hashtag' },
        'hex.openvibe.tools':        { name: 'OpenVibeHex',       icon: 'fa-barcode' },
        'escape.openvibe.tools':     { name: 'OpenVibeEscape',    icon: 'fa-shield-halved' },
        'timestamp.openvibe.tools':  { name: 'OpenVibeTimestamp', icon: 'fa-clock' },
        'cron.openvibe.tools':       { name: 'OpenVibeCron',      icon: 'fa-calendar-check' },
        'beautify.openvibe.tools':   { name: 'OpenVibeBeautify',  icon: 'fa-wand-magic-sparkles' },
        'minify.openvibe.tools':     { name: 'OpenVibeMinify',    icon: 'fa-compress' },
        'diff.openvibe.tools':       { name: 'OpenVibeDiff',      icon: 'fa-code-compare' },
        'regex.openvibe.tools':      { name: 'OpenVibeRegex',     icon: 'fa-magnifying-glass' },
        'slug.openvibe.tools':       { name: 'OpenVibeSlug',      icon: 'fa-link' },
        'lorem.openvibe.tools':      { name: 'OpenVibeLorem',     icon: 'fa-paragraph' },
        'curl.openvibe.tools':       { name: 'OpenVibeCurl',      icon: 'fa-terminal' },
        'webhook.openvibe.tools':    { name: 'OpenVibeWebhook',   icon: 'fa-satellite-dish' },
        'color.openvibe.tools':      { name: 'OpenVibeColor',     icon: 'fa-palette' },
        'opengraph.openvibe.tools':  { name: 'OpenVibeOpenGraph', icon: 'fa-share-nodes' },
        // Dev.OpenVibe aliases
        'build.openvibe.tools':      { name: 'Dev.OpenVibe',       icon: 'fa-code' },
        'debug.openvibe.tools':      { name: 'Dev.OpenVibe',       icon: 'fa-code' },
        'compare.openvibe.tools':    { name: 'OpenVibeDiff',      icon: 'fa-code-compare' },
        'format.openvibe.tools':     { name: 'OpenVibeBeautify',  icon: 'fa-wand-magic-sparkles' },
        'prettier.openvibe.tools':   { name: 'OpenVibeBeautify',  icon: 'fa-wand-magic-sparkles' },
        'md.openvibe.tools':         { name: 'OpenVibeMarkdown',  icon: 'fa-file-lines' },
        'unix.openvibe.tools':       { name: 'OpenVibeTimestamp', icon: 'fa-clock' },
        'epoch.openvibe.tools':      { name: 'OpenVibeTimestamp', icon: 'fa-clock' },
        'b64.openvibe.tools':        { name: 'OpenVibeBase64',    icon: 'fa-lock' },
        'guid.openvibe.tools':       { name: 'OpenVibeUUID',      icon: 'fa-fingerprint' },
        'sha256.openvibe.tools':     { name: 'OpenVibeHash',      icon: 'fa-hashtag' },
        'entities.openvibe.tools':   { name: 'OpenVibeEscape',    icon: 'fa-shield-halved' },
        'http.openvibe.tools':       { name: 'OpenVibeCurl',      icon: 'fa-terminal' },
        'og.openvibe.tools':         { name: 'OpenVibeOpenGraph', icon: 'fa-share-nodes' },
        'colors.openvibe.tools':     { name: 'OpenVibeColor',     icon: 'fa-palette' },
    };

    // ─── Brand from hostname ───────────────────────────────────
    // Every property is <sub?>.openvibe.<tld> (plus openre.stream). The navbar spells the
    // whole name — Pastes.OpenVibe.Tools, not "Paste.OpenVibe" — because the subdomain and
    // the TLD are what tell a visitor where they are in the network.
    const TLD_LABELS = {
        live: 'Live', tools: 'Tools', network: 'Network', media: 'Media', games: 'Games',
        community: 'Community', chat: 'Chat', codes: 'Codes', blog: 'Blog', wiki: 'Wiki',
        news: 'News', reviews: 'Reviews', tips: 'Tips', vip: 'VIP', trade: 'Trade', host: 'Host',
        deals: 'Deals', coupons: 'Coupons',
    };
    const SUB_LABELS = {
        json: 'JSON', yaml: 'YAML', xml: 'XML', csv: 'CSV', sql: 'SQL', html: 'HTML', jwt: 'JWT',
        uuid: 'UUID', guid: 'GUID', url: 'URL', b64: 'B64', sha256: 'SHA256', og: 'OG', md: 'MD',
        yt: 'YT', ip: 'IP', myip: 'MyIP', ipv4: 'IPv4', ipv6: 'IPv6', geoip: 'GeoIP', asn: 'ASN',
        rdns: 'rDNS', dns: 'DNS', mx: 'MX', txt: 'TXT', ns: 'NS', spf: 'SPF', dkim: 'DKIM',
        dmarc: 'DMARC', mtr: 'MTR', ssl: 'SSL', tls: 'TLS', ptr: 'PTR', smtp: 'SMTP', http: 'HTTP',
        httpstatus: 'HTTPStatus', rdap: 'RDAP', isp: 'ISP', pdf: 'PDF', mergepdf: 'MergePDF',
        splitpdf: 'SplitPDF', compresspdf: 'CompressPDF', rotatepdf: 'RotatePDF',
        reorderpdf: 'ReorderPDF', watermarkpdf: 'WatermarkPDF', protectpdf: 'ProtectPDF',
        unlockpdf: 'UnlockPDF', image2pdf: 'Image2PDF', jpg2pdf: 'JPG2PDF', png2pdf: 'PNG2PDF',
        pdf2jpg: 'PDF2JPG', pdf2png: 'PDF2PNG', png: 'PNG', jpg: 'JPG', jpeg: 'JPEG', webp: 'WebP',
        avif: 'AVIF', heic: 'HEIC', heif: 'HEIF', svg: 'SVG', gif: 'GIF', ico: 'ICO', tiff: 'TIFF',
        bmp: 'BMP', mp3: 'MP3', wav: 'WAV', flac: 'FLAC', ogg: 'OGG', m4a: 'M4A', aac: 'AAC',
        opus: 'Opus', wma: 'WMA', aiff: 'AIFF', ac3: 'AC3', eq: 'EQ', equalizer: 'EQ', mxn: 'MXN',
        ascii: 'ASCII', smallcaps: 'SmallCaps', titlecase: 'TitleCase', textlogo: 'TextLogo',
        textart: 'TextArt', channelart: 'ChannelArt', lowerthird: 'LowerThird', copypaste: 'CopyPaste',
        dnspropagation: 'DNSPropagation', opengraph: 'OpenGraph', whip: 'WHIP', ingest: 'Ingest',
        play: 'Play', my: 'My', auth: 'Auth', api: 'API', admin: 'Admin', docs: 'Docs', dev: 'Dev',
        net: 'Net', img: 'Img', pastes: 'Pastes', paste: 'Pastes', maps: 'Maps', food: 'Food',
        text: 'Text', logo: 'Logo', audio: 'Audio', ai: 'AI', cdn: 'CDN', status: 'Status',
    };
    const SERVICE_TLD = { live: 'live', tools: 'tools', games: 'games', media: 'media', network: 'network', community: 'community' };
    const SERVICE_SUB = { net: 'net', dev: 'dev', paste: 'pastes', maps: 'maps', food: 'food', img: 'img', yt: 'yt', audio: 'audio', text: 'text', logo: 'logo', docs: 'docs' };

    function titleCase(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : ''; }
    function subLabel(sub) { return SUB_LABELS[sub] || titleCase(sub); }

    /**
     * { sub, core, tld, name, short, icon, variant } for the current page.
     *   sub   'Pastes' | null           tld  'Tools'        core 'OpenVibe'
     *   name  'Pastes.OpenVibe.Tools'   short 'Pastes' (what compact mode keeps)
     *   variant  the ov-mark flavour: the TLD id ('live', 'tools', …) — every site gets its own twist
     */
    function resolveBrand() {
        const b = Object.assign({}, _config.brand || {});
        const host = currentHost().toLowerCase();
        let sub = null, tld = null, core = 'OpenVibe';
        let m = host.match(/^(?:(.+)\.)?openvibe\.([a-z]+)$/);
        if (m) { sub = m[1] && m[1] !== 'www' ? m[1] : null; tld = m[2]; }
        else if ((m = host.match(/^(?:(.+)\.)?openre\.stream$/))) { sub = m[1] && m[1] !== 'www' ? m[1] : null; core = 'OpenRe'; tld = 'stream'; }
        // Off-network hosts (localhost, previews): fall back to the service id.
        if (!tld) { tld = SERVICE_TLD[_config.service] || (SERVICE_SUB[_config.service] ? 'tools' : 'network'); sub = SERVICE_SUB[_config.service] || null; }
        // Legacy brandName ("Paste.OpenVibe", "OpenVibe.Live") still steers the segments.
        if (_config.brandName && !b.sub && !b.tld) {
            const parts = String(_config.brandName).split('.');
            if (parts.length >= 2 && /^openvibe$/i.test(parts[0])) tld = parts[1].toLowerCase();
            else if (parts.length >= 2 && /^openvibe$/i.test(parts[1])) sub = parts[0].toLowerCase();
            else if (parts.length === 1) sub = parts[0].toLowerCase();
        }
        if (b.sub !== undefined) sub = b.sub ? String(b.sub).toLowerCase() : null;
        if (b.tld) tld = String(b.tld).toLowerCase();
        const subText = b.subLabel || (sub ? subLabel(sub) : null);
        const tldText = b.tldLabel || TLD_LABELS[tld] || titleCase(tld);
        const name = b.name || [subText, core, tldText].filter(Boolean).join('.');
        const icon = b.icon || _config.brandIcon || null;
        const variant = b.variant || (core === 'OpenRe' ? 'stream' : tld);
        return { sub, subText, core, tld, tldText, name, short: subText || `${core}.${tldText}`, icon, variant, tag: b.tag || null, href: b.href || '/' };
    }

    /** Where each brand segment goes: sub → this tool, OpenVibe → the network, TLD → the site's apex. */
    function brandLinks(brand) {
        const apex = brand.core === 'OpenRe' ? 'https://openre.stream/' : `https://openvibe.${brand.tld}/`;
        if (!brand.subText) return { sub: brand.href, core: brand.href, tld: brand.href, apex };
        return { sub: brand.href, core: 'https://openvibe.network/', tld: apex, apex };
    }

    function brandHTML(brand) {
        const to = brandLinks(brand);
        const seg = (cls, text, href, title) => `<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ''} class="${cls}">${escapeAttr(text)}</a>`;
        const dot = '<span class="b-dot">.</span>';
        const text = brand.subText
            ? seg('b-sub', brand.subText, to.sub, brand.name) + dot + seg('b-core', brand.core, to.core, 'OpenVibe Network') + dot + seg('b-tld', brand.tldText, to.tld, `All of ${brand.core}.${brand.tldText}`)
            : seg('b-core', brand.core, to.core, brand.name) + dot + seg('b-tld', brand.tldText, to.tld, brand.name);
        const mark = brand.icon
            ? `<i class="fa-solid ${escapeAttr(brand.icon)}"></i>`
            : `<span class="ov-mark" data-size="28" data-variant="${escapeAttr(brand.variant)}"></span>`;
        return `<div class="openvibe-navbar-brand${brand.subText ? ' has-sub' : ''}">
                <a class="flame" href="${escapeAttr(brand.href)}" aria-label="${escapeAttr(brand.name)} home">${mark}</a>
                <span class="name">${text}${brand.tag ? `<span class="b-tag">${escapeAttr(brand.tag)}</span>` : ''}</span>
            </div>
            ${_config.launcher === false ? '' : '<button type="button" class="ovnav-launch" id="openvibe-launcher-btn" aria-label="All OpenVibe sites and tools" aria-haspopup="true" aria-expanded="false" title="All OpenVibe sites and tools"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="currentColor"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></g></svg></button>'}`;
    }


    // ── Shared chrome data (https://openvibe.network/api/chrome) ─────────────────────────────
    // Sites ordered by real use, footer copy and per-site legal links. Cached per host for 30
    // minutes in localStorage and refreshed in the background, so pages paint from cache and the
    // order never jumps while someone is looking at it. Defined once, shared by navbar + footer.
    const OVChrome = root.OpenVibeChrome || (root.OpenVibeChrome = (function () {
        const KEY = 'ov_chrome_v1', TTL = 30 * 60000;
        let inflight = null;
        const host = () => (typeof location !== 'undefined' ? location.hostname : '');
        const https = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
        function clean(d) {
            if (!d || !Array.isArray(d.nav)) return null;
            const link = (l) => (l && typeof l.name === 'string' && https(l.url) ? { id: String(l.id || ''), name: l.name.slice(0, 60), url: l.url, icon: String(l.icon || ''), tagline: String(l.tagline || '').slice(0, 80) } : null);
            const f = d.footer || {}, lg = f.legal || {};
            return { nav: d.nav.map(link).filter(Boolean).slice(0, 12), soon: (d.soon || []).map(link).filter(Boolean).slice(0, 24),
                footer: { blurb: String(f.blurb || '').slice(0, 200), discover: (f.discover || []).map(link).filter(Boolean).slice(0, 6), popular: (f.popular || []).map(link).filter(Boolean).slice(0, 10),
                    legal: https(lg.terms) && https(lg.privacy) && https(lg.dmca) ? { terms: lg.terms, privacy: lg.privacy, dmca: lg.dmca } : null } };
        }
        function cached() { try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); return c && c.host === host() && c.data ? c : null; } catch { return null; } }
        function refresh() {
            if (inflight || typeof fetch === 'undefined') return inflight || Promise.resolve(null);
            inflight = fetch('https://openvibe.network/api/chrome?host=' + encodeURIComponent(host()), { credentials: 'omit' })
                .then(r => (r.ok ? r.json() : null)).then(clean)
                .then(d => { if (d) { try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), host: host(), data: d })); } catch { /* */ } } return d; })
                .catch(() => null);
            return inflight;
        }
        /** Cached data now (or null); `onFirst` fires once when a first-ever fetch lands. */
        function get(onFirst) {
            const c = cached();
            if (!c || Date.now() - c.at > TTL) { const p = refresh(); if (!c && onFirst) p.then(d => { if (d) onFirst(d); }); }
            return c ? c.data : null;
        }
        return { get, refresh };
    })());

    // ── Network launcher ─────────────────────────────────────
    const LAUNCHER_SITES = [
        { name: 'Live', desc: 'Streams, clips and chat', icon: 'live', url: 'https://openvibe.live/' },
        { name: 'Tools', desc: 'Every online tool', icon: 'tools', url: 'https://openvibe.tools/' },
        { name: 'Community', desc: 'Pastes and posts', icon: 'community', url: 'https://openvibe.community/' },
        { name: 'Games', desc: 'Browser games', icon: 'games', url: 'https://openvibe.games/' },
        { name: 'Media', desc: 'VODs, clips, files', icon: 'media', url: 'https://openvibe.media/' },
        { name: 'Network', desc: 'Account and themes', icon: 'network', url: 'https://openvibe.network/' },
    ];
    const LAUNCHER_FAMILIES = [
        { name: 'Media Tools', icon: 'youtube', url: 'https://yt.openvibe.tools/' },
        { name: 'Image Tools', icon: 'image', url: 'https://img.openvibe.tools/' },
        { name: 'Audio Tools', icon: 'audio', url: 'https://audio.openvibe.tools/' },
        { name: 'PDF & Documents', icon: 'pdf', url: 'https://docs.openvibe.tools/' },
        { name: 'Text Tools', icon: 'text', url: 'https://text.openvibe.tools/' },
        { name: 'Developer Tools', icon: 'code', url: 'https://dev.openvibe.tools/' },
        { name: 'Network Tools', icon: 'dns', url: 'https://net.openvibe.tools/' },
    ];
    const CATALOG_URL = 'https://openvibe.tools/api/catalog.json';
    const okUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

    async function launcherCatalog() {
        try { const c = JSON.parse(sessionStorage.getItem('ov_catalog') || 'null'); if (c && Date.now() - c.at < 30 * 60000) return c.data; } catch { /* */ }
        try {
            const r = await fetch(CATALOG_URL, { credentials: 'omit' }); if (!r.ok) return null;
            const j = await r.json();
            const data = { families: (j.families || []).slice(0, 12).map(f => ({ name: String(f.name || ''), icon: String(f.icon || 'tools'), url: okUrl(f.url) })).filter(f => f.name && f.url),
                tools: (j.tools || []).slice(0, 400).map(t => ({ name: String(t.name || ''), icon: String(t.icon || 'tools'), url: okUrl(t.url), k: [t.name, t.tagline].concat(t.keywords || []).join(' ').toLowerCase().slice(0, 400) })).filter(t => t.name && t.url) };
            try { sessionStorage.setItem('ov_catalog', JSON.stringify({ at: Date.now(), data })); } catch { /* */ }
            return data;
        } catch { return null; }
    }

    function bindLauncher(nav) {
        const btn = nav.querySelector('#openvibe-launcher-btn'); if (!btn) return;
        let panel = null;
        const tile = (it, cls) => `<a class="${cls}" href="${escapeAttr(it.url)}"><span class="ov-icon" data-icon="${escapeAttr(it.icon)}" data-size="${cls === 'ovl-site' ? 34 : 24}" data-fx="none"></span><span><b>${escapeAttr(it.name)}</b>${it.desc ? `<small>${escapeAttr(it.desc)}</small>` : ''}</span></a>`;
        const close = () => { if (panel) panel.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
        function paint(cat, q) {
            const fams = (cat && cat.families.length ? cat.families : LAUNCHER_FAMILIES);
            const body = panel.querySelector('.ovl-body');
            if (q && cat) {
                const hits = cat.tools.filter(t => t.k.includes(q)).slice(0, 12);
                body.innerHTML = hits.length ? `<div class="ovl-h">Tools</div><div class="ovl-fams">${hits.map(t => tile(t, 'ovl-fam')).join('')}</div>` : '<div class="ovl-empty">No tool matches. <a href="https://openvibe.tools/">Browse them all</a></div>';
                return;
            }
            const chrome = OVChrome.get();
            const sites = chrome && chrome.nav.length ? chrome.nav.map(n => ({ name: n.name, desc: n.tagline, icon: n.icon || n.id, url: n.url })) : LAUNCHER_SITES;
            const soon = chrome ? chrome.soon : [];
            body.innerHTML = `<div class="ovl-h">Sites</div><div class="ovl-sites">${sites.map(x => tile(x, 'ovl-site')).join('')}</div>
                <div class="ovl-h">Tools <a href="https://openvibe.tools/">See all</a></div><div class="ovl-fams">${fams.map(x => tile(x, 'ovl-fam')).join('')}</div>
                ${soon.length ? `<div class="ovl-h">Opening soon</div><div class="ovl-soon">${soon.map(x => `<a href="${escapeAttr(x.url)}">${escapeAttr(x.name)}</a>`).join('')}</div>` : ''}`;
        }
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (panel && panel.classList.contains('open')) return close();
            if (!panel) {
                panel = document.createElement('div'); panel.className = 'ovnav-launcher'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'OpenVibe sites and tools');
                panel.innerHTML = '<input type="search" class="ovl-q" placeholder="Find a tool or site" aria-label="Find a tool or site"><div class="ovl-body"></div>';
                nav.appendChild(panel);
                if (!root.OpenVibeIcons && !document.getElementById('ov-icons-loader')) { const sc = document.createElement('script'); sc.id = 'ov-icons-loader'; sc.src = 'https://openvibe.network/shared/ov-icons.js'; sc.async = true; document.head.appendChild(sc); }
                let cat = null; paint(null, '');
                const input = panel.querySelector('.ovl-q');
                input.addEventListener('input', () => paint(cat, input.value.trim().toLowerCase()));
                input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { const first = panel.querySelector('.ovl-body a'); if (first) location.href = first.href; } if (ev.key === 'ArrowDown') { const first = panel.querySelector('.ovl-body a'); if (first) { ev.preventDefault(); first.focus(); } } });
                panel.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Escape') { close(); btn.focus(); return; }
                    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
                    const links = [...panel.querySelectorAll('.ovl-body a')]; const i = links.indexOf(document.activeElement); if (i < 0) return;
                    ev.preventDefault(); const n = i + (ev.key === 'ArrowDown' ? 1 : -1); (links[n] || (n < 0 ? input : links[0])).focus();
                });
                panel.addEventListener('click', (ev) => ev.stopPropagation());
                document.addEventListener('click', close);
                launcherCatalog().then((c) => { if (c) { cat = c; paint(cat, input.value.trim().toLowerCase()); } });
            }
            panel.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
            try { panel.querySelector('.ovl-q').focus({ preventScroll: true }); } catch { /* */ }
        });
    }

    /** One anonymous page-view count per page load (host only), which is what orders the network's
     *  navigation. Skipped when the browser asks not to be tracked. */
    let _counted = false;
    function countView() {
        if (_counted || _config.countViews === false) return; _counted = true;
        try {
            if (navigator.globalPrivacyControl || navigator.doNotTrack === '1') return;
            if (!/^https:$/.test(location.protocol)) return;
            const url = 'https://openvibe.network/api/chrome/hit';
            if (navigator.sendBeacon) navigator.sendBeacon(url);
        } catch { /* */ }
    }

    /** The network's most used sites, after the page's own links (networkLinks: false turns it off). */
    function networkLinksHTML(pageLinks) {
        if (_config.networkLinks === false) return '';
        const chrome = OVChrome.get((d) => { if (d && _navEl && !_navEl.querySelector('.ovnav-net')) { try { render(); } catch { /* */ } } });
        if (!chrome) return '';
        const here = currentHost().toLowerCase();
        const taken = new Set((pageLinks || []).map(l => { try { return new URL(l.href, location.href).hostname; } catch { return ''; } }));
        const max = typeof _config.networkLinks === 'number' ? _config.networkLinks : 4;
        const pick = chrome.nav.filter(n => { try { const h = new URL(n.url).hostname; return h !== here && !here.endsWith('.' + h) && !taken.has(h); } catch { return false; } }).slice(0, max);
        if (!pick.length) return '';
        return `<span class="ovnav-sep" aria-hidden="true"></span>` + pick.map(n => `<a class="ovnav-net" href="${escapeAttr(n.url)}" title="${escapeAttr(n.tagline)}">${escapeAttr(n.name)}</a>`).join('');
    }

    // ── Notification bell (mounted by the navbar itself) ─────
    function mountBell(nav, u) {
        if (_config.notifications === false || !u || u.is_anon || !_config.token) return;
        const mount = nav.querySelector('#openvibe-bell-mount'); if (!mount || mount.childElementCount) return;
        const go = () => {
            const N = root.OpenVibeNotifications; if (!N || mount.childElementCount) return;
            try { if (!N.__ovNavInit) { N.init({ token: _config.token, apiBase: 'https://openvibe.network' }); N.__ovNavInit = true; } N.createBell(mount); } catch { /* */ }
        };
        if (root.OpenVibeNotifications) return go();
        if (document.getElementById('ov-notify-loader')) return;
        const sc = document.createElement('script'); sc.id = 'ov-notify-loader'; sc.src = 'https://openvibe.network/shared/notification-ui.js'; sc.async = true; sc.onload = () => setTimeout(go, 0); document.head.appendChild(sc);
    }

    function menuItemHTML(item) {
        if (!item) return '';
        if (item.sep) return '<div class="sep"></div>';
        const icon = item.icon ? `<span class="icon"><i class="fa-solid ${escapeAttr(item.icon)}"></i></span>` : '<span class="icon"></span>';
        const cls = item.danger ? ' class="danger"' : '';
        const id = item.id ? ` data-menu-id="${escapeAttr(item.id)}"` : '';
        if (item.href) return `<a href="${escapeAttr(item.href)}"${cls}${id}${item.external ? ' target="_blank" rel="noopener"' : ''}>${icon} ${escapeAttr(item.label)}</a>`;
        return `<button type="button"${cls}${id}>${icon} ${escapeAttr(item.label)}</button>`;
    }

    function bindMenuItems(container, items) {
        for (const item of items) {
            if (!item || !item.id || typeof item.onClick !== 'function') continue;
            container.querySelector(`[data-menu-id="${item.id}"]`)?.addEventListener('click', (e) => { if (!item.href) e.preventDefault(); item.onClick(e); });
        }
    }

    function currentLinks() {
        const list = _runtimeLinks || _config.links || SERVICE_LINKS[_config.service] || [];
        const path = (typeof location !== 'undefined' && location.pathname) || '/';
        return list.map((l) => Object.assign({}, l, { active: l.active !== undefined ? l.active : (l.href === path && path !== '/') }));
    }

    const SERVICE_LINKS = {
        live: [
            { label: 'Watch', href: '/' },
            { label: 'Chat', href: '/chat' },
            { label: 'VODs', href: '/vods' },
            { label: 'Game', href: '/game' },
        ],
        tools: [
            { label: 'Home', href: '/' },
        ],
        games: [
            { label: 'Play', href: '/game' },
            { label: 'Canvas', href: '/canvas' },
            { label: 'Leaderboard', href: '/leaderboard' },
        ],
        media: [
            { label: 'Home', href: '/' },
            { label: 'Network', href: 'https://openvibe.network' },
            { label: 'Live', href: 'https://openvibe.live' },
            { label: 'Tools', href: 'https://openvibe.tools' },
        ],
        network: [
            { label: 'Home', href: '/' },
            { label: 'My Account', href: '/my' },
            { label: 'Themes', href: '/themes' },
        ],
        maps: [
            { label: 'Map', href: '/' },
            { label: 'Camps', href: '/camps' },
        ],
        food: [
            { label: 'Food Banks', href: '/' },
            { label: 'Meal Plan', href: '/#meal-plan' },
        ],
        img: [
            { label: 'Convert', href: 'https://convert.openvibe.tools' },
            { label: 'Compress', href: 'https://compress.openvibe.tools' },
            { label: 'Resize', href: 'https://resize.openvibe.tools' },
            { label: 'Crop', href: 'https://crop.openvibe.tools' },
        ],
        yt: [
            { label: 'Download', href: '/' },
        ],
        audio: [
            { label: 'Convert', href: 'https://audio.openvibe.tools' },
            { label: 'Trim', href: 'https://trim.openvibe.tools' },
            { label: 'Pitch', href: 'https://pitch.openvibe.tools' },
            { label: 'Reverb', href: 'https://reverb.openvibe.tools' },
        ],
        text: [
            { label: 'Fancy', href: 'https://fancy.openvibe.tools' },
            { label: 'Zalgo', href: 'https://zalgo.openvibe.tools' },
            { label: 'ASCII', href: 'https://ascii.openvibe.tools' },
            { label: 'Symbols', href: 'https://symbols.openvibe.tools' },
        ],
        logo: [
            { label: 'Title', href: 'https://title.openvibe.tools' },
            { label: 'Wordmark', href: 'https://wordmark.openvibe.tools' },
            { label: 'Badge', href: 'https://badge.openvibe.tools' },
            { label: 'Thumbnail', href: 'https://thumbnail.openvibe.tools' },
        ],
        docs: [
            { label: 'Merge', href: 'https://mergepdf.openvibe.tools' },
            { label: 'Split', href: 'https://splitpdf.openvibe.tools' },
            { label: 'Compress', href: 'https://compresspdf.openvibe.tools' },
            { label: 'Images→PDF', href: 'https://image2pdf.openvibe.tools' },
        ],
        net: [
            { label: 'Lookup', href: 'https://lookup.openvibe.tools' },
            { label: 'My IP', href: 'https://myip.openvibe.tools' },
            { label: 'DNS', href: 'https://dns.openvibe.tools' },
            { label: 'Ping', href: 'https://ping.openvibe.tools' },
            { label: 'SSL', href: 'https://ssl.openvibe.tools' },
        ],
        dev: [
            { label: 'JSON', href: 'https://json.openvibe.tools' },
            { label: 'Base64', href: 'https://base64.openvibe.tools' },
            { label: 'JWT', href: 'https://jwt.openvibe.tools' },
            { label: 'Regex', href: 'https://regex.openvibe.tools' },
            { label: 'Diff', href: 'https://diff.openvibe.tools' },
        ],
    };

    function getAccounts() {
        try { return JSON.parse(localStorage.getItem('openvibe_accounts') || '[]'); } catch { return []; }
    }

    // ─── SSO auth resolution ───────────────────────────────────
    // Cookie policy (CONTRACTS.md): ov_token is host-only on openvibe.network,
    // and Domain=.openvibe.tools on the tools apex + every tool subdomain.
    // The tools gateway (apex) owns the OAuth client: /auth/login, /auth/logout,
    // /auth/me, POST /auth/refresh. Satellite subdomains (maps., audio., text.,
    // img., yt., docs., food., …) do NOT mount /auth/* — they only read the
    // shared cookie — so sign-in/out always goes through the gateway apex.
    // Detection order: ov_token cookie → localStorage → page-provided token →
    // app-specific session endpoint (opt-in via config.sessionUrl).
    const TOOLS_APEX = 'openvibe.tools';
    const TOKEN_KEY = 'ov_token';

    function currentHost() {
        return (typeof location !== 'undefined' && location.hostname) || '';
    }

    function onToolsDomain(host) {
        const h = host !== undefined ? host : currentHost();
        return h === TOOLS_APEX || h.endsWith('.' + TOOLS_APEX);
    }

    function onNetworkDomain(host) {
        const h = host !== undefined ? host : currentHost();
        try { return h !== '' && h === new URL(_config.apiBase).hostname; } catch { return false; }
    }

    function parseCookieToken(cookieStr) {
        const m = String(cookieStr || '').match(/(?:^|;\s*)ov_token=([^;]*)/);
        if (!m || !m[1]) return null;
        try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    }

    function getCookieToken() {
        if (typeof document === 'undefined') return null;
        return parseCookieToken(document.cookie);
    }

    function getStoredToken() {
        try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
    }

    function resolveToken() {
        return getCookieToken() || getStoredToken() || _config.token || null;
    }

    /** Where "Sign In" goes on this host. */
    function resolveLoginHref(host, returnUrl) {
        if (_config.loginUrl) return String(_config.loginUrl).replace('{url}', encodeURIComponent(returnUrl || '/'));
        if (onToolsDomain(host)) {
            // Every *.openvibe.tools host signs in through the gateway apex: it
            // holds the OAuth state cookie + redirect_uri (both apex-host-only)
            // and sets ov_token with Domain=.openvibe.tools, so the session
            // reaches all satellites. A host-local /auth/login would 404 on
            // satellites and break the OAuth state check on gateway subdomains.
            return `https://${TOOLS_APEX}/auth/login?next=${encodeURIComponent(returnUrl)}`;
        }
        if (onNetworkDomain(host)) return `/login?return=${encodeURIComponent(returnUrl)}`;
        return `${_config.apiBase}/login?return=${encodeURIComponent(returnUrl)}`;
    }

    function setAuthCookie(token) {
        if (typeof document === 'undefined') return;
        const maxAge = 24 * 60 * 60; // matches the 24h access JWT
        if (onToolsDomain()) {
            document.cookie = `ov_token=${token};path=/;max-age=${maxAge};domain=.${TOOLS_APEX};SameSite=Lax;Secure`;
        } else {
            const secure = (typeof location !== 'undefined' && location.protocol === 'https:') ? ';Secure' : '';
            document.cookie = `ov_token=${token};path=/;max-age=${maxAge};SameSite=Lax${secure}`;
        }
    }

    function clearAuthState() {
        if (typeof document !== 'undefined') {
            document.cookie = 'ov_token=;path=/;max-age=0;SameSite=Lax';
            if (onToolsDomain()) {
                document.cookie = `ov_token=;path=/;max-age=0;domain=.${TOOLS_APEX};SameSite=Lax`;
            }
        }
        try {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem('openvibe_anon_token');
            localStorage.removeItem('openvibe_active_account');
        } catch { /* storage unavailable */ }
    }

    function persistToken(token) {
        try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
        setAuthCookie(token);
    }

    /** GET {apiBase}/api/auth/me with the Bearer token. */
    async function fetchMe(token) {
        try {
            const res = await fetch(`${_config.apiBase}/api/auth/me`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                return { ok: true, user: (data && (data.user || data)) || null };
            }
            return { ok: false, unauthorized: res.status === 401 || res.status === 403 };
        } catch {
            return { ok: false, unauthorized: false };
        }
    }

    /** Same-origin session refresh — mounted by the tools gateway (POST /auth/refresh). */
    async function gatewayRefresh() {
        try {
            const res = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin' });
            if (!res.ok) return null;
            const data = await res.json();
            return data && data.token ? data : null;
        } catch { return null; }
    }

    /** Network-side refresh — accepts tokens expired up to 7 days ago (grace). */
    async function networkRefresh(token) {
        try {
            const res = await fetch(`${_config.apiBase}/api/auth/refresh`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data && data.token ? data : null;
        } catch { return null; }
    }

    /**
     * Resolve the signed-in user from the shared SSO state.
     * With a token: validate it against the Network. If it is rejected, make
     * ONE refresh attempt (same-origin gateway refresh first on tools hosts,
     * then the Network's grace refresh) before giving up — never leave a
     * stale "Sign In" when a recoverable session exists.
     */
    async function resolveSessionUser() {
        const token = resolveToken();
        if (token) {
            const me = await fetchMe(token);
            if (me.ok && me.user) return { user: me.user, token };
            if (me.unauthorized) {
                if (onToolsDomain()) {
                    const r = await gatewayRefresh();
                    if (r) {
                        const user = r.user || (await fetchMe(r.token)).user;
                        if (user) { persistToken(r.token); return { user, token: r.token }; }
                    }
                }
                const n = await networkRefresh(token);
                if (n) {
                    const user = n.user || (await fetchMe(n.token)).user;
                    if (user) { persistToken(n.token); return { user, token: n.token }; }
                }
            }
            return null;
        }
        // No token anywhere — ask the page's own session endpoint if it has one
        if (_config.sessionUrl) {
            try {
                const res = await fetch(_config.sessionUrl, { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    const user = (data && (data.user || data)) || null;
                    if (user && (user.username || user.id)) return { user, token: null };
                }
            } catch { /* signed out */ }
        }
        return null;
    }

    let _authInFlight = null;

    function ssoHint() {
        const m = (typeof document !== 'undefined' ? document.cookie : '').match(/(?:^|;\s*)ov_sso_hint=([^;]*)/);
        if (m) return m[1];
        try { return localStorage.getItem('ov_sso_hint'); } catch { return null; }
    }

    /**
     * One silent sign-in attempt per tab: only when this browser has signed in to the network
     * before (the hint survives token expiry), never after an explicit sign-out ('guest'), and
     * never for bots. The site's login route turns silent=1 into prompt=none and comes straight
     * back on error=login_required, so a signed-out visitor sees one quick redirect at most.
     */
    let _ssoClientLoading = null;
    function loadSsoClient() {
        if (root.OpenVibeSSO) return Promise.resolve(root.OpenVibeSSO);
        if (_ssoClientLoading) return _ssoClientLoading;
        _ssoClientLoading = new Promise((resolve) => {
            const sc = document.createElement('script'); sc.async = true; sc.src = `${_config.apiBase}/shared/sso-client.js`;
            sc.onload = () => resolve(root.OpenVibeSSO || null); sc.onerror = () => resolve(null);
            document.head.appendChild(sc);
        });
        return _ssoClientLoading;
    }

    /** Signed in here: cross-site links carry the session along (see sso-client.js). */
    function enableHandoff() {
        loadSsoClient().then((sso) => { try { sso && sso.handoffLinks({ signedIn: !!_config.user && !_config.user.is_anon }); } catch { /* */ } });
    }

    function silentLoginNow() {
        const url = String(_config.silentLogin).replace('{url}', encodeURIComponent(location.href));
        location.replace(url);
        return true;
    }

    /**
     * Two ways to find out that this browser is signed in to the network without a session here:
     *   1. the hint cookie this site set on an earlier sign-in ('account') — go straight to the
     *      silent sign-in (one quick redirect, back where you were);
     *   2. otherwise ask the network in a hidden iframe (GET /sso/check) — invisible, no
     *      redirect unless the answer is yes. Browsers that partition third-party cookies answer
     *      no and nothing happens, which is the same as before.
     * At most once per tab per 10 minutes; never after an explicit sign-out ('guest'); never for bots.
     */
    function maybeSilentLogin() {
        if (!_config.silentLogin || typeof location === 'undefined') return false;
        const hint = ssoHint();
        if (hint === 'guest') return false;
        if (/bot|crawl|spider|slurp|headless/i.test(navigator.userAgent || '')) return false;
        if (/[?&]sso=none\b/.test(location.search)) return false;
        try {
            const last = +sessionStorage.getItem('ov_silent_sso_at') || 0;
            if (Date.now() - last < 10 * 60 * 1000) return false;
            sessionStorage.setItem('ov_silent_sso_at', String(Date.now()));
        } catch { return false; }
        if (hint === 'account') return silentLoginNow();
        checkNetworkSession().then((state) => {
            if (state && state.signedIn) return silentLoginNow();
            // No answer or "not signed in" — either a guest, or a browser that keeps the network's
            // cookie away from iframes. FedCM asks the browser itself; the network's login status
            // makes it a no-op for guests, a native chip (then silent re-auth) for signed-in users.
            if (_config.fedcm === false) return;
            loadSsoClient().then(async (sso) => {
                if (!sso || !sso.fedcmAvailable()) return;
                const r = await sso.fedcm({ apiBase: _config.apiBase, fedcmLogin: _config.fedcmLogin || undefined, mediation: _config.fedcm === 'silent' ? 'silent' : 'optional' });
                if (r && r.ok) { try { sessionStorage.removeItem('ov_silent_sso_at'); } catch { /* */ } location.reload(); }
            });
        });
        return false;
    }

    /** Ask the network (hidden iframe + postMessage) whether this browser is signed in there. */
    function checkNetworkSession(timeoutMs = 4000) {
        return new Promise((resolve) => {
            let done = false, frame = null, timer = null;
            const finish = (v) => { if (done) return; done = true; clearTimeout(timer); window.removeEventListener('message', onMsg); try { frame?.remove(); } catch { /* */ } resolve(v); };
            const onMsg = (e) => {
                if (e.origin !== _config.apiBase || !e.data || e.data.type !== 'ov-sso') return;
                finish({ signedIn: !!e.data.signedIn, username: e.data.username || null });
            };
            try {
                window.addEventListener('message', onMsg);
                frame = document.createElement('iframe');
                frame.setAttribute('aria-hidden', 'true'); frame.setAttribute('tabindex', '-1');
                frame.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';
                frame.src = `${_config.apiBase}/sso/check?origin=${encodeURIComponent(location.origin)}`;
                (document.body || document.documentElement).appendChild(frame);
                timer = setTimeout(() => finish(null), timeoutMs);
            } catch { finish(null); }
        });
    }

    function recordHistory() {
        const h = _config.history;
        if (!h || !_config.user || _config.user.is_anon) return;
        const rec = Object.assign({ url: location.href, title: document.title, service: resolveBrand().tld }, h);
        const H = root.OpenVibeHistory;
        if (H && typeof H.record === 'function') { H.record(rec, { token: _config.token, apiBase: _config.apiBase }); return; }
        if (!document.getElementById('ov-history-loader')) {
            const sc = document.createElement('script'); sc.id = 'ov-history-loader'; sc.async = true;
            sc.src = `${_config.apiBase}/shared/history.js`;
            sc.onload = () => { try { root.OpenVibeHistory.record(rec, { token: _config.token, apiBase: _config.apiBase }); } catch { /* */ } };
            document.head.appendChild(sc);
        } else {
            document.getElementById('ov-history-loader').addEventListener('load', () => { try { root.OpenVibeHistory.record(rec, { token: _config.token, apiBase: _config.apiBase }); } catch { /* */ } });
        }
    }

    function refreshAuthState() {
        if (_authInFlight) return _authInFlight;
        _authInFlight = resolveSessionUser()
            .then((session) => {
                _authInFlight = null;
                if (session && session.user) {
                    _config.user = session.user;
                    if (session.token) _config.token = session.token;
                    render();
                    recordHistory();
                    enableHandoff();
                } else {
                    maybeSilentLogin();
                }
                try {
                    document.dispatchEvent(new CustomEvent('openvibe-navbar-auth', {
                        detail: { user: session ? session.user : null, token: session ? session.token : null },
                    }));
                } catch { /* non-DOM environment */ }
                return session ? session.user : null;
            })
            .catch(() => { _authInFlight = null; return null; });
        return _authInFlight;
    }

    function escapeAttr(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    function getAvatarInitial(user) {
        const source = user?.display_name || user?.username || 'O';
        return String(source).trim().charAt(0).toUpperCase() || 'O';
    }

    function makeAvatarPlaceholder(user, size = 64) {
        const initial = getAvatarInitial(user);
        const bg = user?.profile_color || '#3b82f6';
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
                <rect width="100%" height="100%" rx="${Math.round(size / 2)}" fill="${bg}"/>
                <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${Math.round(size * 0.42)}" font-weight="700" fill="#ffffff">${initial}</text>
            </svg>`;
        return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
    }

    function avatarSrc(user, size = 64) {
        return user?.avatar_url || makeAvatarPlaceholder(user, size);
    }

    function avatarImg(user, size = 64, className = 'openvibe-navbar-avatar', id = '') {
        const fallback = makeAvatarPlaceholder(user, size);
        const idAttr = id ? ` id="${escapeAttr(id)}"` : '';
        const alt = escapeAttr(user?.display_name || user?.username || 'Avatar');
        return `<img class="${escapeAttr(className)}" src="${escapeAttr(avatarSrc(user, size))}" data-fallback-src="${escapeAttr(fallback)}" alt="${alt}"${idAttr}>`;
    }

    function attachAvatarFallbacks(rootEl) {
        rootEl?.querySelectorAll('img[data-fallback-src]').forEach((img) => {
            img.addEventListener('error', () => {
                const fallback = img.dataset.fallbackSrc;
                if (fallback && img.src !== fallback) {
                    img.src = fallback;
                }
            }, { once: true });
        });
    }

    /**
     * "Recently used" rows in the dropdown: the last few things this account touched anywhere
     * on the network, from the shared history module (loaded lazily from the Network).
     */
    function renderRecent(el) {
        if (!el || !_config.user || _config.user.is_anon) return;
        const draw = (items) => {
            if (!items || !items.length) { el.hidden = true; return; }
            el.hidden = false;
            el.innerHTML = `<div class="label"><span>Recently used</span><a href="https://openvibe.network/my#history">All history</a></div>` +
                items.slice(0, 4).map(h => `<a class="item" href="${escapeAttr(h.url)}"><span class="icon"><i class="fa-solid ${escapeAttr(h.icon || 'fa-clock-rotate-left')}"></i></span><span class="t">${escapeAttr(h.title || h.url)}</span><span class="s">${escapeAttr(h.service_label || h.service || '')}</span></a>`).join('');
        };
        const H = root.OpenVibeHistory;
        if (H && typeof H.recent === 'function') { H.recent({ limit: 4, token: _config.token, apiBase: _config.apiBase }).then(draw).catch(() => draw(null)); return; }
        if (document.getElementById('ov-history-loader')) return;
        const sc = document.createElement('script'); sc.id = 'ov-history-loader'; sc.async = true;
        sc.src = `${_config.apiBase}/shared/history.js`;
        sc.onload = () => { try { root.OpenVibeHistory.recent({ limit: 4, token: _config.token, apiBase: _config.apiBase }).then(draw).catch(() => draw(null)); } catch { /* */ } };
        document.head.appendChild(sc);
    }

    function render() {
        if (_navEl) _navEl.remove();

        const nav = document.createElement('nav');
        nav.className = 'openvibe-navbar';
        const svc = _config.service;

        const brand = resolveBrand();
        if (typeof nav.setAttribute === 'function') { nav.setAttribute('data-compact', _config.compact || 'auto'); nav.setAttribute('data-service', svc); }
        const links = currentLinks();

        const u = _config.user;
        const accounts = getAccounts();
        const isAnon = u && u.is_anon;
        const loginHref = resolveLoginHref(currentHost(), window.location.href);
        const addAccountHref = `${_config.apiBase}/login?add_account=1&return=${encodeURIComponent(window.location.href)}`;

        // The OV brand mark is a self-contained drop-in (mounts every .ov-mark it finds).
        if (!window.__ovMark && !document.getElementById('ov-mark-loader')) {
            try { const sc = document.createElement('script'); sc.id = 'ov-mark-loader'; sc.src = 'https://openvibe.network/shared/ov-mark.js'; sc.async = true; document.head.appendChild(sc); } catch { /* */ }
        }
        nav.innerHTML = `
            ${brandHTML(brand)}
            <div class="openvibe-navbar-links">
                ${links.map(l => `<a href="${escapeAttr(l.href)}"${l.active ? ' class="active"' : ''}${l.external ? ' target="_blank" rel="noopener"' : ''}>${l.icon ? `<i class="fa-solid ${escapeAttr(l.icon)} icon"></i>` : ''}${escapeAttr(l.label)}</a>`).join('')}
                ${networkLinksHTML(links)}
                ${u && u.role === 'admin' ? `<a href="https://openvibe.network/admin"><i class="fa-solid fa-shield-halved"></i> Admin</a>` : ''}
            </div>
            <div class="openvibe-navbar-spacer"></div>
            <div class="openvibe-navbar-right">
                <div id="openvibe-bell-mount"></div>
                ${u ? avatarImg(u, 64, 'openvibe-navbar-avatar', 'openvibe-avatar-btn') :
                    `<a class="openvibe-navbar-login" id="openvibe-login-btn" href="${escapeAttr(loginHref)}">Sign In</a>`}
            </div>
        `;
        bindLauncher(nav);
        countView();
        // Pages that wire the bell themselves run right after init(); give them the first go.
        setTimeout(() => mountBell(nav, u), 0);

        // Dropdown
        if (u) {
            const dropdown = document.createElement('div');
            dropdown.className = 'openvibe-navbar-dropdown';
            dropdown.id = 'openvibe-user-dropdown';

            const otherAccounts = accounts.filter(a => isAnon ? !a.is_anon : String(a.id) !== String(u.id));
            const before = ((_config.menu && _config.menu.before) || []).concat(_runtimeMenu.before);
            const after = ((_config.menu && _config.menu.after) || []).concat(_runtimeMenu.after);

            dropdown.innerHTML = `
                <div class="openvibe-navbar-dropdown-header">
                    ${avatarImg(u, 72, '', '')}
                    <div class="info">
                        <div class="name">${u.display_name || u.username}</div>
                        <div class="email">${u.email || `@${u.username}`}</div>
                        ${isAnon ? `<div class="anon-tag">Anonymous #${u.anon_number || '?'}</div>` : ''}
                    </div>
                </div>
                <div class="openvibe-navbar-dropdown-accounts">
                    ${otherAccounts.map(a => `
                        <div class="account-item" data-account-id="${a.id}">
                            ${avatarImg(a, 48, '', '')}
                            <span>${a.display_name || a.username}${a.is_anon ? ' (anon)' : ''}</span>
                        </div>
                    `).join('')}
                    <div class="account-item" data-account-id="anon" style="${isAnon ? 'display:none' : ''}">
                        <span style="width:24px;text-align:center"><i class="fa-solid fa-user-secret"></i></span>
                        <span>Switch to Anonymous</span>
                    </div>
                    <a class="add-account" id="openvibe-add-account" href="${escapeAttr(addAccountHref)}">
                        <span style="width:24px;text-align:center"><i class="fa-solid fa-plus"></i></span>
                        <span>Add another account</span>
                    </a>
                </div>
                <div class="openvibe-navbar-dropdown-recent" id="openvibe-recent" hidden></div>
                <div class="openvibe-navbar-dropdown-menu">
                    ${before.map(menuItemHTML).join('')}${before.length ? '<div class="sep"></div>' : ''}
                    <a href="https://openvibe.network/my"><span class="icon"><i class="fa-solid fa-user"></i></span> My Account</a>
                    <a href="https://openvibe.network/my#history"><span class="icon"><i class="fa-solid fa-clock-rotate-left"></i></span> History</a>
                    <a href="https://openvibe.network/my#notifications"><span class="icon"><i class="fa-solid fa-bell"></i></span> Notifications</a>
                    <a href="https://openvibe.network/themes"><span class="icon"><i class="fa-solid fa-palette"></i></span> Themes</a>
                    <a href="https://openvibe.network/my#linked"><span class="icon"><i class="fa-solid fa-link"></i></span> Linked Services</a>
                    ${u.role === 'admin' ? `<a href="https://openvibe.network/admin"><span class="icon"><i class="fa-solid fa-screwdriver-wrench"></i></span> Admin Panel</a>` : ''}
                    ${after.length ? '<div class="sep"></div>' : ''}${after.map(menuItemHTML).join('')}
                    <div class="sep"></div>
                    <button id="openvibe-logout-btn" class="danger"><span class="icon"><i class="fa-solid fa-right-from-bracket"></i></span> Sign Out</button>
                </div>
            `;
            nav.appendChild(dropdown);
            bindMenuItems(dropdown, before.concat(after));
            if (_config.recent !== false) renderRecent(dropdown.querySelector('#openvibe-recent'));

            // Avatar click toggles dropdown
            nav.querySelector('#openvibe-avatar-btn').addEventListener('click', () => {
                dropdown.classList.toggle('open');
            });

            // Close on outside click
            document.addEventListener('click', e => {
                if (!nav.contains(e.target)) dropdown.classList.remove('open');
            });

            // Account switching
            dropdown.querySelectorAll('[data-account-id]').forEach(el => {
                el.addEventListener('click', () => {
                    const id = el.dataset.accountId;
                    document.dispatchEvent(new CustomEvent('openvibe-switch-account', { detail: { accountId: id } }));
                    dropdown.classList.remove('open');
                });
            });

            dropdown.querySelector('#openvibe-logout-btn')?.addEventListener('click', () => {
                dropdown.classList.remove('open');
                if (_config.onLogout) _config.onLogout();
                else {
                    clearAuthState();
                    _config.user = null;
                    _config.token = null;
                    try { root.OpenVibeSSO && root.OpenVibeSSO.preventSilent(); } catch { /* */ }
                    try { localStorage.setItem('ov_sso_hint', 'guest'); } catch { /* */ }
                    if (onToolsDomain()) {
                        // The gateway also clears the Domain=.openvibe.tools cookie
                        // and the httpOnly refresh cookie, then sends us back here.
                        window.location.href = `https://${TOOLS_APEX}/auth/logout?next=${encodeURIComponent(window.location.href)}`;
                    } else {
                        window.location.reload();
                    }
                }
            });
        } else {
            nav.querySelector('#openvibe-login-btn')?.addEventListener('click', (event) => {
                if (!_config.onLogin) return;
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                _config.onLogin();
            });
        }

        // Insert into page — use navbar-mount placeholder if available, otherwise prepend to body
        const mount = document.getElementById('navbar-mount');
        if (mount) {
            mount.appendChild(nav);
        } else {
            document.body.prepend(nav);
        }
        _navEl = nav;
        attachAvatarFallbacks(nav);
        return nav;
    }

    const OpenVibeNavbar = {
        init(opts = {}) {
            Object.assign(_config, opts);
            injectStyles();
            const el = render();
            // Pages that hand us a resolved user (openvibe.network, the tools
            // gateway hub) keep full control. Everyone else — pages that pass
            // only a token, or nothing at all — gets the user resolved from
            // the shared SSO state (ov_token cookie / localStorage / optional
            // sessionUrl) and the navbar re-renders when it arrives.
            if (!_config.user) refreshAuthState();
            else { recordHistory(); enableHandoff(); }
            return el;
        },

        /** Record something the signed-in user did here ({type, title, url, icon}) in their network history. */
        record(entry) { const h = _config.history; _config.history = Object.assign({}, h || {}, entry || {}); recordHistory(); _config.history = h; },

        /** Re-resolve the signed-in user from the shared SSO state. */
        refreshAuth() { return refreshAuthState(); },

        /** Update user (after account switch). */
        setUser(user) {
            _config.user = user;
            render();
        },

        /** Replace this site's top links at runtime ([{label, href, icon?, active?, external?}]). */
        setLinks(links) { _runtimeLinks = Array.isArray(links) ? links : null; if (_navEl) render(); },

        /** Add a row to the account dropdown: {label, href|onClick, icon, danger, external, position:'before'|'after'}. */
        addMenuItem(item) {
            if (!item || !item.label) return;
            const it = Object.assign({ id: item.id || `mi-${Math.random().toString(36).slice(2, 8)}` }, item);
            (it.position === 'before' ? _runtimeMenu.before : _runtimeMenu.after).push(it);
            if (_navEl && _config.user) render();
            return it.id;
        },

        removeMenuItem(id) {
            for (const k of ['before', 'after']) _runtimeMenu[k] = _runtimeMenu[k].filter(i => i.id !== id);
            if (_navEl && _config.user) render();
        },

        /** Is this browser signed in to the network? ({ signedIn, username } or null when unknown). */
        checkNetworkSession,

        /** The resolved brand for this page ({ sub, core, tld, name, short, variant }). */
        brand() { return resolveBrand(); },

        /** The activity island (island.js), loaded on first use: OpenVibeNavbar.activity.start({...}). */
        get activity() { return root.OpenVibeIsland || null; },
        set activity(_v) { /* island.js binds itself; nothing to store */ },

        setToken(token) { _config.token = token; },

        /** Get the bell mount point for OpenVibeNotifications. */
        getBellMount() {
            return _navEl?.querySelector('#openvibe-bell-mount') || null;
        },

        getElement() { return _navEl; },

        destroy() {
            _navEl?.remove();
            _navEl = null;
        },

        /** Internal auth helpers — exposed for tests, not a public API. */
        _auth: {
            parseCookieToken,
            onToolsDomain,
            onNetworkDomain,
            resolveLoginHref,
            resolveToken,
            resolveSessionUser,
            clearAuthState,
            persistToken,
        },
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = OpenVibeNavbar;
    else root.OpenVibeNavbar = OpenVibeNavbar;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
