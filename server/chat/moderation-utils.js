'use strict';
/**
 * moderation-utils.js — Shared chat moderation logic for OpenVibe.Live
 *
 * This module is the single authoritative source for:
 *  - Text normalization (leet-char mapping, NFKD, de-duplication)
 *  - Built-in slur category pattern definitions
 *  - Matching helpers used by both server and client code
 *
 * SERVER AUTHORITATIVE: Even if the client pre-send check misses a variant,
 * the server always runs these same checks before forwarding the message.
 *
 * KEEP IN SYNC: The browser-side copy of these definitions lives in
 * public/js/chat.js as CHAT_CORE_SLUR_CATEGORIES. When updating patterns
 * here, update that constant there too (or vice-versa).
 * Important safety framing:
 * This is defensive moderation work. Do not generate, expand, list, or repeat offensive protected-class terms in comments, docs, test names, commit messages, logs, or UI text. Use neutral placeholders like BLOCKED_TERM_ALPHA / BLOCKED_TERM_BETA in tests where possible. Existing repository patterns may be refactored, but do not add new hateful terminology unless it already exists in the codebase and is strictly necessary for preserving current behavior.
 */

// ── Leet-char substitution map ──────────────────────────────────────────────
// Applied before any pattern matching to catch common substitution ciphers.
const LEET_MAP = {
    '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
    '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
    '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
};

// ── Built-in slur category definitions ────────────────────────────────────
// Patterns are matched against normalizeSlurPatternText() output (spaces
// preserved, leet mapped, accents stripped, non-alphanumeric removed).
//
// N-word notes:
//   (?:a+[sz]?|e+r+[sz]?) catches:
//     base
//     plural
//   The second pattern catches the "nick/knick" family (different root).
//   Both patterns are deliberately word-boundary anchored to reduce false positives.
const CORE_SLUR_CATEGORIES = [
    {
        key: 'n_word',
        label: 'N-word and variants',
        patterns: [
            // Base + plural forms: ****a, ****as, ****az, ****er, ****ers, ****az
            '\\bn+i+g+g+(?:a+[sz]?|e+r+[sz]?)\\b',
            // Alternate root family: nick, knick, etc.
            '\\b[kn]*n+h?i+c?k+e+r+s?\\b',
        ],
    },
    {
        key: 'antisemitic',
        label: 'Antisemitic slurs',
        patterns: [
            '\\bk+\\s*y+\\s*k+\\s*e+\\b',
            '\\bj+\\s*e+\\s*w+\\s*s?\\s+w+\\s*i+\\s*l+\\s*l+\\s+n+\\s*o+\\s*t+\\s+r+\\s*e+\\s*p+\\s*l+\\s*a+\\s*c+\\s*e+\\b',
        ],
    },
    {
        key: 'homophobic',
        label: 'Homophobic slurs',
        patterns: [
            '\\bf+\\s*a+\\s*g+(?:o+\\s*t+)?[sz]?\\b',
        ],
    },
    {
        key: 'racial',
        label: 'Racial slurs',
        patterns: [
            '\\bs+\\s*p+\\s*i+\\s*c+[sz]?\\b',
            '\\bc+\\s*h+\\s*i+\\s*n+\\s*k+[sz]?\\b',
        ],
    },
];

// Add a reusable candidate generation helper for built-in pattern matching.
for (const cat of CORE_SLUR_CATEGORIES) {
    cat.generateCandidates = (text) => {
        const normalized = normalizeSlurPatternText(text);
        if (!normalized) return [];
        const collapsed = normalized.replace(/\s+/g, '');
        return [normalized, collapsed];
    };
}

// Pre-compile all patterns at module load time.
for (const cat of CORE_SLUR_CATEGORIES) {
    cat.compiled = cat.patterns
        .map((src) => { try { return new RegExp(src, 'i'); } catch { return null; } })
        .filter(Boolean);
}

// ── Normalization helpers ────────────────────────────────────────────────────

/**
 * Heavy normalization: strip everything to just unambiguous letters.
 * Used for configured-term substring matching where inter-word boundaries
 * are not needed.
 *
 * Steps: lowercase → leet map → NFKD + accent strip → letters only → dedup consecutive chars
 */
function normalizeSlurText(input) {
    const lower = String(input || '').toLowerCase();
    const mapped = lower.split('').map((ch) => LEET_MAP[ch] || ch).join('');
    const ascii = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const lettersOnly = ascii.replace(/[^a-z]/g, '');
    return lettersOnly.replace(/(.)\1{1,}/g, '$1');
}

/**
 * Pattern normalization: preserve word boundaries (spaces) so regex anchors work.
 * Used for core category pattern matching and custom regex matching.
 *
 * Steps: lowercase → leet map → NFKD + accent strip → collapse non-alphanum to spaces
 */
