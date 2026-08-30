/**
 * names.js — how a streamer's name comes out of a speech-to-text engine, and how to find it.
 *
 * "JapaneseOldGuy" is never transcribed as one token: whisper hears "Japanese old guy",
 * "japanese-old-guy", "Japanese Old Guy's stream". "lofi_dan99" → "lofi dan". "Maticus" →
 * "Matticus" / "Mattie cuss". "x_Goosely_TV" → "Goosely". This module turns a name into every
 * spoken form we can predict, then matches transcript lines against them with:
 *
 *   1. exact/loose-separator matches ("japanese old guy", "japanese-old-guy", "japaneseoldguy")
 *   2. fuzzy matches on n-grams of the line (edit distance scaled by length)
 *   3. phonetic matches (a compact metaphone-ish key: "goosely" ≈ "goose lee" ≈ "goosley")
 *
 * Guard rails: single-word aliases must be ≥ 4 letters and not a common English word, so a
 * fighter called "Guy" or "Old" cannot be "mentioned" by every sentence; multi-word aliases only
 * match as the whole phrase; the speaker never matches themselves; longest alias wins.
 */
'use strict';

const COMMON = new Set(('about after again also always another anyone anything around because before being between both bring build built came cant cannot chat check come could does doing done down each else even ever every first from game games getting give going gone good great group guy guys have having here home into just keep kind know last later least life like little live look made make many maybe mean might more most much must name need never next nice night nobody nothing okay only other over people place play player point pretty probably really right same says school seen shit should show since some something sorry stay still stop stream streamer stuff sure take talk tell than thank that their them then there these they thing think this those three time today told took trying under until very want watch week well went were what when where which while whole will with without work would year years young your live love hate lord king queen dude bro bruh fam yeah yes okay old new big small guy girl boy man men women woman baby dan dave mike john tom jack ben sam max alex chris'
).split(/\s+/));

const SUFFIXES = /(?:_|-)?(?:tv|ttv|live|official|yt|twitch|gaming|stream|streams|vods|irl|hd|4k)$/i;

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'l' };

function clean(s) { return String(s || '').trim(); }
function words(s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

/** Split a handle the way it is SAID: camelCase, snake_case, kebab, letters|digits. */
function splitHandle(name) {
    let s = clean(name);
    if (!s) return [];
    s = s.replace(/[_.\-+]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')          // JapaneseOldGuy → Japanese Old Guy
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')    // XXGooselyXX → XX Goosely XX
        .replace(/([a-zA-Z])(\d)/g, '$1 $2')          // dan99 → dan 99
        .replace(/(\d)([a-zA-Z])/g, '$1 $2');
    return s.toLowerCase().split(/\s+/).filter(Boolean);
}

function deleet(w) { return String(w).replace(/[0134578@$!|]/g, c => LEET[c] || c); }

/**
 * All predicted spoken forms of one name (lowercase word arrays, deduped, most specific first).
 *   JapaneseOldGuy → ["japanese old guy"], ["japaneseoldguy"]
 *   lofi_dan99     → ["lofi dan 99"], ["lofi dan"], ["lofidan"]
 *   x_Goosely_TV   → ["x goosely tv"], ["goosely"], ["x goosely"]
 *   M4ticus        → ["m4ticus"], ["maticus"]
 */
function variants(name) {
    const out = new Set();
    const add = (ws) => { const v = ws.filter(Boolean).join(' ').trim(); if (v.length >= 3) out.add(v); };
    const raw = clean(name);
    if (!raw) return [];
    const base = splitHandle(raw);
    add(base);
    add(base.map(deleet));
    add(base.filter(w => !/^\d+$/.test(w)));                                  // drop pure numbers: "lofi dan 99" → "lofi dan"
    add(base.map(deleet).filter(w => !/^\d+$/.test(w)));
    const noSuffix = raw.replace(SUFFIXES, '');
    if (noSuffix !== raw) { const b2 = splitHandle(noSuffix); add(b2); add(b2.filter(w => !/^\d+$/.test(w))); }
    // Decorations people put around handles: xX_name_Xx, __name__, TheName → name
    const stripped = raw.replace(/^(?:xx+|x_|_+|the)/i, '').replace(/(?:xx+|_x|_+)$/i, '');
    if (stripped !== raw && stripped.length >= 3) { const b3 = splitHandle(stripped); add(b3); add(b3.filter(w => !/^\d+$/.test(w))); }
    // Glued form for names that ARE a phrase (a transcriber may glue or split them).
    for (const v of [...out]) { const ws = v.split(' '); if (ws.length > 1 && ws.every(w => /^[a-z]+$/.test(w))) out.add(ws.join('')); }
    // Drop unsafe single common words (would match every sentence).
    return [...out].filter(v => v.split(' ').length > 1 || (v.length >= 4 && !COMMON.has(v) && !/^\d+$/.test(v))).sort((a, b) => b.length - a.length);
}

// ── Fuzzy + phonetic ────────────────────────────────────────

function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}

/** Compact phonetic key: "goosely" → "gsl", "goose lee" → "gsl", "matticus" → "mtks", "japanese old guy" → "jpns ld g". */
function phonetic(s) {
    let t = String(s || '').toLowerCase().replace(/[^a-z ]/g, '');
    t = t.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw').replace(/x/g, 'ks').replace(/z/g, 's').replace(/wh/g, 'w')
        .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/g(?=[eiy])/g, 'j').replace(/dg/g, 'j').replace(/tio/g, 'sho').replace(/y/g, 'i');
    return t.split(' ').map(w => {
        if (!w) return '';
        const first = w[0];
        let rest = w.slice(1).replace(/[aeiouhw]/g, '');
        rest = rest.replace(/(.)\1+/g, '$1');
        return (first + rest).replace(/(.)\1+/g, '$1');
    }).filter(Boolean).join(' ');
}
function ratioThreshold(len) { return len <= 4 ? 0 : len <= 7 ? 1 : len <= 11 ? 2 : 3; }

