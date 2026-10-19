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
 *   privateDetail(text)     a time zone, school, street address, phone number or email: never kept
 *   slugify / sameTopic     topic identity
 *   lineLang(text)          a line's language, roughly (desk.js keeps a streamer's own languages, so a clip in Portuguese
 *                           playing on a Greek streamer's stream is never theirs)
 */

// Announcer and system lines of the games streamed here (League of Legends, Counter-Strike, Valorant), as speech-to-text
// writes them. Whole-phrase patterns only: a streamer saying "first blood" in a sentence about the game still is the
// streamer, but these lines are exactly what the game says.
const GAME_LINES = [
    /^(?:an? )?(?:enemy|ally) (?:has been slain|double kill|triple kill|quadra kill|penta kill)\.?$/i,
    /\byou have (?:slain an? enemy|been slain)\b/i,
    /\b(?:an )?(?:enemy|ally) has been slain\b/i,
    /^(?:i'?ve|i have|you'?ve) been slain[.!]?$/i,
    /^(?:the )?(?:first blood|double kill|triple kill|quadra kill|penta ?kill|killing spree|rampage|unstoppable|dominating|godlike|legendary|ace|shut ?down|victory|defeat)[.!]?$/i,
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

// A line's language, roughly: by script (Greek, Cyrillic, Japanese, Chinese, Korean, Arabic), else by common words among
// English, Portuguese, Spanish, French, German and Italian; null when a line is too short to tell.
const STOPWORDS = {
    en: ['the', 'and', 'you', 'that', 'is', 'it', 'what', 'i', 'to', 'this', 'are', 'my', 'so', 'bro', 'yeah', 'just', 'like', 'gonna', 'chat', 'guys', 'okay', 'oh', 'no'],
    pt: ['eu', 'você', 'voce', 'que', 'não', 'nao', 'essa', 'esse', 'isso', 'muito', 'está', 'esta', 'meu', 'minha', 'então', 'também', 'nenhum', 'foi', 'uma', 'com', 'para', 'tudo'],
    es: ['que', 'el', 'la', 'los', 'las', 'pero', 'muy', 'está', 'esto', 'eso', 'yo', 'tú', 'qué', 'por', 'con', 'una', 'para', 'como', 'bueno', 'vamos'],
    fr: ['le', 'la', 'les', 'est', 'je', 'tu', 'pas', 'que', 'une', 'des', 'et', 'ça', "c'est", 'mais', 'avec', 'pour', 'oui', 'non'],
    de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'nicht', 'du', 'ein', 'eine', 'zu', 'mit', 'auch', 'was', 'ja', 'nein'],
    it: ['che', 'il', 'non', 'è', 'per', 'una', 'sono', 'questo', 'ma', 'come', 'anche', 'perché', 'molto', 'io'],
};
function lineLang(text) {
    const t = String(text || '');
    if (/[Ͱ-Ͽἀ-῿]/.test(t)) return 'el';
    if (/[Ѐ-ӿ]/.test(t)) return 'ru';
    if (/[぀-ヿ]/.test(t)) return 'ja';
    if (/[一-鿿]/.test(t)) return 'zh';
    if (/[가-힯]/.test(t)) return 'ko';
    if (/[؀-ۿ]/.test(t)) return 'ar';
    const ws = t.toLowerCase().normalize('NFC').split(/[^\p{L}']+/u).filter(Boolean);
    if (ws.length < 3) return null;
    let best = null, bestN = 0;
    for (const [k, list] of Object.entries(STOPWORDS)) { const n = ws.filter((w) => list.includes(w)).length; if (n > bestN) { best = k; bestN = n; } }
    return best;
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

// Details that place a person (the prompts forbid them; this is the check after): a time zone, school, a street address,
// a phone number or an email address. A teen streamer's theme-park stream was written up with "around eight mountain
// time" and school details on the first night (2026-10-19).
const PRIVATE = [
    /\b(?:mountain|pacific|eastern|central|atlantic|alaska|hawaii)\s+(?:standard\s+|daylight\s+)?time\b/i,
    /\b(?:[ECMP][SD]T|AKST|HST)\b/,
    /\b(?:my|our|at|his|her|their|the|to|from|after)\s+(?:high\s+|middle\s+|elementary\s+)?school\b|\bschool\s+(?:newspaper|bus|trip|kids)\b|\bclassmates?\b|\bhomeroom\b|\bmy\s+teacher\b/i,
    /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b/,
    /(?:\+?\d[\s().-]?){10,}/,
    /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,
];
/** Does `text` name a time zone, a school, a street address, a phone number or an email address? */
function privateDetail(text) {
    const t = String(text || '');
    return PRIVATE.some((re) => re.test(t));
}

// A topic name that names no subject: a kind ("chat", "games", "life"…) or a word for streaming itself. The model filed 35
// segments under "chat", "games" and "life" once the first of them was in the known topics it is asked to reuse.
const VAGUE = new Set(['news', 'games', 'game', 'tech', 'life', 'music', 'sports', 'money', 'internet', 'chat', 'other', 'gaming', 'gameplay',
    'chatting', 'just chatting', 'stream', 'streaming', 'the stream', 'stream talk', 'misc', 'general', 'random', 'stuff', 'irl', 'talk', 'conversation',
    'banter', 'reactions', 'updates', 'life update', 'nothing']);
// Words for a mood, the play or the stream, not a subject. A topic made only of them ("Frustration and chaos in the
// match", "Talking with chat and teammates") gathered a night of play-by-play from every game: 106 and 84 takes.
const GENERIC = new Set(['frustration', 'frustrated', 'chaos', 'chaotic', 'rage', 'raging', 'tilt', 'tilted', 'salt', 'salty', 'vent',
    'venting', 'rant', 'rants', 'ranting', 'reaction', 'reactions', 'reacting', 'hype', 'mood', 'vibes', 'energy', 'moment', 'moments',
    'highlights', 'talking', 'chatting', 'chat', 'teammates', 'team', 'match', 'matches', 'game', 'games', 'gaming', 'gameplay', 'round',
    'rounds', 'play', 'plays', 'stream', 'streaming', 'streamer', 'viewers', 'mid', 'calls', 'commands', 'builds', 'criticism', 'banter',
    'jokes', 'stuff', 'things', 'life', 'random', 'night', 'session', 'fun', 'drama', 'confusion', 'mistakes']);
/** Is this topic name too vague to be a topic? A kind, a word for streaming, or only words for a mood or the play. */
function vagueTopic(title) {
    const t = norm(title);
    return !t || VAGUE.has(t) || t.length < 4 || [...keyWords(title)].every((w) => GENERIC.has(w));
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

// A chat message the stream's TTS read aloud is heard by speech-to-text and lands in the transcript as if the streamer
// said it ("WTF this site is so cool." on goosely's stream, 2026-10-19). A line that holds most of the words of a chat
// message sent shortly before it is the message, not the streamer.
const READ_ALOUD_BEFORE = 120;   // TTS queues: a message can be read up to two minutes after it was sent
const READ_ALOUD_AFTER = 5;      // speech-to-text times are a little early at times
const tokens = (t) => norm(t).split(' ').filter(Boolean);
/** Messages as [{ at: seconds into the stream, words: Set }] for readAloud(); messages under 3 words never count. */
function chatHeard(messages) {
    return (messages || []).map((m) => ({ at: Number(m.at), words: new Set(tokens(m.text)) })).filter((m) => Number.isFinite(m.at) && m.words.size >= 3);
}
/** Is this speech line (at `t` seconds) a chat message read aloud? `heard` from chatHeard(). */
function readAloud(text, t, heard) {
    if (!heard || !heard.length) return false;
    const line = new Set(tokens(text));
    if (line.size < 3) return false;
    for (const m of heard) {
        if (m.at > t + READ_ALOUD_AFTER || m.at < t - READ_ALOUD_BEFORE) continue;
        let both = 0;
        for (const w of m.words) if (line.has(w)) both++;
        if (both / m.words.size >= 0.7) return true;
    }
    return false;
}

module.exports = { gameLine, verifiedQuote, addsAccusation, privateDetail, vagueTopic, slugify, sameTopic, norm, lineLang, chatHeard, readAloud, GAME_LINES };
