'use strict';
/**
 * Content labels (L1, labels and choices, 2026-10-31; Contracts 0.257.0 common.content-labels@1).
 *
 * The one label list, the shape a stream stores and returns, the creator's write, and the AI's *suggestion*.
 * A label is never a ban: it never hides content from the person who posted it, and it changes nothing until the
 * creator confirms it. The AI only ever writes to `suggested`; a suggestion never moves itself into `labels`.
 */
const LABELS = Object.freeze(['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']);
const SHAPE = Object.freeze({ labels: Object.freeze([]), suggested: Object.freeze([]) });

const isLabel = (x) => typeof x === 'string' && LABELS.includes(x);

/** A clean label list from a creator's request, or null when it is not a list of known labels. */
function parseLabels(value) {
    if (!Array.isArray(value)) return null;
    const out = [];
    for (const label of value) {
        if (!isLabel(label)) return null;
        if (!out.includes(label)) out.push(label);
    }
    return out;
}

/** The contract's shape from a jsonb column, a JSON string, or nothing: always two arrays of known labels. */
function labelsOf(row) {
    let raw = row && typeof row === 'object' && 'content_labels' in row ? row.content_labels : row;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
    const pick = (v) => [...new Set((Array.isArray(v) ? v : []).filter(isLabel))];
    return { labels: pick(raw && raw.labels), suggested: pick(raw && raw.suggested) };
}

/** The shape to store: `labels` are in force, `suggested` is still a suggestion. */
const shape = (labels, suggested = []) => ({ labels: [...new Set((labels || []).filter(isLabel))], suggested: [...new Set((suggested || []).filter(isLabel))] });

/** Apply a creator's labels and drop the ones they just confirmed from the suggestions. */
function confirmed(current, labels) {
    const now = labelsOf(current);
    return { labels: [...labels], suggested: now.suggested.filter((l) => !labels.includes(l)) };
}

// What the AI sees in the frame notes and hears in the transcript. Narrow on purpose: a label is a suggestion for
// the creator, not a verdict, and it never touches the content itself.
const NUDITY = /\b(?:nude|naked|nudity|topless|undressed|bare\s+(?:chest|breasts?|bottom)|explicit(?:ly)?\s+(?:adult|sexual)|sexual\s+(?:acts?|content|activity|material)|porn(?:o|ography|ographic)?|erotic\w*|genitals?|masturbat\w*|intercourse)\b/i;
const GRAPHIC = /\b(?:blood(?:y|ied)?|gore|gory|graphic\s+(?:violence|injury)|severe\s+injur\w*|dead\s+body|corpse|mutilat\w*|dismember\w*)\b/i;
const FLASHING = /\b(?:strobe[sd]?|strobing|flashing\s+lights?|seizure\s+warning|epilep\w*)\b/i;
const LANGUAGE = /\b(?:fuck\w*|shit(?:ty|s|ting)?|bitch\w*|cunts?|assholes?|bastards?|dick(?:s|head)?|puss(?:y|ies)|cock(?:s|sucker)?)\b/i;

/**
 * What the AI suggests from one frame's notes and the transcript it heard: nudity from the scene (and 18+ with it),
 * graphic violence and flashing lights from the scene, strong language from what was said. Spoilers cannot be
 * guessed from a frame, so they are never suggested. Order follows the label list.
 */
function suggestFrom({ description, transcript } = {}) {
    const scene = String(description || '');
    const heard = String(transcript || '');
    const found = new Set();
    if (NUDITY.test(scene) || NUDITY.test(heard)) { found.add('nudity'); found.add('18+'); }
    if (LANGUAGE.test(heard)) found.add('language');
    if (GRAPHIC.test(scene)) found.add('graphic');
    if (FLASHING.test(scene)) found.add('flashing');
    return LABELS.filter((l) => found.has(l));
}

module.exports = { LABELS, SHAPE, isLabel, parseLabels, labelsOf, shape, confirmed, suggestFrom };
