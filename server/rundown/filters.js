'use strict';
/**
 * The Rundown's checks on what the desk keeps (server/rundown/desk.js).
 *
 * Speech-to-text hears a stream's whole audio track: a game's announcer and characters, videos, songs and articles read
 * aloud sit beside the streamer's own voice. On 2026-10-18 the Arena's "quote of the day" was League of Legends'
 * announcer ("You have slain an enemy"), credited to iZoR_One. So:
 *   gameLine(text)          a line a game says, never a streamer's own words (also dropped before the AI reads them)
 *   verifiedQuote(q, text)  a quote is kept only when it is in the transcript the AI read, word for word, and is no game line
 *   addsAccusation(t, src)  an AI line may use an accusing word (threat, attack, scam…) only when the transcript did
 *   slugify / sameTopic     topic identity
 */

// Announcer and system lines of the games streamed here (League of Legends, Counter-Strike, Valorant), as speech-to-text
// writes them. Whole-phrase patterns only: a streamer saying "first blood" in a sentence about the game still is the
// streamer, but these lines are exactly what the game says.
const GAME_LINES = [
    /^(?:an? )?(?:enemy|ally) (?:has been slain|double kill|triple kill|quadra kill|penta kill)\.?$/i,
    /\byou have (?:slain an? enemy|been slain)\b/i,
    /\b(?:an )?(?:enemy|ally) has been slain\b/i,
    /^(?:first blood|double kill|triple kill|quadra kill|penta ?kill|killing spree|rampage|unstoppable|dominating|godlike|legendary|ace|shut ?down|victory|defeat)[.!]?$/i,
    /\bwelcome to summoner'?s rift\b/i,
    /\b(?:thirty seconds until minions spawn|minions have spawned)\b/i,
    /\b(?:your|the enemy|our) team has (?:destroyed|taken|slain) (?:a |an |the )?(?:turret|inhibitor|dragon|baron|herald|nexus)\b/i,
    /\b(?:an )?inhibitor (?:is respawning|has been destroyed)\b/i,
    /\b(?:your|the enemy) (?:turret|inhibitor) has been destroyed\b/i,
    /^(?:counter[- ]?)?terrorists win[.!]?$/i,
    /\bthe bomb has been (?:planted|defused)\b/i,
    /^spike (?:planted|defused)[.!]?$/i,
];
function gameLine(text) {
    const t = String(text || '').trim();
    return !!t && GAME_LINES.some((re) => re.test(t));
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The quote, trimmed, when it is in `source` (the lines the AI read) word for word and no game line; else null. */
function verifiedQuote(quote, source) {
    const q = String(quote || '').replace(/\s+/g, ' ').trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
    const nq = norm(q);
    if (nq.split(' ').filter(Boolean).length < 3 || gameLine(q)) return null;
    return norm(source).includes(nq) ? q.slice(0, 400) : null;
}

// Words that accuse a real person of something (the list the Arena's desk used after it rewrote a beef built on a game's
// voice lines as "DEATH THREATS", 2026-10-18).
const ACCUSING = /\b(threat\w*|death|deadly|kill\w*|murder\w*|abus\w*|assault\w*|attack\w*|violen\w*|harass\w*|stalk\w*|racis\w*|nazi\w*|crim(?:e|es|inal\w*)|illegal\w*|weapon\w*|groom\w*|predator\w*|pedo\w*|doxx?\w*|rap(?:e|es|ed|ist\w*)|scam\w*|fraud\w*|cheat\w*|steal\w*|stole\w*|hack(?:ed|er|ers|ing)?)\b/gi;
/** Does `text` use an accusing word whose root (its first four letters: hackers ~ hacked) `source` never used? */
function addsAccusation(text, source) {
    const root = (w) => w.toLowerCase().slice(0, 4);
    const have = new Set((String(source || '').match(ACCUSING) || []).map(root));
    return (String(text || '').match(ACCUSING) || []).some((w) => !have.has(root(w)));
}

function slugify(title) {
    return norm(title).replace(/ /g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '');
}

const STOP = new Set(['the', 'and', 'for', 'with', 'about', 'from', 'that', 'this', 'their', 'into', 'over', 'what', 'who', 'how', 'why', 'are', 'was', 'his', 'her', 'its', 'new', 'old', 'vs']);
const keyWords = (t) => new Set(norm(t).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)));
/** Two topic names for one subject: most of their key words shared ("League ranked matchmaking" ~ "Ranked matchmaking in League"). */
function sameTopic(a, b) {
    const x = keyWords(a), y = keyWords(b);
    if (!x.size || !y.size) return false;
    let both = 0;
    for (const w of x) if (y.has(w)) both++;
    return both / (x.size + y.size - both) >= 0.6;
}

module.exports = { gameLine, verifiedQuote, addsAccusation, slugify, sameTopic, norm, GAME_LINES };
