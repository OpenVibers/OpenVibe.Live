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
// The verb the card line opens with, wherever the overview puts it early ("the flaming feline streams …").
const VERB = /\b(?:streams?|broadcasts?|presents?|plays?|hosts?|covers?|shows?|builds?|creates?|chats?)\b/i;
// A description in the past tense is not the card's present tense: use the fallback shape instead.
const PAST = /\b(?:streamed|broadcast|used to|was|were|had|played|hosted|presented|built|created|chatted)\b/i;
// A full "Name: …" opener, after the name is off, can leave a leading separator.
const LEADING_JUNK = /^[\s:;,.\-–—]+/;
// Stop a single long phrase at the last whole prepositional phrase that still fits.
const TAIL_PREP = /\s(?:with|from|in|on|at|by|for|about|over|under|into)\s/gi;

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
    TAIL_PREP.lastIndex = 0;
    for (let m; (m = TAIL_PREP.exec(s));) {
        // The first whole prepositional phrase that still leaves a real line is the cut: after it
        // comes a new phrase the card line cannot hold ("… gameplay with a focus on immersive worlds").
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
        let out = phrases[0];
        for (let i = 1; i < phrases.length; i++) {
            const next = `${out}, ${phrases[i]}`;
            if (next.length > MAX_CONTENT) break;
            out = next;
        }
        if (out.length <= MAX_CONTENT && out !== s) return out;
        if (out.length > MAX_CONTENT) return cutPhrase(out);
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
            if (role) content = `as a ${role}`;
        }
        if (!content) continue;

        // A colon never reaches a card line; a comma keeps the sentence reading.
        content = fitContent(content.replace(/:/g, ',')).replace(/[.!?…]+$/g, '').trim();
        if (!content) continue;
        const line = `Streams ${content}.`;
        if (line.length > MAX_LEN || !CHANNEL_LINE_RE.test(line)) continue;
        // The owner's line (AGENTS.md, server/ai/explicit.js): people may be described; sex acts never are.
        if (isExplicit(line)) return FALLBACK_CHANNEL_LINE;
        return line;
    }
    return FALLBACK_CHANNEL_LINE;
}

module.exports = { shapeChannelLine, CHANNEL_LINE_RE, FALLBACK_CHANNEL_LINE, MAX_LEN };
