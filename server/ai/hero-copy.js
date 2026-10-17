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
// Never a real person's looks or age ("ara007 shirtless thoughts" was served once).
const LOOKS = /\b(shirtless|topless|bare-?chested|naked|nude|cleavage|bikini|underwear|teen(age)?|young|kids?|child(ren)?|boys?|girls?)\b/i;
// Nothing crude or sexual on the front page ("testicle banter crew", 2026-10-17), whatever chat joked about.
const CRUDE = /\b(testic\w*|dick|cock|penis|vagina|puss(y|ies)|boobs?|tits|titties|ass(hole)?s?|butthole|cum|horny|sexy?|porn\w*|nsfw|fuck\w*|shit\w*|piss\w*|bitch\w*|cunt|wank\w*|poop\w*|fart\w*|turds?)\b/i;
// A keyboard mash taken for a name ("qeqweqwe watchers").
const MASH = /(qwe|ewq|asdf|sdfg|zxcv|qeqw)/i;
// Jokes about how few people watch a channel ("goosely's loyal 3 viewers").
const VIEWER_COUNT = /\b\d+\s+(loyal\s+)?(viewers?|watchers?|fans?|followers?)\b/i;

const RULES = [NO_FREE, LOOKS, CRUDE, MASH, VIEWER_COUNT];

function publicOk(text) {
    const s = String(text == null ? '' : text);
    return !RULES.some((re) => re.test(s));
}

module.exports = { publicOk, NO_FREE, LOOKS, CRUDE, MASH, VIEWER_COUNT };
