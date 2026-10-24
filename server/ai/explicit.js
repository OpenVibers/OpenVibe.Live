'use strict';
/**
 * AI text that says a frame or clip shows sexual content. The no-looks rules (openvibe-sdk/no-looks) take out how a
 * person looks; they were never meant to judge what a scene shows, and an adjective-only filter turns "a naked man …
 * reaching toward their genitals" into "a man … reaching toward their genitals". On 2026-10-23 an AI auto-clip of a
 * stream that showed sexual acts went public on openvibe.media and Live's home with that description (clip 483).
 *
 * So: a moment whose AI text is explicit is never picked, posted or clipped (ai-moments-job.js, auto-clip-job.js),
 * and an AI-made clip whose overview turns out explicit goes private (guardAutoClip). People's own clips are theirs
 * to publish: only the AI's are changed. The owner decides about the stream itself.
 */
const media = require('../media-client');

// What a scene shows, not what someone talks about in passing: body parts, sex acts, pornography, nudity.
const EXPLICIT = /\b(?:genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|sexual(?:ly)?\s+(?:acts?|activity|content|material|explicit|intercourse)|sex\s+acts?|(?:explicit|adult|pornographic|sexual)\s+(?:content|material|footage|scenes?|imagery|videos?|acts?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|nudity|erotica?)\b/i;

/** True when any of the texts describes sexual content. */
function isExplicit(...texts) {
    return texts.some((t) => t != null && EXPLICIT.test(String(t)));
}

/**
 * After a clip's AI overview is stored: an AI-made clip whose overview is explicit goes private and loses its
 * description. A clip object from an event may not say whether the AI made it, so Media is asked then (rare: only for
 * an explicit overview). → true when the clip was made private.
 */
async function guardAutoClip(clip, overview) {
    if (!clip || !clip.id || !isExplicit(overview)) return false;
    try {
        const c = clip.auto_generated === undefined ? await media.getClip(clip.id) : clip;
        if (!c || !c.auto_generated || c.visibility === 'private') return false;
        await media.updateClip(clip.id, { visibility: 'private', description: '' });
        console.warn(`[AI] Auto-clip ${clip.id} made private: its AI overview describes sexual content (the owner reviews the stream)`);
        return true;
    } catch (e) {
        console.warn(`[AI] Auto-clip ${clip.id}: explicit overview, but it could not be made private:`, e.message);
        return false;
    }
}

module.exports = { isExplicit, guardAutoClip, EXPLICIT };
