'use strict';
/**
 * clip-publication.js — how visible an AI clip may be (item 151, C16: "gate publication and preserve protected
 * private content").
 *
 * A clip is never more visible than the recording it is cut from: a private recording's clip is private, an unlisted
 * recording's is at most unlisted, and only a public recording's clip can be public, when the picker's score says so.
 * A recording that is protected for good (VOD 5709) is never cut. Media makes a clip public when no visibility is
 * sent, and does not look at the source, so every AI cut sends the one this decides.
 *
 *   visibilityFor({ vodVisibility, wanted }) → 'public' | 'unlisted' | 'private'
 *   mayCut(vodId) → false for a protected recording
 *   vodVisibility(vod) → the recording's visibility (asked from Media when the row does not say), 'private' when
 *                        Media cannot tell
 */
const media = require('../media-client');

// Protected for good (owner, 2026-10-29): never cut again, never republished. Clip 483 is kept private by
// auto-clip-flag sync and the clip evaluation; this list is the recordings.
const NEVER_CUT = new Set(['5709']);
const RANK = { private: 0, unlisted: 1, public: 2 };

function normalize(v, fallback = 'private') {
    const s = String(v || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(RANK, s) ? s : fallback;
}

/** The lower of what the picker wants and what the recording allows. */
function visibilityFor({ vodVisibility, wanted = 'public' } = {}) {
    const cap = normalize(vodVisibility, 'private');
    const want = normalize(wanted, 'unlisted');
    return RANK[want] <= RANK[cap] ? want : cap;
}

function mayCut(vodId) {
    return !NEVER_CUT.has(String(vodId));
}

async function vodVisibility(vod) {
    if (vod && typeof vod.visibility === 'string' && vod.visibility) return normalize(vod.visibility);
    if (vod && typeof vod.is_public === 'boolean') return vod.is_public ? 'public' : 'private';
    const id = vod && (vod.vod_id || vod.id);
    if (!id) return 'private';
    try {
        const v = await media.getVod(id, { timeoutMs: 10_000 });
        if (v && typeof v.visibility === 'string' && v.visibility) return normalize(v.visibility);
        if (v && typeof v.is_public === 'boolean') return v.is_public ? 'public' : 'private';
    } catch { /* unknown: treated as private below */ }
    return 'private';
}

module.exports = { visibilityFor, mayCut, vodVisibility, NEVER_CUT };
