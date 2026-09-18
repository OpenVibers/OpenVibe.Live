'use strict';
// ═══════════════════════════════════════════════════════════════
// openvibe-shared/app-icon — one app icon design for every OpenVibe site.
//
// The icon is the OV mark as it appears in the navbar (ring, comet, white V, dot) on the network's
// deep navy, tinted per site. No text: a home-screen icon is a few millimetres wide.
//   svg({ site, maskable })   full-bleed square SVG. maskable keeps the mark inside the 40 % radius
//                             safe zone, so round, squircle and teardrop masks never clip it.
//   favicon({ site })         the same mark on a rounded tile, tuned for 16–32 px.
//   manifest({ site, name, shortName, description, startUrl })  web app manifest with shared colours.
//   SITES                     accent + dot colour per site (the dot is the one thing that differs,
//                             matching ov-mark.js variants: Live is "on air" red).
// PNG sets are rendered from these by scripts/build-app-icons.js.
// ═══════════════════════════════════════════════════════════════
const BG = '#0a0f1c', BG_EDGE = '#060912';
const SITES = {
    network: { accent: ['#60a5fa', '#2563eb'], dot: '#ffffff' },
    live: { accent: ['#60a5fa', '#2563eb'], dot: '#ef4444' },
    tools: { accent: ['#38bdf8', '#2563eb'], dot: '#ffffff' },
    community: { accent: ['#34d399', '#2563eb'], dot: '#ffffff' },
    games: { accent: ['#a78bfa', '#2563eb'], dot: '#facc15' },
    media: { accent: ['#fbbf24', '#2563eb'], dot: '#ffffff' },
};
const of = (site) => SITES[site] || SITES.network;

function mark(site, scale) {
    // Drawn in a 48-unit box centred on 0,0 (same geometry as ov-mark.js), then scaled.
    const c = of(site);
    return `<g transform="scale(${scale})">
<circle r="21" fill="url(#glow)"/>
<circle r="18" fill="none" stroke="url(#ring)" stroke-width="4" opacity=".38"/>
<path d="M0,-18 A18,18 0 0,1 17.4,4.6" fill="none" stroke="url(#ring)" stroke-width="4.4" stroke-linecap="round"/>
<path d="M-9.5,-7 L0,10 L9.5,-7" fill="none" stroke="#fff" stroke-width="4.8" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="17.4" cy="4.6" r="3.2" fill="${c.dot}"/></g>`;
}

function defs(site) {
    const [a, b] = of(site).accent;
    return `<defs><linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="${a}" stop-opacity=".34"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
<radialGradient id="bg" cx=".5" cy=".38" r=".8"><stop offset="0" stop-color="#16223a"/><stop offset=".6" stop-color="${BG}"/><stop offset="1" stop-color="${BG_EDGE}"/></radialGradient></defs>`;
}

/** Full-bleed square. `maskable`: mark radius ≤ 40 % of the half-width; otherwise it fills more of the tile. */
function svg({ site = 'network', maskable = true, size = 512 } = {}) {
    const scale = maskable ? 3.7 : 4.6;                       // 21u glow radius × 3.7 ≈ 78u of the 256u half-width… well inside 40 %
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-256 -256 512 512" width="${size}" height="${size}">${defs(site)}
<rect x="-256" y="-256" width="512" height="512" fill="url(#bg)"${maskable ? '' : ' rx="112"'}/>${mark(site, scale * (maskable ? 1.55 : 1.6))}</svg>`;
}

/** Small sizes: thicker strokes read better, and the tile is rounded because nothing masks a favicon. */
function favicon({ site = 'network' } = {}) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-32 -32 64 64">${defs(site)}<rect x="-32" y="-32" width="64" height="64" rx="15" fill="url(#bg)"/>${mark(site, 1.22)}</svg>`;
}

function manifest({ site = 'network', name, shortName, description, startUrl = '/', iconBase = '/assets' }) {
    const sizes = [72, 192, 512];
    return {
        name, short_name: shortName || name, description, start_url: startUrl, scope: '/', display: 'standalone',
        background_color: BG, theme_color: '#3b82f6',
        icons: [...sizes.map(s => ({ src: `${iconBase}/logo-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any' })),
            ...[192, 512].map(s => ({ src: `${iconBase}/logo-maskable-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'maskable' })),
            { src: `${iconBase}/logo.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    };
}

// First paint must never depend on another server. These two inline tags give every page the network's
// dark canvas and the visitor's cached theme immediately; theme-loader.js (deferred, from the Network)
// reconciles with the account afterwards. If the Network is slow or restarting, the page is still
// styled and readable instead of blank white.
const CRITICAL = `<style id="ov-critical">html{background:${BG};color:#e6edf7;color-scheme:dark}</style>`
    + `<script>(function(){try{var r=localStorage.getItem('ov_theme');if(!r)return;var t=JSON.parse(r),v=t&&t.variables;if(!v)return;var e=document.documentElement;for(var k in v)if(k.charAt(0)==='-')e.style.setProperty(k,v[k]);if(v['--bg-primary'])e.style.background=v['--bg-primary'];if(v['--text-primary'])e.style.color=v['--text-primary'];if(v['--color-scheme']==='light'||v['--color-scheme']==='dark')e.style.colorScheme=v['--color-scheme'];if(t.id)e.setAttribute('data-theme',t.id)}catch(_){}})();</script>`;

/** <head> tags every site shares: SVG favicon (inline, no request), theme colour, and the PNG touch icon when the site ships one. */
function headTags({ site = 'network', iconBase = null } = {}) {
    const uri = 'data:image/svg+xml,' + encodeURIComponent(favicon({ site })).replace(/'/g, '%27');
    return [`<link rel="icon" type="image/svg+xml" data-ov-icon="${String(site).replace(/[^a-z]/g, '')}" href="${uri}">`, '<meta name="theme-color" content="#0d131d">', '<meta name="color-scheme" content="dark">', CRITICAL,
        iconBase ? `<link rel="apple-touch-icon" href="${iconBase}/logo-192.png">` : '', iconBase ? `<link rel="manifest" href="/manifest.webmanifest">` : ''].filter(Boolean).join('\n');
}

module.exports = { svg, favicon, manifest, headTags, CRITICAL, SITES, BG };
