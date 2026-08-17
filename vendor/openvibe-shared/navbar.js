// ═══════════════════════════════════════════════════════════════
// OpenVibe — Universal Navbar
// Consistent top bar across all services with logo, navigation,
// notification bell, account switcher, and theme-aware styling.
// Usage: OpenVibeNavbar.init({ service, token, user, apiBase })
// ═══════════════════════════════════════════════════════════════

(function (root) {
    'use strict';

    let _config = { service: 'network', token: null, user: null, apiBase: 'https://openvibe.network', onLogin: null, onLogout: null };
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
            .openvibe-navbar-brand { display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; margin-right: 8px; }
            .openvibe-navbar-brand .flame { font-size: 18px; color: var(--accent, #8b5cf6); }
            .openvibe-navbar-brand .name { font-size: 15px; font-weight: 700; letter-spacing: -.3px; }
            .openvibe-navbar-brand .service-name { font-size: 11px; color: var(--accent-light, #a78bfa); font-weight: 500; letter-spacing: .5px; text-transform: uppercase; }

            .openvibe-navbar-links { display: flex; align-items: center; gap: 4px; margin-left: 8px; }
            .openvibe-navbar-links a {
                padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 500;
                color: var(--text-secondary, #b0b0b8); text-decoration: none;
                transition: all .15s;
            }
            .openvibe-navbar-links a:hover { background: var(--bg-hover, #2f2f3d); color: var(--text-primary, #e0e0e0); }
            .openvibe-navbar-links a.active { background: var(--bg-tertiary, #2a2a38); color: var(--accent-light, #a78bfa); }

            .openvibe-navbar-spacer { flex: 1; }

            .openvibe-navbar-right { display: flex; align-items: center; gap: 6px; }

            .openvibe-navbar-avatar {
                width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
                border: 2px solid var(--border, #333340); transition: border-color .2s;
                object-fit: cover;
            }
            .openvibe-navbar-avatar:hover { border-color: var(--accent, #8b5cf6); }

            .openvibe-navbar-login {
                padding: 6px 16px; border-radius: 6px; font-size: 13px; font-weight: 600;
                background: var(--accent, #8b5cf6); color: #fff; border: none; cursor: pointer;
                transition: background .15s; text-decoration: none; display: inline-flex; align-items: center;
            }
            .openvibe-navbar-login:hover { background: var(--accent-dark, #6d28d9); }

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
            .openvibe-navbar-dropdown-header .info .anon-tag { font-size: 10px; color: var(--accent-light, #a78bfa); }

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
            .openvibe-navbar-dropdown-accounts .account-item.active { color: var(--accent-light, #a78bfa); font-weight: 600; }
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
                background: rgba(139,92,246,0.1); color: var(--accent-light, #a78bfa);
                font-weight: 500; cursor: pointer; border: 1px solid transparent;
                transition: all .15s;
            }
            .openvibe-navbar .openvibe-network-badge:hover { border-color: var(--accent-dark, #6d28d9); }

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

    function escapeAttr(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    function getAvatarInitial(user) {
        const source = user?.display_name || user?.username || 'O';
        return String(source).trim().charAt(0).toUpperCase() || 'O';
    }

    function makeAvatarPlaceholder(user, size = 64) {
        const initial = getAvatarInitial(user);
        const bg = user?.profile_color || '#8b5cf6';
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

    function render() {
        if (_navEl) _navEl.remove();

        const nav = document.createElement('nav');
        nav.className = 'openvibe-navbar';
        const svc = _config.service;
        const links = SERVICE_LINKS[svc] || [];

        // Resolve brand name + icon: config override > subdomain lookup > service defaults
        const host = (typeof location !== 'undefined' && location.hostname) || '';
        // Exact match first (e.g., hostname.openvibe.tools), then fallback to service name
        let subBrand = SUBDOMAIN_BRANDS[host];
        if (!subBrand && host && host.includes('.openvibe.tools')) {
            // Try matching against service names
            const parts = host.split('.');
            const potential = parts[0]; // e.g., 'json' from 'json.openvibe.tools'
            subBrand = SUBDOMAIN_BRANDS[`${potential}.openvibe.tools`];
        }
        const svcName = _config.brandName || (subBrand && subBrand.name) || SERVICE_NAMES[svc] || 'OpenVibe';
        const svcIcon = _config.brandIcon || (subBrand && subBrand.icon) || SERVICE_ICONS[svc] || 'fa-circle-nodes';

        const brandHref = '/';

        const u = _config.user;
        const accounts = getAccounts();
        const isAnon = u && u.is_anon;
        const loginHref = `https://openvibe.network/login?return=${encodeURIComponent(window.location.href)}`;
        const addAccountHref = `https://openvibe.network/login?add_account=1&return=${encodeURIComponent(window.location.href)}`;

        nav.innerHTML = `
            <a class="openvibe-navbar-brand" href="${brandHref}">
                <span class="flame"><i class="fa-solid ${svcIcon}"></i></span>
                <div>
                    <div class="name">${svcName}</div>
                </div>
            </a>
            <div class="openvibe-navbar-links">
                ${links.map(l => `<a href="${l.href}">${l.label}</a>`).join('')}
                ${u && u.role === 'admin' ? `<a href="https://openvibe.network/admin"><i class="fa-solid fa-shield-halved"></i> Admin</a>` : ''}
            </div>
            <div class="openvibe-navbar-spacer"></div>
            <div class="openvibe-navbar-right">
                <a class="openvibe-network-badge" href="https://openvibe.network" title="Connected to OpenVibe"><i class="fa-solid fa-circle-nodes"></i> OpenVibe</a>
                <div id="openvibe-bell-mount"></div>
                ${u ? avatarImg(u, 64, 'openvibe-navbar-avatar', 'openvibe-avatar-btn') :
                    `<a class="openvibe-navbar-login" id="openvibe-login-btn" href="${escapeAttr(loginHref)}">Sign In</a>`}
            </div>
        `;

        // Dropdown
        if (u) {
            const dropdown = document.createElement('div');
            dropdown.className = 'openvibe-navbar-dropdown';
            dropdown.id = 'openvibe-user-dropdown';

            const otherAccounts = accounts.filter(a => isAnon ? !a.is_anon : String(a.id) !== String(u.id));

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
                <div class="openvibe-navbar-dropdown-menu">
                    <a href="https://openvibe.network/my"><span class="icon"><i class="fa-solid fa-user"></i></span> My Account</a>
                    <a href="https://openvibe.network/my#notifications"><span class="icon"><i class="fa-solid fa-bell"></i></span> Notification Settings</a>
                    <a href="https://openvibe.network/themes"><span class="icon"><i class="fa-solid fa-palette"></i></span> Themes</a>
                    <a href="https://openvibe.network/my#linked"><span class="icon"><i class="fa-solid fa-link"></i></span> Linked Services</a>
                    ${u.role === 'admin' ? `<a href="https://openvibe.network/admin"><span class="icon"><i class="fa-solid fa-screwdriver-wrench"></i></span> Admin Panel</a>` : ''}
                    <div style="height:1px;background:var(--border,#333340);margin:4px -8px"></div>
                    <button id="openvibe-logout-btn" class="danger"><span class="icon"><i class="fa-solid fa-right-from-bracket"></i></span> Sign Out</button>
                </div>
            `;
            nav.appendChild(dropdown);

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
                    document.cookie = 'ov_token=;path=/;max-age=0';
                    document.cookie = 'ov_token=;path=/;max-age=0;domain=.openvibe.tools';
                    localStorage.removeItem('ov_token');
                    localStorage.removeItem('openvibe_anon_token');
                    localStorage.removeItem('openvibe_active_account');
                    window.location.reload();
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
            return render();
        },

        /** Update user (after account switch). */
        setUser(user) {
            _config.user = user;
            render();
        },

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
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = OpenVibeNavbar;
    else root.OpenVibeNavbar = OpenVibeNavbar;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
