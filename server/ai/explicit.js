'use strict';
/**
 * AI text that says a frame or clip shows sex acts or pornography. Describing people is fine, and so is nudity: the
 * owner, 2026-10-31, "dick is art. Penis is art. Vagina is art. Titties is art… stop being against art on my
 * platform." What stays is sex itself: on 2026-10-23 an AI auto-clip of a stream that showed sexual acts went public
 * on openvibe.media and Live's home with its description (clip 483). Porn brings age-verification and record-keeping
 * duties that an adults-only section would have to meet; until there is one, the AI does not promote it.
 *
 * So: a moment whose AI text is explicit is never picked, posted or clipped (ai-moments-job.js, auto-clip-job.js),
 * and an AI-made clip whose overview turns out explicit goes private (guardAutoClip). People's own clips are theirs
 * to publish: only the AI's are changed. The owner decides about the stream itself.
 */
const media = require('../media-client');

// What a scene shows, not what someone talks about in passing: sex acts and pornography. Nudity and body words are
// not in it (a nude body is not a sex act).
const EXPLICIT = /\b(?:sexual(?:ly)?\s+(?:acts?|activity|intercourse)|sex\s+acts?|having\s+sex|(?:pornographic|sexually\s+explicit|explicit\s+adult)\s+(?:content|material|footage|scenes?|imagery|videos?|acts?)|adult\s+(?:films?|videos?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|oral\s+sex|penetrat\w*)\b/i;

// The hard line that nudity being art never moves: a child and a bare body in the same text. Not a judgement of the
// words alone ("kids in swimsuits at the beach" is not this); a child together with nudity or genitals is treated as
// explicit, so the moment is never picked and an AI clip of it goes private for the owner to review.
const MINOR = /\b(?:child(?:ren)?|kids?|minors?|teen(?:age(?:rs?)?|s)?|toddlers?|bab(?:y|ies)|infants?|boys?|girls?|underage)\b/i;
const NUDE = /\b(?:naked|nude|nudity|undress(?:ed|ing)?|topless|bottomless|genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|breasts?|nipples?)\b/i;
const minorNude = (t) => MINOR.test(t) && NUDE.test(t);

/** True when any of the texts describes sex acts or pornography, or puts a child and nudity together. */
function isExplicit(...texts) {
    return texts.some((t) => t != null && (EXPLICIT.test(String(t)) || minorNude(String(t))));
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
        console.warn(`[AI] Auto-clip ${clip.id} made private: its AI overview describes sex acts (the owner reviews the stream)`);
        return true;
    } catch (e) {
        console.warn(`[AI] Auto-clip ${clip.id}: explicit overview, but it could not be made private:`, e.message);
        return false;
    }
}

module.exports = { isExplicit, guardAutoClip, EXPLICIT, MINOR, NUDE };
