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
            .openvibe-navbar .ovnav-ic, .openvibe-navbar-dropdown .ovnav-ic { flex: none; height: 1em; font-size: 1em; vertical-align: -.125em; overflow: visible; }
            .openvibe-navbar-links { min-width: 0; overflow-x: auto; scrollbar-width: none; }
            .openvibe-navbar-links::-webkit-scrollbar { display: none; }
            .openvibe-navbar-links a.ovnav-link { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; flex: none; }
            .openvibe-navbar .ovnav-link[hidden], .openvibe-navbar .ovnav-dd[hidden], .openvibe-navbar-dropdown [hidden] { display: none !important; }
            .openvibe-navbar .ovnav-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger, #ef4444); box-shadow: 0 0 0 0 rgba(239,68,68,.6); animation: ovnavPulse 1.8s infinite; }
            .openvibe-navbar .ovnav-dot[hidden] { display: none; }
            @keyframes ovnavPulse { 70% { box-shadow: 0 0 0 6px rgba(239,68,68,0); } 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); } }
            .openvibe-navbar .ovnav-caret { font-size: 10px; opacity: .6; }
            .openvibe-navbar .ovnav-dd { position: relative; display: inline-flex; flex: none; }
            .openvibe-navbar .ovnav-dd-menu { display: none; position: absolute; top: 100%; left: 0; min-width: 180px; padding: 5px; border-radius: 12px; z-index: 1002; background: var(--bg-elevated, var(--bg-secondary, #111826)); border: 1px solid var(--border, rgba(255,255,255,.12)); box-shadow: 0 18px 44px rgba(0,0,0,.45); flex-direction: column; gap: 2px; }
            .openvibe-navbar .ovnav-dd:hover .ovnav-dd-menu, .openvibe-navbar .ovnav-dd.open .ovnav-dd-menu, .openvibe-navbar .ovnav-dd:focus-within .ovnav-dd-menu { display: flex; }
            .openvibe-navbar .ovnav-chip { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 11px; border-radius: 999px; font: 700 13px/1 inherit; color: var(--chip-c, var(--text-primary, #e6edf7)); background: color-mix(in srgb, var(--chip-c, var(--accent, #3b82f6)) 12%, transparent); border: 1px solid color-mix(in srgb, var(--chip-c, var(--accent, #3b82f6)) 38%, transparent); font-variant-numeric: tabular-nums; }
            .ovnav-chip[data-tone="gold"] { --chip-c: #fbbf24; } .ovnav-chip[data-tone="green"] { --chip-c: #4ade80; } .ovnav-chip[hidden] { display: none !important; }
            .openvibe-navbar-dropdown .ud-chips { display: flex; gap: 6px; flex-wrap: nowrap; margin-top: 6px; }
            .openvibe-navbar-dropdown-header .info { min-width: 0; flex: 1; }
            .openvibe-navbar-dropdown .ovnav-chip--menu { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; font: 700 12px/1.2 inherit; color: var(--chip-c, #fbbf24); background: color-mix(in srgb, var(--chip-c, #fbbf24) 12%, transparent); border: 1px solid color-mix(in srgb, var(--chip-c, #fbbf24) 34%, transparent); }
            .openvibe-navbar .ovnav-burger { all: unset; box-sizing: border-box; cursor: pointer; display: none; width: 38px; height: 38px; border-radius: 11px; flex-direction: column; align-items: center; justify-content: center; gap: 4px; flex: none; }
            .openvibe-navbar .ovnav-burger span { display: block; width: 18px; height: 2px; border-radius: 2px; background: currentColor; transition: transform .2s, opacity .2s; }
            .openvibe-navbar .ovnav-burger[aria-expanded="true"] span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
            .openvibe-navbar .ovnav-burger[aria-expanded="true"] span:nth-child(2) { opacity: 0; }
            .openvibe-navbar .ovnav-burger[aria-expanded="true"] span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }
            .openvibe-navbar .ovnav-burger:hover, .openvibe-navbar .ovnav-burger[aria-expanded="true"] { background: var(--accent-glow, rgba(59,130,246,.14)); }
            .ovnav-drawer { display: none; position: fixed; top: calc(var(--ovnav-h, 56px) + 6px); right: 8px; width: min(300px, calc(100vw - 16px)); padding: 7px; border-radius: 16px; z-index: 1001; flex-direction: column; gap: 2px;
                background: var(--bg-elevated, var(--bg-secondary, #111826)); border: 1px solid var(--border, rgba(255,255,255,.12)); box-shadow: 0 22px 48px rgba(0,0,0,.45);
                max-height: calc(100vh - var(--ovnav-h, 56px) - 16px); max-height: calc(100dvh - var(--ovnav-h, 56px) - 16px - env(safe-area-inset-bottom, 0px)); overflow-y: auto; overscroll-behavior: contain; }
            .ovnav-drawer.open { display: flex; animation: openvibe-slide-down .2s ease; }
            .ovnav-drawer a { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 10px; color: var(--text-primary, #e6edf7); text-decoration: none; font-size: 14.5px; font-weight: 600; }
            .ovnav-drawer a.ovnav-sublink { padding-left: 34px; font-weight: 500; color: var(--text-secondary, #a8b3c4); }
            .ovnav-drawer a:hover, .ovnav-drawer a.active { background: var(--accent-glow, rgba(59,130,246,.14)); }
            .ovnav-drawer a[hidden] { display: none; }
            .ovnav-drawer .ud-label { padding: 10px 12px 3px; font-size: 10.5px; font-weight: 800; letter-spacing: .9px; text-transform: uppercase; color: var(--text-muted, #7d8aa0); }
            .ovnav-drawer-net:empty { display: none; } .ovnav-drawer-net { border-top: 1px solid var(--border, rgba(255,255,255,.08)); margin-top: 4px; }
            .ovnav-drawer-net a.ovnav-net { display: flex !important; }
            @media (max-width: 860px) { .openvibe-navbar .ovnav-burger { display: inline-flex; } .openvibe-navbar .openvibe-navbar-links { display: none; } .openvibe-navbar .ovnav-chip .ovnav-ic + .ovnav-chip-v:empty { display: none; } }
            @media (max-width: 420px) { .openvibe-navbar .ovnav-chip { padding: 0 8px; height: 30px; font-size: 12px; } }
            .ovnav-launcher { position: absolute; top: calc(100% + 6px); left: 12px; width: min(440px, calc(100vw - 24px));  background: var(--bg-elevated, var(--bg-secondary, #111826)); border: 1px solid var(--border, rgba(255,255,255,.12)); border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.5); padding: 12px; z-index: 1000; opacity: 0; transform: translateY(-6px) scale(.98); transform-origin: top left; pointer-events: none; transition: opacity .16s, transform .2s cubic-bezier(.2,1.2,.3,1); }
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
            .ovnav-launcher .ovl-display { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; padding: 10px 4px 2px; border-top: 1px solid var(--border, rgba(255,255,255,.08)); font-size: 12px; color: var(--text-muted, #7d8aa0); }
            .ovnav-launcher .ovl-display[hidden] { display: none; }
            .ovnav-launcher .ovl-dl { font-weight: 700; letter-spacing: .6px; text-transform: uppercase; font-size: 11px; margin-right: 2px; }
            .ovnav-launcher .ovl-seg { display: inline-flex; border: 1px solid var(--border, rgba(255,255,255,.12)); border-radius: 9px; overflow: hidden; }
            .ovnav-launcher .ovl-seg button { all: unset; cursor: pointer; padding: 5px 9px; font-size: 12px; font-weight: 650; color: var(--text-secondary, #a8b3c4); }
            .ovnav-launcher .ovl-seg button[aria-pressed="true"] { background: var(--accent, #3b82f6); color: var(--on-accent, #fff); }
            .ovnav-launcher .ovl-seg button:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: -2px; }
            .ovnav-launcher .ovl-display a { margin-left: auto; color: var(--accent-light, var(--accent, #60a5fa)); font-weight: 600; }
            .ovnav-launcher .ovl-addr a { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
            .ovnav-launcher .ovl-addr a.is-here { border-color: var(--accent, #3b82f6); color: var(--text-primary, #e6edf7); }
            .ovnav-launcher .ovl-all { grid-column: 1 / -1; color: var(--accent-light, var(--accent, #60a5fa)); }
            .ovnav-launcher .ovl-h span { text-transform: none; letter-spacing: 0; font-weight: 500; }
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
            .openvibe-navbar-dropdown { width: min(300px, calc(100vw - 16px)); }
            .openvibe-navbar-dropdown-menu .ud-label { padding: 8px 10px 3px; font-size: 10.5px; font-weight: 800; letter-spacing: .9px; text-transform: uppercase; color: var(--text-muted, #7d8aa0); }
            .openvibe-navbar-dropdown-menu .ud-val { margin-left: auto; font-weight: 600; font-size: 12.5px; color: var(--text-secondary, #a8b3c4); }
            .openvibe-navbar-dropdown-menu .icon { display: inline-grid; place-items: center; width: 22px; flex: none; }
            .openvibe-navbar-dropdown-header { background: linear-gradient(180deg, color-mix(in srgb, var(--accent, #3b82f6) 10%, transparent), transparent); }
            .openvibe-navbar-dropdown-header img { border-radius: 50%; box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #3b82f6) 55%, transparent); }
            .openvibe-navbar-dropdown-header .ud-wallet a { display: inline-flex; align-items: center; gap: 5px; margin-top: 5px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; text-decoration: none; color: #fbbf24; background: rgba(251,191,36,.12); border: 1px solid rgba(251,191,36,.3); }
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
            /* Panels never leave the screen: dvh is the VISIBLE height on phones (100vh reaches behind the address
               bar), the panel scrolls inside itself, and it is never wider than the viewport. */
            .openvibe-navbar-dropdown, .ovnav-launcher {
                max-width: calc(100vw - 16px);
                max-height: calc(100vh - 64px); max-height: calc(100dvh - 64px - env(safe-area-inset-bottom, 0px));
                overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; scrollbar-width: thin;
            }
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

    // ── Icons ────────────────────────────────────────────────
    // The navbar draws its own icons. It used to borrow the page's Font Awesome, so on pages that do not load
    // that font every menu row had an empty slot. Known names get an inline SVG; an unknown name still falls
    // back to the page's icon font, so sites that pass their own Font Awesome icons keep working.
    // BEGIN generated by scripts/build-nav-icons.py
    // Font Awesome Free 6 solid glyphs (CC BY 4.0, fontawesome.com/license/free) as filled paths,
    // viewBox 0 0 <w> 512. Regenerate: python3 packages/openvibe-shared/scripts/build-nav-icons.py
    const NAV_ICONS = {
        'fa-bell': [448, 'M224 11Q210 11 201 20Q192 29 192 43V62Q136 74 101 117Q65 160 64 219V238Q63 310 16 365L8 374Q-5 389 3 408Q12 426 32 427H416Q436 426 445 408Q453 389 440 374L433 365Q385 311 384 238V219Q383 160 347 117Q312 74 256 62V43Q256 29 247 20Q238 11 224 11ZM269 504Q288 485 288 459H224H160Q160 485 179 504Q198 523 224 523Q250 523 269 504Z'],
        'fa-book': [448, 'M96 11Q55 12 28 39Q1 66 0 107V427Q1 468 28 495Q55 522 96 523H384H416Q430 523 439 514Q448 505 448 491Q448 477 439 468Q430 459 416 459V395Q430 395 439 386Q448 377 448 363V43Q448 29 439 20Q430 11 416 11H384ZM96 395H352H96H352V459H96Q82 459 73 450Q64 441 64 427Q64 413 73 404Q82 395 96 395ZM128 155Q129 140 144 139H336Q351 140 352 155Q351 170 336 171H144Q129 170 128 155ZM144 203H336H144H336Q351 204 352 219Q351 234 336 235H144Q129 234 128 219Q129 204 144 203Z'],
        'fa-camera': [512, 'M149 76 139 107 149 76 139 107H64Q37 108 19 126Q1 144 0 171V427Q1 454 19 472Q37 490 64 491H448Q475 490 493 472Q511 454 512 427V171Q511 144 493 126Q475 108 448 107H373L363 76Q351 45 317 43H195Q161 45 149 76ZM256 203Q282 203 304 216Q326 229 339 251Q352 274 352 299Q352 324 339 347Q326 369 304 382Q282 395 256 395Q230 395 208 382Q186 369 173 347Q160 324 160 299Q160 274 173 251Q186 229 208 216Q230 203 256 203Z'],
        'fa-clock-rotate-left': [512, 'M75 86 41 52 75 86 41 52Q29 41 15 47Q1 52 0 69V179Q2 201 24 203H134Q151 202 156 188Q162 174 151 162L120 131Q174 77 256 75Q338 77 392 131Q446 185 448 267Q446 349 392 403Q338 457 256 459Q194 458 146 425Q135 417 122 419Q110 422 102 433Q94 444 96 456Q99 469 110 477Q173 522 256 523Q328 522 385 488Q443 454 477 396Q511 339 512 267Q511 195 477 138Q443 80 385 46Q328 12 256 11Q203 11 156 31Q110 51 75 86ZM256 139Q234 141 232 163V267Q232 277 239 284L311 356Q328 370 345 356Q359 339 345 322L280 257V163Q278 141 256 139Z'],
        'fa-coins': [512, 'M512 91Q511 118 474 139Q428 164 351 170Q346 167 340 165Q279 140 192 139Q180 139 168 140L166 139Q129 118 128 91Q130 57 184 34Q238 12 320 11Q402 12 456 34Q510 57 512 91ZM161 172Q176 171 192 171Q239 171 278 180Q318 188 345 202Q383 223 384 251Q384 257 382 263Q374 283 347 298Q347 298 347 298Q347 298 347 298Q347 298 347 298Q347 298 347 298Q346 299 346 299Q346 299 346 299Q319 314 279 322Q240 331 192 331Q100 330 44 302Q41 300 38 299Q1 278 0 251Q1 224 36 204Q71 184 128 176Q144 173 161 172ZM416 251Q414 218 392 198Q435 191 468 177Q493 167 512 152V187Q511 217 468 238Q446 249 416 256Q416 256 416 256Q416 254 416 251ZM384 347Q383 374 346 395Q344 396 342 397Q341 397 340 398Q284 426 192 427Q144 427 105 418Q65 410 38 395Q1 374 0 347V312Q19 327 44 337Q105 362 192 363Q279 362 340 337Q352 332 363 326Q372 321 380 315Q381 314 383 313Q383 312 384 312V315V321V347ZM416 347V315V347V315V289Q445 283 468 273Q493 263 512 248V283Q512 299 497 314Q471 339 416 352Q416 350 416 347ZM192 459Q279 458 340 433Q365 423 384 408V443Q382 477 328 500Q274 522 192 523Q110 522 56 500Q2 477 0 443V408Q19 423 44 433Q105 458 192 459Z'],
        'fa-comments': [640, 'M208 363Q296 361 355 311Q414 262 416 187Q414 112 355 63Q296 13 208 11Q120 13 61 63Q2 112 0 187Q1 246 40 290Q34 305 25 315Q18 324 12 329Q9 332 8 333Q7 334 7 334H6Q-2 341 1 352Q5 362 16 363Q50 362 78 351Q92 345 103 339Q150 362 208 363ZM448 187Q445 273 384 329Q322 385 232 394Q251 451 305 486Q359 522 432 523Q490 522 537 499Q548 505 562 511Q590 522 624 523Q635 522 639 512Q642 501 633 494Q633 494 633 493Q632 493 632 493Q631 492 628 489Q622 484 615 475Q606 464 600 450Q639 406 640 347Q638 276 584 227Q530 178 447 171Q448 179 448 187Z'],
        'fa-gamepad': [640, 'M192 75Q110 77 56 131Q2 185 0 267Q2 349 56 403Q110 457 192 459H448Q530 457 584 403Q638 349 640 267Q638 185 584 131Q530 77 448 75H192ZM496 179Q519 180 531 199Q541 219 531 239Q519 258 496 259Q473 258 461 239Q451 219 461 199Q473 180 496 179ZM392 315Q393 292 412 280Q432 270 452 280Q471 292 472 315Q471 338 452 350Q432 360 412 350Q393 338 392 315ZM168 211Q170 189 192 187Q214 189 216 211V243H248Q270 245 272 267Q270 289 248 291H216V323Q214 345 192 347Q170 345 168 323V291H136Q114 289 112 267Q114 245 136 243H168V211Z'],
        'fa-gauge-high': [512, 'M0 267Q1 197 34 139Q68 81 128 45Q189 11 256 11Q323 11 384 45Q444 81 478 139Q511 197 512 267Q511 337 478 395Q444 453 384 489Q323 523 256 523Q189 523 128 489Q68 453 34 395Q1 337 0 267ZM288 107Q288 93 279 84Q270 75 256 75Q242 75 233 84Q224 93 224 107Q224 121 233 130Q242 139 256 139Q270 139 279 130Q288 121 288 107ZM256 427Q283 426 301 408Q319 390 320 363Q319 336 302 318L366 173Q373 152 354 141Q333 134 322 153L258 299Q257 299 257 299Q256 299 256 299Q229 300 211 318Q193 336 192 363Q193 390 211 408Q229 426 256 427ZM176 155Q176 141 167 132Q158 123 144 123Q130 123 121 132Q112 141 112 155Q112 169 121 178Q130 187 144 187Q158 187 167 178Q176 169 176 155ZM96 299Q110 299 119 290Q128 281 128 267Q128 253 119 244Q110 235 96 235Q82 235 73 244Q64 253 64 267Q64 281 73 290Q82 299 96 299ZM448 267Q448 253 439 244Q430 235 416 235Q402 235 393 244Q384 253 384 267Q384 281 393 290Q402 299 416 299Q430 299 439 290Q448 281 448 267Z'],
        'fa-hand-fist': [448, 'M192 11Q206 11 215 20Q224 29 224 43V155H160V43Q160 29 169 20Q178 11 192 11ZM64 75Q64 61 73 52Q82 43 96 43Q110 43 119 52Q128 61 128 75V155H64V75ZM256 75Q256 61 265 52Q274 43 288 43Q302 43 311 52Q320 61 320 75V171Q320 185 311 194Q302 203 288 203Q274 203 265 194Q256 185 256 171V75ZM352 139Q352 125 361 116Q370 107 384 107Q398 107 407 116Q416 125 416 139V203Q416 217 407 226Q398 235 384 235Q370 235 361 226Q352 217 352 203V139ZM256 227V226V227V226Q270 235 288 235Q308 235 324 224Q330 243 347 255Q363 267 384 267Q402 267 416 258V267Q416 307 399 340Q382 373 352 395V491Q352 505 343 514Q334 523 320 523H160Q146 523 137 514Q128 505 128 491V413Q102 401 81 380L70 369Q33 331 32 278V251Q33 224 51 206Q69 188 96 187H184Q201 187 212 199Q224 210 224 227Q224 244 212 255Q201 267 184 267H128Q113 268 112 283Q113 298 128 299H184Q215 298 235 278Q255 258 256 227Z'],
        'fa-house': [576, 'M576 267Q575 280 566 289Q557 298 544 299H512L513 459Q512 463 512 467V483Q512 500 500 511Q489 523 472 523H456Q454 523 453 523Q451 523 449 523H416H392Q375 523 364 511Q352 500 352 483V459V395Q352 381 343 372Q334 363 320 363H256Q242 363 233 372Q224 381 224 395V459V483Q224 500 212 511Q201 523 184 523H160H128Q127 523 126 523Q125 523 124 523Q122 523 120 523H104Q87 523 76 511Q64 500 64 483V371Q64 370 64 368V299H32Q18 298 9 289Q0 280 0 267Q0 253 10 243L266 19Q277 10 288 11Q300 11 309 18L565 243Q577 253 576 267Z'],
        'fa-id-card': [576, 'M0 107H576H0H576Q575 80 557 62Q539 44 512 43H64Q37 44 19 62Q1 80 0 107ZM0 139V427V139V427Q1 454 19 472Q37 490 64 491H512Q539 490 557 472Q575 454 576 427V139H0ZM64 416Q65 394 80 379Q95 364 117 363H235Q257 364 272 379Q287 394 288 416Q287 426 277 427H75Q65 426 64 416ZM176 203Q212 204 231 235Q249 267 231 299Q212 330 176 331Q140 330 121 299Q103 267 121 235Q140 204 176 203ZM352 219Q353 204 368 203H496Q511 204 512 219Q511 234 496 235H368Q353 234 352 219ZM352 283Q353 268 368 267H496Q511 268 512 283Q511 298 496 299H368Q353 298 352 283ZM352 347Q353 332 368 331H496Q511 332 512 347Q511 362 496 363H368Q353 362 352 347Z'],
        'fa-link': [640, 'M580 279Q622 234 622 176Q622 119 580 74Q541 37 489 32Q438 28 394 59L392 60Q381 68 379 81Q377 93 385 105Q393 115 405 117Q418 120 429 112L431 111Q456 94 484 96Q513 98 535 119Q558 144 558 176Q558 209 535 233L422 346Q397 369 365 369Q333 369 308 346Q287 324 285 295Q283 267 300 242L301 240Q308 229 306 217Q304 204 293 196Q282 188 270 190Q257 192 249 203L248 205Q217 249 221 301Q225 352 263 391Q308 433 365 433Q423 433 468 391L580 279ZM60 255Q18 300 18 358Q18 415 60 460Q99 497 151 502Q202 506 247 475L248 474Q259 466 261 453Q263 441 256 429Q247 419 235 417Q222 414 211 422L209 423Q184 440 156 438Q127 436 105 415Q82 390 82 358Q82 325 106 301L218 188Q243 165 275 165Q307 165 332 188Q353 210 355 239Q357 267 340 292L339 294Q332 305 334 318Q336 330 347 338Q358 346 370 344Q383 342 391 331L392 329Q423 285 419 233Q415 182 377 143Q332 101 275 101Q217 101 173 143L60 255Z'],
        'fa-list-check': [512, 'M152 49Q167 65 154 83L82 163Q75 171 65 171Q54 171 47 164L7 124Q-7 107 7 90Q24 76 41 90L63 112L118 51Q134 36 152 49ZM152 209Q167 225 154 243L82 323Q75 331 65 331Q54 331 47 324L7 284Q-7 267 7 250Q24 236 41 250L63 272L118 211Q134 196 152 209ZM224 107Q224 93 233 84Q242 75 256 75H480Q494 75 503 84Q512 93 512 107Q512 121 503 130Q494 139 480 139H256Q242 139 233 130Q224 121 224 107ZM224 267Q224 253 233 244Q242 235 256 235H480Q494 235 503 244Q512 253 512 267Q512 281 503 290Q494 299 480 299H256Q242 299 233 290Q224 281 224 267ZM160 427Q160 413 169 404Q178 395 192 395H480Q494 395 503 404Q512 413 512 427Q512 441 503 450Q494 459 480 459H192Q178 459 169 450Q160 441 160 427ZM48 379Q75 380 90 403Q102 427 90 451Q75 474 48 475Q21 474 6 451Q-6 427 6 403Q21 380 48 379Z'],
        'fa-network-wired': [640, 'M256 75H384H256H384V139H256V75ZM240 11Q220 12 206 25Q193 39 192 59V155Q193 175 206 189Q220 202 240 203H288V235H32Q18 235 9 244Q0 253 0 267Q0 281 9 290Q18 299 32 299H128V331H80Q60 332 46 345Q33 359 32 379V475Q33 495 46 509Q60 522 80 523H240Q260 522 274 509Q287 495 288 475V379Q287 359 274 345Q260 332 240 331H192V299H448V331H400Q380 332 366 345Q353 359 352 379V475Q353 495 366 509Q380 522 400 523H560Q580 522 594 509Q607 495 608 475V379Q607 359 594 345Q580 332 560 331H512V299H608Q622 299 631 290Q640 281 640 267Q640 253 631 244Q622 235 608 235H352V203H400Q420 202 434 189Q447 175 448 155V59Q447 39 434 25Q420 12 400 11H240ZM96 459V395V459V395H224V459H96ZM416 395H544H416H544V459H416V395Z'],
        'fa-palette': [512, 'M512 267Q512 268 512 268Q512 269 512 270Q511 297 490 314Q470 331 442 331H344Q324 332 310 345Q297 359 296 379Q296 384 297 389Q300 403 307 417Q307 418 308 419Q318 439 320 461Q320 485 305 503Q291 521 267 523Q261 523 256 523Q184 522 127 488Q69 454 35 396Q1 339 0 267Q1 195 35 138Q69 80 127 46Q184 12 256 11Q328 12 385 46Q443 80 477 138Q511 195 512 267ZM128 299Q128 285 119 276Q110 267 96 267Q82 267 73 276Q64 285 64 299Q64 313 73 322Q82 331 96 331Q110 331 119 322Q128 313 128 299ZM128 203Q142 203 151 194Q160 185 160 171Q160 157 151 148Q142 139 128 139Q114 139 105 148Q96 157 96 171Q96 185 105 194Q114 203 128 203ZM288 107Q288 93 279 84Q270 75 256 75Q242 75 233 84Q224 93 224 107Q224 121 233 130Q242 139 256 139Q270 139 279 130Q288 121 288 107ZM384 203Q398 203 407 194Q416 185 416 171Q416 157 407 148Q398 139 384 139Q370 139 361 148Q352 157 352 171Q352 185 361 194Q370 203 384 203Z'],
        'fa-paste': [512, 'M160 11Q123 13 105 43H48Q28 44 14 57Q1 71 0 91V411Q1 431 14 445Q28 458 48 459H192V187Q193 153 215 130Q238 108 272 107H320V91Q319 71 306 57Q292 44 272 43H215Q197 13 160 11ZM272 139Q252 140 238 153Q225 167 224 187V459V475Q225 495 238 509Q252 522 272 523H464Q484 522 498 509Q511 495 512 475V255Q512 235 498 221L430 153Q416 139 396 139H320ZM160 51Q182 53 184 75Q182 97 160 99Q138 97 136 75Q138 53 160 51Z'],
        'fa-people-arrows': [640, 'M64 75Q65 39 96 20Q128 2 160 20Q191 39 192 75Q191 111 160 130Q128 148 96 130Q65 111 64 75ZM26 244Q29 213 51 192Q74 172 106 171H150Q193 173 216 205Q212 208 208 211L144 275Q128 293 128 315Q128 337 144 355L192 402V475Q191 495 178 509Q164 522 144 523H112Q92 522 78 509Q65 495 64 475V359Q44 352 32 334Q20 316 22 294L26 244ZM448 75Q449 39 480 20Q512 2 544 20Q575 39 576 75Q575 111 544 130Q512 148 480 130Q449 111 448 75ZM432 211Q428 208 424 205Q448 173 490 171H534Q566 172 589 192Q611 213 614 244L618 294Q620 316 608 334Q596 352 576 359V475Q575 495 562 509Q548 522 528 523H496Q476 522 462 509Q449 495 448 475V402L496 355Q512 337 512 315Q512 293 496 275L432 211ZM272 251V283V251V283H368V251Q369 235 383 229Q397 223 409 234L473 298Q487 315 473 332L409 396Q397 406 383 401Q369 395 368 379V347H272V379Q271 395 257 401Q243 407 231 396L167 332Q153 315 167 298L231 234Q243 224 257 229Q271 236 272 251Z'],
        'fa-people-group': [640, 'M72 99Q73 67 100 51Q128 35 156 51Q183 67 184 99Q183 131 156 147Q128 163 100 147Q73 131 72 99ZM64 257Q49 274 48 299Q49 324 64 341V257ZM208 207Q162 249 160 315Q161 367 192 406V427Q192 441 183 450Q174 459 160 459H96Q82 459 73 450Q64 441 64 427V400Q35 386 18 360Q0 333 0 299Q1 251 33 220Q64 188 112 187H144Q181 188 208 207ZM448 427V406V427V406Q479 367 480 315Q478 249 432 207Q459 188 496 187H528Q576 188 607 220Q639 251 640 299Q640 333 622 360Q605 386 576 400V427Q576 441 567 450Q558 459 544 459H480Q466 459 457 450Q448 441 448 427ZM456 99Q457 67 484 51Q512 35 540 51Q567 67 568 99Q567 131 540 147Q512 163 484 147Q457 131 456 99ZM576 257V341V257V341Q592 324 592 299Q592 274 576 257ZM320 43Q356 44 375 75Q393 107 375 139Q356 170 320 171Q284 170 265 139Q247 107 265 75Q284 44 320 43ZM240 315Q241 340 256 357V273Q241 290 240 315ZM384 273V357V273V357Q400 340 400 315Q400 290 384 273ZM448 315Q448 349 430 376Q413 402 384 416V459Q384 473 375 482Q366 491 352 491H288Q274 491 265 482Q256 473 256 459V416Q227 402 210 376Q192 349 192 315Q193 267 225 236Q256 204 304 203H336Q384 204 415 236Q447 267 448 315Z'],
        'fa-plus': [448, 'M256 91Q256 77 247 68Q238 59 224 59Q210 59 201 68Q192 77 192 91V235H48Q34 235 25 244Q16 253 16 267Q16 281 25 290Q34 299 48 299H192V443Q192 457 201 466Q210 475 224 475Q238 475 247 466Q256 457 256 443V299H400Q414 299 423 290Q432 281 432 267Q432 253 423 244Q414 235 400 235H256V91Z'],
        'fa-right-from-bracket': [512, 'M378 117 501 240 378 117 501 240Q512 251 512 267Q512 283 501 294L378 417Q368 427 354 427Q340 427 330 417Q320 407 320 393V331H192Q178 331 169 322Q160 313 160 299V235Q160 221 169 212Q178 203 192 203H320V141Q320 127 330 117Q340 107 354 107Q368 107 378 117ZM160 107H96H160H96Q82 107 73 116Q64 125 64 139V395Q64 409 73 418Q82 427 96 427H160Q174 427 183 436Q192 445 192 459Q192 473 183 482Q174 491 160 491H96Q55 490 28 463Q1 436 0 395V139Q1 98 28 71Q55 44 96 43H160Q174 43 183 52Q192 61 192 75Q192 89 183 98Q174 107 160 107Z'],
        'fa-scissors': [512, 'M256 203 217 164 256 203 217 164Q224 145 224 123Q223 75 191 44Q160 12 112 11Q64 12 33 44Q1 75 0 123Q1 171 33 202Q64 234 112 235Q134 235 153 228L192 267L153 307Q134 299 112 299Q64 300 33 332Q1 363 0 411Q1 459 33 490Q64 522 112 523Q160 522 191 490Q223 459 224 411Q224 389 217 371L499 88Q510 75 499 62Q477 41 448 41Q419 41 397 62L256 203ZM279 354 397 472 279 354 397 472Q419 493 448 493Q477 493 499 472Q510 459 499 446L343 290L279 354ZM64 123Q65 96 88 81Q112 69 136 81Q159 96 160 123Q159 150 136 165Q112 177 88 165Q65 150 64 123ZM112 363Q139 364 154 387Q166 411 154 435Q139 458 112 459Q85 458 70 435Q58 411 70 387Q85 364 112 363Z'],
        'fa-screwdriver-wrench': [512, 'M79 16Q62 5 47 18L7 58Q-6 73 5 90L85 194Q92 203 104 203H158L267 312Q256 334 260 359Q263 383 281 402L393 514Q403 523 416 523Q429 523 439 514L503 450Q512 440 512 427Q512 414 503 404L391 292Q372 274 348 271Q323 267 301 278L192 169V115Q192 103 183 96L79 16ZM20 407Q0 427 0 455Q1 484 20 503Q39 522 68 523Q96 523 116 503L234 385Q222 353 230 320L168 258L20 407ZM512 155Q512 139 509 125Q506 116 499 114Q491 113 485 119L421 182Q416 187 409 187H352Q337 186 336 171V114Q336 107 341 102L405 38Q411 32 409 24Q407 17 399 14Q384 11 368 11Q307 13 266 53Q226 94 224 155V156L309 241Q337 234 364 241Q392 249 413 270L429 286Q466 268 489 233Q511 199 512 155ZM56 443Q58 421 80 419Q102 421 104 443Q102 465 80 467Q58 465 56 443Z'],
        'fa-shield-halved': [512, 'M256 11Q263 11 269 14L458 94Q475 101 485 116Q496 131 496 151Q497 202 479 271Q461 340 414 405Q368 471 282 514Q256 526 230 514Q144 471 98 405Q51 340 33 271Q15 202 16 151Q16 131 27 116Q37 101 54 94L243 14Q249 11 256 11ZM256 78V456V78V456Q324 421 363 367Q401 313 417 256Q432 198 432 152L256 78Z'],
        'fa-shirt': [640, 'M212 11Q224 12 229 24Q238 54 263 72Q287 90 320 91Q353 90 377 72Q402 54 412 24Q416 12 428 11H441Q475 11 502 33L629 138Q639 147 640 161Q641 174 632 184L576 248Q567 258 555 259Q542 260 532 252L480 209V459Q479 486 461 504Q443 522 416 523H224Q197 522 179 504Q161 486 160 459V209L109 252Q98 260 86 259Q73 258 64 248L8 184Q-1 174 0 161Q1 147 12 138L138 33Q165 11 199 11H212Z'],
        'fa-text-height': [576, 'M64 139V107V139V107H128V427H96Q82 427 73 436Q64 445 64 459Q64 473 73 482Q82 491 96 491H224Q238 491 247 482Q256 473 256 459Q256 445 247 436Q238 427 224 427H192V107H256V139Q256 153 265 162Q274 171 288 171Q302 171 311 162Q320 153 320 139V91Q319 71 306 57Q292 44 272 43H160H48Q28 44 14 57Q1 71 0 91V139Q0 153 9 162Q18 171 32 171Q46 171 55 162Q64 153 64 139ZM503 52Q493 43 480 43Q467 43 457 52L393 116Q379 132 386 151Q395 170 416 171H448V363H416Q395 364 386 383Q379 402 393 418L457 482Q467 491 480 491Q493 491 503 482L567 418Q581 402 574 383Q565 364 544 363H512V171H544Q565 170 574 151Q581 132 567 116L503 52Z'],
        'fa-tower-broadcast': [576, 'M80 55Q64 94 64 139Q64 184 80 223Q85 236 80 247Q75 259 63 265Q50 270 38 265Q26 259 21 247Q0 197 0 139Q0 81 21 31Q26 19 38 14Q50 9 63 13Q75 19 80 30Q85 42 80 55ZM555 31Q576 81 576 139Q576 197 555 247Q550 259 538 264Q526 269 513 265Q501 259 496 248Q491 236 496 223Q512 184 512 139Q512 94 496 55Q491 42 496 31Q501 19 513 13Q526 8 538 13Q550 19 555 31ZM352 139Q350 176 320 194V491Q320 505 311 514Q302 523 288 523Q274 523 265 514Q256 505 256 491V194Q226 176 224 139Q225 112 243 94Q261 76 288 75Q315 76 333 94Q351 112 352 139ZM171 88Q160 111 160 139Q160 167 171 190Q176 203 171 215Q166 227 154 232Q141 237 130 233Q118 228 112 216Q96 180 96 139Q96 98 112 62Q118 50 130 45Q142 41 154 46Q166 51 171 63Q176 75 171 88ZM464 62Q480 98 480 139Q480 180 464 216Q458 228 446 233Q434 237 422 232Q410 227 405 215Q400 203 405 190Q416 167 416 139Q416 111 405 88Q400 75 405 63Q410 51 422 46Q435 41 446 45Q458 50 464 62Z'],
        'fa-user': [448, 'M224 267Q259 267 288 250Q317 233 335 203Q352 173 352 139Q352 105 335 75Q317 45 288 28Q259 11 224 11Q189 11 160 28Q131 45 113 75Q96 105 96 139Q96 173 113 203Q131 233 160 250Q189 267 224 267ZM178 315Q103 317 52 367Q2 418 0 493Q0 506 9 514Q17 523 30 523H418Q431 523 439 514Q448 506 448 493Q446 418 396 367Q345 317 270 315H178Z'],
        'fa-user-secret': [448, 'M224 27Q215 26 209 21Q208 21 208 21Q201 13 176 11Q153 12 137 39Q120 65 110 100Q74 107 53 117Q32 127 32 139Q35 161 97 175Q96 181 96 187Q96 213 105 235H45Q33 236 32 248Q32 251 33 253L72 350Q39 375 20 412Q0 449 0 493Q0 506 9 514Q17 523 30 523H418Q431 523 439 514Q448 506 448 493Q448 449 428 412Q409 375 376 350L415 253Q416 251 416 248Q415 236 403 235H343Q352 213 352 187Q352 181 351 175Q413 161 416 139Q416 127 395 117Q374 107 338 100Q328 65 311 39Q295 12 272 11Q247 13 240 21Q240 21 240 21Q239 21 239 21Q233 26 224 27ZM280 235H268H280H268Q241 234 231 209Q229 204 224 204Q219 204 217 209Q207 234 181 235H168Q151 235 140 223Q128 212 128 195V181Q171 187 224 187Q277 187 320 181V195Q320 212 308 223Q297 235 280 235ZM192 331 208 363 192 331 208 363 176 491 128 299 192 331ZM320 299 272 491 320 299 272 491 240 363 256 331 320 299Z'],
        'fa-video': [576, 'M0 139Q1 112 19 94Q37 76 64 75H320Q347 76 365 94Q383 112 384 139V395Q383 422 365 440Q347 458 320 459H64Q37 458 19 440Q1 422 0 395V139ZM559 111Q575 120 576 139V395Q575 414 559 423Q542 432 526 422L430 358L416 348V331V203V186L430 176L526 112Q542 103 559 111Z'],
        'fa-wallet': [512, 'M64 43Q37 44 19 62Q1 80 0 107V427Q1 454 19 472Q37 490 64 491H448Q475 490 493 472Q511 454 512 427V203Q511 176 493 158Q475 140 448 139H80Q65 138 64 123Q65 108 80 107H448Q462 107 471 98Q480 89 480 75Q480 61 471 52Q462 43 448 43H64ZM416 283Q430 283 439 292Q448 301 448 315Q448 329 439 338Q430 347 416 347Q402 347 393 338Q384 329 384 315Q384 301 393 292Q402 283 416 283Z'],
        'fa-wand-magic-sparkles': [576, 'M235 54 197 68 235 54 197 68Q192 70 192 75Q192 80 197 82L235 96L249 134Q251 139 256 139Q261 139 263 134L277 96L315 82Q320 80 320 75Q320 70 315 68L277 54L263 16Q261 11 256 11Q251 11 249 16L235 54ZM46 406Q32 421 32 440Q32 459 46 474L81 509Q95 523 115 523Q134 523 149 509L530 128Q544 113 544 94Q544 74 530 60L495 25Q481 11 461 11Q442 11 427 25L46 406ZM485 94 380 199 485 94 380 199 356 175 461 70 485 94ZM8 128Q0 131 0 139Q0 147 8 150L64 171L85 228Q88 235 96 235Q104 235 107 228L128 171L185 150Q192 147 192 139Q192 131 185 128L128 107L107 51Q104 43 96 43Q88 43 85 51L64 107L8 128ZM360 384Q352 387 352 395Q352 403 360 406L416 427L437 484Q440 491 448 491Q456 491 459 484L480 427L537 406Q544 403 544 395Q544 387 537 384L480 363L459 307Q456 299 448 299Q440 299 437 307L416 363L360 384Z'],
        'fa-arrow-up-right-from-square': [512, 'M320 11Q306 11 297 20Q288 29 288 43Q288 57 297 66Q306 75 320 75H403L201 276Q192 286 192 299Q192 312 201 322Q211 331 224 331Q237 331 247 322L448 120V203Q448 217 457 226Q466 235 480 235Q494 235 503 226Q512 217 512 203V43Q512 29 503 20Q494 11 480 11H320ZM80 43Q46 44 23 66Q1 89 0 123V443Q1 477 23 500Q46 522 80 523H400Q434 522 457 500Q479 477 480 443V331Q480 317 471 308Q462 299 448 299Q434 299 425 308Q416 317 416 331V443Q415 458 400 459H80Q65 458 64 443V123Q65 108 80 107H192Q206 107 215 98Q224 89 224 75Q224 61 215 52Q206 43 192 43H80Z'],
        'fa-chevron-down': [512, 'M233 418Q243 427 256 427Q269 427 279 418L471 226Q480 216 480 203Q480 190 471 180Q461 171 448 171Q435 171 425 180L256 350L87 180Q77 171 64 171Q51 171 41 180Q32 190 32 203Q32 216 41 226L233 418Z'],
        'fa-chevron-right': [320, 'M311 244Q320 254 320 267Q320 280 311 290L119 482Q109 491 96 491Q83 491 73 482Q64 472 64 459Q64 446 73 436L243 267L73 98Q64 88 64 75Q64 62 73 52Q83 43 96 43Q109 43 119 52L311 244Z'],
        'fa-bars': [448, 'M0 107Q0 93 9 84Q18 75 32 75H416Q430 75 439 84Q448 93 448 107Q448 121 439 130Q430 139 416 139H32Q18 139 9 130Q0 121 0 107ZM0 267Q0 253 9 244Q18 235 32 235H416Q430 235 439 244Q448 253 448 267Q448 281 439 290Q430 299 416 299H32Q18 299 9 290Q0 281 0 267ZM448 427Q448 441 439 450Q430 459 416 459H32Q18 459 9 450Q0 441 0 427Q0 413 9 404Q18 395 32 395H416Q430 395 439 404Q448 413 448 427Z'],
        'fa-xmark': [384, 'M343 162Q352 152 352 139Q352 126 343 116Q333 107 320 107Q307 107 297 116L192 222L87 116Q77 107 64 107Q51 107 41 116Q32 126 32 139Q32 152 41 162L147 267L41 372Q32 382 32 395Q32 408 41 418Q51 427 64 427Q77 427 87 418L192 312L297 418Q307 427 320 427Q333 427 343 418Q352 408 352 395Q352 382 343 372L237 267L343 162Z'],
        'fa-magnifying-glass': [512, 'M416 219Q415 289 376 342L503 468Q512 478 512 491Q512 504 503 514Q493 523 480 523Q467 523 457 514L331 387Q278 426 208 427Q120 425 61 366Q2 307 0 219Q2 131 61 72Q120 13 208 11Q296 13 355 72Q414 131 416 219ZM208 363Q247 363 280 344Q313 325 333 291Q352 257 352 219Q352 181 333 147Q313 113 280 94Q247 75 208 75Q169 75 136 94Q103 113 83 147Q64 181 64 219Q64 257 83 291Q103 325 136 344Q169 363 208 363Z'],
        'fa-gear': [512, 'M496 178Q500 192 490 202L446 242Q448 254 448 267Q448 280 446 292L490 332Q500 342 496 356Q489 374 480 391L475 399Q465 415 453 430Q443 441 429 437L373 419Q353 435 329 444L317 502Q313 516 298 519Q278 523 256 523Q234 523 213 519Q199 516 195 502L183 444Q159 435 139 419L83 437Q69 441 59 430Q46 415 37 399L32 391Q23 374 16 357Q12 342 22 332L66 293Q64 280 64 267Q64 254 66 242L22 202Q12 192 16 178Q23 160 32 143L37 135Q46 119 59 104Q69 93 83 97L139 115Q159 99 183 89L195 32Q199 18 214 15Q234 11 256 11Q278 11 299 15Q313 18 317 32L329 89Q353 99 373 115L429 97Q443 93 453 104Q466 119 476 135L480 143Q489 160 496 178ZM256 347Q301 346 325 307Q347 267 325 227Q301 188 256 187Q211 188 187 227Q165 267 187 307Q211 346 256 347Z'],
        'fa-circle-half-stroke': [512, 'M448 267Q446 185 392 131Q338 77 256 75V459Q338 457 392 403Q446 349 448 267ZM0 267Q1 197 34 139Q68 81 128 45Q189 11 256 11Q323 11 384 45Q444 81 478 139Q511 197 512 267Q511 337 478 395Q444 453 384 489Q323 523 256 523Q189 523 128 489Q68 453 34 395Q1 337 0 267Z'],
        'fa-moon': [384, 'M224 43Q161 44 111 74Q60 103 30 154Q1 204 0 267Q1 330 31 380Q60 431 111 460Q161 490 224 491Q317 489 379 428Q387 419 382 409Q377 399 365 400Q351 403 335 403Q261 401 211 351Q162 302 160 227Q160 177 184 137Q209 97 249 74Q259 68 257 56Q254 46 242 44Q233 43 223 43Z'],
        'fa-sun': [512, 'M362 12Q369 16 371 24L391 132L499 152Q507 154 511 161Q514 169 509 177L447 267L509 357Q514 365 511 373Q507 380 499 382L391 402L371 510Q369 518 362 522Q354 525 346 520L256 458L166 520Q158 525 151 522Q143 518 141 510L121 402L13 382Q5 380 1 373Q-2 365 3 357L65 267L3 177Q-2 169 1 162Q5 154 13 152L121 132L141 24Q143 16 151 12Q158 9 166 14L256 76L346 14Q354 9 362 12ZM160 267Q160 241 173 219Q186 197 208 184Q231 171 256 171Q281 171 304 184Q326 197 339 219Q352 241 352 267Q352 293 339 315Q326 337 304 350Q281 363 256 363Q231 363 208 350Q186 337 173 315Q160 293 160 267ZM384 267Q384 232 367 203Q350 174 320 156Q290 139 256 139Q222 139 192 156Q162 174 145 203Q128 232 128 267Q128 302 145 331Q162 360 192 378Q222 395 256 395Q290 395 320 378Q350 360 367 331Q384 302 384 267Z'],
        'fa-file-pdf': [512, 'M0 75Q1 48 19 30Q37 12 64 11H224V139Q224 153 233 162Q242 171 256 171H384V315H176Q149 316 131 334Q113 352 112 379V523H64Q37 522 19 504Q1 486 0 459V75ZM384 139H256H384H256V11L384 139ZM176 363H208H176H208Q232 364 248 379Q263 395 264 419Q263 443 248 459Q232 474 208 475H192V507Q191 522 176 523Q161 522 160 507V459V379Q161 364 176 363ZM208 443Q230 441 232 419Q230 397 208 395H192V443H208ZM304 363H336H304H336Q356 364 370 377Q383 391 384 411V475Q383 495 370 509Q356 522 336 523H304Q289 522 288 507V379Q289 364 304 363ZM336 491Q351 490 352 475V411Q351 396 336 395H320V491H336ZM416 379Q417 364 432 363H480Q495 364 496 379Q495 394 480 395H448V427H480Q495 428 496 443Q495 458 480 459H448V507Q447 522 432 523Q417 522 416 507V443V379Z'],
        'fa-arrow-down': [384, 'M169 482Q179 491 192 491Q205 491 215 482L375 322Q384 312 384 299Q384 286 375 276Q365 267 352 267Q339 267 329 276L224 382V75Q224 61 215 52Q206 43 192 43Q178 43 169 52Q160 61 160 75V382L55 276Q45 267 32 267Q19 267 9 276Q0 286 0 299Q0 312 9 322L169 482Z'],
        'fa-arrow-right': [448, 'M439 290Q448 280 448 267Q448 254 439 244L279 84Q269 75 256 75Q243 75 233 84Q224 94 224 107Q224 120 233 130L339 235H32Q18 235 9 244Q0 253 0 267Q0 281 9 290Q18 299 32 299H339L233 404Q224 414 224 427Q224 440 233 450Q243 459 256 459Q269 459 279 450L439 290Z'],
        'fa-clock': [512, 'M256 11Q326 12 384 45Q442 79 478 139Q512 200 512 267Q512 334 478 395Q442 455 384 489Q326 522 256 523Q186 522 128 489Q70 455 34 395Q0 334 0 267Q0 200 34 139Q70 79 128 45Q186 12 256 11ZM232 131V267V131V267Q232 280 243 287L339 351Q358 362 372 344Q383 325 365 311L280 254V131Q278 109 256 107Q234 109 232 131Z'],
        'fa-envelope': [512, 'M48 75Q28 76 14 89Q1 103 0 123Q1 147 19 161L237 325Q256 337 275 325L493 161Q511 147 512 123Q511 103 498 89Q484 76 464 75H48ZM0 187V395V187V395Q1 422 19 440Q37 458 64 459H448Q475 458 493 440Q511 422 512 395V187L294 350Q277 363 256 363Q235 363 218 350L0 187Z'],
        'fa-star': [576, 'M317 29Q308 12 288 11Q269 12 259 29L195 161L51 183Q32 186 26 204Q20 223 34 237L138 340L113 486Q111 505 126 517Q142 528 160 519L288 451L417 519Q434 528 450 517Q466 505 463 486L439 340L543 237Q556 223 551 204Q544 186 525 183L381 161L317 29Z'],
        'fa-heart': [512, 'M48 311 228 480 48 311 228 480Q240 491 256 491Q272 491 284 480L464 311Q511 267 512 202V196Q511 142 478 104Q445 65 393 55Q358 50 325 60Q293 70 268 95L256 107L244 95Q219 70 187 60Q154 50 119 55Q67 65 34 104Q1 142 0 196V202Q1 267 48 311Z'],
        'fa-play': [384, 'M73 50Q49 36 25 49Q1 63 0 91V443Q1 471 25 485Q49 498 73 484L361 308Q383 294 384 267Q383 241 361 226L73 50Z'],
        'fa-circle-info': [512, 'M256 523Q326 522 384 489Q442 455 478 395Q512 334 512 267Q512 200 478 139Q442 79 384 45Q326 12 256 11Q186 12 128 45Q70 79 34 139Q0 200 0 267Q0 334 34 395Q70 455 128 489Q186 522 256 523ZM216 347H240H216H240V283H216Q194 281 192 259Q194 237 216 235H264Q286 237 288 259V347H296Q318 349 320 371Q318 393 296 395H216Q194 393 192 371Q194 349 216 347ZM256 139Q270 139 279 148Q288 157 288 171Q288 185 279 194Q270 203 256 203Q242 203 233 194Q224 185 224 171Q224 157 233 148Q242 139 256 139Z'],
        'fa-triangle-exclamation': [512, 'M256 43Q279 44 291 63L507 431Q517 451 507 471Q495 490 472 491H40Q17 490 5 471Q-5 451 5 431L222 63Q234 44 256 43ZM256 171Q234 173 232 195V307Q234 329 256 331Q278 329 280 307V195Q278 173 256 171ZM288 395Q288 381 279 372Q270 363 256 363Q242 363 233 372Q224 381 224 395Q224 409 233 418Q242 427 256 427Q270 427 279 418Q288 409 288 395Z'],
        'fa-check': [448, 'M439 116Q448 126 448 139Q448 152 439 162L183 418Q173 427 160 427Q147 427 137 418L9 290Q0 280 0 267Q0 254 9 244Q19 235 32 235Q45 235 55 244L160 350L393 116Q403 107 416 107Q429 107 439 116Z'],
        'fa-globe': [512, 'M352 267Q352 300 349 331H163Q160 300 160 267Q160 234 163 203H349Q352 234 352 267ZM381 203H504H381H504Q512 234 512 267Q512 300 504 331H381Q384 300 384 267Q384 234 381 203ZM493 171H377H493H377Q361 73 321 19Q381 36 426 75Q470 115 493 171ZM344 171H168H344H168Q177 116 195 76Q211 41 228 25Q245 10 256 11Q267 10 284 25Q301 41 317 76Q335 116 344 171ZM135 171H19H135H19Q42 115 86 75Q131 36 191 19Q151 73 135 171ZM8 203H131H8H131Q128 234 128 267Q128 300 131 331H8Q0 300 0 267Q0 234 8 203ZM195 458Q177 418 168 363H344Q335 418 317 458Q301 493 284 509Q267 524 256 523Q245 524 228 509Q211 493 195 458ZM135 363Q151 461 191 515Q131 498 86 459Q42 419 19 363H135ZM493 363Q470 419 426 459Q381 498 322 515Q361 461 377 363H493Z'],
        'fa-code': [640, 'M393 12Q380 9 368 15Q357 21 353 34L225 482Q222 495 228 507Q234 518 247 522Q260 525 272 519Q283 513 287 500L415 52Q418 39 412 27Q406 16 393 12ZM473 132Q464 142 464 155Q464 168 473 178L563 267L473 356Q464 366 464 379Q464 392 473 402Q483 411 496 411Q509 411 519 402L631 290Q640 280 640 267Q640 254 631 244L519 132Q509 123 496 123Q483 123 473 132ZM167 132Q157 123 144 123Q131 123 121 132L9 244Q0 254 0 267Q0 280 9 290L121 402Q131 411 144 411Q157 411 167 402Q176 392 176 379Q176 366 167 356L77 267L167 178Q176 168 176 155Q176 142 167 132Z'],
        'fa-robot': [640, 'M320 11Q334 11 343 20Q352 29 352 43V107H472Q503 108 523 128Q543 148 544 179V451Q543 482 523 502Q503 522 472 523H168Q137 522 117 502Q97 482 96 451V179Q97 148 117 128Q137 108 168 107H288V43Q288 29 297 20Q306 11 320 11ZM208 395Q193 396 192 411Q193 426 208 427H240Q255 426 256 411Q255 396 240 395H208ZM304 395Q289 396 288 411Q289 426 304 427H336Q351 426 352 411Q351 396 336 395H304ZM400 395Q385 396 384 411Q385 426 400 427H432Q447 426 448 411Q447 396 432 395H400ZM264 267Q263 244 244 232Q224 222 204 232Q185 244 184 267Q185 290 204 302Q224 312 244 302Q263 290 264 267ZM416 307Q439 306 451 287Q461 267 451 247Q439 228 416 227Q393 228 381 247Q371 267 381 287Q393 306 416 307ZM48 235H64H48H64V427H48Q28 426 14 413Q1 399 0 379V283Q1 263 14 249Q28 236 48 235ZM592 235Q612 236 626 249Q639 263 640 283V379Q639 399 626 413Q612 426 592 427H576V235H592Z'],
        'fa-photo-film': [640, 'M256 11H576H256H576Q603 12 621 30Q639 48 640 75V299Q639 326 621 344Q603 362 576 363H256Q229 362 211 344Q193 326 192 299V75Q193 48 211 30Q229 12 256 11ZM476 118Q469 107 456 107Q443 107 436 118L380 202L363 180Q355 171 344 171Q333 171 325 180L261 260Q252 272 258 285Q265 298 280 299H360H552Q566 299 573 286Q579 274 572 262L476 118ZM336 107Q336 93 327 84Q318 75 304 75Q290 75 281 84Q272 93 272 107Q272 121 281 130Q290 139 304 139Q318 139 327 130Q336 121 336 107ZM64 139H160H64H160V395V427Q160 441 169 450Q178 459 192 459H320Q334 459 343 450Q352 441 352 427V395H512V459Q511 486 493 504Q475 522 448 523H64Q37 522 19 504Q1 486 0 459V203Q1 176 19 158Q37 140 64 139ZM72 203Q57 204 56 219V235Q57 250 72 251H88Q103 250 104 235V219Q103 204 88 203H72ZM72 307Q57 308 56 323V339Q57 354 72 355H88Q103 354 104 339V323Q103 308 88 307H72ZM72 411Q57 412 56 427V443Q57 458 72 459H88Q103 458 104 443V427Q103 412 88 411H72ZM408 427V443V427V443Q409 458 424 459H440Q455 458 456 443V427Q455 412 440 411H424Q409 412 408 427Z'],
        'fa-tower-cell': [576, 'M63 13Q50 9 38 14Q26 19 21 31Q0 81 0 139Q0 197 21 247Q26 259 38 264Q50 269 63 265Q75 259 80 248Q85 236 80 223Q64 184 64 139Q64 94 80 55Q85 42 80 31Q75 19 63 13ZM513 13Q501 19 496 31Q491 42 496 55Q512 94 512 139Q512 184 496 223Q491 236 496 247Q501 259 513 265Q526 270 538 265Q550 259 555 247Q576 197 576 139Q576 81 555 31Q550 19 538 14Q526 9 513 13ZM340 176Q352 160 352 139Q351 112 333 94Q315 76 288 75Q261 76 243 94Q225 112 224 139Q224 160 236 176L99 478Q94 490 98 502Q103 514 115 520Q127 526 139 521Q151 517 157 504L178 459H398L419 504Q425 516 437 521Q449 525 461 520Q474 514 478 502Q483 490 477 478L340 176ZM369 395H207H369H207L221 363H355L369 395ZM288 216 326 299 288 216 326 299H250L288 216ZM163 85Q170 64 151 53Q130 46 119 65Q104 100 104 139Q104 178 119 213Q130 232 151 225Q170 214 163 193Q152 168 152 139Q152 110 163 85ZM457 65Q446 46 425 53Q406 64 413 85Q424 110 424 139Q424 168 413 193Q406 214 425 225Q446 232 457 213Q472 178 472 139Q472 100 457 65Z'],
        'fa-diagram-project': [576, 'M0 91Q1 71 14 57Q28 44 48 43H144Q164 44 178 57Q191 71 192 91V107H384V91Q385 71 398 57Q412 44 432 43H528Q548 44 562 57Q575 71 576 91V187Q575 207 562 221Q548 234 528 235H432Q412 234 398 221Q385 207 384 187V171H192V187Q192 190 192 192L272 299H368Q388 300 402 313Q415 327 416 347V443Q415 463 402 477Q388 490 368 491H272Q252 490 238 477Q225 463 224 443V347Q224 344 224 342L144 235H48Q28 234 14 221Q1 207 0 187V91Z'],
        'fa-toolbox': [512, 'M176 99V139V99V139H336V99Q335 92 328 91H184Q177 92 176 99ZM128 139V99V139V99Q129 75 144 59Q160 44 184 43H328Q352 44 368 59Q383 75 384 99V139H412Q432 139 446 153L498 205Q512 219 512 239V315H384V299Q384 285 375 276Q366 267 352 267Q338 267 329 276Q320 285 320 299V315H192V299Q192 285 183 276Q174 267 160 267Q146 267 137 276Q128 285 128 299V315H0V239Q0 219 14 205L66 153Q80 139 100 139H128ZM0 427V347V427V347H128V363Q128 377 137 386Q146 395 160 395Q174 395 183 386Q192 377 192 363V347H320V363Q320 377 329 386Q338 395 352 395Q366 395 375 386Q384 377 384 363V347H512V427Q511 454 493 472Q475 490 448 491H64Q37 490 19 472Q1 454 0 427Z'],
        'fa-comment-dots': [512, 'M256 459Q328 458 385 431Q443 403 477 356Q511 309 512 251Q511 193 477 146Q443 99 385 71Q328 44 256 43Q184 44 127 71Q69 99 35 146Q1 193 0 251Q1 320 48 372Q43 409 26 435Q18 449 11 456Q8 460 6 462Q6 463 5 463Q5 463 5 464Q-2 471 1 481Q6 491 16 491Q60 489 98 472Q133 456 152 441Q200 459 256 459ZM128 219Q142 219 151 228Q160 237 160 251Q160 265 151 274Q142 283 128 283Q114 283 105 274Q96 265 96 251Q96 237 105 228Q114 219 128 219ZM256 219Q270 219 279 228Q288 237 288 251Q288 265 279 274Q270 283 256 283Q242 283 233 274Q224 265 224 251Q224 237 233 228Q242 219 256 219ZM352 251Q352 237 361 228Q370 219 384 219Q398 219 407 228Q416 237 416 251Q416 265 407 274Q398 283 384 283Q370 283 361 274Q352 265 352 251Z'],
        'fa-money-bill-wave': [576, 'M0 124V433V124V433Q1 463 27 475Q92 497 158 489Q223 481 288 463Q348 446 408 437Q468 429 527 444Q545 448 560 438Q575 429 576 410V101Q575 71 549 59Q484 37 419 45Q353 53 288 71Q228 88 168 96Q108 105 49 90Q30 86 16 95Q1 105 0 124ZM288 363Q254 362 231 335Q209 308 208 267Q209 226 231 199Q254 172 288 171Q322 172 345 199Q367 226 368 267Q367 308 345 335Q322 362 288 363ZM64 363Q91 364 109 382Q127 400 128 427H64V363ZM128 155Q127 182 109 200Q91 218 64 219V155H128ZM512 315V379V315V379H448Q449 352 467 334Q485 316 512 315ZM448 107H512H448H512V171Q485 170 467 152Q449 134 448 107Z'],
        'fa-crown': [576, 'M309 117Q327 105 328 83Q328 66 316 55Q305 43 288 43Q271 43 260 55Q248 66 248 83Q249 106 267 117L210 232Q202 245 188 249Q174 252 161 242L72 171Q80 161 80 147Q80 130 68 119Q57 107 40 107Q23 107 12 119Q0 130 0 147Q0 164 12 175Q23 187 40 187Q40 187 40 187Q41 187 41 187L86 438Q91 462 108 476Q126 491 149 491H427Q450 491 468 476Q485 462 490 438L535 187Q535 187 536 187Q536 187 536 187Q553 187 564 175Q576 164 576 147Q576 130 564 119Q553 107 536 107Q519 107 508 119Q496 130 496 147Q496 161 504 171L415 242Q402 252 388 249Q374 245 366 232L309 117Z'],
        'fa-server': [512, 'M64 43Q37 44 19 62Q1 80 0 107V171Q1 198 19 216Q37 234 64 235H448Q475 234 493 216Q511 198 512 171V107Q511 80 493 62Q475 44 448 43H64ZM344 115Q366 117 368 139Q366 161 344 163Q322 161 320 139Q322 117 344 115ZM392 139Q394 117 416 115Q438 117 440 139Q438 161 416 163Q394 161 392 139ZM64 299Q37 300 19 318Q1 336 0 363V427Q1 454 19 472Q37 490 64 491H448Q475 490 493 472Q511 454 512 427V363Q511 336 493 318Q475 300 448 299H64ZM344 371Q366 373 368 395Q366 417 344 419Q322 417 320 395Q322 373 344 371ZM400 395Q402 373 424 371Q446 373 448 395Q446 417 424 419Q402 417 400 395Z'],
        'fa-newspaper': [512, 'M96 107Q97 80 115 62Q133 44 160 43H448Q475 44 493 62Q511 80 512 107V427Q511 454 493 472Q475 490 448 491H80Q46 490 23 468Q1 445 0 411V139Q0 125 9 116Q18 107 32 107Q46 107 55 116Q64 125 64 139V411Q65 426 80 427Q95 426 96 411V107ZM160 131V211V131V211Q162 233 184 235H296Q318 233 320 211V131Q318 109 296 107H184Q162 109 160 131ZM368 123Q369 138 384 139H432Q447 138 448 123Q447 108 432 107H384Q369 108 368 123ZM368 219Q369 234 384 235H432Q447 234 448 219Q447 204 432 203H384Q369 204 368 219ZM160 315Q161 330 176 331H432Q447 330 448 315Q447 300 432 299H176Q161 300 160 315ZM160 411Q161 426 176 427H432Q447 426 448 411Q447 396 432 395H176Q161 396 160 411Z'],
        'fa-tag': [448, 'M0 91V241V91V241Q0 267 19 286L195 462Q214 481 240 481Q265 481 285 462L419 328Q437 309 437 283Q437 258 419 238L243 62Q224 43 197 43H48Q28 44 14 57Q1 71 0 91ZM112 123Q126 123 135 132Q144 141 144 155Q144 169 135 178Q126 187 112 187Q98 187 89 178Q80 169 80 155Q80 141 89 132Q98 123 112 123Z'],
        'fa-ticket': [576, 'M64 75Q37 76 19 94Q1 112 0 139V203Q2 217 16 222Q46 233 48 267Q46 301 16 312Q2 317 0 331V395Q1 422 19 440Q37 458 64 459H512Q539 458 557 440Q575 422 576 395V331Q574 317 560 312Q530 301 528 267Q530 233 560 222Q574 217 576 203V139Q575 112 557 94Q539 76 512 75H64ZM128 187V347V187V347Q129 362 144 363H432Q447 362 448 347V187Q447 172 432 171H144Q129 172 128 187ZM96 171Q96 157 105 148Q114 139 128 139H448Q462 139 471 148Q480 157 480 171V363Q480 377 471 386Q462 395 448 395H128Q114 395 105 386Q96 377 96 363V171Z'],
        'fa-chart-line': [512, 'M64 75Q64 61 55 52Q46 43 32 43Q18 43 9 52Q0 61 0 75V411Q1 445 23 468Q46 490 80 491H480Q494 491 503 482Q512 473 512 459Q512 445 503 436Q494 427 480 427H80Q65 426 64 411V75ZM471 162Q480 152 480 139Q480 126 471 116Q461 107 448 107Q435 107 425 116L320 222L263 164Q253 155 240 155Q227 155 217 164L105 276Q96 286 96 299Q96 312 105 322Q115 331 128 331Q141 331 151 322L240 232L297 290Q307 299 320 299Q333 299 343 290L471 162Z'],
        'fa-pen-nib': [512, 'M368 29 313 85 368 29 313 85 438 210 494 155Q510 137 510 115Q510 93 494 75L448 29Q430 13 408 13Q386 13 368 29ZM288 106 279 108 288 106 279 108 135 152Q104 162 92 193L4 457Q-2 475 11 489L165 336Q160 326 160 315Q161 295 174 281Q188 268 208 267Q228 268 242 281Q255 295 256 315Q255 335 242 349Q228 362 208 363Q197 363 187 358L34 512Q48 525 66 519L330 431Q361 419 371 388L415 244L417 235L288 106Z'],
        'fa-key': [512, 'M336 363Q411 361 460 311Q510 262 512 187Q510 112 460 63Q411 13 336 11Q261 13 212 63Q162 112 160 187Q160 215 168 241L7 402Q0 409 0 419V499Q2 521 24 523H104Q126 521 128 499V459H168Q190 457 192 435V395H232Q242 395 249 388L282 355Q308 363 336 363ZM376 107Q399 108 411 127Q421 147 411 167Q399 186 376 187Q353 186 341 167Q331 147 341 127Q353 108 376 107Z'],
        'fa-plug': [384, 'M96 11Q82 11 73 20Q64 29 64 43V139H128V43Q128 29 119 20Q110 11 96 11ZM288 11Q274 11 265 20Q256 29 256 43V139H320V43Q320 29 311 20Q302 11 288 11ZM32 171Q18 171 9 180Q0 189 0 203Q0 217 9 226Q18 235 32 235V267Q33 326 69 369Q104 412 160 424V491Q160 505 169 514Q178 523 192 523Q206 523 215 514Q224 505 224 491V424Q280 412 315 369Q351 326 352 267V235Q366 235 375 226Q384 217 384 203Q384 189 375 180Q366 171 352 171H32Z'],
        'fa-bolt': [448, 'M349 56Q358 33 339 17Q318 4 299 19L43 243Q27 258 34 278Q43 298 64 299H176L99 478Q90 501 109 517Q130 530 149 515L405 291Q421 276 414 256Q406 236 384 235H273L349 56Z'],
        'fa-satellite-dish': [512, 'M192 43Q192 29 201 20Q210 11 224 11Q304 12 369 50Q434 89 473 154Q511 219 512 299Q512 313 503 322Q494 331 480 331Q466 331 457 322Q448 313 448 299Q447 236 417 186Q388 135 337 106Q287 76 224 75Q210 75 201 66Q192 57 192 43ZM61 232 165 336 61 232 165 336 193 307Q192 303 192 299Q192 285 201 276Q210 267 224 267Q238 267 247 276Q256 285 256 299Q256 313 247 322Q238 331 224 331Q220 331 216 330L187 358L291 462Q302 474 300 488Q298 502 284 509Q249 523 208 523Q120 521 61 462Q2 403 0 315Q0 274 14 239Q21 225 35 223Q49 221 61 232ZM224 107Q306 109 360 163Q414 217 416 299Q416 313 407 322Q398 331 384 331Q370 331 361 322Q352 313 352 299Q351 245 315 208Q278 172 224 171Q210 171 201 162Q192 153 192 139Q192 125 201 116Q210 107 224 107Z'],
        'fa-brain': [512, 'M184 11Q208 12 224 27Q239 43 240 67V467Q239 491 224 507Q208 522 184 523Q162 523 146 509Q131 495 128 473Q120 475 112 475Q85 474 67 456Q49 438 48 411Q48 400 52 390Q29 381 14 361Q0 341 0 315Q0 291 13 272Q25 253 46 243Q32 226 32 203Q32 180 46 163Q60 146 82 140Q80 132 80 123Q80 100 94 83Q107 67 128 61Q131 39 146 25Q162 11 184 11ZM328 11Q350 11 366 25Q381 39 384 61Q405 67 418 83Q432 100 432 123Q432 132 430 140Q452 146 466 163Q480 180 480 203Q480 226 466 243Q487 253 499 272Q512 291 512 315Q512 341 498 361Q483 381 460 390Q464 400 464 411Q463 438 445 456Q427 474 400 475Q392 475 384 473Q381 495 366 509Q350 523 328 523Q304 522 288 507Q273 491 272 467V67Q273 43 288 27Q304 12 328 11Z'],
        'fa-microchip': [512, 'M176 35Q174 13 152 11Q130 13 128 35V75Q101 76 83 94Q65 112 64 139H24Q2 141 0 163Q2 185 24 187H64V243H24Q2 245 0 267Q2 289 24 291H64V347H24Q2 349 0 371Q2 393 24 395H64Q65 422 83 440Q101 458 128 459V499Q130 521 152 523Q174 521 176 499V459H232V499Q234 521 256 523Q278 521 280 499V459H336V499Q338 521 360 523Q382 521 384 499V459Q411 458 429 440Q447 422 448 395H488Q510 393 512 371Q510 349 488 347H448V291H488Q510 289 512 267Q510 245 488 243H448V187H488Q510 185 512 163Q510 141 488 139H448Q447 112 429 94Q411 76 384 75V35Q382 13 360 11Q338 13 336 35V75H280V35Q278 13 256 11Q234 13 232 35V75H176V35ZM160 139H352H160H352Q366 139 375 148Q384 157 384 171V363Q384 377 375 386Q366 395 352 395H160Q146 395 137 386Q128 377 128 363V171Q128 157 137 148Q146 139 160 139ZM352 171H160H352H160V363H352V171Z'],
        'fa-circle-nodes': [512, 'M418 169Q445 162 462 141Q479 120 480 91Q479 57 457 34Q434 12 400 11Q367 12 344 34Q322 55 320 88L136 162Q114 140 80 139Q46 140 23 162Q1 185 0 219Q1 253 23 276Q46 298 80 299Q98 299 114 291L260 419Q256 430 256 443Q257 477 279 500Q302 522 336 523Q370 522 393 500Q415 477 416 443Q414 400 381 377L418 169ZM156 243Q160 233 160 222L344 148Q349 153 355 158L318 365Q309 367 302 371L156 243Z'],
        'fa-download': [512, 'M288 43Q288 29 279 20Q270 11 256 11Q242 11 233 20Q224 29 224 43V286L151 212Q141 203 128 203Q115 203 105 212Q96 222 96 235Q96 248 105 258L233 386Q243 395 256 395Q269 395 279 386L407 258Q416 248 416 235Q416 222 407 212Q397 203 384 203Q371 203 361 212L288 286V43ZM64 363Q37 364 19 382Q1 400 0 427V459Q1 486 19 504Q37 522 64 523H448Q475 522 493 504Q511 486 512 459V427Q511 400 493 382Q475 364 448 363H347L301 408Q281 427 256 427Q230 427 211 408L166 363H64ZM432 419Q454 421 456 443Q454 465 432 467Q410 465 408 443Q410 421 432 419Z'],
        'fa-upload': [512, 'M288 120V363V120V363Q288 377 279 386Q270 395 256 395Q242 395 233 386Q224 377 224 363V120L151 194Q141 203 128 203Q115 203 105 194Q96 184 96 171Q96 158 105 148L233 20Q243 11 256 11Q269 11 279 20L407 148Q416 158 416 171Q416 184 407 194Q397 203 384 203Q371 203 361 194L288 120ZM64 363H192H64H192Q193 390 211 408Q229 426 256 427Q283 426 301 408Q319 390 320 363H448Q475 364 493 382Q511 400 512 427V459Q511 486 493 504Q475 522 448 523H64Q37 522 19 504Q1 486 0 459V427Q1 400 19 382Q37 364 64 363ZM432 467Q454 465 456 443Q454 421 432 419Q410 421 408 443Q410 465 432 467Z'],
        'fa-image': [512, 'M0 107Q1 80 19 62Q37 44 64 43H448Q475 44 493 62Q511 80 512 107V427Q511 454 493 472Q475 490 448 491H64Q37 490 19 472Q1 454 0 427V107ZM324 214Q316 203 304 203Q291 203 284 214L197 341L171 308Q163 299 152 299Q141 299 133 308L69 388Q61 400 66 413Q73 426 88 427H184H424Q438 427 445 414Q451 401 444 390L324 214ZM112 203Q139 202 154 179Q166 155 154 131Q139 108 112 107Q85 108 70 131Q58 155 70 179Q85 202 112 203Z'],
        'fa-music': [512, 'M499 17Q512 27 512 43V115V379Q511 413 484 436Q457 458 416 459Q375 458 348 436Q321 413 320 379Q321 345 348 322Q375 300 416 299Q433 299 448 304V158L192 235V443Q191 477 164 500Q137 522 96 523Q55 522 28 500Q1 477 0 443Q1 409 28 386Q55 364 96 363Q113 363 128 368V211V139Q129 116 151 108L471 12Q486 8 499 17Z'],
        'fa-file-lines': [384, 'M64 11Q37 12 19 30Q1 48 0 75V459Q1 486 19 504Q37 522 64 523H320Q347 522 365 504Q383 486 384 459V171H256Q242 171 233 162Q224 153 224 139V11H64ZM256 11V139V11V139H384L256 11ZM112 267H272H112H272Q287 268 288 283Q287 298 272 299H112Q97 298 96 283Q97 268 112 267ZM112 331H272H112H272Q287 332 288 347Q287 362 272 363H112Q97 362 96 347Q97 332 112 331ZM112 395H272H112H272Q287 396 288 411Q287 426 272 427H112Q97 426 96 411Q97 396 112 395Z'],
        'fa-font': [448, 'M254 64Q245 44 224 43Q203 44 194 64L58 427H32Q18 427 9 436Q0 445 0 459Q0 473 9 482Q18 491 32 491H128Q142 491 151 482Q160 473 160 459Q160 445 151 436Q142 427 128 427H126L144 379H304L322 427H320Q306 427 297 436Q288 445 288 459Q288 473 297 482Q306 491 320 491H416Q430 491 439 482Q448 473 448 459Q448 445 439 436Q430 427 416 427H390L254 64ZM280 315H168H280H168L224 166L280 315Z'],
        'fa-location-dot': [384, 'M216 510Q243 477 282 421Q321 366 352 307Q382 248 384 203Q382 121 328 67Q274 13 192 11Q110 13 56 67Q2 121 0 203Q2 248 32 307Q63 366 102 421Q141 477 168 510Q178 522 192 522Q206 522 216 510ZM192 139Q228 140 247 171Q265 203 247 235Q228 266 192 267Q156 266 137 235Q119 203 137 171Q156 140 192 139Z'],
        'fa-lock': [448, 'M144 155V203V155V203H304V155Q303 121 281 98Q258 76 224 75Q190 76 167 98Q145 121 144 155ZM80 203V155V203V155Q82 94 122 53Q163 13 224 11Q285 13 326 53Q366 94 368 155V203H384Q411 204 429 222Q447 240 448 267V459Q447 486 429 504Q411 522 384 523H64Q37 522 19 504Q1 486 0 459V267Q1 240 19 222Q37 204 64 203H80Z'],
        'fa-wave-square': [640, 'M128 75Q128 61 137 52Q146 43 160 43H320Q334 43 343 52Q352 61 352 75V427H448V267Q448 253 457 244Q466 235 480 235H608Q622 235 631 244Q640 253 640 267Q640 281 631 290Q622 299 608 299H512V459Q512 473 503 482Q494 491 480 491H320Q306 491 297 482Q288 473 288 459V107H192V267Q192 281 183 290Q174 299 160 299H32Q18 299 9 290Q0 281 0 267Q0 253 9 244Q18 235 32 235H128V75Z'],
        'fa-map': [576, 'M384 487 192 432 384 487 192 432V47L384 102V487ZM416 486V99V486V99L543 49Q556 44 565 51Q575 58 576 71V406Q575 421 561 428L416 486ZM15 106 160 48 15 106 160 48V435L33 486Q20 490 11 483Q1 476 0 463V128Q1 113 15 106Z'],
        'fa-utensils': [448, 'M416 11Q406 10 376 25Q345 39 318 77Q290 116 288 187V299Q289 326 307 344Q325 362 352 363H384V491Q384 505 393 514Q402 523 416 523Q430 523 439 514Q448 505 448 491V363V251V43Q448 29 439 20Q430 11 416 11ZM64 27Q63 14 50 11Q36 11 32 24L2 160Q0 169 0 179Q1 214 23 238Q46 263 80 267V491Q80 505 89 514Q98 523 112 523Q126 523 135 514Q144 505 144 491V267Q178 263 201 238Q223 214 224 179Q224 169 222 160L192 24Q188 11 174 11Q161 14 160 27V161Q159 170 150 171Q142 170 140 162L128 26Q126 12 112 11Q98 12 96 26L84 162Q82 170 74 171Q65 170 64 161V27ZM112 179V178V179Z'],
        'fa-user-shield': [640, 'M224 267Q259 267 288 250Q317 233 335 203Q352 173 352 139Q352 105 335 75Q317 45 288 28Q259 11 224 11Q189 11 160 28Q131 45 113 75Q96 105 96 139Q96 173 113 203Q131 233 160 250Q189 267 224 267ZM178 315Q103 317 52 367Q2 418 0 493Q0 506 9 514Q17 523 30 523H418Q421 523 424 523Q367 479 345 424Q322 368 320 322Q296 315 270 315H178ZM487 237 367 285 487 237 367 285Q353 291 352 307Q351 340 363 381Q374 422 403 460Q433 498 487 521Q496 525 505 521Q559 498 589 460Q618 422 629 381Q641 340 640 307Q639 291 625 285L505 237Q496 233 487 237ZM591 323Q589 363 568 404Q546 446 496 473V285L591 323Z'],
    };
    // END generated
    // Icons are solid filled paths generated from the Font Awesome Free solid font (see the
    // generated block above), so every OpenVibe page gets the same crisp glyphs with no
    // dependency on Font Awesome CSS. Names not in the set fall back to an <i class="fa-solid">
    // for pages that do load Font Awesome.
    function navIcon(cls) {
        if (!cls) return '';
        const key = String(cls).split(/\s+/).find(c => NAV_ICONS[c]);
        if (!key) return `<i class="fa-solid ${escapeAttr(cls)}"></i>`;
        const [w, d] = NAV_ICONS[key];
        return `<svg class="ovnav-ic" viewBox="0 0 ${w} 512" style="width:${(w / 512).toFixed(3)}em" aria-hidden="true" focusable="false"><path fill="currentColor" d="${d}"/></svg>`;
    }
    function upgradeIconsWhenFontsReady() { /* icons no longer depend on webfonts */ }

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
    // Descriptive hosts ('youtube-downloader') are for search engines; the brand shows the name people use.
    const LONG_SUBS = { 'youtube-downloader': 'YT', youtubedownloader: 'YT', 'youtube-download': 'YT', youtube: 'YT', ytdl: 'YT' };
    function subLabel(sub) { return SUB_LABELS[sub] || SUB_LABELS[LONG_SUBS[sub] && LONG_SUBS[sub].toLowerCase()] || LONG_SUBS[sub] || titleCase(String(sub).replace(/-/g, ' ')).replace(/ /g, ''); }

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
    const CATALOG_URL = 'https://openvibe.network/api/catalog.json';   // allowed by every site's CSP
    const TOOLS_SEARCH = 'https://openvibe.tools/search?q=';
    const okUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

    async function launcherCatalog() {
        try { const c = JSON.parse(sessionStorage.getItem('ov_catalog2') || 'null'); if (c && Date.now() - c.at < 30 * 60000) return c.data; } catch { /* */ }
        try {
            const r = await fetch(CATALOG_URL, { credentials: 'omit' }); if (!r.ok) return null;
            const j = await r.json();
            const data = { families: (j.families || []).slice(0, 12).map(f => ({ name: String(f.name || ''), icon: String(f.icon || 'tools'), url: okUrl(f.url) })).filter(f => f.name && f.url),
                tools: (j.tools || []).slice(0, 400).map(t => ({ name: String(t.name || ''), icon: String(t.icon || 'tools'), url: okUrl(t.url), go: t.hosts && t.hosts.short ? okUrl('https://' + t.hosts.short + '/') : null,
                    hosts: [t.hosts && t.hosts.short, t.hosts && t.hosts.canonical].concat((t.hosts && t.hosts.mirrors) || [], (t.hosts && t.hosts.aliases) || []).filter(h => typeof h === 'string' && h), id: String(t.id || ''), k: [t.name, t.tagline].concat(t.keywords || []).join(' ').toLowerCase().slice(0, 400) })).filter(t => t.name && t.url) };
            try { sessionStorage.setItem('ov_catalog2', JSON.stringify({ at: Date.now(), data })); } catch { /* */ }
            return data;
        } catch { return null; }
    }

    function bindLauncher(nav) {
        const btn = nav.querySelector('#openvibe-launcher-btn'); if (!btn) return;
        let panel = null;
        const tile = (it, cls) => `<a class="${cls}" href="${escapeAttr(it.go || it.url)}"><span class="ov-icon" data-icon="${escapeAttr(it.icon)}" data-size="${cls === 'ovl-site' ? 34 : 24}" data-fx="none"></span><span><b>${escapeAttr(it.name)}</b>${it.desc ? `<small>${escapeAttr(it.desc)}</small>` : ''}</span></a>`;
        const close = () => { if (panel) panel.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
        function paint(cat, q) {
            const fams = (cat && cat.families.length ? cat.families : LAUNCHER_FAMILIES);
            const body = panel.querySelector('.ovl-body');
            if (q) {
                // Sites and families always filter locally; tools need the catalog. Without it (offline, blocked),
                // the last row hands the query to the Tools search page, so typing never does nothing.
                const hit = (x) => (x.name + ' ' + (x.desc || '')).toLowerCase().includes(q);
                const siteList = (OVChrome.get() && OVChrome.get().nav.length ? OVChrome.get().nav.map(n => ({ name: n.name, desc: n.tagline, icon: n.icon || n.id, url: n.url })) : LAUNCHER_SITES).filter(hit);
                const famList = fams.filter(hit);
                const tools = cat ? cat.tools.filter(t => t.k.includes(q)).slice(0, 12) : [];
                const more = `<a class="ovl-fam ovl-all" href="${escapeAttr(TOOLS_SEARCH + encodeURIComponent(q))}"><span class="ov-icon" data-icon="search" data-size="24" data-fx="none"></span><span><b>Search all tools for “${escapeAttr(q)}”</b></span></a>`;
                body.innerHTML = (siteList.length ? `<div class="ovl-h">Sites</div><div class="ovl-fams">${siteList.map(x => tile(x, 'ovl-fam')).join('')}</div>` : '')
                    + (famList.length ? `<div class="ovl-h">Tool families</div><div class="ovl-fams">${famList.map(x => tile(x, 'ovl-fam')).join('')}</div>` : '')
                    + `<div class="ovl-h">Tools${cat ? '' : ' <span>loading…</span>'}</div><div class="ovl-fams">${tools.map(t => tile(t, 'ovl-fam')).join('')}${more}</div>`;
                return;
            }
            const chrome = OVChrome.get();
            const sites = chrome && chrome.nav.length ? chrome.nav.map(n => ({ name: n.name, desc: n.tagline, icon: n.icon || n.id, url: n.url })) : LAUNCHER_SITES;
            const soon = chrome ? chrome.soon : [];
            // On a tool: every address it answers to (short, search-friendly, mirrors, custom domains), so people
            // can pick the one they will remember.
            const cur = currentHost().toLowerCase();
            const here = cat ? cat.tools.find(t => t.hosts.indexOf(cur) >= 0) : null;
            const addresses = here && here.hosts.length > 1 ? `<div class="ovl-h">${escapeAttr(here.name)} lives at <a href="https://openvibe.tools/tool/${escapeAttr(here.id)}">About</a></div><div class="ovl-soon ovl-addr">${[...new Set(here.hosts)].filter(h => /^[a-z0-9.-]+$/.test(h)).map(h => `<a href="https://${h}/"${h === cur ? ' class="is-here" aria-current="page"' : ''}>${h}</a>`).join('')}</div>` : '';
            body.innerHTML = addresses + `<div class="ovl-h">Sites</div><div class="ovl-sites">${sites.map(x => tile(x, 'ovl-site')).join('')}</div>
                <div class="ovl-h">Tools <a href="https://openvibe.tools/">See all</a></div><div class="ovl-fams">${fams.map(x => tile(x, 'ovl-fam')).join('')}</div>
                ${soon.length ? `<div class="ovl-h">Opening soon</div><div class="ovl-soon">${soon.map(x => `<a href="${escapeAttr(x.url)}">${escapeAttr(x.name)}</a>`).join('')}</div>` : ''}`;
        }
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (panel && panel.classList.contains('open')) return close();
            if (!panel) {
                panel = document.createElement('div'); panel.className = 'ovnav-launcher'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'OpenVibe sites and tools');
                panel.innerHTML = '<input type="search" class="ovl-q" placeholder="Find a tool or site" aria-label="Find a tool or site"><div class="ovl-body"></div><div class="ovl-display" hidden></div>';
                bindDisplayControls(panel.querySelector('.ovl-display'));
                nav.appendChild(panel);
                regPanel(panel, 'launcher', close);
                if (!root.OpenVibeIcons && !document.getElementById('ov-icons-loader')) { const sc = document.createElement('script'); sc.id = 'ov-icons-loader'; sc.src = 'https://openvibe.network/shared/ov-icons.js'; sc.async = true; document.head.appendChild(sc); }
                let cat = null; paint(null, '');
                const input = panel.querySelector('.ovl-q');
                input.addEventListener('input', () => paint(cat, input.value.trim().toLowerCase()));
                input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { const first = panel.querySelector('.ovl-body a'); location.href = first ? first.href : TOOLS_SEARCH + encodeURIComponent(input.value.trim()); } if (ev.key === 'ArrowDown') { const first = panel.querySelector('.ovl-body a'); if (first) { ev.preventDefault(); first.focus(); } } });
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

    /** Status chips beside the bell (balances, counters): [{ id, icon, value, valueId, title, tone, onClick, hidden }]. */
    function chipsHTML(chips, cls) {
        return (Array.isArray(chips) ? chips : []).filter(Boolean).map(c => `<button type="button" class="${cls || 'ovnav-chip'}" data-chip-id="${escapeAttr(c.id)}"${c.tone ? ` data-tone="${escapeAttr(c.tone)}"` : ''}${c.title ? ` title="${escapeAttr(c.title)}"` : ''}${c.hidden ? ' hidden' : ''}>${c.icon ? navIcon(c.icon) : ''}<span class="ovnav-chip-v"${c.valueId ? ` id="${escapeAttr((cls ? 'menu-' : '') + c.valueId)}"` : ''}>${escapeAttr(c.value == null ? '' : c.value)}</span></button>`).join('');
    }
    function bindChips(scope) {
        (_config.chips || []).concat((_config.menu && _config.menu.headerChips) || []).forEach((c) => {
            if (!c || typeof c.onClick !== 'function') return;
            scope.querySelectorAll(`[data-chip-id="${c.id}"]`).forEach(el => { if (!el.__b) { el.__b = true; el.addEventListener('click', (e) => { e.stopPropagation(); c.onClick(e); }); } });
        });
    }

    /** Link behaviour: per-link onClick, in-app navigation (onNavigate), dropdowns, the mobile drawer. */
    function bindLinks(nav, links) {
        const byId = new Map(flatLinks(links).filter(l => l.id).map(l => [l.id, l]));
        const drawer = nav.querySelector('#openvibe-drawer'), burger = nav.querySelector('#openvibe-burger');
        const closeDrawer = () => { if (drawer) drawer.classList.remove('open'); if (burger) burger.setAttribute('aria-expanded', 'false'); };
        nav.addEventListener('click', (e) => {
            const a = e.target.closest && e.target.closest('a.ovnav-link, .ovnav-net'); if (!a || !nav.contains(a)) return;
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const item = byId.get(a.getAttribute('data-link-id'));
            // A parent of a dropdown opens it on touch (there is no hover); a second tap follows the link.
            const dd = a.parentElement && a.parentElement.classList.contains('ovnav-dd') ? a.parentElement : null;
            if (dd && matchMedia('(hover: none)').matches && !dd.classList.contains('open')) { e.preventDefault(); nav.querySelectorAll('.ovnav-dd.open').forEach(x => x.classList.remove('open')); dd.classList.add('open'); return; }
            if (item && typeof item.onClick === 'function') { const r = item.onClick(e); if (r === false) e.preventDefault(); closeDrawer(); if (e.defaultPrevented) return; }
            if (typeof _config.onNavigate === 'function' && a.target !== '_blank') {
                let same = false; try { same = new URL(a.href, location.href).origin === location.origin; } catch { /* */ }
                if (same && _config.onNavigate(a.getAttribute('href'), e) === false) e.preventDefault();
            }
            closeDrawer();
        });
        document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.ovnav-dd')) nav.querySelectorAll('.ovnav-dd.open').forEach(x => x.classList.remove('open')); });
        if (burger && drawer) {
            burger.addEventListener('click', (e) => { e.stopPropagation(); const open = drawer.classList.toggle('open'); burger.setAttribute('aria-expanded', String(open)); });
            document.addEventListener('click', (e) => { if (drawer.classList.contains('open') && !drawer.contains(e.target) && !burger.contains(e.target)) closeDrawer(); });
            regPanel(drawer, 'nav-drawer', closeDrawer);
        }
    }

    /** Dropdown, launcher and notifications share one coordinator (panels.js): one open at a time, Escape, rotation.
     *  Panels are registered where they are created (no page-wide observers); registrations queue until the script loads. */
    const _panelQueue = [];
    function regPanel(el, id, close) {
        if (!el) return;
        const opts = { el, openClass: 'open', id, close };
        if (root.OpenVibePanels) return root.OpenVibePanels.register(opts);
        _panelQueue.push(opts);
        if (document.getElementById('ov-panels-loader')) return;
        const sc = document.createElement('script'); sc.id = 'ov-panels-loader'; sc.src = 'https://openvibe.network/shared/panels.js'; sc.async = true;
        sc.onload = () => { while (_panelQueue.length) root.OpenVibePanels && root.OpenVibePanels.register(_panelQueue.shift()); };
        document.head.appendChild(sc);
    }

    /** Sites in the user menu: most used first (chrome data), never the one we are on. */
    function acrossHTML() {
        const chrome = OVChrome.get();
        const here = currentHost().toLowerCase();
        const list = (chrome && chrome.nav.length ? chrome.nav.map(n => ({ name: n.name, url: n.url, icon: n.icon || n.id })) : LAUNCHER_SITES)
            .filter(n => { try { const h = new URL(n.url).hostname; return h !== here && !here.endsWith('.' + h); } catch { return false; } }).slice(0, 5);
        return list.map(n => `<a href="${escapeAttr(n.url)}"><span class="icon"><span class="ov-icon" data-icon="${escapeAttr(n.icon)}" data-size="20" data-fx="none"></span></span> ${escapeAttr(n.name)}</a>`).join('');
    }

    /** Display rows (text size, animations) cycle their value; state lives in theme-loader.js. */
    function bindDisplayRows(dropdown) {
        const L = root.OpenVibeThemeLoader; const rows = dropdown.querySelectorAll('[data-ov-display]');
        if (!L || !L.display) { rows.forEach(r => { r.hidden = true; }); return; }
        const LABEL = { text: { 100: 'Default', 112: 'Large', 125: 'Largest' }, motion: { auto: 'On', reduced: 'Calm' } };
        const paint = () => { const d = L.display.get(); rows.forEach(r => { const k = r.getAttribute('data-ov-display'); r.querySelector('.ud-val').textContent = LABEL[k][d[k]] || ''; }); };
        rows.forEach(r => r.addEventListener('click', (e) => { e.stopPropagation(); const k = r.getAttribute('data-ov-display'), o = L.display.options[k], cur = L.display.get()[k]; L.display.set({ [k]: o[(o.indexOf(cur) + 1) % o.length] }); paint(); }));
        root.addEventListener('ov:display', paint); paint();
    }

    /** OpenCoins balance in the menu header (one request when the menu first opens). */
    let _walletLoaded = false;
    async function loadWallet(dropdown) {
        if (_walletLoaded || !_config.token || (_config.menu && _config.menu.headerChips)) return; _walletLoaded = true;
        try {
            const r = await fetch(`${_config.apiBase}/api/coins/me`, { headers: { Authorization: `Bearer ${_config.token}` }, credentials: 'include' });
            if (!r.ok) return; const j = await r.json(); const bal = Number(j.balance ?? (j.wallet && j.wallet.balance));
            const el = dropdown.querySelector('#openvibe-wallet'); if (!el || !isFinite(bal)) return;
            el.innerHTML = `<a href="https://openvibe.network/my#coins" title="OpenCoins">${navIcon('fa-coins')} ${bal.toLocaleString()}</a>`; el.hidden = false;
        } catch { /* the chip is optional */ }
    }

    /** The network's most used sites, after the page's own links (networkLinks: false turns it off). */
    function networkLinksHTML(pageLinks, inDrawer) {
        if (_config.networkLinks === false) return '';
        const chrome = OVChrome.get((d) => { if (d && _navEl && !_navEl.querySelector('.ovnav-net')) { try { render(); } catch { /* */ } } });
        if (!chrome) return '';
        const here = currentHost().toLowerCase();
        const taken = new Set((pageLinks || []).map(l => { try { return new URL(l.href, location.href).hostname; } catch { return ''; } }));
        const max = inDrawer ? 6 : (typeof _config.networkLinks === 'number' ? _config.networkLinks : 4);
        const pick = chrome.nav.filter(n => { try { const h = new URL(n.url).hostname; return h !== here && !here.endsWith('.' + h) && !taken.has(h); } catch { return false; } }).slice(0, max);
        if (!pick.length) return '';
        return (inDrawer ? '<div class="ud-label">Across OpenVibe</div>' : `<span class="ovnav-sep" aria-hidden="true"></span>`) + pick.map(n => `<a class="ovnav-net" href="${escapeAttr(n.url)}" title="${escapeAttr(n.tagline)}">${escapeAttr(n.name)}</a>`).join('');
    }

    /** Display settings in the launcher, for guests and members alike (theme-loader.js owns the state). */
    function bindDisplayControls(box) {
        const L = root.OpenVibeThemeLoader; if (!box || !L || !L.display) return;
        const paint = () => {
            const d = L.display.get();
            const seg = (key, val, label, title) => `<button type="button" data-k="${key}" data-v="${val}" aria-pressed="${String(d[key]) === val}" title="${title}">${label}</button>`;
            box.innerHTML = `<span class="ovl-dl">Display</span><span class="ovl-seg" role="group" aria-label="Text size">${seg('text', '100', 'A', 'Default text size')}${seg('text', '112', 'A+', 'Larger text')}${seg('text', '125', 'A++', 'Largest text')}</span>
                <span class="ovl-seg" role="group" aria-label="Motion">${seg('motion', 'auto', 'Motion', 'Animations on')}${seg('motion', 'reduced', 'Calm', 'Reduce animations')}</span><a href="https://openvibe.network/themes">Themes</a>`;
            box.hidden = false;
        };
        box.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; L.display.set({ [b.dataset.k]: b.dataset.v }); paint(); });
        root.addEventListener('ov:display', paint);
        paint();
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

    /** Custom sections for the user menu: [{ label, items: [{ label, icon, href, id, elId, hidden, danger, value, onClick }] }]. */
    function sectionsHTML(sections) {
        return (Array.isArray(sections) ? sections : []).filter(sec => sec && Array.isArray(sec.items) && sec.items.length).map(sec =>
            `<div class="ud-sec"${sec.id ? ` data-sec-id="${escapeAttr(sec.id)}"` : ''}${sec.hidden ? ' hidden' : ''}>${sec.label ? `<div class="ud-label">${escapeAttr(sec.label)}</div>` : ''}${sec.items.map(menuItemHTML).join('')}</div><div class="sep"></div>`).join('');
    }
    const sectionItems = (sections) => (Array.isArray(sections) ? sections : []).reduce((o, sec) => o.concat((sec && sec.items) || []), []);

    function menuItemHTML(item) {
        if (!item) return '';
        if (item.sep) return '<div class="sep"></div>';
        const icon = item.icon ? `<span class="icon">${navIcon(item.icon)}</span>` : '<span class="icon"></span>';
        const cls = item.danger ? ' class="danger"' : '';
        const id = `${item.id ? ` data-menu-id="${escapeAttr(item.id)}"` : ''}${item.elId ? ` id="${escapeAttr(item.elId)}"` : ''}${item.hidden ? ' hidden' : ''}`;
        const val = item.value !== undefined ? `<b class="ud-val">${escapeAttr(item.value)}</b>` : '';
        if (item.href) return `<a href="${escapeAttr(item.href)}"${cls}${id}${item.external ? ' target="_blank" rel="noopener"' : ''}>${icon} ${escapeAttr(item.label)}${val}</a>`;
        return `<button type="button"${cls}${id}>${icon} ${escapeAttr(item.label)}${val}</button>`;
    }

    function bindMenuItems(container, items) {
        for (const item of items) {
            if (!item || !item.id || typeof item.onClick !== 'function') continue;
            container.querySelector(`[data-menu-id="${item.id}"]`)?.addEventListener('click', (e) => { if (!item.href) e.preventDefault(); const r = item.onClick(e); if (r === false) e.preventDefault(); if (item.keepOpen !== true) container.closest('.openvibe-navbar-dropdown')?.classList.remove('open'); });
        }
    }

    /** One top-level link. Supports { label, href, icon, id, elId, page, hidden, external, dot, dotId, children: [...] }. */
    function linkHTML(l, inDrawer) {
        const attrs = `${l.id ? ` data-link-id="${escapeAttr(l.id)}"` : ''}${l.elId ? ` id="${escapeAttr((inDrawer ? 'drawer-' : '') + l.elId)}"` : ''}${l.page ? ` data-page="${escapeAttr(l.page)}"` : ''}${l.hidden ? ' hidden' : ''}${l.external ? ' target="_blank" rel="noopener"' : ''}`;
        const kids = Array.isArray(l.children) ? l.children.filter(Boolean) : [];
        const inner = `${l.icon ? `<span class="icon">${navIcon(l.icon)}</span>` : ''}<span class="ovnav-l">${escapeAttr(l.label)}</span>${l.dot !== undefined ? `<span class="ovnav-dot"${l.dotId && !inDrawer ? ` id="${escapeAttr(l.dotId)}"` : ''}${l.dot ? '' : ' hidden'}></span>` : ''}`;
        const a = `<a href="${escapeAttr(l.href || '#')}" class="ovnav-link${l.active ? ' active' : ''}"${attrs}>${inner}${kids.length && !inDrawer ? '<span class="ovnav-caret" aria-hidden="true">▾</span>' : ''}</a>`;
        if (!kids.length) return a;
        const menu = kids.map(k => `<a href="${escapeAttr(k.href || '#')}" class="ovnav-link ovnav-sublink"${k.id ? ` data-link-id="${escapeAttr(k.id)}"` : ''}${k.hidden ? ' hidden' : ''}>${k.icon ? `<span class="icon">${navIcon(k.icon)}</span>` : ''}<span class="ovnav-l">${escapeAttr(k.label)}</span></a>`).join('');
        return inDrawer ? a + menu : `<div class="ovnav-dd"${l.hidden ? ' hidden' : ''}>${a}<div class="ovnav-dd-menu">${menu}</div></div>`;
    }
    const flatLinks = (list) => list.reduce((out, l) => out.concat([l], Array.isArray(l.children) ? l.children : []), []);

    function currentLinks() {
        const list = _runtimeLinks || _config.links || SERVICE_LINKS[_config.service] || [];
        const path = (typeof location !== 'undefined' && location.pathname) || '/';
        const activePage = _activePage;
        return list.map((l) => Object.assign({}, l, { active: l.active !== undefined ? l.active : (activePage ? l.page === activePage : (l.href === path && path !== '/')) }));
    }

    let _activePage = null;   // setActive(): single-page apps tell the navbar where they are
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
        // A site may put state classes on the bar (Live's transparent hero mode). A re-render must not lose them.
        let carried = []; try { carried = Array.from((_navEl && _navEl.classList) || []).filter(c => c !== 'openvibe-navbar'); } catch { carried = []; }
        if (_navEl) _navEl.remove();

        const nav = document.createElement('nav');
        nav.className = 'openvibe-navbar';
        carried.forEach(c => { try { nav.classList.add(c); } catch { /* */ } });
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
                ${links.map(l => linkHTML(l, false)).join('')}
                ${networkLinksHTML(links)}
                ${u && u.role === 'admin' && _config.adminLink !== false && !flatLinks(links).some(l => l.id === 'admin') ? `<a href="https://openvibe.network/admin">${navIcon('fa-shield-halved')} Admin</a>` : ''}
            </div>
            <div class="openvibe-navbar-spacer"></div>
            <div class="openvibe-navbar-right">
                ${u ? chipsHTML(_config.chips) : ''}
                <div id="openvibe-bell-mount"></div>
                ${u ? avatarImg(u, 64, 'openvibe-navbar-avatar', 'openvibe-avatar-btn') :
                    `<a class="openvibe-navbar-login" id="openvibe-login-btn" href="${escapeAttr(loginHref)}">Sign In</a>`}
                ${links.length ? '<button type="button" class="ovnav-burger" id="openvibe-burger" aria-label="Menu" aria-haspopup="true" aria-expanded="false"><span></span><span></span><span></span></button>' : ''}
            </div>
            ${links.length ? `<div class="ovnav-drawer" id="openvibe-drawer" role="menu">${links.map(l => linkHTML(l, true)).join('')}<div class="ovnav-drawer-net">${networkLinksHTML(links, true)}</div></div>` : ''}
        `;
        if (_config.className) String(_config.className).split(/\s+/).filter(Boolean).forEach(c => nav.classList.add(c));
        bindLinks(nav, links);
        bindChips(nav);
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
            const menuCfg = _config.menu || {};
            const before = ((_config.menu && _config.menu.before) || []).concat(_runtimeMenu.before);
            const after = ((_config.menu && _config.menu.after) || []).concat(_runtimeMenu.after);

            dropdown.innerHTML = `
                <div class="openvibe-navbar-dropdown-header">
                    ${avatarImg(u, 72, '', '')}
                    <div class="info">
                        <div class="name">${escapeAttr(u.display_name || u.username)}</div>
                        <div class="email">${isAnon ? '' : '@' + escapeAttr(u.username || '')}</div>
                        ${menuCfg.headerChips ? `<div class="ud-chips">${chipsHTML(menuCfg.headerChips, 'ovnav-chip ovnav-chip--menu')}</div>` : '<div class="ud-wallet" id="openvibe-wallet" hidden></div>'}
                        ${isAnon ? `<div class="anon-tag">Anonymous #${u.anon_number || '?'}</div>` : ''}
                    </div>
                </div>
                <div class="openvibe-navbar-dropdown-accounts"${_config.accounts === false ? ' hidden' : ''}>
                    ${otherAccounts.map(a => `
                        <div class="account-item" data-account-id="${a.id}">
                            ${avatarImg(a, 48, '', '')}
                            <span>${a.display_name || a.username}${a.is_anon ? ' (anon)' : ''}</span>
                        </div>
                    `).join('')}
                    <div class="account-item" data-account-id="anon" style="${isAnon ? 'display:none' : ''}">
                        <span style="width:24px;text-align:center">${navIcon('fa-user-secret')}</span>
                        <span>Switch to Anonymous</span>
                    </div>
                    <a class="add-account" id="openvibe-add-account" href="${escapeAttr(addAccountHref)}">
                        <span style="width:24px;text-align:center">${navIcon('fa-plus')}</span>
                        <span>Add another account</span>
                    </a>
                </div>
                <div class="openvibe-navbar-dropdown-recent" id="openvibe-recent" hidden></div>
                <div class="openvibe-navbar-dropdown-menu">
                    ${before.length ? `<div class="ud-label">${escapeAttr((_config.menu && _config.menu.label) || brand.short || 'This site')}</div>${before.map(menuItemHTML).join('')}<div class="sep"></div>` : ''}
                    ${sectionsHTML(menuCfg.sections)}
                    ${menuCfg.defaults === false ? '' : `<div class="ud-label">You</div>
                    <a href="https://openvibe.network/my"><span class="icon">${navIcon('fa-user')}</span> My Account</a>
                    ${!isAnon && u.username ? `<a href="https://openvibe.live/@${escapeAttr(u.username)}"><span class="icon">${navIcon('fa-tower-broadcast')}</span> My Channel</a>` : ''}
                    <a href="https://openvibe.network/my#notifications"><span class="icon">${navIcon('fa-bell')}</span> Notifications</a>
                    <div class="sep"></div>`}
                    <div class="ud-label">Display</div>
                    <button type="button" data-ov-display="text"><span class="icon">${navIcon('fa-text-height')}</span> Text size <b class="ud-val"></b></button>
                    <button type="button" data-ov-display="motion"><span class="icon">${navIcon('fa-wand-magic-sparkles')}</span> Animations <b class="ud-val"></b></button>
                    <a href="https://openvibe.network/themes"><span class="icon">${navIcon('fa-palette')}</span> Themes</a>
                    <div class="sep"></div>
                    <div class="ud-label">Across OpenVibe</div>
                    ${acrossHTML()}
                    ${menuCfg.defaults === false ? '' : `
                    <a href="https://openvibe.network/my#history"><span class="icon">${navIcon('fa-clock-rotate-left')}</span> History</a>
                    <a href="https://openvibe.network/my#linked"><span class="icon">${navIcon('fa-link')}</span> Linked Services</a>
                    ${u.role === 'admin' ? `<a href="https://openvibe.network/admin"><span class="icon">${navIcon('fa-shield-halved')}</span> Admin Panel</a>` : ''}`}
                    ${after.length ? '<div class="sep"></div>' : ''}${after.map(menuItemHTML).join('')}
                    <div class="sep"></div>
                    <button id="openvibe-logout-btn" class="danger"><span class="icon">${navIcon('fa-right-from-bracket')}</span> Sign Out</button>
                </div>
            `;
            nav.appendChild(dropdown);
            bindMenuItems(dropdown, before.concat(after, sectionItems(menuCfg.sections)));
            bindChips(dropdown);
            if (typeof _config.onNavigate === 'function') dropdown.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (!a || e.defaultPrevented || a.target === '_blank' || e.metaKey || e.ctrlKey) return; let same = false; try { same = new URL(a.href, location.href).origin === location.origin; } catch { /* */ } if (same) { if (_config.onNavigate(a.getAttribute('href'), e) === false) e.preventDefault(); dropdown.classList.remove('open'); } });
            bindDisplayRows(dropdown);
            regPanel(dropdown, 'user-menu');
            if (_config.recent !== false) renderRecent(dropdown.querySelector('#openvibe-recent'));

            // Avatar click toggles dropdown
            nav.querySelector('#openvibe-avatar-btn').addEventListener('click', () => {
                dropdown.classList.toggle('open');
                if (dropdown.classList.contains('open')) { loadWallet(dropdown); dropdown.scrollTop = 0; if (root.OpenVibeIcons) root.OpenVibeIcons.mount(dropdown); else if (!document.getElementById('ov-icons-loader')) { const sc = document.createElement('script'); sc.id = 'ov-icons-loader'; sc.src = 'https://openvibe.network/shared/ov-icons.js'; sc.async = true; document.head.appendChild(sc); } }
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
            upgradeIconsWhenFontsReady();
            // Pages that hand us a resolved user (openvibe.network, the tools
            // gateway hub) keep full control. Everyone else — pages that pass
            // only a token, or nothing at all — gets the user resolved from
            // the shared SSO state (ov_token cookie / localStorage / optional
            // sessionUrl) and the navbar re-renders when it arrives.
            // auth: 'external' — the site signs people in itself (Live) and tells us with setUser().
            if (_config.auth === 'external') { if (_config.user) { recordHistory(); enableHandoff(); } }
            else if (!_config.user) refreshAuthState();
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

        /** The signed-in user changed (sites with auth: 'external'). Pass null for signed out. */
        setUser(user, token) { _config.user = user || null; if (token !== undefined) _config.token = token; _walletLoaded = false; return render(); },
        /** Single-page apps: mark the link whose `page` matches as active. */
        setActive(page) { _activePage = page || null; if (!_navEl) return; _navEl.querySelectorAll('.ovnav-link[data-page]').forEach(a => a.classList.toggle('active', a.getAttribute('data-page') === _activePage)); },
        /** Change a status chip's text (navbar and menu header): setChip('coins', '1,234'). */
        setChip(id, value, patch) {
            const lists = [_config.chips || [], (_config.menu && _config.menu.headerChips) || []];
            lists.forEach(l => l.forEach(c => { if (c && c.id === id) { c.value = value; if (patch) Object.assign(c, patch); } }));
            document.querySelectorAll(`[data-chip-id="${id}"]`).forEach(el => { const v = el.querySelector('.ovnav-chip-v'); if (v) v.textContent = value == null ? '' : String(value); if (patch && 'hidden' in patch) el.hidden = !!patch.hidden; });
        },
        /** Patch a top-level or dropdown link by id: updateLink('broadcast', { hidden: false, dot: true, label }). */
        updateLink(id, patch) {
            const list = _runtimeLinks || _config.links || [];
            const l = flatLinks(list).find(x => x && x.id === id); if (!l) return; Object.assign(l, patch || {});
            if (!_navEl) return;
            _navEl.querySelectorAll(`[data-link-id="${id}"]`).forEach(a => {
                if ('hidden' in patch) { a.hidden = !!patch.hidden; const dd = a.parentElement; if (dd && dd.classList.contains('ovnav-dd')) dd.hidden = !!patch.hidden; }
                if ('label' in patch) { const t = a.querySelector('.ovnav-l'); if (t) t.textContent = patch.label; }
                if ('href' in patch) a.setAttribute('href', patch.href);
                if ('dot' in patch) { const d = a.querySelector('.ovnav-dot'); if (d) d.hidden = !patch.dot; }
            });
        },
        /** Patch a custom menu item by id: updateMenuItem('admin', { hidden: false, value: '3' }). */
        updateMenuItem(id, patch) {
            const item = sectionItems(_config.menu && _config.menu.sections).find(x => x && x.id === id); if (item) Object.assign(item, patch || {});
            document.querySelectorAll(`.openvibe-navbar-dropdown [data-menu-id="${id}"]`).forEach(el => { if ('hidden' in patch) el.hidden = !!patch.hidden; if ('value' in patch) { const v = el.querySelector('.ud-val'); if (v) v.textContent = patch.value; } });
        },

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