// ── Matching ────────────────────────────────────────────────

/** Regex for one variant: words joined by any separator, optional 's / plural, no letters glued around. */
function variantRegex(v) {
    const parts = v.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(?:^|[^a-z0-9])@?${parts.join('[\\s\\-_.]*')}(?:'?s)?(?![a-z0-9])`, 'i');
}

/** Build an alias entry: { userId, name, words, re, key } for each variant of each name. */
function aliasEntries(userId, names) {
    const seen = new Set();
    const out = [];
    for (const n of names.filter(Boolean)) {
        for (const v of variants(n)) {
            if (seen.has(v)) continue; seen.add(v);
            out.push({ userId, name: v, words: v.split(' '), re: variantRegex(v), key: phonetic(v), letters: v.replace(/\s+/g, '') });
        }
    }
    return out;
}

/**
 * Which alias entries occur in `text`. Returns [{ userId, name, how: 'exact'|'fuzzy'|'phonetic', hit }].
 * `excludeUserId` = the speaker (never mentions themselves).
 */
function findMentions(text, entries, { excludeUserId = null, fuzzy = true } = {}) {
    const found = new Map(); // userId → best hit
    const raw = String(text || '');
    if (raw.length < 3) return [];
    const consider = (e, how, hit) => { if (e.userId === excludeUserId) return; const cur = found.get(e.userId); if (!cur || cur.rank < (how === 'exact' ? 3 : how === 'fuzzy' ? 2 : 1)) found.set(e.userId, { userId: e.userId, name: e.name, how, hit, rank: how === 'exact' ? 3 : how === 'fuzzy' ? 2 : 1 }); };
    // 1) exact / loose separators
    for (const e of entries) { const m = raw.match(e.re); if (m) consider(e, 'exact', m[0].trim()); }
    if (!fuzzy) return [...found.values()].map(({ rank, ...r }) => r);
    // 2) fuzzy + phonetic on n-grams (1..4 words) of the line
    const toks = words(raw).map(deleet);
    if (!toks.length) return [...found.values()].map(({ rank, ...r }) => r);
    for (const e of entries) {
        if (found.has(e.userId) && found.get(e.userId).rank === 3) continue;
        const n = e.words.length;
        const target = e.letters;
        if (target.length < 5) continue;                       // too short to fuzzy-match safely
        const maxD = ratioThreshold(target.length);
        // n-grams of n words, and of n±1 words (a name can be split or glued by the transcriber)
        for (const span of [n, n + 1, n - 1].filter(x => x >= 1 && x <= 4)) {
            for (let i = 0; i + span <= toks.length; i++) {
                const gram = toks.slice(i, i + span);
                const glued = gram.join('');
                if (Math.abs(glued.length - target.length) > maxD + 4) continue;
                // Fuzzy (typo-level) only on the same number of words: "matticus" ~ "maticus", "japanese old gai" ~
                // "japanese old guy" — but never "japanese guy" ~ "japanese old guy" (a different phrase).
                if (span === n && maxD > 0 && Math.abs(glued.length - target.length) <= maxD + 1 && levenshtein(glued, target) <= maxD) { consider(e, 'fuzzy', gram.join(' ')); break; }
                // "mattie cuss" → mtks == maticus → mtks; "goose lee" → gsl == goosely → gsl
                if (glued.length >= 5 && !gram.every(w => COMMON.has(w)) && phonetic(gram.join(' ')).replace(/ /g, '') === e.key.replace(/ /g, '')) { consider(e, 'phonetic', gram.join(' ')); break; }
            }
        }
    }
    return [...found.values()].sort((a, b) => b.rank - a.rank).map(({ rank, ...r }) => r);
}

module.exports = { variants, splitHandle, deleet, phonetic, levenshtein, aliasEntries, findMentions, variantRegex, COMMON };
