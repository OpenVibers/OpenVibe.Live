/**
 * clip-dedupe.js — text/visual identity for moments, shared by the moment registry and both cutters.
 *
 * The old registry compared only the first five ASCII words of a description: paraphrases got
 * through, Japanese collapsed to an empty signature, and unrelated scenes that opened with the
 * same boilerplate collided. This module keeps Unicode, compares token sets (Dice similarity, so
 * a re-worded or longer description of the same scene still matches) and keeps the visual scene
 * separate from what was said. A static webcam with a NEW conversation must not be treated as a
 * repeated moment: when both sides have speech, the speech has to be similar too.
 *
 *   normalize(text)                     lower-case NFKC text, punctuation removed, spaces kept
 *   tokens(text)                        {word} tokens; CJK uses character bigrams
 *   contentTokens(text)                 tokens without articles/boilerplate media words
 *   shortSignature(text, words = 5)     the legacy five-token signature (registry `sig`)
 *   isSameScene(a, b, opts)             true for the same visual scene (near-duplicate wording)
 *   isSameSpeech(a, b)                  true for a near-duplicate transcript excerpt (Dice ≥ 0.8)
 *   isSameEmbedding(a, b)               true for near-identical frame embeddings, when both exist
 *   similarity(a, b)                    Dice coefficient over token sets
 *   cosine(a, b)                        cosine similarity over numeric vectors
 *
 * No model or network: a cheap baseline that replaces exact string equality. Frame embeddings are
 * optional — the registry stores them when a caller has them and otherwise relies on text.
 */
'use strict';

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_RE = /[\p{L}\p{N}]+/gu;

// Words that describe the medium rather than the scene. They must not be the only reason two
// different moments look alike ("a live streaming session with chat" vs "… with music").
const BOILERPLATE = new Set((
    'a an the and or of to in on at for with from by as is are was were be been being ' +
    'it its this that these those there here ' +
    'video videos stream streams live streaming session screen screenshot image images frame ' +
    'footage scene clip moment appears appear shown showing visible view camera close ' +
    'background foreground'
).split(' '));

function normalize(text) {
    return String(text == null ? '' : text).normalize('NFKC').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Token set: words for spaced languages, overlapping bigrams for CJK (which has no spaces). */
function tokens(text) {
    const norm = normalize(text);
    if (!norm) return [];
    if (CJK_RE.test(norm)) {
        const compact = norm.replace(/\s+/g, '');
        const out = [];
        for (let i = 0; i + 1 < compact.length; i++) out.push(compact.slice(i, i + 2));
        // Mixed Japanese/English streams: reuse the Latin words as well.
        for (const w of norm.match(/[a-z0-9]+/g) || []) if (w.length > 1) out.push(w);
        return [...new Set(out)];
    }
    return [...new Set((norm.match(WORD_RE) || []))];
}

/** Tokens that actually describe content; articles and media boilerplate are dropped. */
function contentTokens(text) {
    return tokens(text).filter((t) => !BOILERPLATE.has(t) && !/^\d+$/.test(t));
}

function similarity(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const x of A) if (B.has(x)) shared++;
    return (2 * shared) / (A.size + B.size);
}

/** Cosine similarity of two numeric vectors; 0 for a missing/zero/mismatched pair. */
function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = Number(a[i]), y = Number(b[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
        dot += x * y; na += x * x; nb += y * y;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The legacy registry signature: the first `words` tokens, joined. */
function shortSignature(text, words = 5) {
    return tokens(text).slice(0, words).join(' ');
}

/**
 * Same scene when the token sets are near-identical. A match may not rest on boilerplate alone:
 * the two descriptions must share at least one content token, so "a live stream with chat" does
 * not match "a live stream with music". Short texts only match exactly.
 */
function isSameScene(a, b, { threshold = 0.85, minTokens = 4 } = {}) {
    const A = tokens(a), B = tokens(b);
    if (!A.length || !B.length) return false;
    if (normalize(a) === normalize(b)) return true;
    const CA = contentTokens(a), CB = contentTokens(b);
    const cbSet = new Set(CB);
    const sharedContent = CA.filter((t) => cbSet.has(t));
    if (CA.length || CB.length) {
        if (!sharedContent.length) return false;
        if (CA.length >= 2 && CB.length >= 2) return similarity(CA, CB) >= threshold;
    }
    if (A.length < minTokens || B.length < minTokens) return false;
    return similarity(A, B) >= threshold;
}

/**
 * A transcript excerpt is the same speech even when speech-to-text differs a little. Dice ≥ 0.8
 * over Unicode-safe token sets; a match that shares only boilerplate ("this is a live stream" vs
 * "this is a live chat") is not enough.
 */
function isSameSpeech(a, b, { threshold = 0.8 } = {}) {
    const A = tokens(a), B = tokens(b);
    if (!A.length || !B.length) return false;
    if (normalize(a) === normalize(b)) return true;
    if (similarity(A, B) < threshold) return false;
    const CA = contentTokens(a), CB = contentTokens(b);
    if (CA.length || CB.length) {
        const cbSet = new Set(CB);
        return CA.some((t) => cbSet.has(t));
    }
    return true;
}

/** Frame embeddings, when the caller has them: the same footage scores near 1. */
function isSameEmbedding(a, b, { threshold = 0.92 } = {}) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return false;
    return cosine(a, b) >= threshold;
}

module.exports = {
    normalize, tokens, contentTokens, similarity, cosine, shortSignature,
    isSameScene, isSameSpeech, isSameEmbedding,
};
