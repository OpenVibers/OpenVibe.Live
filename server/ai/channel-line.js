/**
 * channel-line.js — the one-line channel description on the home "Recently Online" cards.
 *
 * The stored overviews come from OpenVibe.AI (live.streamer.overview, model "openvibe-ai", refreshed by
 * server/ai/streamer-overview-job.js) in different shapes: "Maticus streams …", "AmberFieraGames37: …",
 * "Renyi1333 is a car-streamer who …". The card already carries the name, so the card line is reshaped to
 * one shape (owner, 2026-11-10): one sentence, what they stream first ("Streams League of Legends, mostly
 * ranked, with voice chat."), no name at the start, no colon, at most 90 characters, present tense. The full
 * overview keeps its detail; only the card line is reshaped. Describing people stays as AGENTS.md allows
 * (the owner lifted the old no-looks rule); only the explicit guard refuses a line.
 *
 * Used on the write path (db.upsertStreamerOverview and db.cleanupMalformedAiText, so the streamer-overview
 * job that already rewrites the stored rows refreshes them into this shape), by that job's deterministic
 * reshape pass (db.shapeStoredStreamerOverviewShorts), and on the read path (GET
 * /api/streams/recently-online shapes any row the job has not reached yet).
 */
'use strict';

const { isExplicit } = require('./explicit');

// The same sentence shape where there is too little to go on.
const FALLBACK_CHANNEL_LINE = 'Streams live on OpenVibe.';
// "Streams " + 1-81 content characters + "."; no colon, no other sentence end.
const CHANNEL_LINE_RE = /^Streams [^:.!?]{1,81}\.$/;
const MAX_LEN = 90;
const MAX_CONTENT = MAX_LEN - 'Streams '.length - 1; // 81

// Joining words a cut may not end on ("… sessions and", "… with a").
const TRAIL_WORD = /^(?:a|an|the|and|or|but|with|from|in|on|at|by|for|of|to|as|that|while|when|often|usually|frequently|typically|mostly|generally|sometimes|featuring|including|presenting)$/i;
// A cut may not end on an introduced noun ("… and a dark", "… with a focus"): the phrase continues.
const WEAK_END = /\b(?:a|an|the)\s+\S+$/i;
// The verb the card line opens with, wherever the overview puts it early ("the flaming feline streams …").
const VERB = /\b(?:streams?|broadcasts?|presents?|plays?|hosts?|covers?|shows?|builds?|creates?|chats?)\b/i;
// A description in the past tense is not the card's present tense: use the fallback shape instead.
const PAST = /\b(?:streamed|broadcast|used to|was|were|had|played|hosted|presented|built|created|chatted)\b/i;
// A full "Name: …" opener, after the name is off, can leave a leading separator.
const LEADING_JUNK = /^[\s:;,.\-–—]+/;
// Stop a single long phrase at a whole joining word ("… lighting and …", "… gameplay with …").
const TAIL_CUT = /\s(?:with|from|in|on|at|by|for|about|over|under|into|and|or|but)\s/gi;
// A comma-separated phrase is a whole cut when it is long enough to stand alone or when the next
// phrase is a new clause ("…, with …", "…, often …"), not the rest of the same adjective list
// ("… and blocky, imaginative builds …").
const NEXT_CLAUSE = /^(?:and|or|but|with|from|in|on|at|by|for|about|over|under|into|often|usually|frequently|typically|mostly|generally|sometimes|while|when|before|after|plus)\b/i;

