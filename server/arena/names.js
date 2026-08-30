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

const COMMON = new Set(('about after again also always another anyone anything around because before being between both bring build built came cant cannot chat check come could does doing done down each else even ever every first from game games getting give going gone good great group guy guys have having here home into just keep kind know last later least life like little live look made make many maybe mean might more most much must name need never next nice night nobody nothing okay only other over people place play player point pretty probably really right same says school seen shit should show since some something sorry stay still stop stream streamer stuff sure take talk tell than thank that their them then there these they thing think this those three time today told took trying under until very want watch week well went were what when where which while whole will with without work would year years young your live love hate lord king queen dude bro bruh fam yeah yes okay old new big small guy girl boy man men women woman baby dan dave mike john tom jack ben sam max alex chris '
    + 'matter meter motor water later letter little level lever mother master mister monster minute minutes money moment mountain market maybe major magic medic metal middle mirror mission model modern moving music mute native nature never number often order other paper party power pretty price quick quiet radio ready river robot round sauce scary second server seven shadow silver simple sister sixty slower smaller smoke solid sound south space speak speed spend spirit sport square start state steam story street strong stuff sugar summer super sweet table taken teach teeth thank thick thing third thought throw tiger timer title toast total touch tower track trade train travel treat truck truly trust truth turned twenty under upper usual value video village voice waste water wheel where white whole winter wonder world worry worse worth would write wrong yellow young about above across actor adult again agent ahead alarm album alien alive allow alone along alter among angle animal answer anyway apple armor arrow attack aware awful bacon badge basic battle beach beast begin being below bench birth black blade blame blank blast blind block blood board boost boots bottle bottom bounce bounty brain brand brave bread break brick bridge bright broken brush bucket buddy budget bullet button cable camera candy cannon cargo carry castle catch cause chain chair chance change charge chase cheap cheese chest chief child choice church claim class clean clear click climb clock close cloud coach coast coffee color combo comic coming crazy crash cream credit crime cross crowd crown cycle daily damage dance dark death decent delay demon depth desert device diamond dinner direct dirty double dozen dragon drama dream dress drink drive dungeon early earth eight empty enemy energy engine enter entire equal error event exact extra faith false fancy farm fast fatal fault favor feast fence field fight figure final finish fire flame flash flesh floor flower focus force forest forge frame fresh front frozen fruit funny giant glass glory gold grand grass green guard guess guide happy heart heavy hello hidden honor horse hotel house human hunt image inside iron island jacket joint judge juice jungle knife knight label ladder large laser latest laugh layer leader legend lemon light limit liquid local lucky lunch magic manual march match medal melee metal minor mobile moon mouse mouth movie nasty needle noise north notice number nurse ocean offer olive onion orange order outer oven owner paint panel panic paper patch peace pearl pedal pencil phone photo piano piece pilot pizza plain plane plant plate plush pocket poison police potato pound press prime print prize proof pulse punch puzzle queen quest rabbit radar raid rain range ratio razor reach recent relax reload rescue retro rifle rival rocket rough route royal rubber ruler rusty sadly safety salad sample sandwich scale scene score scout screen script scroll search secret select shape share sharp shelf shield shirt shock shoot shore short shoulder shovel signal silent skill skull slate sleep slice slide slime smart smell smile snake sneak snipe snow sock solar solo sorry sound spare spark spawn spear spell spice spider spike spoon spray staff stage stair stamp stand star steel step stick stone store storm story stove strange strike stupid sudden sunny sword tackle talent tank taste tavern temple tennis thief thirty ticket tired toilet token tomato tooth torch tough toxic trail trap trash treasure trick troll trophy trouble tunnel turtle twist uncle unique unit upset urban valley vault vendor virus vision vocal volume wagon waiting wallet weapon weird whale wheat window wire wizard wolf worker yard zombie zone'
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

function deleet(w) { w = String(w); if (/^\d+$/.test(w)) return w; /* 151 stays a number, never 'isi' */ return /[a-z]/i.test(w) ? w.replace(/[0134578@$!|]/g, c => LEET[c] || c) : w; }

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
    // Leet inside a token (M4ticus, l33t_dan) → un-leet the whole handle first, then split.
    if (/[a-z][0134578@$!|]+[a-z]/i.test(raw)) { const b0 = splitHandle(raw.replace(/[0134578@$!|]/g, c => LEET[c] || c)); add(b0); add(b0.filter(w => !/^\d+$/.test(w))); }
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
        if (target.length < 6) continue;                       // "mater" ≈ matter/meter/water — too short to fuzzy-match safely
        if (n === 1 && COMMON.has(e.name)) continue;
        const maxD = ratioThreshold(target.length);
        // n-grams of n words, and of n±1 words (a name can be split or glued by the transcriber)
        for (const span of [n, n + 1, n - 1].filter(x => x >= 1 && x <= 4)) {
            for (let i = 0; i + span <= toks.length; i++) {
                const gram = toks.slice(i, i + span);
                const glued = gram.join('');
                if (Math.abs(glued.length - target.length) > maxD + 4) continue;
                // Fuzzy (typo-level) only on the same number of words: "matticus" ~ "maticus", "japanese old gai" ~
                // "japanese old guy" — but never "japanese guy" ~ "japanese old guy" (a different phrase).
                if (gram.filter(w => COMMON.has(w)).length * 2 > gram.length) continue;   // plain English words are never a mangled name ("water is" ≠ mater)
                if (span === n && maxD > 0 && Math.abs(glued.length - target.length) <= maxD + 1 && levenshtein(glued, target) <= maxD) { consider(e, 'fuzzy', gram.join(' ')); break; }
                // "mattie cuss" → mtks == maticus → mtks; "goose lee" → gsl == goosely → gsl
                if (glued.length >= 6 && phonetic(gram.join(' ')).replace(/ /g, '') === e.key.replace(/ /g, '')) { consider(e, 'phonetic', gram.join(' ')); break; }
            }
        }
    }
    return [...found.values()].sort((a, b) => b.rank - a.rank).map(({ rank, ...r }) => r);
}

/**
 * Alias entries for a whole roster, roster-aware: besides every spoken form of each name, a handle's
 * FIRST token ("grizzly" for grizzly_bear, "japanese" is NOT for JapaneseOldGuy — common word) becomes
 * an alias when it is ≥ 5 letters, not a common word, and no other fighter starts with it.
 * `extra(id)` may add persona names / spoken_as forms per fighter.
 */
function rosterEntries(roster, extra = null) {
    const firsts = new Map();
    for (const id of roster.order) { const f = splitHandle(roster.byId[id].user.username)[0]; if (f && f.length >= 5 && !COMMON.has(f) && !/^\d+$/.test(f)) firsts.set(f, (firsts.get(f) || 0) + 1); }
    const list = [];
    for (const id of roster.order) {
        const u = roster.byId[id].user;
        const names = [u.username, u.display_name, ...(extra ? (extra(id) || []) : [])];
        const first = splitHandle(u.username)[0];
        if (first && firsts.get(first) === 1 && !variants(u.username).includes(first)) names.push(first);
        list.push(...aliasEntries(id, names));
    }
    return list.sort((a, b) => b.name.length - a.name.length);
}

module.exports = { variants, splitHandle, deleet, phonetic, levenshtein, aliasEntries, rosterEntries, findMentions, variantRegex, COMMON };
