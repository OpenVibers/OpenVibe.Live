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
            .openvibe-navbar .ovnav-ic, .openvibe-navbar-dropdown .ovnav-ic { flex: none; font-size: 1.05em; vertical-align: -.15em; }
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
    const NAV_ICONS = {
        'fa-user': '<circle cx="12" cy="9" r="3.2"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/>',
        'fa-user-secret': '<path d="M4 11h16M7.5 11l1.2-5h6.6l1.2 5"/><circle cx="9" cy="15" r="2"/><circle cx="15" cy="15" r="2"/><path d="M11 15h2"/>',
        'fa-clock-rotate-left': '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5L4.5 8.8M4.5 4.8v4h4M12 8v4.2l2.8 1.8"/>',
        'fa-bell': '<path d="M6.5 16.5h11l-1.2-2V11a4.3 4.3 0 0 0-8.6 0v3.5zM10.5 19a1.6 1.6 0 0 0 3 0"/>',
        'fa-palette': '<path d="M12 4.5a7.5 7.5 0 1 0 0 15c1 0 1.6-.8 1.2-1.7-.5-1.1.3-2.3 1.5-2.3h1.6a3.2 3.2 0 0 0 3.2-3.2C19.5 8 16.2 4.5 12 4.5z"/><circle cx="8.5" cy="11" r=".7"/><circle cx="11.5" cy="8" r=".7"/><circle cx="15" cy="9" r=".7"/>',
        'fa-link': '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.700l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.700l1-1"/>',
        'fa-shield-halved': '<path d="M12 3.5l7 2.500v5.500c0 4.3-3 7.3-7 9-4-1.7-7-4.7-7-9V6zM12 3.500v17"/>',
        'fa-screwdriver-wrench': '<path d="M14.5 5.5a4 4 0 0 0-5.2 5.2L4.5 15.5a1.8 1.8 0 0 0 2.5 2.5l4.8-4.8a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.1-.5-.5-2.1z"/>',
        'fa-right-from-bracket': '<path d="M10 5H6.500A1.5 1.5 0 0 0 5 6.500v11A1.5 1.5 0 0 0 6.5 19H10M14 8l4 4-4 4M18 12H9.5"/>',
        'fa-tower-broadcast': '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
        'fa-text-height': '<path d="M4 7V5.5h9V7M8.5 5.5v13M6.5 18.5h4M18 6v12M15.5 8.5 18 6l2.5 2.5M15.5 15.5 18 18l2.5-2.5"/>',
        'fa-wand-magic-sparkles': '<path d="M5 19 15 9M13.5 7.5l3 3M17.5 4l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L15.5 6l1.4-.6zM7 5l.5 1.2 1.2.5-1.2.5L7 8.400l-.5-1.200L5.3 6.700l1.2-.5zM18.5 13l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z"/>',
        'fa-coins': '<ellipse cx="12" cy="7.5" rx="6.5" ry="3"/><path d="M5.5 7.5v4.500c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3V7.500M5.5 12v4.500c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3V12"/>',
        'fa-video': '<rect x="3.5" y="6.5" width="12" height="11" rx="2"/><path d="M15.5 10.5 20.5 8v8l-5-2.500z"/>',
        'fa-scissors': '<circle cx="6.5" cy="7.5" r="2.5"/><circle cx="6.5" cy="16.5" r="2.5"/><path d="M8.7 9 20 17M8.7 15 20 7"/>',
        'fa-comments': '<path d="M4 6.500h10a1.5 1.5 0 0 1 1.5 1.500v5a1.5 1.5 0 0 1-1.5 1.500H9l-3 2.500v-2.500H4A1.5 1.5 0 0 1 2.5 13V8A1.5 1.5 0 0 1 4 6.500zM18 10.500h2A1.5 1.5 0 0 1 21.5 12v4.500A1.5 1.5 0 0 1 20 18h-1v2.500L16 18h-4"/>',
        'fa-hand-fist': '<path d="M7 11V8a1.5 1.5 0 0 1 3 0v2M10 9.500V7a1.5 1.5 0 0 1 3 0v3M13 9.500V8a1.5 1.5 0 0 1 3 0v3M16 10.500a1.5 1.5 0 0 1 3 0V14a5.5 5.5 0 0 1-5.5 5.500h-2A5.5 5.5 0 0 1 6 14v-1.500a1.5 1.5 0 0 1 3 0"/>',
        'fa-gamepad': '<path d="M7 9h10a4 4 0 0 1 3.9 4.900l-.6 2.600a2 2 0 0 1-3.5.8L15.5 16h-7l-1.3 1.300a2 2 0 0 1-3.5-.8l-.6-2.600A4 4 0 0 1 7 9zM8 11.500v3M6.5 13h3"/><circle cx="15.5" cy="12" r=".6"/><circle cx="17.5" cy="14" r=".6"/>',
        'fa-list-check': '<path d="M4 7l1.5 1.500L8 6M4 12.5 5.5 14 8 11.500M11 7.500h9M11 13h9M4.5 18.500h.01M11 18.500h9"/>',
        'fa-id-card': '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 15.500a3 3 0 0 1 6 0M14.5 10h3.500M14.5 13.500h3.5"/>',
        'fa-shirt': '<path d="M8.5 4.5 4 7l1.5 3.500L7.5 10v9.500h9V10l2 .5L20 7l-4.5-2.500a3.5 3.5 0 0 1-7 0z"/>',
        'fa-camera': '<path d="M4 8.500h3l1.5-2.500h7L17 8.500h3A1.5 1.5 0 0 1 21.5 10v8A1.5 1.5 0 0 1 20 19.500H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.500z"/><circle cx="12" cy="13.5" r="3.2"/>',
        'fa-book': '<path d="M6 4.500h12v15H6.500A1.5 1.5 0 0 1 5 18V5.500a1 1 0 0 1 1-1zM5 17.500A1.5 1.5 0 0 1 6.5 16H18M9 8.500h6"/>',
        'fa-wallet': '<path d="M4.5 7.500A1.5 1.5 0 0 1 6 6h11.500v3M4.5 7.500V17A1.5 1.5 0 0 0 6 18.500h12.500A1.5 1.5 0 0 0 20 17V10.500A1.5 1.5 0 0 0 18.5 9H6a1.5 1.5 0 0 1-1.5-1.500z"/><circle cx="16.5" cy="13.7" r=".8"/>',
        'fa-people-arrows': '<circle cx="6" cy="8" r="2"/><circle cx="18" cy="8" r="2"/><path d="M3 17a3 3 0 0 1 6 0M15 17a3 3 0 0 1 6 0M9.5 12h5M12.5 10l2 2-2 2M11.5 10l-2 2 2 2"/>',
        'fa-network-wired': '<rect x="9" y="3.5" width="6" height="4.5" rx="1"/><rect x="3" y="16" width="6" height="4.5" rx="1"/><rect x="15" y="16" width="6" height="4.5" rx="1"/><path d="M12 8v4M6 16v-2.500h12V16"/>',
        'fa-people-group': '<circle cx="9" cy="9" r="2.6"/><circle cx="16.5" cy="10" r="2"/><path d="M3.8 18.500a5.2 5.2 0 0 1 10.4 0M14.6 14.200a4 4 0 0 1 5.6 3.8"/>',
        'fa-plus': '<path d="M12 5.500v13M5.5 12h13"/>',
        'fa-paste': '<rect x="6" y="6" width="12" height="14" rx="1.8"/><path d="M9.5 6V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1M9 11h6M9 14h6"/>',
        'fa-house': '<path d="M4.5 11.5 12 5l7.5 6.500M6.5 10v8.500h11V10"/>',
        'fa-gauge-high': '<path d="M4.5 17a8 8 0 1 1 15 0M12 13l3.5-4"/><circle cx="12" cy="13.5" r="1.3"/>',
    };
    function navIcon(cls) {
        const key = String(cls || '').split(/\s+/).find(c => NAV_ICONS[c]);
        if (!key) return cls ? `<i class="fa-solid ${escapeAttr(cls)}"></i>` : '';
        return `<svg class="ovnav-ic" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${NAV_ICONS[key]}</svg>`;
    }

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