/** Plain text: a JSON-wrapped model answer and markdown noise become prose. */
function plain(text) {
    let t = String(text == null ? '' : text).trim();
    if (t.startsWith('{')) {
        try {
            const o = JSON.parse(t);
            t = String((o && (o.overview || o.description || o.text || o.line)) || t);
        } catch { /* not JSON */ }
    }
    return t.replace(/\*\*|__/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

/** The first few sentences, each including its full stop when it has one. */
function sentences(text, max = 4) {
    const t = String(text || '').trim();
    if (!t) return [];
    const parts = t.match(/.*?[.!?](?:\s|$)|.+$/g) || [];
    return parts.map((s) => s.trim()).filter(Boolean).slice(0, max);
}

function escRe(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The name off the front ("Maticus streams …", "AmberFieraGames37: …" — the card has the name). */
function stripName(sentence, names) {
    let s = String(sentence || '').trim();
    for (const n of names) {
        const name = String(n || '').trim();
        if (!name) continue;
        const m = s.match(new RegExp(`^${escRe(name)}(?:'s)?\\s*:?\\s*`, 'i'));
        if (m) { s = s.slice(m[0].length); break; }
    }
    return s.replace(LEADING_JUNK, '').trim();
}

/**
 * The content after the streaming verb, or null when the sentence has no verb early enough to be about
 * the channel ("A trading-focused channel where …" has none and falls back).
 */
function contentAfterVerb(sentence) {
    const m = VERB.exec(sentence);
    if (!m || m.index > 70) return null;
    return sentence.slice(m.index + m[0].length).replace(LEADING_JUNK, '').trim() || null;
}

/** "is a car-streamer who …" keeps its role; a bare "is a streamer who …" says nothing. */
function roleOf(sentence) {
    const m = sentence.match(/^is\s+(?:an?\s+)?(.+?)\s+(?:who|that|whose|where)\b/i);
    if (!m) return null;
    const role = m[1].replace(/\s+/g, ' ').trim();
    if (!role || role.length > 40) return null;
    if (/^(?:an?\s+)?(?:streamer|content\s+creator|creator|broadcaster|user|channel|gamer)$/i.test(role)) return null;
    if (/\b(?:channel|server|community)$/i.test(role)) return null;
    return role;
}

/** Cut a single long phrase at a whole word, dropping the joining word it would end on. */
function cutWords(s) {
    let t = s.slice(0, MAX_CONTENT).trim();
    for (;;) {
        const before = t;
        t = t.replace(/[\s,;:.!?…–—-]+$/g, '');
        t = t.replace(/\s+(\S+)$/, (m, w) => (TRAIL_WORD.test(w) ? '' : m));
        if (t === before) break;
    }
    return t;
}

/** One long phrase may end at a whole prepositional phrase ("… gameplay with a focus on …"). */
function cutPhrase(s) {
    if (s.length <= MAX_CONTENT) return s;
    TAIL_CUT.lastIndex = 0;
    for (let m; (m = TAIL_CUT.exec(s));) {
        // The first whole joining phrase that still leaves a real line is the cut: after it comes a
        // new phrase the card line cannot hold ("… lighting and blocky, imaginative builds").
        if (m.index >= 35 && m.index <= MAX_CONTENT) return s.slice(0, m.index).trim();
    }
    return cutWords(s);
}

/** Content at most MAX_CONTENT, preferring whole comma-separated phrases. */
function fitContent(content) {
    const s = String(content || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= MAX_CONTENT) return s;
    const phrases = s.split(/\s*,\s*/).filter(Boolean);
    if (phrases.length > 1) {
        let out = phrases[0], best = '';
        for (let i = 1; i < phrases.length; i++) {
            if (out.length <= MAX_CONTENT && (out.length >= 50 || NEXT_CLAUSE.test(phrases[i])) && !WEAK_END.test(out)) best = out;
            const next = `${out}, ${phrases[i]}`;
            if (next.length > MAX_CONTENT) break;
            out = next;
        }
        if (best.length >= 35) return best;
    }
    return cutPhrase(s);
}

/**
 * Shape a stored overview into the card line. `names` are the username/display name to strip.
 * Returns the shaped line, or FALLBACK_CHANNEL_LINE when there is too little to go on.
 */
function shapeChannelLine({ username = null, displayName = null, overview = '' } = {}) {
    for (const raw of sentences(plain(overview))) {
        // A label sentence ("Name (@handle).") says nothing on its own; the next one carries the content.
        const sentence = stripName(raw, [displayName, username]);
        if (!sentence || PAST.test(sentence)) continue;
        // "is a streamer whose broadcasts …" says nothing about what they stream.
        if (/^is\s+(?:an?\s+)?(?:streamer|content\s+creator|creator|broadcaster|user|gamer)\b/i.test(sentence)) continue;

        let content = contentAfterVerb(sentence);
        if (!content) {
            const role = roleOf(sentence);
            if (role) content = `as ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`;
        }
        if (!content) continue;

        // A colon never reaches a card line; a comma keeps the sentence reading.
        content = fitContent(content.replace(/:/g, ',')).replace(/[.!?…]+$/g, '').trim();
        // "as a car-streamer" is a complete role; other trailing "a …" is an unfinished phrase.
        if (!content || (!/^as\s+(?:a|an)\s/i.test(content) && WEAK_END.test(content))) continue;
        const line = `Streams ${content}.`;
        if (line.length > MAX_LEN || !CHANNEL_LINE_RE.test(line)) continue;
        // The owner's line (AGENTS.md, server/ai/explicit.js): people may be described; sex acts never are.
        if (isExplicit(line)) return FALLBACK_CHANNEL_LINE;
        return line;
    }
    return FALLBACK_CHANNEL_LINE;
}

/*
 * The AI's own card line (2026-11-11, ask 363: the owner, "not all so generic sounding … more human feeling and nice").
 * OpenVibe.AI's live.streamer.overview answers a `line` written for the card ("Robots, cameras and late-night
 * tinkering, with chat riding along."); it is kept when it is one sentence of 20 to 100 characters, without the name, a
 * colon or a handle, without the stock words that make every channel sound the same, not explicit, and not in the
 * reshaped "Streams …" shape (that shape is the fallback's, so the reshape pass knows its own lines). Otherwise null,
 * and the card falls back to the overview reshaped.
 */
const STOCK = /\b(?:focus|content|engaging|various|a mix of|dive into|diving into|showcas\w*|vibrant|dynamic|journey|immersive|a blend of)\b/i;
function humanLine(raw, { username = null, displayName = null } = {}) {
    let s = plain(raw).replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '').trim();
    if (!s) return null;
    if (!/[.!?\u2026]$/.test(s)) s += '.';
    if (s.length < 20 || s.length > 100) return null;
    if (/^Streams\b/.test(s) || s.includes(':') || /@\w/.test(s)) return null;
    if (sentences(s).length > 1) return null;
    for (const n of [displayName, username]) {
        const name = String(n || '').trim();
        if (name && new RegExp(`^${escRe(name)}\\b`, 'i').test(s)) return null;
    }
    if (STOCK.test(s) || isExplicit(s)) return null;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The card's line: the AI's own when it passes, else the overview in the one shape. */
function cardLine({ username = null, displayName = null, overview = '', line = null } = {}) {
    return humanLine(line, { username, displayName }) || shapeChannelLine({ username, displayName, overview });
}

module.exports = { shapeChannelLine, humanLine, cardLine, CHANNEL_LINE_RE, FALLBACK_CHANNEL_LINE, MAX_LEN };
