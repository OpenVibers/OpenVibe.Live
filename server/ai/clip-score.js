'use strict';

/**
 * How good an automatic clip would be, before it is cut (owner 2026-10-29: "some of the clips suck … needs to be more
 * intelligent"). The live cutter used to cut whenever chat crossed a spike ratio and the AI said yes, so a moment that
 * only just cleared the bar became a public clip like any other. This module turns what the cutter already gathers into
 * one score from 0 to 1, with its reasons, and a verdict:
 *
 *   skip      — below the minimum bar: no clip at all ("no clip beats a bad clip");
 *   unlisted  — worth keeping, not worth the public feed: the streamer can still find it and make it public;
 *   public    — a clear moment.
 *
 *   score({ spike: { peak, avg }, chatters, sounds: [{ label, confidence }], speechWords, ai: { clip } })
 *     → { score, verdict, parts, reasons }
 *
 * The AI's "no" is a veto. With the AI off (ai.clip === null) its part is neutral and both bars rise, as the cutter's
 * old no-AI rule required a stronger spike. Pure: no I/O, so the bars can be tuned against labelled moments.
 */

// keep 0.40 is where the old rule's borderline clips land (a 2.5× spike the AI agreed with): they are kept, unlisted;
// public needs a clear moment. Calibrate both against C01's production audit.
const BARS = Object.freeze({ keep: 0.4, public: 0.65, noAiRaise: 0.1 });
const WEIGHTS = Object.freeze({ spike: 0.35, breadth: 0.15, sound: 0.15, speech: 0.1, ai: 0.25 });
// Sounds people clip for: laughter, a crowd, a bang. Speech and music alone are not a moment.
const STRONG_SOUND = /laugh|cheer|applause|clap|crowd|scream|shout|explosion|gunshot|gunfire|boom|crash|siren|whistle|gasp/i;

const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const ramp = (v, lo, hi) => clamp((Number(v) - lo) / (hi - lo));

function score({ spike = {}, chatters = null, sounds = [], speechWords = 0, ai = {} } = {}) {
    const peak = Math.max(0, Number(spike.peak) || 0);
    const avg = Math.max(0, Number(spike.avg) || 0);
    const ratio = peak / Math.max(1, avg);
    // A spike is strong when it is far above the window's average AND big in absolute terms (6 messages in a quiet
    // room is a ratio of 6 but a weak signal; 40 in a busy one at 2× is a real one).
    const spikePart = 0.6 * ramp(ratio, 1.5, 6) + 0.4 * ramp(peak, 6, 30);
    // How many different people reacted: one excited viewer is not a moment. Unknown → it follows the spike.
    const breadthPart = chatters == null ? spikePart : ramp(chatters, 2, 10);
    const loud = (sounds || []).filter((s) => s && STRONG_SOUND.test(String(s.label || '')));
    const soundPart = loud.length ? clamp(Math.max(...loud.map((s) => Number(s.confidence) || 0))) : 0;
    const speechPart = ramp(speechWords, 0, 40);
    const aiPart = ai.clip === true ? 1 : ai.clip === false ? 0 : 0.5;
    const parts = { spike: spikePart, breadth: breadthPart, sound: soundPart, speech: speechPart, ai: aiPart };
    const total = Object.keys(WEIGHTS).reduce((sum, k) => sum + WEIGHTS[k] * parts[k], 0);
    const raise = ai.clip == null ? BARS.noAiRaise : 0;
    const reasons = [];
    if (ai.clip === false) reasons.push('the AI said it is not a moment');
    if (spikePart < 0.3) reasons.push(`a weak chat spike (${peak} messages, ${ratio.toFixed(1)}× the average)`);
    if (chatters != null && chatters < 3) reasons.push(`only ${chatters} people reacted`);
    if (loud.length) reasons.push(`heard: ${loud.map((s) => s.label).slice(0, 3).join(', ')}`);
    let verdict;
    if (ai.clip === false) verdict = 'skip';
    else if (total >= BARS.public + raise) verdict = 'public';
    else if (total >= BARS.keep + raise) verdict = 'unlisted';
    else verdict = 'skip';
    return { score: Math.round(total * 1000) / 1000, verdict, parts, reasons };
}

module.exports = { score, BARS, WEIGHTS, STRONG_SOUND };
