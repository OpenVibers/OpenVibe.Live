'use strict';
/**
 * What the home hero's AI copy may say ("Live streaming for {audience}" and the quips under it). The slogan job
 * (server/ai/slogan-job.js) writes it from real chat and streams, so it names real people, and it is the first line
 * every visitor reads. Checked when a batch is stored and again when the hero serves one, so a rule added later
 * also cleans a batch stored before it.
 *
 *   publicOk(text)  false when the text breaks any rule below
 */

// The owner's rule: no "free"/"$0" copy anywhere.
const NO_FREE = /\b(free|no[- ]cost)\b|\$\s?0\b/i;
// Describing people and nudity are fine (owner, 2026-10-31). The front page never puts a child and bare skin in one
// line.
const MINOR = /\b(teen(age)?|kids?|child(ren)?|boys?|girls?)\b/i;
const SKIN = /\b(shirtless|topless|bare-?chested|cleavage|bikini|underwear|naked|nude|nudity|undress\w*)\b/i;
const MINOR_SKIN = { test: (s) => MINOR.test(s) && SKIN.test(s) };
// No profanity, toilet jokes or porn on the front page, whatever chat joked about. Bodies are fine (owner, 2026-10-31).
const CRUDE = /\b(cum|horny|porn\w*|nsfw|fuck\w*|shit\w*|piss\w*|bitch\w*|cunt|wank\w*|poop\w*|fart\w*|turds?|ass(hole)?s?|butthole)\b/i;
// A keyboard mash taken for a name ("qeqweqwe watchers").
const MASH = /(qwe|ewq|asdf|sdfg|zxcv|qeqw)/i;

const RULES = [NO_FREE, MINOR_SKIN, CRUDE, MASH];

function publicOk(text) {
    const s = String(text == null ? '' : text);
    return !RULES.some((re) => re.test(s));
}

module.exports = { publicOk, NO_FREE, MINOR_SKIN, CRUDE, MASH };
