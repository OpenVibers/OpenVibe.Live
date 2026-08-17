/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Theme Engine
   Applies, persists, and manages themes client-side.
   ═══════════════════════════════════════════════════════════════ */

/* ── State ────────────────────────────────────────────────────── */
let activeTheme = null;       // Full theme object from server
let customOverrides = {};     // Custom variable overrides
let allThemes = [];           // Cached list of all themes
let isCustomMode = false;

/* ── Default (Campfire) variables — fallback ──────────────────── */
const DEFAULT_VARS = {
    '--bg-primary': '#0d0d0f',
    '--bg-secondary': '#16161a',
    '--bg-tertiary': '#1e1e24',
    '--bg-card': '#1a1a20',
    '--bg-hover': '#242430',
    '--bg-input': '#12121a',
    '--text-primary': '#e8e6e3',
    '--text-secondary': '#9a9a9a',
    '--text-muted': '#666',
    '--accent': '#8b5cf6',
    '--accent-light': '#a78bfa',
    '--accent-dark': '#6d28d9',
    '--on-accent': '#0b0d10',
    '--live-red': '#e74c3c',
    '--success': '#2ecc71',
    '--warning': '#f39c12',
    '--danger': '#e74c3c',
    '--info': '#3498db',
    '--border': '#2a2a32',
    '--border-light': '#3a3a44',
    '--radius': '8px',
    '--radius-sm': '4px',
    '--radius-lg': '12px',
    '--shadow': '0 2px 12px rgba(0,0,0,0.4)',
    '--shadow-lg': '0 8px 32px rgba(0,0,0,0.6)',
    '--shadow-soft': '0 12px 40px rgba(0,0,0,0.28)',
    '--glass': 'rgba(22, 22, 26, 0.82)',
    '--glass-strong': 'rgba(16, 16, 22, 0.94)',
    '--ring-accent': '0 0 0 1px rgba(139,92,246,0.20), 0 18px 40px rgba(0,0,0,0.30)',
    '--font': "'Segoe UI', system-ui, -apple-system, sans-serif",
    '--font-mono': "'Consolas', 'Courier New', monospace",
    '--navbar-h': '56px',
    '--chat-w': '340px',
};

/* All themeable CSS variable names */
const THEME_VARS = [
    '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-card', '--bg-hover', '--bg-input',
    '--text-primary', '--text-secondary', '--text-muted',
    '--accent', '--accent-light', '--accent-dark', '--on-accent',
    '--live-red', '--success', '--warning', '--danger', '--info',
    '--border', '--border-light',
    '--shadow', '--shadow-lg',
];

/* Human-friendly labels for the editor */
const VAR_LABELS = {
    '--bg-primary': 'Background Primary',
    '--bg-secondary': 'Background Secondary',
    '--bg-tertiary': 'Background Tertiary',
    '--bg-card': 'Card Background',
    '--bg-hover': 'Hover Background',
    '--bg-input': 'Input Background',
    '--text-primary': 'Text Primary',
    '--text-secondary': 'Text Secondary',
    '--text-muted': 'Text Muted',
    '--accent': 'Accent',
    '--accent-light': 'Accent Light',
    '--accent-dark': 'Accent Dark',
    '--live-red': 'Live Indicator',
    '--success': 'Success',
    '--warning': 'Warning',
    '--danger': 'Danger',
    '--info': 'Info',
    '--border': 'Border',
    '--border-light': 'Border Light',
    '--shadow': 'Shadow',
    '--shadow-lg': 'Large Shadow',
};

/* Groups for the theme editor */
const VAR_GROUPS = [
    { label: 'Backgrounds', icon: 'fa-fill-drip', vars: ['--bg-primary','--bg-secondary','--bg-tertiary','--bg-card','--bg-hover','--bg-input'] },
    { label: 'Text', icon: 'fa-font', vars: ['--text-primary','--text-secondary','--text-muted'] },
    { label: 'Accent', icon: 'fa-palette', vars: ['--accent','--accent-light','--accent-dark'] },
    { label: 'Semantic', icon: 'fa-circle-check', vars: ['--live-red','--success','--warning','--danger','--info'] },
    { label: 'Borders & Shadows', icon: 'fa-border-all', vars: ['--border','--border-light','--shadow','--shadow-lg'] },
];