function normalizeSlurPatternText(input) {
    const lower = String(input || '').toLowerCase();
    const mapped = lower.split('').map((ch) => LEET_MAP[ch] || ch).join('');
    const ascii = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return ascii.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Matching helpers ─────────────────────────────────────────────────────────

/**
 * Returns true if the normalized text hits any enabled built-in slur category.
 *
 * Two normalization passes are run:
 *  1. Space-preserved: "n i g g a" — catches word-boundary-separated attempts
 *  2. Space-collapsed: "****a"    — catches letter-by-letter separation via dots/dashes
 *
 * @param {string} text - Raw message text (pre-normalization).
 * @param {string[]} disabledCategories - Category keys to skip (per-channel setting).
 */
function containsCoreSlur(text, disabledCategories = []) {
    const disabled = new Set(disabledCategories);
    return CORE_SLUR_CATEGORIES.some((cat) => {
        if (disabled.has(cat.key)) return false;
        const candidates = cat.generateCandidates(text);
        return candidates.some((candidate) => cat.compiled.some((pat) => pat.test(candidate)));
    });
}

/**
 * Returns true if the normalized text matches any of the provided custom regex lines.
 * Lines may be bare patterns or /pattern/flags wrapped patterns.
 *
 * @param {string} text - Raw message text.
 * @param {string[]} regexLines - Array of pattern strings (user-configured).
 */
function containsRegexSlur(text, regexLines) {
    const normalized = normalizeSlurPatternText(text);
    if (!normalized) return false;
    const candidates = [normalized, normalized.replace(/\s+/g, '')];
    const compiled = compileRegexList(regexLines, { forceInsensitive: true });
    return compiled.some((pat) => candidates.some((candidate) => pat.test(candidate)));
}

/**
 * Returns true if the heavy-normalized text contains any of the configured term substrings.
 *
 * @param {string} text - Raw message text.
 * @param {string[]} terms - Array of configured term strings (user-configured).
 */
function containsConfiguredSlur(text, terms) {
    const normalizedText = normalizeSlurText(text);
    if (!normalizedText) return false;
    for (const term of terms) {
        const normalizedTerm = normalizeSlurText(term);
        if (!normalizedTerm || normalizedTerm.length < 2) continue;
        if (normalizedText.includes(normalizedTerm)) return true;
    }
    return false;
}

/**
 * Compile an array of raw pattern strings into RegExp objects.
 * Supports /pattern/flags wrapped syntax. Invalid patterns are silently skipped.
 *
 * @param {string[]} patternStrings
 * @param {{ forceInsensitive?: boolean }} opts
 * @returns {RegExp[]}
 */
function compileRegexList(patternStrings, { forceInsensitive = true } = {}) {
    const compiled = [];
    for (const raw of patternStrings || []) {
        if (!raw || raw.length > 200) continue;
        let source = raw;
        let flags = forceInsensitive ? 'i' : '';
        const slashWrapped = raw.match(/^\/(.+)\/([a-z]*)$/i);
        if (slashWrapped) {
            source = slashWrapped[1];
            flags = slashWrapped[2] || '';
            if (forceInsensitive && !flags.includes('i')) flags += 'i';
        }
        try {
            compiled.push(new RegExp(source, flags));
        } catch {
            // Ignore invalid user-provided regex patterns.
        }
    }
    return compiled;
}

// ── Friendly global chat (viewer-side) ───────────────────────────────────────
// What the "Friendly global chat" setting hides on a viewer's screen. Nothing is deleted and
// nobody is banned for it — the message is still there for anyone with the setting off, and the
// viewer can reveal it with a tap. It is on for a viewer's first day so partners and newcomers
// looking around don't meet the roughest corners first.
//
// Patterns run against normalizeSlurPatternText() output (lower case, leetspeak folded), with the
// same word-boundary style as the core list. Deliberately narrow: slurs, hate slogans, threats,
// sexual content and anything involving minors — not ordinary swearing.
const FRIENDLY_FILTER_CATEGORIES = [
    ...CORE_SLUR_CATEGORIES.map(c => ({ key: c.key, label: c.label, patterns: c.patterns })),
    {
        key: 'slurs_more',
        label: 'Other slurs',
        patterns: [
            '\\br+e+t+a+r+d+(?:e+d+|s+)?\\b',
            '\\bt+r+a+n+n+(?:y+|i+e+s+)\\b',
            '\\bc+o+o+n+s?\\b',
            '\\bg+o+o+k+s?\\b',
            '\\bw+e+t+b+a+c+k+s?\\b',
            '\\bb+e+a+n+e+r+s?\\b',
            '\\b(?:t+o+w+e+l+|r+a+g+|s+a+n+d+)\\s*(?:h+e+a+d+|n+i+g+g+\\w*)s?\\b',
            '\\bd+y+k+e+s?\\b',
            '\\bs+h+e+m+a+l+e+s?\\b',
            '\\bp+a+k+i+s?\\b',
        ],
    },
    {
        key: 'hate',
        label: 'Hate slogans',
        patterns: [
            '\\b(?:h+e+i+l+|s+i+e+g+)\\s+(?:h+i+t+l+e+r+|h+e+i+l+)\\b',
            '\\b14\\s*[/.]?\\s*88\\b',
            '\\bg+a+s+\\s+(?:t+h+e+|a+l+l+)\\s+\\w+',
            '\\bw+h+i+t+e+\\s+p+o+w+e+r+\\b',
            '\\bk+i+l+l+\\s+a+l+l+\\s+(?:t+h+e+\\s+)?(?:j+e+w+|b+l+a+c+k+|g+a+y+|m+u+s+l+i+m+|t+r+a+n+|w+h+i+t+e+|m+e+x+i+c+a+n+|a+s+i+a+n+)\\w*',
            '\\bh+i+t+l+e+r+\\s+(?:d+i+d+\\s+n+o+t+h+i+n+g+\\s+w+r+o+n+g+|w+a+s+\\s+r+i+g+h+t+)\\b',
            '\\bh+o+l+o+c+a+u+s+t+\\s+(?:n+e+v+e+r+\\s+h+a+p+p+e+n+e+d+|d+i+d+n+\'?t+\\s+h+a+p+p+e+n+|i+s+\\s+a+\\s+(?:l+i+e+|h+o+a+x+))\\b',
        ],
    },
    {
        key: 'threats',
        label: 'Threats and self-harm baiting',
        patterns: [
            '\\bk+y+s+\\b',
            '\\bk+i+l+l+\\s+y+o+u+r+\\s*s+e+l+f+\\b',
            '\\b(?:i+\\s*(?:\'?l+l+|w+i+l+l+|a+m+\\s+g+o+n+n+a+|a+m+\\s+g+o+i+n+g+\\s+t+o+)|i+m+\\s+g+o+n+n+a+)\\s+(?:k+i+l+l+|m+u+r+d+e+r+|s+h+o+o+t+|s+t+a+b+)\\s+(?:y+o+u+|u+)\\b',
            '\\bh+o+p+e+\\s+(?:y+o+u+|u+)\\s+d+i+e+\\b',
            '\\bg+o+\\s+d+i+e+\\b',
        ],
    },
    {
        key: 'sexual',
        label: 'Sexual content',
        patterns: [
            '\\br+a+p+(?:e+|e+d+|i+n+g+|i+s+t+s?)\\b',
            '\\bc+u+m+(?:m+i+n+g+|s+h+o+t+)?\\b',
            '\\bc+o+c+k+s?\\b',
            '\\bp+u+s+s+(?:y+|i+e+s+)\\b',
            '\\bb+l+o+w+\\s*j+o+b+s?\\b',
            '\\bp+o+r+n+\\w*',
            '\\bn+u+d+e+s+\\b',
            '\\bj+e+r+k+(?:i+n+g+)?\\s+o+f+f+\\b',
        ],
    },
    {
        key: 'minors',
        label: 'Anything sexualising minors',
        patterns: [
            '\\bp+e+d+o+(?:p+h+i+l+e+s?|s+)?\\b',
            '\\bc+h+i+l+d+\\s*p+o+r+n+\\w*',
            '\\bc+p+\\b',
            '\\bl+o+l+i+(?:c+o+n+)?s?\\b',
            '\\bm+i+n+o+r+s?\\s+(?:n+u+d+e+s+|s+e+x+)',
        ],
    },
];
for (const cat of FRIENDLY_FILTER_CATEGORIES) {
    cat.compiled = cat.patterns.map((src) => { try { return new RegExp(src, 'i'); } catch { return null; } }).filter(Boolean);
}
/** The category a message falls in for the friendly filter, or null. */
function friendlyFilterCategory(text) {
    // Both spellings: leetspeak folding catches "n1gg…", but it also turns "14/88" into letters.
    const n = normalizeSlurPatternText(text);
    const raw = String(text || '').toLowerCase();
    for (const cat of FRIENDLY_FILTER_CATEGORIES) if (cat.compiled.some(re => re.test(n) || re.test(raw))) return cat.key;
    return null;
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    LEET_MAP,
    CORE_SLUR_CATEGORIES,
    FRIENDLY_FILTER_CATEGORIES,
    friendlyFilterCategory,
    normalizeSlurText,
    normalizeSlurPatternText,
    containsCoreSlur,
    containsRegexSlur,
    containsConfiguredSlur,
    compileRegexList,
};
