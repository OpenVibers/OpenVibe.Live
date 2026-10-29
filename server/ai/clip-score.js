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
 *     → { score, verdict, parts, reasons, bucket, evidence }
 *
 * The AI's "no" is a veto. With the AI off (ai.clip === null) its part is neutral and both bars rise, as the cutter's
 * old no-AI rule required a stronger spike. Pure: no I/O, so the bars can be tuned against labelled moments.
 *
 * Calibrated by the production audit (C01, 2026-10-29: research-2026-10-29/clip-audit.md). The old rule made 99.6 % of
 * automatic clips public, 29 % were never watched by a person in 30 days, and neither the spike nor the audience
 * predicted a watch. So:
 *   - evidence first: a moment is kept only with a real spike (≥ 3× the average and ≥ 10 messages), a strong sound or
 *     ≥ 20 spoken words — never on the AI's yes alone;
 *   - public only from the reacted bucket: a score ≥ 0.70 and ≥ 12 messages in the peak from ≥ 3 people (unknown
 *     chatters are never public);
 *   - every cut says its bucket (A no chat · B 1–5 · C 6–11 · D ≥ 12 with ≥ 3 people) so the next audit can measure them.
 */

// keep 0.40 is where the old rule's borderline clips land (a 2.5× spike the AI agreed with): they are kept, unlisted;
// public needs a clear moment, in the reacted bucket (above).
const BARS = Object.freeze({ keep: 0.4, public: 0.7, noAiRaise: 0.1 });
// The evidence a kept moment needs, and the reacted bucket a public one needs (C01).
const EVIDENCE = Object.freeze({ ratio: 3, peak: 10, soundConfidence: 0.6, words: 20 });
const REACTED = Object.freeze({ peak: 12, people: 3 });
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
    const strongSound = loud.some((s) => Number(s.confidence) >= EVIDENCE.soundConfidence);
    const evidence = (ratio >= EVIDENCE.ratio && peak >= EVIDENCE.peak) || strongSound || Number(speechWords) >= EVIDENCE.words;
    const bucket = peak <= 0 ? 'A' : peak <= 5 ? 'B' : peak < REACTED.peak || !(chatters >= REACTED.people) ? 'C' : 'D';
    let verdict;
    if (ai.clip === false) verdict = 'skip';
    else if (!evidence) { verdict = 'skip'; reasons.push('nothing but the AI\'s yes: no real spike, strong sound or speech'); }
    else if (total >= BARS.public + raise && bucket === 'D') verdict = 'public';
    else if (total >= BARS.keep + raise) verdict = 'unlisted';
    else verdict = 'skip';
    if (verdict === 'unlisted' && total >= BARS.public + raise && bucket !== 'D') reasons.push(chatters == null ? 'kept unlisted: how many people reacted is unknown' : `kept unlisted: ${peak} messages from ${chatters} people is not a crowd yet`);
    return { score: Math.round(total * 1000) / 1000, verdict, parts, reasons, bucket, evidence };
}

module.exports = { score, BARS, WEIGHTS, STRONG_SOUND, EVIDENCE, REACTED };