/* ── Sanitize a CSS variable value ───────────────────────────────── */
const UNSAFE_CSS_RE = /url\s*\(|expression\s*\(|javascript\s*:|@import|behavior\s*:|\bvar\s*\(/i;
function sanitizeCssValue(v) {
    return UNSAFE_CSS_RE.test(v) ? '' : v;
}

/* ── Apply a set of CSS variables to :root ──────────────── */
function applyVariables(vars) {
    const root = document.documentElement;
    // Start from defaults, layer theme vars, then custom overrides
    const merged = { ...DEFAULT_VARS };
    if (vars) Object.assign(merged, vars);
    if (isCustomMode && customOverrides) Object.assign(merged, customOverrides);

    for (const [key, value] of Object.entries(merged)) {
        if (key.startsWith('--')) {
            const safe = sanitizeCssValue(value);
            if (safe) root.style.setProperty(key, safe);
        }
    }
}

/* ── Apply a theme by object ──────────────────────────────────── */
function applyTheme(theme) {
    activeTheme = theme;
    if (theme && theme.variables) {
        applyVariables(theme.variables);
    } else {
        applyVariables({});
    }
    // Update body class for light/dark specific CSS
    document.body.classList.toggle('theme-light', theme?.mode === 'light');
    document.body.classList.toggle('theme-dark', theme?.mode !== 'light');
}

/* ── Load & apply theme from localStorage (instant, no flash) ── */
function loadThemeFromStorage() {
    try {
        const stored = localStorage.getItem('ov_theme');
        if (stored) {
            const data = JSON.parse(stored);
            isCustomMode = !!data.is_custom;
            customOverrides = data.custom_variables || {};
            if (data.theme) {
                applyTheme(data.theme);
            } else if (isCustomMode) {
                applyVariables({});
            }
            return true;
        }
    } catch { /* ignore */ }
    return false;
}

/* ── Save current theme to localStorage ────────────────────── */
function saveThemeToStorage() {
    try {
        localStorage.setItem('ov_theme', JSON.stringify({
            theme: activeTheme,
            theme_id: activeTheme?.id || null,
            custom_variables: customOverrides,
            is_custom: isCustomMode,
        }));
    } catch { /* quota exceeded etc */ }
}

/* ── Sync theme preference with server (when logged in) ──────── */
async function syncThemeToServer() {
    if (!currentUser) return;
    try {
        await api('/themes/me', {
            method: 'PUT',
            body: {
                theme_id: activeTheme?.id || null,
                custom_variables: customOverrides,
                is_custom: isCustomMode,
            },
        });
    } catch { /* silent */ }
}

/* ── Load theme preference from server (on login) ─────────────── */
async function loadThemeFromServer() {
    if (!currentUser) return;
    try {
        const data = await api('/themes/me');
        if (data.theme) {
            // Skip re-apply if the server theme matches what's already active
            if (activeTheme?.id === data.theme.id && !data.is_custom) return;
            activeTheme = data.theme;
            isCustomMode = data.is_custom;
            customOverrides = data.custom_variables || {};
            applyTheme(activeTheme);
            saveThemeToStorage();
        } else if (data.is_custom && Object.keys(data.custom_variables || {}).length) {
            isCustomMode = true;
            customOverrides = data.custom_variables;
            activeTheme = null;
            applyVariables({});
            saveThemeToStorage();
        }
    } catch { /* silent, localStorage fallback */ }
}

/* ── Select a theme by ID — called from UI ───────────────────── */
async function selectTheme(themeId) {
    let theme = allThemes.find(t => t.id === themeId);

    // Fallback: try dirThemes (Theme Directory page cache)
    if (!theme && typeof dirThemes !== 'undefined' && Array.isArray(dirThemes)) {
        theme = dirThemes.find(t => t.id === themeId);
    }

    // Fallback: fetch from server if not in any client cache
    if (!theme) {
        try {
            const data = await api(`/themes/${themeId}`);
            theme = data.theme;
        } catch { /* theme not found */ }
    }

    if (!theme) return;

    isCustomMode = false;
    customOverrides = {};
    applyTheme(theme);
    saveThemeToStorage();
    await syncThemeToServer();

    // Increment download count for community themes
    if (!theme.is_builtin) {
        try { await api(`/themes/${themeId}/download`, { method: 'POST' }); } catch {}
    }
}

/* ── Reset to default (Vibe) ──────────────────────────────────── */
async function resetTheme() {
    const vibe = allThemes.find(t => t.slug === 'vibe');
    if (vibe) {
        await selectTheme(vibe.id);
    } else {
        isCustomMode = false;
        customOverrides = {};
        activeTheme = null;
        applyVariables({});
        saveThemeToStorage();
        await syncThemeToServer();
    }
}

/* ── Apply custom variable override (live editor) ─────────── */
function setCustomVar(varName, value) {
    const safe = sanitizeCssValue(value);
    if (!safe) return;
    customOverrides[varName] = safe;
    document.documentElement.style.setProperty(varName, safe);
}

/* ── Save custom theme ─────────────────────────────────────── */
async function saveCustomTheme() {
    isCustomMode = true;
    applyVariables(activeTheme?.variables || {});
    saveThemeToStorage();
    await syncThemeToServer();
}

/* ── Get current resolved value of a CSS variable ─────────── */
function getThemeVar(varName) {
    if (isCustomMode && customOverrides[varName]) return customOverrides[varName];
    if (activeTheme?.variables?.[varName]) return activeTheme.variables[varName];
    return DEFAULT_VARS[varName] || '';
}

/* ── Fetch all themes from server ─────────────────────────── */
async function fetchAllThemes(opts = {}) {
    try {
        const params = new URLSearchParams();
        if (opts.mode) params.set('mode', opts.mode);
        if (opts.search) params.set('search', opts.search);
        if (opts.sort) params.set('sort', opts.sort);
        const qs = params.toString();
        const data = await api(`/themes${qs ? '?' + qs : ''}`);
        allThemes = data.themes || [];
        return allThemes;
    } catch {
        return allThemes;
    }
}

/* ── Submit a community theme to the directory ────────────── */
async function submitThemeToDirectory(name, description, mode) {
    // Build variables from current state
    const vars = {};
    for (const v of THEME_VARS) {
        vars[v] = getThemeVar(v);
    }

    const res = await api('/themes', {
        method: 'POST',
        body: {
            name,
            description,
            mode: mode || (activeTheme?.mode || 'dark'),
            variables: vars,
            tags: [],
        },
    });
    return res;
}

/* ── Init: apply stored theme immediately to prevent flash ───── */
(function () {
    loadThemeFromStorage();
})();
