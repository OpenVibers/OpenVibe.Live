// ═══════════════════════════════════════════════════════════════
// OpenVibe — Theme Loader (Browser)
// Synchronous theme application from cookie/localStorage.
// Load this BEFORE navbar.js to prevent FOUC.
// Sets CSS custom properties on <html> from the user's theme.
// ═══════════════════════════════════════════════════════════════

(function (root) {
    'use strict';

    const COOKIE_NAME = 'ov_theme_id';
    const STORAGE_KEY = 'ov_theme';
    // The user's theme is owned centrally by openvibe.network, so EVERY app (openvibe.live,
    // openvibe.tools + subdomains, openvibe.games, openvibe.media) fetches it from there —
    // that's what makes the theme chosen at openvibe.network/themes sync everywhere.
    // Apps may override via init({apiBase}).
    const DEFAULT_API_BASE = 'https://openvibe.network';
    let _config = { apiBase: DEFAULT_API_BASE };

    // ── Condensed built-in theme variable maps ───────────────
    // Kept in sync with packages/openvibe-shared/builtin-themes.js
    const THEMES = {
        'vibe': { '--bg-primary':'#0d0d0f','--bg-secondary':'#16161a','--bg-tertiary':'#1e1e24','--bg-card':'#1a1a20','--bg-hover':'#242430','--bg-input':'#12121a','--text-primary':'#e8e6e3','--text-secondary':'#9a9a9a','--text-muted':'#666','--accent':'#8b5cf6','--accent-light':'#a78bfa','--accent-dark':'#6d28d9','--border':'#2a2a32','--border-light':'#3a3a44','--live-red':'#e74c3c','--success':'#2ecc71','--warning':'#f39c12','--danger':'#e74c3c','--info':'#3498db','--shadow':'0 2px 12px rgba(0,0,0,0.4)','--shadow-lg':'0 8px 32px rgba(0,0,0,0.6)' },
        'midnight': { '--bg-primary':'#0a0e17','--bg-secondary':'#111827','--bg-tertiary':'#1a2235','--bg-card':'#151d2e','--bg-hover':'#1e2a42','--bg-input':'#0d1220','--text-primary':'#e2e8f0','--text-secondary':'#94a3b8','--text-muted':'#64748b','--accent':'#6366f1','--accent-light':'#818cf8','--accent-dark':'#4f46e5','--border':'#1e293b','--border-light':'#334155' },
        'forest': { '--bg-primary':'#0a120a','--bg-secondary':'#121e12','--bg-tertiary':'#1a2a1a','--bg-card':'#152015','--bg-hover':'#1e3420','--bg-input':'#0d160d','--text-primary':'#d4e8d4','--text-secondary':'#8aaa8a','--text-muted':'#5a7a5a','--accent':'#4ade80','--accent-light':'#86efac','--accent-dark':'#22c55e','--border':'#1a3a1a','--border-light':'#2a4a2a' },
        'neon-tokyo': { '--bg-primary':'#0a0a0f','--bg-secondary':'#12101a','--bg-tertiary':'#1a1625','--bg-card':'#15111f','--bg-hover':'#221a32','--bg-input':'#0d0b14','--text-primary':'#f0e6ff','--text-secondary':'#b4a0d0','--text-muted':'#6a5a80','--accent':'#ff006e','--accent-light':'#ff4d94','--accent-dark':'#c9005a','--border':'#2a1a3a','--border-light':'#3a2a4a' },
        'dracula': { '--bg-primary':'#282a36','--bg-secondary':'#1e1f29','--bg-tertiary':'#343746','--bg-card':'#2c2e3c','--bg-hover':'#3a3d50','--bg-input':'#21222c','--text-primary':'#f8f8f2','--text-secondary':'#bfbfb2','--text-muted':'#6272a4','--accent':'#bd93f9','--accent-light':'#d4b8ff','--accent-dark':'#9b6ddb','--border':'#44475a','--border-light':'#565970','--success':'#50fa7b','--danger':'#ff5555','--warning':'#f1fa8c','--info':'#8be9fd','--live-red':'#ff5555' },
        'monokai': { '--bg-primary':'#272822','--bg-secondary':'#1e1f1c','--bg-tertiary':'#3e3d32','--bg-card':'#2d2e27','--bg-hover':'#49483e','--bg-input':'#22231e','--text-primary':'#f8f8f2','--text-secondary':'#cfcfc2','--text-muted':'#75715e','--accent':'#a6e22e','--accent-light':'#c4ff50','--accent-dark':'#7dac1c','--border':'#49483e','--border-light':'#5b5a50','--danger':'#f92672','--warning':'#e6db74','--info':'#66d9ef' },
        'ocean-deep': { '--bg-primary':'#0a1215','--bg-secondary':'#0f1a1f','--bg-tertiary':'#162228','--bg-card':'#121c22','--bg-hover':'#1a2a32','--bg-input':'#0c1418','--text-primary':'#d0e8ef','--text-secondary':'#7aa8ba','--text-muted':'#4a7080','--accent':'#00bcd4','--accent-light':'#4dd0e1','--accent-dark':'#0097a7','--border':'#1a3040','--border-light':'#2a4050' },
        'sunset': { '--bg-primary':'#120a0a','--bg-secondary':'#1a1010','--bg-tertiary':'#241616','--bg-card':'#1e1212','--bg-hover':'#2e1a1a','--bg-input':'#140c0c','--text-primary':'#ffe8e0','--text-secondary':'#c49080','--text-muted':'#7a5a50','--accent':'#ff6b35','--accent-light':'#ff8f5e','--accent-dark':'#d04a1a','--border':'#3a2020','--border-light':'#4a3030' },
        'arctic': { '--bg-primary':'#0c1220','--bg-secondary':'#101828','--bg-tertiary':'#182030','--bg-card':'#141c2a','--bg-hover':'#1e2840','--bg-input':'#0e1422','--text-primary':'#e0eaf5','--text-secondary':'#8aa0c0','--text-muted':'#5a708a','--accent':'#38bdf8','--accent-light':'#7dd3fc','--accent-dark':'#0284c7','--border':'#1e3050','--border-light':'#2a4060' },
        'ember': { '--bg-primary':'#120808','--bg-secondary':'#1a0e0e','--bg-tertiary':'#241414','--bg-card':'#1e1010','--bg-hover':'#2e1818','--bg-input':'#140a0a','--text-primary':'#f0dada','--text-secondary':'#b0808a','--text-muted':'#6a4a50','--accent':'#ef4444','--accent-light':'#f87171','--accent-dark':'#b91c1c','--border':'#3a1a20','--border-light':'#4a2a30' },
        'vapor': { '--bg-primary':'#0e0a14','--bg-secondary':'#14101c','--bg-tertiary':'#1c1628','--bg-card':'#181220','--bg-hover':'#241a34','--bg-input':'#100c16','--text-primary':'#f0e0ff','--text-secondary':'#c090e0','--text-muted':'#7050a0','--accent':'#e040fb','--accent-light':'#ea80fc','--accent-dark':'#aa00d4','--border':'#2a1a40','--border-light':'#3a2a50','--info':'#00e5ff','--success':'#69f0ae' },
        'slate': { '--bg-primary':'#0f1118','--bg-secondary':'#161820','--bg-tertiary':'#1e2028','--bg-card':'#1a1c24','--bg-hover':'#24262e','--bg-input':'#12141c','--text-primary':'#e4e6ea','--text-secondary':'#a0a4b0','--text-muted':'#606470','--accent':'#a78bfa','--accent-light':'#c4b5fd','--accent-dark':'#7c3aed','--border':'#2a2c38','--border-light':'#3a3c48' },
        'matrix': { '--bg-primary':'#000000','--bg-secondary':'#050a05','--bg-tertiary':'#0a140a','--bg-card':'#071007','--bg-hover':'#0e1e0e','--bg-input':'#030803','--text-primary':'#00ff41','--text-secondary':'#00b030','--text-muted':'#005a18','--accent':'#00ff41','--accent-light':'#66ff8a','--accent-dark':'#00aa2a','--border':'#0a2a0a','--border-light':'#144014' },
        'nord': { '--bg-primary':'#2e3440','--bg-secondary':'#272c36','--bg-tertiary':'#3b4252','--bg-card':'#333a48','--bg-hover':'#434c5e','--bg-input':'#2a303c','--text-primary':'#eceff4','--text-secondary':'#d8dee9','--text-muted':'#7b88a1','--accent':'#88c0d0','--accent-light':'#8fbcbb','--accent-dark':'#5e81ac','--border':'#3b4252','--border-light':'#4c566a','--success':'#a3be8c','--danger':'#bf616a','--warning':'#ebcb8b','--info':'#81a1c1' },
        'gruvbox-dark': { '--bg-primary':'#1d2021','--bg-secondary':'#282828','--bg-tertiary':'#3c3836','--bg-card':'#32302f','--bg-hover':'#504945','--bg-input':'#242424','--text-primary':'#ebdbb2','--text-secondary':'#d5c4a1','--text-muted':'#928374','--accent':'#fabd2f','--accent-light':'#fce566','--accent-dark':'#d79921','--border':'#3c3836','--border-light':'#504945','--success':'#b8bb26','--danger':'#fb4934','--warning':'#fe8019','--info':'#83a598' },
        'abyss': { '--bg-primary':'#000000','--bg-secondary':'#080808','--bg-tertiary':'#111111','--bg-card':'#0a0a0a','--bg-hover':'#181818','--bg-input':'#050505','--text-primary':'#cccccc','--text-secondary':'#888888','--text-muted':'#444444','--accent':'#ffffff','--accent-light':'#ffffff','--accent-dark':'#aaaaaa','--border':'#1a1a1a','--border-light':'#252525' },
        'copper': { '--bg-primary':'#110d09','--bg-secondary':'#1a140e','--bg-tertiary':'#231c14','--bg-card':'#1e1710','--bg-hover':'#2c2218','--bg-input':'#13100b','--text-primary':'#e8ddd0','--text-secondary':'#b49a80','--text-muted':'#7a6a54','--accent':'#cd7f32','--accent-light':'#daa060','--accent-dark':'#a06020','--border':'#2a2016','--border-light':'#3a3020' },
        'sakura-night': { '--bg-primary':'#0e0a14','--bg-secondary':'#150f1c','--bg-tertiary':'#1c1526','--bg-card':'#181020','--bg-hover':'#221830','--bg-input':'#100c16','--text-primary':'#f0e0f0','--text-secondary':'#c0a0c0','--text-muted':'#7a5a7a','--accent':'#f472b6','--accent-light':'#f9a8d4','--accent-dark':'#db2777','--border':'#2a1a30','--border-light':'#3a2a40' },
        'hacker': { '--bg-primary':'#000000','--bg-secondary':'#0a0800','--bg-tertiary':'#141000','--bg-card':'#0e0c00','--bg-hover':'#1c1800','--bg-input':'#060400','--text-primary':'#ffb000','--text-secondary':'#cc8d00','--text-muted':'#664700','--accent':'#ffb000','--accent-light':'#ffd050','--accent-dark':'#cc8d00','--border':'#1a1400','--border-light':'#2a2200' },
        'daylight': { '--bg-primary':'#ffffff','--bg-secondary':'#f7f7f8','--bg-tertiary':'#eeeef0','--bg-card':'#ffffff','--bg-hover':'#f0f0f2','--bg-input':'#f5f5f7','--text-primary':'#1a1a2e','--text-secondary':'#4a4a6a','--text-muted':'#9a9ab0','--accent':'#8b5cf6','--accent-light':'#a78bfa','--accent-dark':'#6d28d9','--border':'#e0e0e6','--border-light':'#d0d0d8','--shadow':'0 2px 12px rgba(0,0,0,0.08)','--shadow-lg':'0 8px 32px rgba(0,0,0,0.12)' },
        'paper': { '--bg-primary':'#faf8f5','--bg-secondary':'#f0ece6','--bg-tertiary':'#e8e2d8','--bg-card':'#faf8f5','--bg-hover':'#f0ece6','--bg-input':'#f5f2ed','--text-primary':'#2c2416','--text-secondary':'#5a4e3e','--text-muted':'#9a8e7e','--accent':'#8b6914','--accent-light':'#b08a30','--accent-dark':'#6a5010','--border':'#ddd6c8','--border-light':'#ccc4b0','--shadow':'0 2px 12px rgba(60,40,0,0.06)','--shadow-lg':'0 8px 32px rgba(60,40,0,0.10)' },
        'cloud': { '--bg-primary':'#f0f5ff','--bg-secondary':'#e8eef8','--bg-tertiary':'#dde5f0','--bg-card':'#f5f8ff','--bg-hover':'#e4ecf8','--bg-input':'#edf2fa','--text-primary':'#1a2040','--text-secondary':'#4a5070','--text-muted':'#8a90aa','--accent':'#3b82f6','--accent-light':'#60a5fa','--accent-dark':'#2563eb','--border':'#d0d8ea','--border-light':'#bcc8e0','--shadow':'0 2px 12px rgba(0,20,60,0.06)','--shadow-lg':'0 8px 32px rgba(0,20,60,0.10)' },
        'meadow': { '--bg-primary':'#f2f8f0','--bg-secondary':'#e8f0e4','--bg-tertiary':'#dce8d6','--bg-card':'#f5faf2','--bg-hover':'#e4f0de','--bg-input':'#edf5ea','--text-primary':'#1a2e16','--text-secondary':'#3a5a32','--text-muted':'#7a9a6e','--accent':'#16a34a','--accent-light':'#22c55e','--accent-dark':'#15803d','--border':'#c8dcc0','--border-light':'#b0ccaa','--shadow':'0 2px 12px rgba(0,40,0,0.06)','--shadow-lg':'0 8px 32px rgba(0,40,0,0.10)' },
        'peach': { '--bg-primary':'#fff5f0','--bg-secondary':'#fbeae2','--bg-tertiary':'#f5ddd2','--bg-card':'#fff7f2','--bg-hover':'#fce8dc','--bg-input':'#fdf0ea','--text-primary':'#2e1a14','--text-secondary':'#6a4438','--text-muted':'#aa8070','--accent':'#f97316','--accent-light':'#fb923c','--accent-dark':'#ea580c','--border':'#f0d0c0','--border-light':'#e4bfab','--shadow':'0 2px 12px rgba(60,20,0,0.06)','--shadow-lg':'0 8px 32px rgba(60,20,0,0.10)' },
        'lavender': { '--bg-primary':'#f8f5ff','--bg-secondary':'#f0eaf8','--bg-tertiary':'#e6ddf0','--bg-card':'#faf7ff','--bg-hover':'#eee6f8','--bg-input':'#f4f0fa','--text-primary':'#1e1430','--text-secondary':'#4a3a60','--text-muted':'#9080aa','--accent':'#8b5cf6','--accent-light':'#a78bfa','--accent-dark':'#7c3aed','--border':'#ddd0ee','--border-light':'#ccc0dd','--shadow':'0 2px 12px rgba(40,0,60,0.06)','--shadow-lg':'0 8px 32px rgba(40,0,60,0.10)' },
        'gruvbox-light': { '--bg-primary':'#fbf1c7','--bg-secondary':'#f2e5bc','--bg-tertiary':'#ebdbb2','--bg-card':'#fbf1c7','--bg-hover':'#f2e5bc','--bg-input':'#f5ecc4','--text-primary':'#3c3836','--text-secondary':'#504945','--text-muted':'#928374','--accent':'#d65d0e','--accent-light':'#fe8019','--accent-dark':'#af3a03','--border':'#d5c4a1','--border-light':'#bdae93','--success':'#98971a','--danger':'#cc241d','--warning':'#d79921','--info':'#458588','--shadow':'0 2px 12px rgba(40,30,0,0.08)','--shadow-lg':'0 8px 32px rgba(40,30,0,0.12)' },
        'snow': { '--bg-primary':'#ffffff','--bg-secondary':'#f8fafc','--bg-tertiary':'#f1f5f9','--bg-card':'#ffffff','--bg-hover':'#f1f5f9','--bg-input':'#f8fafc','--text-primary':'#0f172a','--text-secondary':'#334155','--text-muted':'#94a3b8','--accent':'#0ea5e9','--accent-light':'#38bdf8','--accent-dark':'#0284c7','--border':'#e2e8f0','--border-light':'#cbd5e1','--shadow':'0 2px 12px rgba(0,0,0,0.05)','--shadow-lg':'0 8px 32px rgba(0,0,0,0.08)' },
        'sand': { '--bg-primary':'#f8f4ef','--bg-secondary':'#f0e8de','--bg-tertiary':'#e8ddd0','--bg-card':'#faf6f0','--bg-hover':'#f0e8de','--bg-input':'#f5f0e8','--text-primary':'#2e2418','--text-secondary':'#5a4e3e','--text-muted':'#9a8e7e','--accent':'#b8860b','--accent-light':'#daa520','--accent-dark':'#8b6508','--border':'#ddd0be','--border-light':'#ccc0aa','--shadow':'0 2px 12px rgba(60,40,0,0.06)','--shadow-lg':'0 8px 32px rgba(60,40,0,0.10)' },
        'rose': { '--bg-primary':'#fff5f7','--bg-secondary':'#fce7ec','--bg-tertiary':'#f5d5de','--bg-card':'#fff7f9','--bg-hover':'#fce0e8','--bg-input':'#fdeef2','--text-primary':'#2e1420','--text-secondary':'#6a3850','--text-muted':'#aa7090','--accent':'#e11d48','--accent-light':'#f43f5e','--accent-dark':'#be123c','--border':'#f0c8d4','--border-light':'#e4b0c0','--shadow':'0 2px 12px rgba(60,0,20,0.06)','--shadow-lg':'0 8px 32px rgba(60,0,20,0.10)' },
        'solarized-dark': { '--bg-primary':'#002b36','--bg-secondary':'#073642','--bg-tertiary':'#0a3f4e','--bg-card':'#053542','--bg-hover':'#0d4a58','--bg-input':'#01303d','--text-primary':'#fdf6e3','--text-secondary':'#93a1a1','--text-muted':'#586e75','--accent':'#b58900','--accent-light':'#d4a017','--accent-dark':'#8a6a00','--border':'#0a4050','--border-light':'#105060','--success':'#859900','--danger':'#dc322f','--warning':'#cb4b16','--info':'#268bd2' },
        'solarized-light': { '--bg-primary':'#fdf6e3','--bg-secondary':'#eee8d5','--bg-tertiary':'#e4ddc6','--bg-card':'#fdf6e3','--bg-hover':'#eee8d5','--bg-input':'#f5eedb','--text-primary':'#002b36','--text-secondary':'#586e75','--text-muted':'#93a1a1','--accent':'#b58900','--accent-light':'#d4a017','--accent-dark':'#8a6a00','--border':'#d6ceb5','--border-light':'#c8c0a5','--success':'#859900','--danger':'#dc322f','--warning':'#cb4b16','--info':'#268bd2','--shadow':'0 2px 12px rgba(0,30,40,0.08)','--shadow-lg':'0 8px 32px rgba(0,30,40,0.12)' },
        'catppuccin-mocha': { '--bg-primary':'#1e1e2e','--bg-secondary':'#181825','--bg-tertiary':'#313244','--bg-card':'#1e1e2e','--bg-hover':'#313244','--bg-input':'#1a1a2c','--text-primary':'#cdd6f4','--text-secondary':'#bac2de','--text-muted':'#6c7086','--accent':'#cba6f7','--accent-light':'#dcc0ff','--accent-dark':'#b07de0','--border':'#313244','--border-light':'#45475a','--success':'#a6e3a1','--danger':'#f38ba8','--warning':'#fab387','--info':'#89b4fa','--live-red':'#f38ba8' },
        'catppuccin-latte': { '--bg-primary':'#eff1f5','--bg-secondary':'#e6e9ef','--bg-tertiary':'#dce0e8','--bg-card':'#eff1f5','--bg-hover':'#dce0e8','--bg-input':'#e8ebf0','--text-primary':'#4c4f69','--text-secondary':'#5c5f77','--text-muted':'#9ca0b0','--accent':'#8839ef','--accent-light':'#a05cff','--accent-dark':'#7028d4','--border':'#ccd0da','--border-light':'#bcc0cc','--success':'#40a02b','--danger':'#d20f39','--warning':'#fe640b','--info':'#1e66f5','--live-red':'#d20f39','--shadow':'0 2px 12px rgba(0,0,0,0.06)','--shadow-lg':'0 8px 32px rgba(0,0,0,0.10)' },
        'high-contrast': { '--bg-primary':'#000000','--bg-secondary':'#0a0a0a','--bg-tertiary':'#1a1a1a','--bg-card':'#0f0f0f','--bg-hover':'#222222','--bg-input':'#0a0a0a','--text-primary':'#ffffff','--text-secondary':'#f0f0f0','--text-muted':'#aaaaaa','--accent':'#ffd700','--accent-light':'#ffed4a','--accent-dark':'#ccac00','--border':'#444444','--border-light':'#666666','--live-red':'#ff0000','--success':'#00ff00','--warning':'#ffff00','--danger':'#ff0000','--info':'#00ffff' },
    };

    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function setCookie(name, value, days) {
        const maxAge = days * 24 * 60 * 60;
        const encoded = encodeURIComponent(value);
        const host = (typeof location !== 'undefined' && location.hostname) || '';
        // Cookie policy (CONTRACTS.md): a Domain=.openvibe.tools cookie is set ONLY
        // when actually running on openvibe.tools or one of its subdomains, so the
        // theme follows the user across the tool satellites. Everywhere else
        // (openvibe.network, openvibe.live, openvibe.games, localhost, ...) the
        // cookie is host-only — NO Domain attribute.
        if (host && (host.endsWith('.openvibe.tools') || host === 'openvibe.tools')) {
            document.cookie = `${name}=${encoded};path=/;max-age=${maxAge};domain=.openvibe.tools;SameSite=Lax;Secure`;
        } else {
            const secure = (typeof location !== 'undefined' && location.protocol === 'https:') ? ';Secure' : '';
            document.cookie = `${name}=${encoded};path=/;max-age=${maxAge};SameSite=Lax${secure}`;
        }
    }

    /**
     * Apply a theme's CSS variables to document.documentElement.
     * If themeId is not found in the built-in map, does nothing.
     */
    function applyById(themeId) {
        const vars = THEMES[themeId];
        if (!vars) return false;
        const el = document.documentElement;
        for (const [prop, val] of Object.entries(vars)) {
            el.style.setProperty(prop, val);
        }
        return true;
    }

    /**
     * Apply arbitrary CSS variables object to <html>.
     */
    function applyVars(vars) {
        if (!vars || typeof vars !== 'object') return;
        const el = document.documentElement;
        for (const [prop, val] of Object.entries(vars)) {
            if (prop.startsWith('--')) el.style.setProperty(prop, val);
        }
    }

    /**
     * Resolve the active theme from (in order):
     * 1. localStorage 'ov_theme' (has id + variables — instant)
     * 2. Cookie 'ov_theme_id' (just slug — look up in built-in map)
     * Falls back to 'vibe'.
     */
    function resolveAndApply() {
        // 1. Try localStorage (same-origin cache with full variables)
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                if (saved && saved.variables && typeof saved.variables === 'object') {
                    applyVars(saved.variables);
                    return saved.id || saved.slug || 'vibe';
                }
                if (saved && (saved.id || saved.slug)) {
                    const id = saved.id || saved.slug;
                    if (applyById(id)) return id;
                }
            }
        } catch { /* corrupt localStorage */ }

        // 2. Try cross-domain cookie
        const cookieId = getCookie(COOKIE_NAME);
        if (cookieId && applyById(cookieId)) {
            // Cache in localStorage for faster next load
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: cookieId, variables: THEMES[cookieId] }));
            } catch { /* quota */ }
            return cookieId;
        }

        // 3. Default — vibe (already the CSS fallback values, but apply explicitly)
        applyById('vibe');
        return 'vibe';
    }

    /**
     * Save theme choice both locally and cross-domain.
     * Call this when the user picks a theme.
     */
    function save(themeId, variables) {
        const vars = variables || THEMES[themeId];
        if (!vars) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: themeId, slug: themeId, variables: vars }));
        } catch { /* quota */ }
        setCookie(COOKIE_NAME, themeId, 365);
    }

    /**
     * Get the current theme ID (from cookie or localStorage).
     */
    function getCurrent() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                if (saved && (saved.id || saved.slug)) return saved.id || saved.slug;
            }
        } catch {}
        return getCookie(COOKIE_NAME) || 'vibe';
    }

    // ── Auto-apply on load (synchronous, prevents FOUC) ─────
    const activeId = resolveAndApply();

    // ── If user is logged in, try to sync from server ────────
    // This runs async after page paint to pick up server-side changes
    if (typeof fetch !== 'undefined') {
        setTimeout(function () {
            const token = getCookie('ov_token') ||
                (typeof localStorage !== 'undefined' && (localStorage.getItem('ov_token') || localStorage.getItem('token')));
            if (!token) return;
            fetch(_config.apiBase + '/api/themes/me/active', {
                headers: { 'Authorization': 'Bearer ' + token },
                credentials: 'include',
            }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (data) {
                if (!data || !data.theme_id) return;
                const serverId = data.theme_id;
                const custom = data.custom_variables;
                if (custom && typeof custom === 'object' && Object.keys(custom).length) {
                    // Custom theme: apply the built-in base (if any) then the user's overrides.
                    const base = THEMES[serverId] || {};
                    applyVars(base);
                    applyVars(custom);
                    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: serverId, variables: Object.assign({}, base, custom) })); } catch { /* quota */ }
                    setCookie(COOKIE_NAME, serverId, 365);
                } else if (serverId !== getCurrent()) {
                    if (applyById(serverId)) save(serverId, THEMES[serverId]);
                }
            }).catch(function () { /* offline / CORS */ });
        }, 500);
    }

    // ── Public API ───────────────────────────────────────────
    const OpenVibeThemeLoader = {
        THEMES: THEMES,
        apply: applyById,
        applyVars: applyVars,
        save: save,
        getCurrent: getCurrent,
        resolveAndApply: resolveAndApply,
        init: function (opts) {
            if (opts && typeof opts.apiBase === 'string' && opts.apiBase.trim()) {
                _config.apiBase = opts.apiBase.trim();
            }
            return OpenVibeThemeLoader;
        },
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = OpenVibeThemeLoader;
    else root.OpenVibeThemeLoader = OpenVibeThemeLoader;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
