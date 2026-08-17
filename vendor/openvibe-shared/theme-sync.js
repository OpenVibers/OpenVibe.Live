'use strict';

const { BUILTIN_THEMES, DEFAULT_VARS } = require('./builtin-themes');

// ═══════════════════════════════════════════════════════════════
// OpenVibe — Theme Sync Engine
// Isomorphic theme system shared across all OpenVibe services.
// Works in both Node.js (SSR) and browser environments.
// ═══════════════════════════════════════════════════════════════

const CSS_VARIABLES = [
    '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-card',
    '--bg-hover', '--bg-input',
    '--text-primary', '--text-secondary', '--text-muted',
    '--accent', '--accent-light', '--accent-dark',
    '--live-red', '--success', '--warning', '--danger', '--info',
    '--border', '--border-light', '--shadow', '--shadow-lg',
];

const NORMALIZED_DEFAULT_VARS = Object.freeze({ ...DEFAULT_VARS });

// ── Dangerous CSS patterns (XSS prevention) ─────────────────
const DANGEROUS_PATTERNS = [
    /url\s*\(/i, /expression\s*\(/i, /javascript:/i,
    /@import/i, /behavior\s*:/i, /var\s*\(/i, /-moz-binding/i,
];

function sanitizeCssValue(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length > 200) return null;
    for (const pat of DANGEROUS_PATTERNS) {
        if (pat.test(trimmed)) return null;
    }
    return trimmed;
}

// ── Theme Application ────────────────────────────────────────

/**
 * Apply a theme's variables to a target (DOM element or plain object).
 * In browser: pass `document.documentElement` as target.
 * In Node: pass an empty object to collect computed values.
 */
function applyTheme(theme, target) {
    if (!theme || !theme.variables) return;
    const vars = { ...NORMALIZED_DEFAULT_VARS, ...theme.variables };
    for (const [key, value] of Object.entries(vars)) {
        if (!CSS_VARIABLES.includes(key)) continue;
        const safe = sanitizeCssValue(value);
        if (!safe) continue;
        if (target && typeof target.style !== 'undefined' && target.style.setProperty) {
            // DOM element (browser)
            target.style.setProperty(key, safe);
        } else if (typeof target === 'object') {
            // Plain object (Node SSR)
            target[key] = safe;
        }
    }
}

/**
 * Resolve a theme by ID from the built-in catalog.
 * Falls back to 'vibe' if not found.
 */
function resolveBuiltinTheme(themeId) {
    return BUILTIN_THEMES.find(t => t.id === themeId || t.slug === themeId)
        || BUILTIN_THEMES[0];
}

// ── Browser-Only Helpers ─────────────────────────────────────
// These are safe to call in Node (they no-op if `window` is undefined).

const STORAGE_KEY = 'ov_theme';
const THEME_API_BASE = 'https://openvibe.network/api/themes';

function loadFromStorage() {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveToStorage(theme) {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            id: theme.id,
            slug: theme.slug,
            name: theme.name,
            mode: theme.mode,
            variables: theme.variables,
        }));
    } catch { /* quota exceeded, etc. */ }
}

/**
 * Sync theme choice to the central OpenVibe.Network server.
 * Requires an auth token. Fails silently if offline.
 */
async function syncThemeToServer(themeId, customVars, token) {
    if (typeof fetch === 'undefined' || !token) return;
    try {
        await fetch(`${THEME_API_BASE}/me`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ theme_id: themeId, custom_variables: customVars || null }),
        });
    } catch { /* offline, CORS, etc. */ }
}

module.exports = {
    CSS_VARIABLES,
    DEFAULT_VARS: NORMALIZED_DEFAULT_VARS,
    BUILTIN_THEMES,
    sanitizeCssValue,
    applyTheme,
    resolveBuiltinTheme,
    loadFromStorage,
    saveToStorage,
    syncThemeToServer,
    STORAGE_KEY,
};
