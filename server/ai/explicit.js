'use strict';
/**
 * AI text that says a frame or clip shows sex acts or pornography, or anything sexual involving a minor.
 * Describing people is fine, and so is nudity: the owner, 2026-10-31, "dick is art. Penis is art. Vagina is
 * art. Titties is art… stop being against art on my platform." What stays is sex itself: on 2026-10-23 an AI
 * auto-clip of a stream that showed sexual acts went public on openvibe.media and Live's home with its
 * description (clip 483). Porn brings age-verification and record-keeping duties that an adults-only section
 * would have to meet; until there is one, the AI does not promote it.
 *
 * VIS-6's decision (2026-11-06) gives every AI text exactly three categories:
 *
 *   fine          allowed, including nudity
 *   sex_acts      never public: the clip is made private and kept for its owner
 *   minor_sexual  always blocked: private even for the owner's page, and an operator report record is made
 *                 through OpenVibe.Vision. Nothing is reported to an external authority from here.
 *
 * A moment whose text is sex_acts or minor_sexual is never picked, posted or clipped (ai-moments-job.js,
 * auto-clip-job.js), and an AI-made clip whose overview is one of them goes private (guardAutoClip). A
 * category-3 clip is blocked even when it is not AI-made. People's own clips stay theirs otherwise.
 */
const media = require('../media-client');

// What a scene shows, not what someone talks about in passing: sex acts and pornography. Nudity and body words
// are not in it (a nude body is not a sex act).
const EXPLICIT = /\b(?:sexual(?:ly)?\s+(?:acts?|activity|intercourse)|sex\s+acts?|having\s+sex|(?:pornographic|sexually\s+explicit|explicit\s+adult)\s+(?:content|material|footage|scenes?|imagery|videos?|acts?)|adult\s+(?:films?|videos?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|oral\s+sex|penetrat\w*)\b/i;

// The hard line that nudity being art never moves: a child and a bare body in the same text. Not a judgement of the
// words alone ("kids in swimsuits at the beach" is not this); a child together with nudity or genitals is treated as
// sexual content involving a minor, so the moment is never picked and the clip is quarantined for the operator.
const MINOR = /\b(?:child(?:ren)?|kids?|minors?|teen(?:age(?:rs?)?|s)?|toddlers?|bab(?:y|ies)|infants?|boys?|girls?|underage)\b/i;
const NUDE = /\b(?:naked|nude|nudity|undress(?:ed|ing)?|topless|bottomless|genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|breasts?|nipples?)\b/i;
const minorNude = (t) => MINOR.test(t) && NUDE.test(t);

const CATEGORIES = Object.freeze(['fine', 'sex_acts', 'minor_sexual']);
const PLAIN = Object.freeze({
    fine: 'Fine — OK to show, including nudity',
    sex_acts: 'Sex acts or porn — never public; kept for its owner',
    minor_sexual: 'Sexual content involving a minor — always blocked and reported to the operator',
});
const ACTION = Object.freeze({ fine: 'allow', sex_acts: 'hide', minor_sexual: 'quarantine_and_report' });

/** Sort one or more AI texts into exactly one category. */
function classifyText(...texts) {
    const all = texts.filter((t) => t != null).map(String).join('\n').trim();
    if (!all) return { category: 'fine', reason: 'there is no text to judge' };
    if (minorNude(all)) return { category: 'minor_sexual', reason: 'the text puts a child together with nudity' };
    if (EXPLICIT.test(all)) return { category: 'sex_acts', reason: 'the text describes sex acts or pornography' };
    if (MINOR.test(all)) return { category: 'fine', reason: 'a child is mentioned without nudity or a sex act' };
    if (NUDE.test(all)) return { category: 'fine', reason: 'the text describes nudity, which is allowed' };
    return { category: 'fine', reason: 'the text describes neither sex acts nor a child with nudity' };
}

/** True when any of the texts is sex_acts or minor_sexual. Kept for every caller that only needs the gate. */
function isExplicit(...texts) {
    return classifyText(...texts).category !== 'fine';
}

/**
 * After a clip's AI overview is stored: a clip whose overview is sex_acts or minor_sexual is made private and
 * loses its description. A category-3 clip is blocked even when it is not AI-made, and Vision is asked for the
 * operator's report record (best effort; the clip is hidden even when Vision is unreachable).
 * → true when the clip was hidden by this call.
 */
async function guardAutoClip(clip, overview) {
    if (!clip || !clip.id) return false;
    const verdict = classifyText(overview);
    if (verdict.category === 'fine') return false;
    try {
        const c = clip.auto_generated === undefined || clip.visibility === undefined ? await media.getClip(clip.id) : clip;
        if (!c) return false;
        // A person's own clip is not touched for sex acts; the hard line is blocked whoever made it.
        if (verdict.category === 'sex_acts' && !c.auto_generated) return false;
        // The hard line's operator record is made even if hiding the clip then fails.
        if (verdict.category === 'minor_sexual') {
            try {
                const out = await require('./review-client').reportMinorSexual({
                    clip: { ...c, id: c.id || clip.id }, text: overview, ownerSubject: c.owner_subject || null,
                });
                if (!out || !out.review || !out.review.report) {
                    console.warn(`[AI] Clip ${clip.id}: minor-sexual content but no operator report record was made`);
                }
            } catch (e) {
                console.warn(`[AI] Clip ${clip.id}: minor-sexual content, but Vision did not record the operator report:`, e.message);
            }
        }
        let changed = false;
        if (c.visibility !== 'private') {
            await media.updateClip(clip.id, { visibility: 'private', description: '' });
            changed = true;
        }
        if (changed) console.warn(`[AI] Clip ${clip.id} made private: its AI overview is ${verdict.category} (${PLAIN[verdict.category]})`);
        return changed;
    } catch (e) {
        console.warn(`[AI] Clip ${clip.id}: ${verdict.category} overview, but it could not be made private:`, e.message);
        return false;
    }
}

module.exports = { isExplicit, classifyText, guardAutoClip, EXPLICIT, MINOR, NUDE, CATEGORIES, PLAIN, ACTION };
