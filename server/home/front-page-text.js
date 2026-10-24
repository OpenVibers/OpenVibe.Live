'use strict';
/**
 * What streamers said, as the home page's "Lately on OpenVibe" strip quotes it: the front page of the site, read by
 * everyone who arrives. A quote with a slur (chat's built-in categories), strong profanity or a hate topic out of
 * context ("…that's got an anti-semitic trope", "…people that I want to fucking follow anymore", the strip on
 * 2026-10-24) is left off it; the next best take is shown instead. The Rundown keeps every take as said.
 */
const { CORE_SLUR_CATEGORIES } = require('../chat/moderation-utils');

const ROUGH = /\b(?:f+u+c+k\w*|motherf\w*|sh[i1]t(?:s|ty|ting|ted)?|bullshit|cunts?|bitch\w*|whores?|sluts?|pussy|retard\w*|nazis?|hitler|holocaust|anti-?semit\w*|kkk|rap(?:e|ed|es|ist|ists|ing))\b/i;
const SLUR_RES = CORE_SLUR_CATEGORIES.map((c) => ({ c, res: c.patterns.map((p) => new RegExp(p, 'i')) }));

/** True when the text may lead the front page. */
function frontPageOk(text) {
    const t = String(text || '');
    if (!t.trim() || ROUGH.test(t)) return false;
    return !SLUR_RES.some(({ c, res }) => c.generateCandidates(t).some((x) => res.some((re) => re.test(x))));
}

module.exports = { frontPageOk };
