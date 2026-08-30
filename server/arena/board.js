/**
 * OpenVibe.Live — Arena Board: living lore profiles of whatever the community is on about
 *
 *   topic    → a SUBJECT people are actually talking about (chat, on stream, or both). Topics
 *              are discovered from the global chat + live transcripts (AI every few minutes,
 *              keyword bursts without AI), or started by a signed-in user (`!topic …` / page,
 *              one per person and per IP per 24 h; the AI rewrites it into a proper subject).
 *              Each topic has KEYWORDS; every chat message or transcript line that matches
 *              becomes a MOMENT on the topic (chat lines, on-mic lines with a VOD deep link).
 *   lore     → the AI rewrites the topic's lore as moments pile up: who brought it up, who
 *              said what, who is on which end of it, how it escalated. Tabloid voice, names
 *              names, quotes the receipts. Templated when AI is off. Lore persists in the
 *              archive after the topic cools off.
 *   join in  → a fighter on the roster "talks on" a topic (button / naturally by saying its
 *              keywords on mic). The listener judges their chunks; each judged hit is a moment
 *              with a quality score → XP → Trash Level. Viewers pile on from chat: their lines
 *              become moments, they climb the "yappers" ladder.
 *   bounty   → a fighter the community keeps naming: every beef hit on them pays double.
 *
 * No voting anywhere. Heat = mentions + hype + fighters talking in the last hour.
 * Token discipline: discovery only runs when there is new material, lore only when ≥ 3 new
 * moments landed (and ≥ 8 min since the last rewrite), one refine call per user-made topic.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/database');
const llm = require('../ai/llm');

const TOPIC_TTL_HOURS = 36;
const TOPIC_MAX_LEN = 140;
const XP_PER_LEVEL = 50;
const XP_JOIN = 10;
const XP_HYPE = 2;
const MAX_OPEN_TOPICS = 24;
const KIND_TTL_HOURS = { topic: TOPIC_TTL_HOURS, bounty: 6 };
const HOT_THRESHOLD = 12;
const MENTION_COOLDOWN_SEC = 45;     // one raw on-mic mention moment per stream per topic per window
const LORE_MIN_NEW_MOMENTS = 3;
const LORE_MIN_INTERVAL_MS = 8 * 60 * 1000;
const DISCOVER_INTERVAL_MS = 5 * 60 * 1000;
const DISCOVER_MIN_NEW_LINES = 8;    // don't spend a call on a dead room
const SCAN_WINDOW_MIN = 30;
function scanWindowMin() { try { const v = Number(db.getSetting('arena_discover_window_min')); return v > 0 ? Math.min(v, 24 * 60) : SCAN_WINDOW_MIN; } catch { return SCAN_WINDOW_MIN; } }
const USER_TOPIC_COOLDOWN_HOURS = 24;

const STOPWORDS = new Set(('the a an and or but if then than that this these those there here what when where which who whom why how all any both each few more most other some such no nor not only own same so too very can will just should now is are was were be been being have has had having do does did doing would could might must shall may of at by for with about against between into through during before after above below to from up down in out on off over under again further once i me my myself we our ours you your yours he him his she her hers it its they them their what its lol lmao omg yeah yes okay ok like get got gets going go went thing things stuff really actually literally bro bruh dude guys chat stream streaming streamer live today tonight right know think mean want make made say said says people time way good bad new old big long still even also back much many'
).split(/\s+/));

let _ready = false;
function ensureTables() {
    if (_ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS arena_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        hint TEXT,
        created_by TEXT NOT NULL,
        creator_user_id INTEGER,
        creator_name TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        angles_json TEXT,
        joins INTEGER DEFAULT 0,
        hits INTEGER DEFAULT 0,
        conquered INTEGER DEFAULT 0,
        last_activity_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_topic_members (
        topic_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        active INTEGER DEFAULT 1,
        conquered_at DATETIME,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (topic_id, user_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_topic_hype (
        topic_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        voter_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (topic_id, user_id, voter_key)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_topic_moments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL,
        kind TEXT NOT NULL,              -- 'speech' | 'chat'
        source TEXT NOT NULL,            -- 'mention' | 'judge' | 'chat' | 'seed'
        user_id INTEGER,
        username TEXT,
        stream_id INTEGER,
        vod_id INTEGER,
        sec INTEGER,
        text TEXT NOT NULL,
        quality REAL,
        about TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_moments_topic ON arena_topic_moments (topic_id, created_at)');
    for (const col of ['chatter_key TEXT', 'source_platform TEXT', 'anon_id TEXT', 'thread_id INTEGER', 'said_at DATETIME']) { try { db.run(`ALTER TABLE arena_topic_moments ADD COLUMN ${col}`); } catch { /* exists */ } }
    db.run('UPDATE arena_topic_moments SET said_at = created_at WHERE said_at IS NULL');
    // Threads: the sub-angles INSIDE an umbrella subject ("Cat enema drama" → "the vet bill", "the bot roasts", "global vs local").
    db.run(`CREATE TABLE IF NOT EXISTS arena_topic_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        hint TEXT,
        keywords_json TEXT,
        moments INTEGER DEFAULT 0,
        last_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_threads_topic ON arena_topic_threads (topic_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_moments_chatter ON arena_topic_moments (chatter_key, id)');
    db.run(`CREATE TABLE IF NOT EXISTS arena_trash_levels (
        user_id INTEGER PRIMARY KEY,
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        angles_cleared INTEGER DEFAULT 0,
        topics_conquered INTEGER DEFAULT 0,
        beef_hits INTEGER DEFAULT 0,
        best_line TEXT,
        best_line_vod_id INTEGER,
        best_line_sec INTEGER,
        best_line_score REAL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_xp_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const col of ["kind TEXT NOT NULL DEFAULT 'topic'", 'target_user_id INTEGER', 'headline TEXT', 'heat REAL DEFAULT 0', 'source_note TEXT', 'expires_at DATETIME', 'resolved_json TEXT',
        'keywords_json TEXT', 'lore TEXT', 'tagline TEXT', 'lore_updated_at DATETIME', 'lore_moment_count INTEGER DEFAULT 0', 'chat_mentions INTEGER DEFAULT 0', 'mic_mentions INTEGER DEFAULT 0', 'last_mention_at DATETIME', 'origin_json TEXT', 'creator_ip_hash TEXT', 'submitted_text TEXT', 'peak_heat REAL DEFAULT 0']) {
        try { db.run(`ALTER TABLE arena_topics ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    for (const col of ['topic_moments INTEGER DEFAULT 0', 'topics_joined INTEGER DEFAULT 0']) { try { db.run(`ALTER TABLE arena_trash_levels ADD COLUMN ${col}`); } catch { /* exists */ } }
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_xp_log_user ON arena_xp_log (user_id, created_at)');
    _ready = true;
}

function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function arena() { return require('./arena-service'); }
function clip(t, n) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, n); }
function levelFor(xp) { return 1 + Math.floor((Number(xp) || 0) / XP_PER_LEVEL); }
function ipHash(ip) { if (!ip) return null; let salt = ''; try { salt = String(db.getSetting('arena_vote_salt') || process.env.JWT_SECRET || 'arena'); } catch { salt = 'arena'; } return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 24); }

// ── Trash Level / XP ─────────────────────────────────────────

function levelRow(userId) {
    ensureTables();
    return db.get('SELECT * FROM arena_trash_levels WHERE user_id = ?', [userId]) || { user_id: userId, xp: 0, level: 1, beef_hits: 0, topic_moments: 0, topics_joined: 0, best_line_score: 0 };
}

function addXp(userId, amount, reason, refId = null, extra = {}) {
    ensureTables();
    amount = Math.round(Number(amount) || 0);
    if (amount <= 0) return levelRow(userId);
    const before = levelRow(userId);
    db.run(`INSERT INTO arena_trash_levels (user_id, xp, level) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET xp = xp + excluded.xp, level = ?, updated_at = CURRENT_TIMESTAMP`,
        [userId, amount, levelFor(amount), levelFor((before.xp || 0) + amount)]);
    db.run('INSERT INTO arena_xp_log (user_id, amount, reason, ref_id) VALUES (?, ?, ?, ?)', [userId, amount, reason, refId]);
    const sets = [];
    if (extra.moment) sets.push('topic_moments = topic_moments + 1');
    if (extra.joined) sets.push('topics_joined = topics_joined + 1');
    if (extra.beefHit) sets.push('beef_hits = beef_hits + 1');
    if (sets.length) db.run(`UPDATE arena_trash_levels SET ${sets.join(', ')} WHERE user_id = ?`, [userId]);
    if (extra.line && (extra.lineScore || 0) > (before.best_line_score || 0)) {
        db.run('UPDATE arena_trash_levels SET best_line = ?, best_line_vod_id = ?, best_line_sec = ?, best_line_score = ? WHERE user_id = ?', [String(extra.line).slice(0, 220), extra.lineVodId || null, extra.lineSec ?? null, extra.lineScore, userId]);
    }
    const after = levelRow(userId);
    if (after.level > before.level) { console.log(`[Arena] user ${userId} → Trash Level ${after.level}`); try { require('./progress').event(`user:${userId}`, 'level', `Trash Level ${after.level}`, { detail: `${after.xp} XP` }); } catch { /* */ } }
    try { arena().loadRoster(true); } catch { /* */ }
    if (!reason.startsWith('ach_')) { try { require('./progress').check(`user:${userId}`); } catch (e) { console.warn('[Arena] progress:', e.message); } }
    return { ...after, leveled_up: after.level > before.level, gained: amount };
}

function recentXp(userId, days = 7) {
    ensureTables();
    return db.get(`SELECT COALESCE(SUM(amount), 0) AS xp FROM arena_xp_log WHERE user_id = ? AND created_at >= datetime('now', ?)`, [userId, `-${days} days`])?.xp || 0;
}

function levelView(userId) {
    const r = levelRow(userId);
    const xp = r.xp || 0;
    return {
        level: levelFor(xp), xp, xp_into_level: xp - (levelFor(xp) - 1) * XP_PER_LEVEL, xp_per_level: XP_PER_LEVEL, next_level_xp: levelFor(xp) * XP_PER_LEVEL,
        topic_moments: r.topic_moments || 0, topics_joined: r.topics_joined || 0, beef_hits: r.beef_hits || 0,
        recent_xp: recentXp(userId),
        best_line: r.best_line ? { text: r.best_line, vod_id: r.best_line_vod_id, sec: r.best_line_sec, score: r.best_line_score } : null,
    };
}

// ── Keywords + matching ──────────────────────────────────────

function cleanTopicText(text) {
    const t = clip(text, TOPIC_MAX_LEN);
    if (t.length < 4) throw new Error('Topic is too short');
    return t;
}

/** Significant words of a subject: ≥ 4 letters, not a stopword, lowercased. */
function keywordsFromText(text) {
    const words = String(text || '').toLowerCase().replace(/[^a-z0-9@_\s'-]/g, ' ').split(/\s+/).map(w => w.replace(/^@/, '').replace(/'s$/, '')).filter(w => w.length >= 4 && !STOPWORDS.has(w));
    return [...new Set(words)].slice(0, 8);
}
// Words that appear on every stream on this site — worthless as subject keywords.
const GENERIC_KW = new Set('mic mics chat chats chatter chatters quote quotes banter chaos drama dramas bill bills ban bans banned timeout timeouts mods mod moderation stream streams streamer streamers streaming live clip clips vod vods game games gaming joke jokes roast roasts roasting beef beefs arena hype crowd viewers viewer subs vibes vibe energy moment moments clash community site global room rooms talk talking said saying mention mentions callout callouts feud feuds war wars saga controversy controversies takes take rant rants'.split(' '));
function normalizeKeywords(list) {
    // Single plain English words ("mic", "banter", "chaos", "bill") match every stream on the site and manufacture
    // phantom moments — only distinctive single words survive; phrases are always fine.
    let COMMON = null; try { COMMON = require('./names').COMMON; } catch { COMMON = new Set(); }
    return [...new Set((Array.isArray(list) ? list : []).map(k => String(k || '').toLowerCase().replace(/^@/, '').replace(/\s+/g, ' ').trim()).filter(k => k.length >= 3 && !STOPWORDS.has(k) && (k.includes(' ') || (!COMMON.has(k) && !GENERIC_KW.has(k)))))].slice(0, 10);
}
function keywordRegex(k) {
    // Loose stem: "pakistanis" matches "pakistani", "tents" matches "tent", "yapping" still needs its own keyword.
    const stem = k.length > 4 && !/ss$/.test(k) ? k.replace(/(?:ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')) : k;
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?:^|[^a-z0-9])${esc}(?:s|es|ies|ing|ed)?(?![a-z0-9])`, 'i');
}
let _kwCache = { at: 0, list: [] };
function openTopicMatchers() {
    if (Date.now() - _kwCache.at < 20 * 1000) return _kwCache.list;
    const list = [];
    for (const t of db.all(`SELECT id, text, kind, target_user_id, keywords_json FROM arena_topics WHERE status = 'open'`)) {
        const kws = normalizeKeywords(parseJson(t.keywords_json, []));
        if (kws.length) list.push({ id: t.id, kind: t.kind, keywords: kws, res: kws.map(keywordRegex) });
    }
    _kwCache = { at: Date.now(), list };
    return list;
}
function invalidateMatchers() { _kwCache.at = 0; }
/** Open topics whose keywords appear in `text`. */
function matchTopics(text) {
    const s = String(text || '');
    if (s.length < 3) return [];
    return openTopicMatchers().filter(m => m.res.some(re => re.test(s))).map(m => ({ id: m.id, kind: m.kind, keywords: m.keywords }));
}

// ── Topics ───────────────────────────────────────────────────

function createTopic({ text, hint = null, createdBy, creatorUserId = null, creatorName = null, creatorIp = null, kind = 'topic', targetUserId = null, headline = null, sourceNote = null, keywords = null, tagline = null, origin = null, submittedText = null, threads = null }) {
    ensureTables();
    const clean = cleanTopicText(text);
    kind = ['topic', 'bounty'].includes(kind) ? kind : 'topic';
    if (kind === 'bounty' && !targetUserId) throw new Error('A bounty needs a target');
    if (kind === 'bounty' && db.get(`SELECT id FROM arena_topics WHERE status = 'open' AND kind = 'bounty' AND target_user_id = ?`, [targetUserId])) throw new Error('There is already a bounty on them');
    const dup = db.get(`SELECT id FROM arena_topics WHERE status = 'open' AND LOWER(text) = LOWER(?)`, [clean]);
    if (dup) throw new Error('That topic is already on the board');
    const threadList = (Array.isArray(threads) ? threads : []).map(t => ({ name: clip(t?.name, 40), hint: t?.hint ? clip(t.hint, 90) : null, keywords: normalizeKeywords(t?.keywords || []) })).filter(t => t.name).slice(0, 6);
    for (const t of threadList) if (!t.keywords.length) t.keywords = keywordsFromText(t.name);
    let kws = normalizeKeywords([...(Array.isArray(keywords) ? keywords : []), ...threadList.flatMap(t => t.keywords)]);
    if (!kws.length) kws = keywordsFromText(clean);
    // A bounty matches ONLY the target's name (never generic words like "bounty" — that's a quest in half the games people stream).
    if (kind === 'bounty' && targetUserId) { const u = db.getUserById(targetUserId); if (u) { const nm = require('./names'); kws = normalizeKeywords([u.username, u.display_name, ...nm.variants(u.username), ...nm.variants(u.display_name)]); } }
    if (kind === 'topic' && kws.length >= 2) {
        for (const m of openTopicMatchers()) { if (m.kind === 'topic' && m.keywords.filter(k => kws.includes(k)).length >= 2) throw new Error('That subject is already on the board'); }
    }
    const open = db.get(`SELECT COUNT(*) AS n FROM arena_topics WHERE status = 'open'`)?.n || 0;
    if (open >= MAX_OPEN_TOPICS) archiveStale(true);
    const expires = new Date(Date.now() + (KIND_TTL_HOURS[kind] || TOPIC_TTL_HOURS) * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.run(`INSERT INTO arena_topics (text, hint, created_by, creator_user_id, creator_name, creator_ip_hash, kind, target_user_id, headline, source_note, expires_at, keywords_json, tagline, origin_json, submitted_text, last_mention_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [clean, hint ? clip(hint, 120) : null, createdBy, creatorUserId, creatorName ? clip(creatorName, 40) : null, ipHash(creatorIp), kind, targetUserId, headline ? clip(headline, 160) : null, sourceNote ? clip(sourceNote, 80) : null, expires, JSON.stringify(kws), tagline ? clip(tagline, 120) : null, origin ? JSON.stringify(origin) : null, submittedText ? clip(submittedText, 200) : null]);
    const row = db.get('SELECT * FROM arena_topics ORDER BY id DESC LIMIT 1');
    if (kind === 'bounty' && targetUserId) { try { require('./notify').arenaNotify(targetUserId, { type: 'bounty', title: `Chat put a bounty on you`, message: `${creatorName || 'The community'}: double XP for anyone who talks shit about you on stream for the next ${KIND_TTL_HOURS.bounty} h. Answer on mic.`, icon: '💰', url: `/arena/topic/${row.id}`, key: `bounty:${row.id}` }); } catch { /* */ } }
    for (const t of threadList) db.run('INSERT INTO arena_topic_threads (topic_id, name, hint, keywords_json) VALUES (?, ?, ?, ?)', [row.id, t.name, t.hint, JSON.stringify(t.keywords)]);
    invalidateMatchers();
    console.log(`[Arena] ${kind} #${row.id} by ${createdBy}${creatorName ? ' ' + creatorName : ''}: "${clean}" [${kws.join(', ')}]${threadList.length ? ` threads: ${threadList.map(t => t.name).join(' | ')}` : ''}`);
    return row;
}

/** One user-made topic per person and per IP per 24 h. Throws with a friendly message. */
function assertCanSubmit(userId, ip) {
    ensureTables();
    if (!userId) throw new Error('Sign in to start a topic');
    const since = `-${USER_TOPIC_COOLDOWN_HOURS} hours`;
    const mine = db.get(`SELECT created_at FROM arena_topics WHERE creator_user_id = ? AND created_by IN ('viewer', 'streamer', 'chat') AND created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1`, [userId, since]);
    if (mine) throw new Error(`One topic per person per ${USER_TOPIC_COOLDOWN_HOURS} h — yours is still cooking`);
    const h = ipHash(ip);
    if (h) {
        const same = db.get(`SELECT created_at FROM arena_topics WHERE creator_ip_hash = ? AND created_by IN ('viewer', 'streamer', 'chat') AND created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1`, [h, since]);
        if (same) throw new Error(`One topic per ${USER_TOPIC_COOLDOWN_HOURS} h from this connection`);
    }
}

const REFINE_SCHEMA = { name: 'arena_refine_topic', schema: { type: 'object', additionalProperties: false, required: ['subject', 'headline', 'tagline', 'hint', 'keywords', 'threads', 'reject'], properties: {
    subject: { type: 'string', description: 'the umbrella subject, 1–4 words, punchy, dumb-funny' },
    headline: { type: 'string', description: 'tabloid headline ≤ 90 chars, inflammatory and stupid in a good way' },
    tagline: { type: 'string', description: '≤ 100 chars, who submitted it and why everyone should care' },
    hint: { type: 'string', description: '≤ 90 chars: how to pile on / bait for streamers' },
    keywords: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string' }, description: 'lowercase words/slang people would actually type or say about it' },
    threads: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['name', 'keywords', 'hint'], properties: { name: { type: 'string', description: '2–5 words, a sub-angle inside the subject' }, keywords: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } }, hint: { type: 'string', description: '≤ 70 chars' } } } },
    reject: { type: 'boolean', description: 'true ONLY if it is a direct threat of violence, sexual content about a minor, or doxxing' },
} } };
const REFINE_SYSTEM = `A user typed a topic for the shit-talking board of a live-streaming site. Rewrite it into a proper board SUBJECT that looks good and baits people: a short, VAGUE umbrella subject (1–4 words), a tabloid headline, a tagline crediting the submitter, a hint on how to pile on, the keywords people would actually type or say about it (slang, variants, misspellings), and 2–4 THREADS — the specific angles inside it people will argue. Make it dumber, funnier and more provocative than what they typed; keep their actual meaning. Slurs, profanity and taboo topics are allowed and never a reason to reject — this platform does not censor language. Reject ONLY direct threats of violence, sexual content about minors, or doxxing. Output only the JSON.`;

/** A user-submitted topic → the AI makes it look good (one call). Falls back to the raw text. */
async function submitTopic({ text, userId, ip, creatorName, onRoster = false }) {
    assertCanSubmit(userId, ip);
    const raw = cleanTopicText(text);
    if (arena()._isBannedText(raw)) throw new Error('That crosses the line (threats, minors, doxxing)');
    let refined = null;
    if (aiOn()) {
        try {
            const r = await llm.complete({ role: 'chat', kind: 'arena_refine_topic', source: 'arena', ownerUserId: userId, system: REFINE_SYSTEM, user: JSON.stringify({ submitted: raw, by: creatorName }), json: REFINE_SCHEMA, maxTokens: 300, temperature: 0.95, timeoutMs: 20000 });
            if (r && r.json) { if (r.json.reject) throw new Error('That crosses the line (threats, minors, doxxing)'); refined = r.json; }
        } catch (e) { if (/crosses the line/.test(e.message)) throw e; console.warn('[Arena] refine topic:', e.message); }
    }
    const mc = mergeCandidate(refined?.subject || raw, refined?.keywords || keywordsFromText(raw));
    if (mc) {
        const r = foldInto(mc.id, { subject: refined?.subject || raw, keywords: refined?.keywords || [], hint: refined?.hint || null, threads: refined?.threads || [] });
        const existing = db.get('SELECT * FROM arena_topics WHERE id = ?', [mc.id]);
        console.log(`[Arena] ${creatorName}'s "${raw}" folded into subject #${mc.id} (${mc.why})`);
        return { ...existing, folded: true, threads_added: r.threads_added };
    }
    const t = createTopic({ text: refined?.subject || raw, hint: refined?.hint || null, createdBy: onRoster ? 'streamer' : 'viewer', creatorUserId: userId, creatorName, creatorIp: ip, headline: refined?.headline || null, tagline: refined?.tagline || `Put up by ${creatorName}`, sourceNote: creatorName, keywords: refined?.keywords || null, threads: refined?.threads || null, submittedText: raw });
    backfillMoments([t]);
    try { require('./chatters').onSubjectStarted(`user:${userId}`, t.id, { display: creatorName }); require('./progress').event(`user:${userId}`, 'subject', `Started “${t.headline || t.text}”`, { url: `/arena/topic/${t.id}` }); } catch { /* */ }
    return t;
}

/** A moment: something someone said (chat or on mic) about the topic. */
function addMoment(topicId, { kind, source, userId = null, username = null, streamId = null, vodId = null, sec = null, text, quality = null, about = null, platform = null, anonId = null, saidAt = null }) {
    ensureTables();
    const t = db.get(`SELECT id, kind, status, heat FROM arena_topics WHERE id = ?`, [topicId]);
    if (!t || t.status !== 'open') return null;
    const body = clip(text, 240);
    if (!body || arena()._isBannedText(body)) return null;
    const chatters = require('./chatters');
    const chatterKey = chatters.keyFor({ user_id: userId, username, anon_id: anonId, source_platform: platform });
    const threadId = threadFor(topicId, body);
    // When the line was actually SAID (chat timestamp / stream start + offset) — not when we filed it.
    let said = saidAt ? String(saidAt).replace('T', ' ').replace(/\.\d+Z?$/, '').replace('Z', '') : null;
    if (!said && kind === 'speech' && streamId && sec != null) { const st = db.get('SELECT started_at FROM streams WHERE id = ?', [streamId]); if (st?.started_at) { const ms = Date.parse(String(st.started_at).replace(' ', 'T') + 'Z'); if (!isNaN(ms)) said = new Date(ms + sec * 1000).toISOString().replace('T', ' ').slice(0, 19); } }
    db.run(`INSERT INTO arena_topic_moments (topic_id, kind, source, user_id, username, stream_id, vod_id, sec, text, quality, about, chatter_key, source_platform, anon_id, thread_id, said_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
        [topicId, kind, source, userId, username ? clip(username, 60) : null, streamId, vodId, sec, body, quality, about ? clip(about, 80) : null, chatterKey, platform, anonId, threadId, said]);
    if (threadId) db.run('UPDATE arena_topic_threads SET moments = moments + 1, last_at = CURRENT_TIMESTAMP WHERE id = ?', [threadId]);
    db.run(`UPDATE arena_topics SET hits = hits + 1, ${kind === 'chat' ? 'chat_mentions = chat_mentions + 1' : 'mic_mentions = mic_mentions + 1'}, last_mention_at = MAX(COALESCE(last_mention_at, ''), COALESCE(?, CURRENT_TIMESTAMP)), last_activity_at = CURRENT_TIMESTAMP WHERE id = ?`, [said, topicId]);
    if (kind === 'speech' && userId && arena().loadRoster().byId[userId]) {
        const m = db.get('SELECT 1 FROM arena_topic_members WHERE topic_id = ? AND user_id = ?', [topicId, userId]);
        if (!m) { db.run('INSERT INTO arena_topic_members (topic_id, user_id, active) VALUES (?, ?, 1)', [topicId, userId]); db.run('UPDATE arena_topics SET joins = joins + 1 WHERE id = ?', [topicId]); addXp(userId, XP_JOIN, 'topic_joined', topicId, { joined: true }); }
    }
    const m = db.get('SELECT * FROM arena_topic_moments ORDER BY id DESC LIMIT 1');
    // Yapper XP for chat lines (seeded backfills count too — they are real lines people typed).
    if (kind === 'chat' && chatterKey) { try { chatters.onMoment(m, t, { hot: (t.heat || 0) >= HOT_THRESHOLD }); } catch (e) { console.warn('[Arena] yapper xp:', e.message); } }
    return m;
}

/**
 * Is this (subject text, keywords) really an existing open subject? Same story = fold in as a thread.
 *   • shares a distinctive keyword that is a roster name (a subject about goosely already exists)
 *   • shares ≥ 2 keywords, or ≥ 1 multi-word keyword
 *   • significant words of the subject text overlap ≥ 50 % (jaccard) with an open subject's
 */
function mergeCandidate(text, keywords, { exclude = null } = {}) {
    const kws = normalizeKeywords(keywords || []);
    const words = new Set(keywordsFromText(text));
    // Roster people named in the text/keywords — a subject that already stars them is the same story.
    const namedVariants = new Set();
    try {
        const roster = arena().loadRoster(); const nm = require('./names');
        const entries = nm.rosterEntries(roster);
        const hay = `${text} ${kws.join(' ')}`;
        for (const h of nm.findMentions(hay, entries, { fuzzy: false })) { for (const v of nm.variants(roster.byId[h.userId].user.username)) namedVariants.add(v); const first = nm.splitHandle(roster.byId[h.userId].user.username)[0]; if (first) namedVariants.add(first); }
    } catch { /* */ }
    for (const m of openTopicMatchers()) {
        if (exclude && m.id === exclude) continue;
        const shared = m.keywords.filter(k => kws.includes(k));
        const star = m.keywords.find(k => namedVariants.has(k));
        if (star) return { id: m.id, why: `about ${star}` };
        if (shared.length >= 2 || shared.some(k => k.includes(' '))) return { id: m.id, why: `shares ${shared.join(', ')}` };
        const t = db.get('SELECT text FROM arena_topics WHERE id = ?', [m.id]);
        const other = new Set(keywordsFromText(t?.text || ''));
        const inter = [...words].filter(w => other.has(w)).length;
        const union = new Set([...words, ...other]).size;
        if (words.size && other.size && inter / union >= 0.5) return { id: m.id, why: 'same words' };
    }
    return null;
}
/** Fold a would-be subject into an existing one as a thread (its keywords widen the subject's). */
function foldInto(existingId, { subject, keywords, hint, threads }) {
    const list = [{ name: subject, keywords: keywords || [], hint: hint || null }, ...(Array.isArray(threads) ? threads : [])];
    // skip threads that are really another open subject
    const keep = list.filter(t => { const mc = mergeCandidate(t.name, t.keywords, { exclude: existingId }); return !mc; });
    const added = upsertThreads(existingId, keep);
    const merged = normalizeKeywords([...(parseJson(db.get('SELECT keywords_json FROM arena_topics WHERE id = ?', [existingId])?.keywords_json, []) || []), ...normalizeKeywords(keywords || []), ...keep.flatMap(t => normalizeKeywords(t.keywords || []))]);
    db.run('UPDATE arena_topics SET keywords_json = ?, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(merged), existingId]);
    invalidateMatchers();
    return { id: existingId, threads_added: added };
}

/** Which thread of a subject a line belongs to (first thread whose keywords match), or null. */
let _threadCache = { at: 0, byTopic: new Map() };
function threadsOf(topicId) {
    if (Date.now() - _threadCache.at > 20 * 1000) { _threadCache = { at: Date.now(), byTopic: new Map() }; }
    if (!_threadCache.byTopic.has(topicId)) _threadCache.byTopic.set(topicId, db.all('SELECT * FROM arena_topic_threads WHERE topic_id = ? ORDER BY id ASC', [topicId]).map(t => ({ ...t, res: normalizeKeywords(parseJson(t.keywords_json, [])).map(keywordRegex) })));
    return _threadCache.byTopic.get(topicId);
}
function threadFor(topicId, text) { for (const t of threadsOf(topicId)) if (t.res.some(re => re.test(text))) return t.id; return null; }
function upsertThreads(topicId, threads) {
    const existing = db.all('SELECT id, name, keywords_json FROM arena_topic_threads WHERE topic_id = ?', [topicId]);
    let added = 0;
    for (const t of (Array.isArray(threads) ? threads : []).slice(0, 8)) {
        const name = clip(t?.name, 40); if (!name) continue;
        const kws = normalizeKeywords(t?.keywords || []); if (!kws.length) kws.push(...keywordsFromText(name));
        const same = existing.find(e => e.name.toLowerCase() === name.toLowerCase() || normalizeKeywords(parseJson(e.keywords_json, [])).some(k => kws.includes(k)));
        if (same) { const merged = normalizeKeywords([...(parseJson(same.keywords_json, []) || []), ...kws]); db.run('UPDATE arena_topic_threads SET keywords_json = ?, hint = COALESCE(?, hint) WHERE id = ?', [JSON.stringify(merged), t?.hint ? clip(t.hint, 90) : null, same.id]); continue; }
        if (existing.length + added >= 6) continue;
        db.run('INSERT INTO arena_topic_threads (topic_id, name, hint, keywords_json) VALUES (?, ?, ?, ?)', [topicId, name, t?.hint ? clip(t.hint, 90) : null, JSON.stringify(kws)]); added++;
    }
    if (added) { _threadCache.at = 0; }
    // Re-file moments that have no thread yet.
    for (const m of db.all('SELECT id, text FROM arena_topic_moments WHERE topic_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 200', [topicId])) { const tid = threadFor(topicId, m.text); if (tid) { db.run('UPDATE arena_topic_moments SET thread_id = ? WHERE id = ?', [tid, m.id]); db.run('UPDATE arena_topic_threads SET moments = moments + 1 WHERE id = ?', [tid]); } }
    return added;
}

/** Raw on-mic mention (no judge): one per stream per topic per cooldown. */
function noteMicMention(topicId, { userId, username, streamId, vodId, sec, text }) {
    const recent = db.get(`SELECT id FROM arena_topic_moments WHERE topic_id = ? AND stream_id = ? AND kind = 'speech' AND created_at >= datetime('now', ?)`, [topicId, streamId, `-${MENTION_COOLDOWN_SEC} seconds`]);
    if (recent) return null;
    return addMoment(topicId, { kind: 'speech', source: 'mention', userId, username, streamId, vodId, sec, text });
}

async function joinTopic(topicId, userId) {
    ensureTables();
    const topic = db.get(`SELECT * FROM arena_topics WHERE id = ? AND status = 'open'`, [topicId]);
    if (!topic) throw new Error('That topic is gone');
    if (!arena().loadRoster().byId[userId]) throw new Error('Only fighters on the roster can talk on a topic — stream once and come back');
    db.run('UPDATE arena_topic_members SET active = 0 WHERE user_id = ? AND active = 1', [userId]);
    const existing = db.get('SELECT * FROM arena_topic_members WHERE topic_id = ? AND user_id = ?', [topicId, userId]);
    if (existing) db.run('UPDATE arena_topic_members SET active = 1 WHERE topic_id = ? AND user_id = ?', [topicId, userId]);
    else { db.run('INSERT INTO arena_topic_members (topic_id, user_id) VALUES (?, ?)', [topicId, userId]); db.run('UPDATE arena_topics SET joins = joins + 1 WHERE id = ?', [topicId]); addXp(userId, XP_JOIN, 'topic_joined', topicId, { joined: true }); }
    db.run('UPDATE arena_topics SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [topicId]);
    return { topic };
}
function leaveTopic(userId) { ensureTables(); db.run('UPDATE arena_topic_members SET active = 0 WHERE user_id = ? AND active = 1', [userId]); }
function activeTopicFor(userId) {
    ensureTables();
    return db.get(`SELECT t.* FROM arena_topic_members m JOIN arena_topics t ON t.id = m.topic_id WHERE m.user_id = ? AND m.active = 1 AND t.status = 'open' ORDER BY m.joined_at DESC LIMIT 1`, [userId]) || null;
}

/** A judged on-mic chunk about a topic: { on_topic, quality, best_line, about, flagged } → judged moment + XP. */
const MIN_JUDGED_QUALITY = 4;
function applyTopicJudgement(userId, topic, judgement, lineRef) {
    if (judgement.flagged || !judgement.on_topic) return { applied: false };
    const quality = Math.max(0, Math.min(10, Number(judgement.quality) || 0));
    if (quality < MIN_JUDGED_QUALITY) return { applied: false, reason: 'too weak' };
    const user = db.getUserById(userId);
    const m = addMoment(topic.id, { kind: 'speech', source: 'judge', userId, username: user?.username || null, streamId: lineRef?.stream_id || null, vodId: lineRef?.vod_id || null, sec: lineRef?.sec ?? null, text: judgement.best_line || judgement.about || 'talked on it', quality, about: judgement.about || null });
    if (!m) return { applied: false };
    const xp = Math.round(quality * 0.8);
    const lvl = addXp(userId, xp, 'topic_hit', topic.id, { moment: true, line: judgement.best_line, lineScore: quality, lineVodId: lineRef?.vod_id, lineSec: lineRef?.sec });
    return { applied: true, quality, xp, level: lvl, moment_id: m.id };
}

function hypeTopic(topicId, userId, voterKey) {
    ensureTables();
    if (voterKey === `user:${userId}`) throw new Error("You can't hype yourself");
    const ins = db.run('INSERT OR IGNORE INTO arena_topic_hype (topic_id, user_id, voter_key) VALUES (?, ?, ?)', [topicId, userId, voterKey]);
    if (ins.changes) { addXp(userId, XP_HYPE, 'hype', topicId); db.run('UPDATE arena_topics SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [topicId]); try { require('./chatters').onHype(voterKey, topicId); } catch { /* */ } }
    const n = db.get('SELECT COUNT(*) AS n FROM arena_topic_hype WHERE topic_id = ? AND user_id = ?', [topicId, userId])?.n || 0;
    return { added: !!ins.changes, hypers: n };
}

/** Heat = the last hour: on-mic moments ×3, chat moments ×1, hype, fighters talking ×4. */
function computeHeat(topicId) {
    const m = db.get(`SELECT SUM(kind = 'speech') AS mic, SUM(kind = 'chat') AS chat FROM arena_topic_moments WHERE topic_id = ? AND created_at >= datetime('now', '-60 minutes')`, [topicId]) || {};
    const hype = db.get(`SELECT COUNT(*) AS n FROM arena_topic_hype WHERE topic_id = ? AND created_at >= datetime('now', '-60 minutes')`, [topicId])?.n || 0;
    const talking = db.get(`SELECT COUNT(*) AS n FROM arena_topic_members WHERE topic_id = ? AND active = 1`, [topicId])?.n || 0;
    const heat = (m.mic || 0) * 3 + (m.chat || 0) + hype + talking * 4;
    const prev = db.get('SELECT heat, creator_user_id, headline, text FROM arena_topics WHERE id = ?', [topicId]);
    db.run('UPDATE arena_topics SET heat = ?, peak_heat = MAX(COALESCE(peak_heat, 0), ?) WHERE id = ?', [heat, heat, topicId]);
    if (prev && (prev.heat || 0) < HOT_THRESHOLD && heat >= HOT_THRESHOLD) {
        try { const n = require('./notify'); const who = new Set([prev.creator_user_id, ...db.all('SELECT user_id FROM arena_topic_members WHERE topic_id = ?', [topicId]).map(r => r.user_id), ...db.all(`SELECT user_id FROM arena_topic_moments WHERE topic_id = ? AND user_id IS NOT NULL GROUP BY user_id`, [topicId]).map(r => r.user_id)].filter(Boolean)); for (const uid of who) n.arenaNotify(uid, { type: 'hot', title: `“${String(prev.headline || prev.text).slice(0, 60)}” is HOT`, message: `Your subject is the loudest thing on the board right now (${heat} heat).`, icon: '🔥', url: `/arena/topic/${topicId}`, key: `hot:${topicId}` }); } catch { /* */ }
    }
    return heat;
}

// ── Bounties ─────────────────────────────────────────────────

function openBountyOn(targetUserId) {
    ensureTables();
    return db.get(`SELECT * FROM arena_topics WHERE status = 'open' AND kind = 'bounty' AND target_user_id = ?`, [targetUserId]) || null;
}
function recordBountyHit(hitterId, bounty, quality, line = null) {
    addXp(hitterId, Math.round(quality), 'bounty_hit', bounty.id);
    const u = db.getUserById(hitterId);
    if (line) addMoment(bounty.id, { kind: 'speech', source: 'judge', userId: hitterId, username: u?.username || null, text: line, quality });
    else db.run('UPDATE arena_topics SET hits = hits + 1, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [bounty.id]);
}

/** Bounties settle when they expire; topics just cool off into the archive (their lore stays). */
function resolveExpired() {
    ensureTables();
    const results = [];
    for (const t of db.all(`SELECT * FROM arena_topics WHERE status = 'open' AND kind = 'bounty' AND expires_at IS NOT NULL AND expires_at <= datetime('now')`)) {
        const top = db.get(`SELECT user_id, SUM(amount) AS s FROM arena_xp_log WHERE reason = 'bounty_hit' AND ref_id = ? GROUP BY user_id ORDER BY s DESC LIMIT 1`, [t.id]);
        const resolved = { kind: 'bounty', claimed_by: top?.user_id || null, total: top?.s || 0, headline: top?.user_id ? `${nameOf(top.user_id)} collected the bounty on ${nameOf(t.target_user_id)}` : `Nobody came for ${nameOf(t.target_user_id)}. Cowards.` };
        if (top?.user_id) addXp(top.user_id, 40, 'bounty_claimed', t.id);
        db.run(`UPDATE arena_topics SET status = 'resolved', resolved_json = ? WHERE id = ?`, [JSON.stringify(resolved), t.id]);
        db.run('UPDATE arena_topic_members SET active = 0 WHERE topic_id = ?', [t.id]);
        results.push({ id: t.id, ...resolved });
        console.log(`[Arena] bounty #${t.id} resolved: ${resolved.headline}`);
    }
    if (results.length) invalidateMatchers();
    return results;
}

function archiveStale(force = false) {
    ensureTables();
    const r = db.run(`UPDATE arena_topics SET status = 'archived' WHERE status = 'open' AND kind = 'topic' AND last_activity_at < datetime('now', ?)`, [`-${TOPIC_TTL_HOURS} hours`]);
    if (force) {
        const extra = db.all(`SELECT id FROM arena_topics WHERE status = 'open' ORDER BY heat ASC, last_activity_at ASC`).slice(0, Math.max(0, (db.get(`SELECT COUNT(*) AS n FROM arena_topics WHERE status = 'open'`)?.n || 0) - MAX_OPEN_TOPICS + 1));
        for (const row of extra) db.run(`UPDATE arena_topics SET status = 'archived' WHERE id = ?`, [row.id]);
    }
    if (r.changes || force) { db.run(`UPDATE arena_topic_members SET active = 0 WHERE topic_id IN (SELECT id FROM arena_topics WHERE status != 'open')`); invalidateMatchers(); }
}

function nameOf(userId) {
    try { return fighterBrief(userId, arena().loadRoster()).fighter_name; } catch { const u = db.getUserById(userId); return u ? (u.display_name || u.username) : `user${userId}`; }
}

// ── Bots are not chatters ────────────────────────────────────
// AI viewers mark their rows with source_platform 'ai'; channel AI bots post as real accounts, so
// their usernames come from channel_ai_bots / ai_chatbot_configs (cached a minute).
let _bots = { at: 0, names: new Set(), ids: new Set() };
function botSet() {
    if (Date.now() - _bots.at < 60 * 1000) return _bots;
    const names = new Set(), ids = new Set();
    for (const t of ['channel_ai_bots', 'ai_chatbot_configs']) {
        try { for (const r of db.all(`SELECT * FROM ${t}`)) { for (const k of ['username', 'bot_username', 'name', 'bot_name', 'display_name']) if (r[k]) names.add(String(r[k]).toLowerCase()); for (const k of ['bot_user_id', 'user_id']) if (r[k] && k === 'bot_user_id') ids.add(Number(r[k])); } } catch { /* table shape varies */ }
    }
    // Admin list for bots that post from real accounts (site setting, comma-separated usernames).
    try { for (const n of String(db.getSetting('arena_bot_usernames') || '').split(/[,\s]+/)) if (n) names.add(n.toLowerCase()); } catch { /* */ }
    _bots = { at: Date.now(), names, ids };
    return _bots;
}
function isBotChatter(row) {
    if (!row) return false;
    if (String(row.source_platform || '') === 'ai') return true;
    const b = botSet();
    if (row.user_id && b.ids.has(Number(row.user_id))) return true;
    return !!row.username && b.names.has(String(row.username).toLowerCase());
}

// ── Discovery: what is the community actually talking about? ─

let _scan = { lastChatId: null, lastDiscoverAt: 0, lastDiscoverSeen: 0 };

/** Every minute: new chat messages → moments on matching topics. */
function scanChat() {
    ensureTables();
    if (_scan.lastChatId == null) { _scan.lastChatId = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages')?.id || 0; return { scanned: 0, moments: 0 }; }
    const rows = db.all(`SELECT id, stream_id, user_id, username, message, source_platform, anon_id, timestamp FROM chat_messages WHERE id > ? AND COALESCE(is_deleted, 0) = 0 AND message IS NOT NULL AND COALESCE(message_type, 'chat') = 'chat' AND COALESCE(source_platform, '') != 'ai' AND LENGTH(message) BETWEEN 6 AND 300 ORDER BY id ASC LIMIT 400`, [_scan.lastChatId]);
    if (!rows.length) return { scanned: 0, moments: 0 };
    _scan.lastChatId = rows[rows.length - 1].id;
    let moments = 0;
    for (const r of rows) {
        if (/^!/.test(r.message)) continue;
        if (isBotChatter(r)) continue;
        for (const t of matchTopics(r.message)) { if (addMoment(t.id, { kind: 'chat', source: 'chat', userId: r.user_id, username: r.username, streamId: r.stream_id, text: r.message, platform: r.source_platform || null, anonId: r.anon_id || null, saidAt: r.timestamp })) moments++; }
    }
    return { scanned: rows.length, moments };
}

const DISCOVER_SCHEMA = { name: 'arena_discover', schema: { type: 'object', additionalProperties: false, required: ['pulse', 'topics', 'bounties'], properties: {
    pulse: { type: 'string', description: 'One sentence ≤ 140 chars: what the community is on about right now, dumb hype-caster voice, name names, funny' },
    topics: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['merge_into_id', 'subject', 'headline', 'tagline', 'keywords', 'threads', 'source', 'hint'], properties: {
        merge_into_id: { type: 'integer', description: 'if this is really one of the subjects already on the board (same story, same people, same drama), that subject\'s id — its threads get added there instead of making a duplicate. 0 for a genuinely new subject.' },
        subject: { type: 'string', description: 'The UMBRELLA subject, 1–4 words, a noun: the thing, person, group, joke or drama — e.g. "Cat enema drama", "Pakistanis", "Goosely", "Tent streams". Vague on purpose; the detail lives in threads.' },
        headline: { type: 'string', description: 'Tabloid headline ≤ 70 chars, inflammatory, stupid-funny' },
        tagline: { type: 'string', description: '≤ 80 chars: where it stands — who started it, who is on which end' },
        keywords: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' }, description: 'lowercase words/short phrases people use for the umbrella subject (slang, misspellings)' },
        threads: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['name', 'keywords', 'hint'], properties: { name: { type: 'string', description: 'a sub-angle inside the subject, 2–5 words ("the vet bill", "the bot roasts", "global vs local")' }, keywords: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } }, hint: { type: 'string', description: '≤ 70 chars, how to pile on this thread' } } }, description: 'the 2–4 threads people are actually arguing inside the subject' },
        source: { type: 'string', description: '≤ 6 words: where it came from ("global chat", "Goosely\'s stream")' },
        hint: { type: 'string', description: '≤ 70 chars, how to pile on' },
    } } },
    bounties: { type: 'array', minItems: 0, maxItems: 1, items: { type: 'object', additionalProperties: false, required: ['target_username', 'headline', 'why'], properties: { target_username: { type: 'string', description: 'exact username from the snapshot the community keeps naming/dunking on' }, headline: { type: 'string' }, why: { type: 'string', description: '≤ 90 chars' } } } },
} } };
const DISCOVER_SYSTEM = `You are the community consciousness of a live-streaming site's Arena — a regular who has been in this chat for years, not a copywriter. VOICE RULES: write the way the people in the sample lines type — same slang, same casing (if chat is lowercase, you are lowercase), short, blunt, funny. No tabloid adjective soup, no invented compound words (no "roastmare", no "chaos escalates"), no exclamation marks for hype, no "epic"/"wild"/"erupts"/"explodes". A headline should read like something a chatter would actually type as a title ("goosely is losing the cat enema war", "nobody asked about the vet bill"), ≤ 60 chars. Use people's names exactly as they appear. You get what people ACTUALLY said in the last while: global + stream chat lines and what streamers said on mic, plus the subjects already on the board. Find the UMBRELLA SUBJECTS the community is really on about — a group of people, a person, a running joke, an argument, a product, a drama, a meme — the more provocative, taboo, petty or stupid the better; nothing generic, nothing wholesome. Keep subjects VAGUE and short (1–4 words) and put the detail into 2–4 THREADS inside each (the specific angles people are arguing). Ignore small talk. ONE story = ONE subject: if what people are saying is the same drama / the same people as a subject already on the board (listed with ids), set merge_into_id to that id and give the NEW threads only — never create a second subject about the same thing ("goosely drama" when "cat enema drama" already stars goosely is a duplicate). Never make a subject about the Arena itself — not the board, a bounty, a beef, yap levels or XP ("goosely bounty" is the bounty, not a subject). For each: the subject, a tabloid headline, a tagline (who started it, who is where on it), the keywords/slang people use for it, the threads, the source, and a hint on how to pile on. If the community keeps naming one specific streamer (dunking, defending, calling out), add ONE bounty on that exact username. Profanity, disrespect, slurs and trolling are welcome and are never a reason to skip a subject — this platform does not censor language. Hard line: no direct threats of violence, nothing sexual about minors, no doxxing. Return empty arrays if nothing real is going on. Output only the JSON.`;

function discoverInput() {
    const out = { at: new Date().toISOString() };
    try { out.chat = db.all(`SELECT c.username, c.message, c.stream_id, c.user_id, c.source_platform FROM chat_messages c WHERE COALESCE(c.is_deleted, 0) = 0 AND COALESCE(c.source_platform, '') != 'ai' AND COALESCE(c.message_type, 'chat') = 'chat' AND c.timestamp >= datetime('now', ?) AND LENGTH(c.message) BETWEEN 8 AND 200 AND c.message NOT LIKE '!%' ORDER BY c.id DESC LIMIT 80`, [`-${scanWindowMin()} minutes`]).reverse().filter(r => !isBotChatter(r) && !arena()._isBannedText(r.message)).map(r => clip(`[${r.stream_id ? 'stream' : 'global'}] ${r.username}: ${r.message}`, 180)); } catch { out.chat = []; }
    try { out.on_mic = db.all(`SELECT u.username, e.text FROM stream_timeline_events e JOIN users u ON u.id = e.user_id WHERE e.kind = 'speech' AND e.created_at >= datetime('now', ?) AND LENGTH(e.text) BETWEEN 25 AND 220 ORDER BY e.id DESC LIMIT 60`, [`-${scanWindowMin()} minutes`]).reverse().filter(r => !arena()._isBannedText(r.text)).map(r => clip(`${r.username}: ${r.text}`, 200)); } catch { out.on_mic = []; }
    try { out.chat_timeline = db.all(`SELECT label, detail FROM chat_timeline_events WHERE created_at >= datetime('now', '-6 hours') ORDER BY id DESC LIMIT 8`).map(r => clip(`${r.label}: ${r.detail || ''}`, 140)); } catch { out.chat_timeline = []; }
    try { const g = db.getChatAiSummary('global', 0, 'rolling'); if (g) { const ov = parseJson(g.overview, null); out.global_chat_overview = clip(ov ? (ov.today || ov.alltime) : g.overview, 500); } } catch { /* */ }
    try { const roster = arena().loadRoster(); out.roster_usernames = roster.order.map(id => roster.byId[id].user.username); } catch { out.roster_usernames = []; }
    out.already_on_board = db.all(`SELECT id, text, headline, keywords_json FROM arena_topics WHERE status = 'open' ORDER BY id DESC LIMIT 20`).map(r => ({ id: r.id, subject: r.text, headline: r.headline, keywords: parseJson(r.keywords_json, []) || [], threads: db.all('SELECT name FROM arena_topic_threads WHERE topic_id = ?', [r.id]).map(x => x.name) }));
    return out;
}

/** No AI: a word (≥ 4 letters, not a stopword) said by ≥ 3 people ≥ 4 times in the window becomes a subject. */
function heuristicDiscover(input) {
    const counts = new Map();
    for (const l of [...(input.chat || []), ...(input.on_mic || [])]) {
        const body = l.replace(/^\[[^\]]*\]\s*/, '');
        const who = body.split(':')[0];
        const seen = new Set();
        for (const w of keywordsFromText(body.replace(/^[^:]+:\s*/, ''))) { if (seen.has(w)) continue; seen.add(w); const c = counts.get(w) || { n: 0, people: new Set() }; c.n++; c.people.add(who); counts.set(w, c); }
    }
    const existing = new Set(openTopicMatchers().flatMap(m => m.keywords));
    return [...counts.entries()].filter(([w, c]) => c.n >= 4 && c.people.size >= 3 && !existing.has(w)).sort((a, b) => b[1].n - a[1].n).slice(0, 2)
        .map(([w, c]) => ({ subject: w.charAt(0).toUpperCase() + w.slice(1), headline: `Everyone is suddenly on about "${w}"`, tagline: `${c.people.size} people, ${c.n} mentions in ${SCAN_WINDOW_MIN} minutes`, keywords: [w], threads: [{ name: `why ${w}`, keywords: [w], hint: 'Say it on mic. Make it worse.' }], source: 'chat burst', hint: 'Say it on mic. Make it worse.' }));
}

let _pulse = { text: null, at: null, sources: [] };
function loadPulse() { if (_pulse.at) return _pulse; try { const p = JSON.parse(db.getState('arena_pulse') || 'null'); if (p && p.text) _pulse = p; } catch { /* */ } return _pulse; }
function savePulse() { try { db.setState('arena_pulse', JSON.stringify(_pulse)); } catch { /* */ } }
/** Every few minutes, only when there is new material: turn what was said into new subjects. */
async function discoverTopics({ force = false } = {}) {
    ensureTables();
    archiveStale();
    if (!force && Date.now() - _scan.lastDiscoverAt < DISCOVER_INTERVAL_MS) return { skipped: true };
    const input = discoverInput();
    const seen = input.chat.length + input.on_mic.length;
    if (!force && (seen < DISCOVER_MIN_NEW_LINES || seen === _scan.lastDiscoverSeen)) { _scan.lastDiscoverAt = Date.now(); return { skipped: true, quiet: true }; }
    _scan.lastDiscoverAt = Date.now(); _scan.lastDiscoverSeen = seen;
    if (!seen) return { made: 0, quiet: true };
    let topics = [], bounties = [];
    if (aiOn()) {
        try {
            const r = await llm.complete({ role: 'summary', kind: 'arena_discover', source: 'arena', system: DISCOVER_SYSTEM, user: JSON.stringify(input), json: DISCOVER_SCHEMA, maxTokens: 700, temperature: 0.9, timeoutMs: 30000 });
            if (!r || !r.json) console.warn('[Arena] discover: model returned no usable JSON', r && r.text ? String(r.text).slice(0, 200) : '');
            if (r && r.json) { topics = r.json.topics || []; bounties = r.json.bounties || []; if (r.json.pulse) { _pulse = { text: clip(r.json.pulse, 200), at: Date.now(), sources: ['chat', 'on_mic'].filter(k => input[k].length) }; savePulse(); } }
        } catch (e) { console.warn('[Arena] discover:', e.message); }
    } else {
        topics = heuristicDiscover(input);
    }
    let made = 0, folded = 0;
    const created = [];
    for (const t of topics.slice(0, 4)) {
        try {
            if (/\b(bounty|bounties|beef|beefs|arena|yap level|yappers?|trash level|the board)\b/i.test(`${t.subject} ${(t.keywords || []).join(' ')}`)) { console.log(`[Arena] skipped meta subject "${t.subject}"`); continue; }
            const target = (t.merge_into_id && db.get(`SELECT id FROM arena_topics WHERE id = ? AND status = 'open'`, [t.merge_into_id])) ? { id: t.merge_into_id, why: 'model said so' } : mergeCandidate(t.subject, t.keywords);
            if (target) { const r = foldInto(target.id, t); folded++; console.log(`[Arena] "${t.subject}" folded into subject #${target.id} (${target.why}; +${r.threads_added} thread(s))`); continue; }
            created.push(createTopic({ text: t.subject, hint: t.hint, createdBy: 'community', creatorName: clip(t.source || 'the community', 40), headline: t.headline, tagline: t.tagline, sourceNote: t.source, keywords: t.keywords, threads: t.threads })); made++;
        } catch (e) { console.warn('[Arena] discover create:', e.message); }
    }
    for (const b of bounties.slice(0, 1)) {
        try {
            const u = db.getUserByUsername(String(b.target_username || '').replace(/^@/, ''));
            if (!u || !arena().loadRoster().byId[u.id]) continue;
            created.push(createTopic({ text: `Bounty: ${nameOf(u.id)}`, hint: clip(b.why, 90), createdBy: 'community', creatorName: 'the community', kind: 'bounty', targetUserId: u.id, headline: b.headline, tagline: b.why, sourceNote: 'community' })); made++;
        } catch { /* dup */ }
    }
    if (created.length) backfillMoments(created, { windowMin: scanWindowMin() * 4 });
    if (made || folded) console.log(`[Arena] discovered ${made} subject(s), folded ${folded} into existing ones (last ${scanWindowMin()} min)`);
    return { made, folded, pulse: _pulse.text };
}

/** Seed a fresh topic with the lines from the window that match it, so it never starts empty. */
function backfillMoments(topics, { windowMin = null } = {}) {
    const win = Math.max(30, Number(windowMin) || scanWindowMin() * 4);
    const chat = db.all(`SELECT id, stream_id, user_id, username, message, source_platform, anon_id, timestamp FROM chat_messages WHERE COALESCE(is_deleted, 0) = 0 AND COALESCE(message_type, 'chat') = 'chat' AND COALESCE(source_platform, '') != 'ai' AND timestamp >= datetime('now', ?) AND LENGTH(message) BETWEEN 6 AND 300 ORDER BY id DESC LIMIT 600`, [`-${win} minutes`]).reverse();
    const speech = db.all(`SELECT e.stream_id, e.user_id, e.vod_id, e.start_sec, e.text, e.created_at, u.username FROM stream_timeline_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.kind = 'speech' AND e.created_at >= datetime('now', ?) ORDER BY e.id DESC LIMIT 400`, [`-${win} minutes`]).reverse();
    let seeded = 0;
    for (const t of topics) {
        const kws = normalizeKeywords(parseJson(t.keywords_json, [])).map(keywordRegex);
        let n = 0;
        for (const c of chat) if (!isBotChatter(c) && !/^!/.test(c.message) && kws.some(re => re.test(c.message))) { if (addMoment(t.id, { kind: 'chat', source: 'seed', userId: c.user_id, username: c.username, streamId: c.stream_id, text: c.message, platform: c.source_platform || null, anonId: c.anon_id || null, saidAt: c.timestamp })) n++; }
        for (const s of speech) if (kws.some(re => re.test(s.text || ''))) { if (addMoment(t.id, { kind: 'speech', source: 'seed', userId: s.user_id, username: s.username, streamId: s.stream_id, vodId: s.vod_id, sec: Math.max(0, Math.floor(s.start_sec) - 2), text: s.text, saidAt: s.created_at })) n++; }
        if (n) console.log(`[Arena] topic #${t.id} seeded with ${n} moment(s) from the last ${win} min`);
        seeded += n;
    }
    return seeded;
}
function pulse() { const p = loadPulse(); return { text: p.text, at: p.at ? new Date(p.at).toISOString() : null, sources: p.sources || [] }; }

// ── Lore ─────────────────────────────────────────────────────

const LORE_SCHEMA = { name: 'arena_lore', schema: { type: 'object', additionalProperties: false, required: ['lore', 'headline', 'tagline', 'keywords', 'threads'], properties: {
    lore: { type: 'string', description: 'SHORT: 2–4 punchy sentences, ≤ 450 characters total. The story so far: who brought it up, the wildest line (quote it verbatim with the username), who is on which end, the latest twist. Tabloid / fight-promoter voice, dumb, petty, funny. No filler, no recap of every line.' },
    headline: { type: 'string', description: 'Updated tabloid headline ≤ 70 chars' },
    tagline: { type: 'string', description: '≤ 80 chars: where it stands right now' },
    keywords: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'string' }, description: 'updated lowercase keywords/slang people use for it (keep the good existing ones)' },
    threads: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['name', 'keywords', 'hint'], properties: { name: { type: 'string', description: '2–5 words' }, keywords: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } }, hint: { type: 'string', description: '≤ 70 chars' } } }, description: 'the threads (sub-angles) inside this subject — keep the existing ones by name, add new angles that emerged in the new moments' },
} } };
const LORE_SYSTEM = `You write and update the LORE of a subject the community of a live-streaming site is talking about — as a regular of this chat, not a copywriter. VOICE RULES: match the way the moments are typed (slang, casing, rhythm; lowercase if chat is lowercase), blunt, dry, funny; quote real lines instead of describing them; use the site's own words; no tabloid adjective soup, no invented compound words, no "erupts"/"explodes"/"chaos"/"saga"/"epic", no exclamation marks. Use what the chat AI knows about the people involved (their known bits, grudges, history) to make it specific to THEM. You get the subject, the previous lore (if any), and the newest moments: chat lines and on-mic lines with usernames. Rewrite the lore SHORT (2–4 sentences, under 450 characters): who started it, the wildest line (verbatim, with username), who is on which end, the latest twist. Drop everything else. Also return the THREADS inside the subject: keep the existing thread names, add a new one only when a genuinely new angle shows up in the new moments. Voice: tabloid meets fight promoter meets the dumbest guy in the group chat; provocative and funny; take the piss out of everyone. This platform does not censor language: slurs, profanity and taboo talk are allowed and should be quoted as said. Hard line: no direct threats of violence, nothing sexual about minors, no doxxing. Output only the JSON.`;

/** What the site already knows: how the community types, the global chat AI overview, and the chat AI's profile of the people in these moments. Cheap (all cached rows), no calls. */
function communityContext(moments) {
    const out = {};
    try { out.how_this_chat_types = db.all(`SELECT message, username, user_id, source_platform FROM chat_messages WHERE COALESCE(is_deleted, 0) = 0 AND COALESCE(source_platform, '') != 'ai' AND COALESCE(message_type, 'chat') = 'chat' AND LENGTH(message) BETWEEN 8 AND 140 AND message NOT LIKE '!%' ORDER BY id DESC LIMIT 40`).filter(r => !isBotChatter(r)).slice(0, 25).map(r => r.message); } catch { out.how_this_chat_types = []; }
    try { const g = db.getChatAiSummary('global', 0, 'rolling'); if (g) { const ov = parseJson(g.overview, null); out.global_chat_overview = clip(ov ? (ov.today || ov.alltime) : g.overview, 500); out.global_chat_memory = clip(g.memory_json, 400); } } catch { /* */ }
    try {
        const chatters = require('./chatters');
        const seen = new Set(); const people = [];
        for (const m of moments || []) {
            const key = m.chatter_key || chatters.keyFor(m); if (!key || seen.has(key) || people.length >= 5) continue; seen.add(key);
            const p = chatters.parseKey(key); let ai = null;
            try { if (p.kind === 'user') ai = db.getChatAiSummary('user', p.user_id, 'rolling'); else if (p.kind === 'anon') ai = db.getChatAiSummary('anon', p.anon_num, 'rolling'); else if (p.kind === 'relay' && db.getRelayUser) { const ru = db.getRelayUser(p.platform, p.username); if (ru) ai = db.getChatAiSummary('relay', ru.id, 'rolling'); } } catch { /* */ }
            if (ai) { const ov = parseJson(ai.overview, null); people.push({ name: m.username, known_for: clip(ov ? (ov.alltime || ov.today) : ai.overview, 260), memory: clip(ai.memory_json, 200) }); }
        }
        if (people.length) out.what_the_chat_ai_knows_about_these_people = people;
    } catch { /* */ }
    return out;
}

function templateLore(topic, moments, members) {
    const first = moments[moments.length - 1];
    const best = moments.filter(m => m.quality != null).sort((a, b) => b.quality - a.quality)[0] || moments.find(m => m.kind === 'speech') || moments[0];
    const chatters = [...new Set(moments.filter(m => m.kind === 'chat').map(m => m.username).filter(Boolean))];
    const parts = [];
    if (first) parts.push(`It started ${first.kind === 'chat' ? 'in chat' : 'on mic'} when ${first.username || 'someone'} said “${clip(first.text, 120)}”.`);
    if (chatters.length) parts.push(`${chatters.length === 1 ? chatters[0] : `${chatters.slice(0, 3).join(', ')}${chatters.length > 3 ? ` and ${chatters.length - 3} others` : ''}`} piled on from chat.`);
    if (members.length) parts.push(`${members.map(m => m.fighter_name).slice(0, 3).join(', ')} took it on stream.`);
    if (best && best !== first) parts.push(`Best line so far, ${best.username || 'unknown'}: “${clip(best.text, 120)}”.`);
    if (!parts.length) parts.push('Nobody has said anything about it yet. Be first.');
    return parts.join(' ');
}

/** Rewrite a topic's lore from its moments (AI when on, template otherwise). */
async function buildLore(topicId, { force = false } = {}) {
    ensureTables();
    const topic = db.get('SELECT * FROM arena_topics WHERE id = ?', [topicId]);
    if (!topic) return null;
    const total = db.get('SELECT COUNT(*) AS n FROM arena_topic_moments WHERE topic_id = ?', [topicId])?.n || 0;
    const fresh = total - (topic.lore_moment_count || 0);
    const stale = !topic.lore_updated_at || Date.now() - Date.parse(topic.lore_updated_at + 'Z') > LORE_MIN_INTERVAL_MS;
    if (!force && (fresh < LORE_MIN_NEW_MOMENTS || (!stale && topic.lore))) return { skipped: true };
    const roster = arena().loadRoster();
    const moments = db.all('SELECT * FROM arena_topic_moments WHERE topic_id = ? ORDER BY id DESC LIMIT 30', [topicId]);
    const members = db.all('SELECT user_id FROM arena_topic_members WHERE topic_id = ?', [topicId]).map(m => fighterBrief(m.user_id, roster));
    let out = null;
    if (aiOn() && moments.length) {
        try {
            const r = await llm.complete({ role: 'summary', kind: 'arena_lore', source: 'arena', system: LORE_SYSTEM, json: LORE_SCHEMA, maxTokens: 600, temperature: 0.85, timeoutMs: 30000,
                user: JSON.stringify({ subject: topic.text, kind: topic.kind, bounty_target: topic.target_user_id ? nameOf(topic.target_user_id) : null, started_by: topic.creator_name || topic.created_by, source: topic.source_note, previous_lore: topic.lore, previous_headline: topic.headline, keywords: parseJson(topic.keywords_json, []), existing_threads: threadsOf(topic.id).map(t => t.name), ...communityContext(moments),
                    fighters_on_it: members.map(m => m.fighter_name), moments: moments.slice().reverse().map(m => ({ who: m.username || 'anon', where: m.kind === 'chat' ? 'chat' : 'on mic', text: m.text, quality: m.quality })) }) });
            if (r && r.json && r.json.lore) out = r.json;
        } catch (e) { console.warn('[Arena] lore:', e.message); }
    }
    if (!out) out = { lore: templateLore(topic, moments, members), headline: topic.headline, tagline: topic.tagline, keywords: parseJson(topic.keywords_json, []) };
    const kws = normalizeKeywords([...(parseJson(topic.keywords_json, []) || []), ...(out.keywords || [])]);
    db.run('UPDATE arena_topics SET lore = ?, headline = COALESCE(?, headline), tagline = COALESCE(?, tagline), keywords_json = ?, lore_updated_at = CURRENT_TIMESTAMP, lore_moment_count = ? WHERE id = ?',
        [clip(out.lore, 600), out.headline ? clip(out.headline, 120) : null, out.tagline ? clip(out.tagline, 100) : null, JSON.stringify(kws), total, topicId]);
    try { if (Array.isArray(out.threads) && out.threads.length) { upsertThreads(topicId, out.threads.filter(t => !mergeCandidate(t.name, t.keywords, { exclude: topicId }))); const merged = normalizeKeywords([...kws, ...threadsOf(topicId).flatMap(t => parseJson(t.keywords_json, []) || [])]); db.run('UPDATE arena_topics SET keywords_json = ? WHERE id = ?', [JSON.stringify(merged), topicId]); } } catch (e) { console.warn('[Arena] threads:', e.message); }
    invalidateMatchers();
    try { require('./chatters').onLore(topic, out.lore, moments); } catch (e) { console.warn('[Arena] lore quotes xp:', e.message); }
    return { lore: out.lore, headline: out.headline, tagline: out.tagline };
}

/** Sweep: refresh lore where enough new moments landed (a few per call so the budget stays sane). */
async function loreSweep(max = 3) {
    ensureTables();
    const due = db.all(`SELECT id, lore_moment_count, lore_updated_at, (SELECT COUNT(*) FROM arena_topic_moments m WHERE m.topic_id = t.id) AS n FROM arena_topics t WHERE status = 'open' ORDER BY heat DESC`)
        .filter(t => (t.n - (t.lore_moment_count || 0)) >= LORE_MIN_NEW_MOMENTS && (!t.lore_updated_at || Date.now() - Date.parse(t.lore_updated_at + 'Z') > LORE_MIN_INTERVAL_MS)).slice(0, max);
    let n = 0;
    for (const t of due) { try { const r = await buildLore(t.id); if (r && !r.skipped) n++; } catch (e) { console.warn('[Arena] lore sweep:', e.message); } }
    return n;
}

// ── Views ────────────────────────────────────────────────────

function fighterBrief(userId, roster) {
    const f = roster.byId[userId];
    const persona = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [userId])?.persona_json);
    return {
        user: f ? f.user : (db.getUserById(userId) ? arena().publicUser(db.getUserById(userId)) : { id: userId, username: `user${userId}`, display_name: `user${userId}` }),
        fighter_name: persona?.fighter_name || f?.user?.display_name || `user${userId}`,
        rank: f ? roster.order.indexOf(userId) + 1 : null,
        image_url: (() => { try { return arena().getFighterImageUrl(userId); } catch { return null; } })(),
        live: !!db.get('SELECT 1 FROM streams WHERE user_id = ? AND is_live = 1 LIMIT 1', [userId]),
        level: levelFor(levelRow(userId).xp || 0),
    };
}
function momentView(m) { return { id: m.id, kind: m.kind, source: m.source, user_id: m.user_id, username: m.username, chatter_key: m.chatter_key || null, platform: m.source_platform || null, thread_id: m.thread_id || null, stream_id: m.stream_id, vod_id: m.vod_id, sec: m.sec, text: m.text, quality: m.quality, about: m.about, at: m.said_at || m.created_at, filed_at: m.created_at }; }

function topicView(topic, roster, { detail = false } = {}) {
    const members = db.all(`SELECT m.*, (SELECT COUNT(*) FROM arena_topic_moments x WHERE x.topic_id = m.topic_id AND x.user_id = m.user_id AND x.kind = 'speech') AS moments, (SELECT COALESCE(SUM(quality), 0) FROM arena_topic_moments x WHERE x.topic_id = m.topic_id AND x.user_id = m.user_id) AS score FROM arena_topic_members m WHERE m.topic_id = ? ORDER BY score DESC, moments DESC`, [topic.id]);
    const heat = topic.heat || 0;
    const last = db.get('SELECT * FROM arena_topic_moments WHERE topic_id = ? ORDER BY COALESCE(said_at, created_at) DESC, id DESC LIMIT 1', [topic.id]);
    const best = db.get('SELECT * FROM arena_topic_moments WHERE topic_id = ? AND quality IS NOT NULL ORDER BY quality DESC, id DESC LIMIT 1', [topic.id]);
    const out = {
        id: topic.id, text: topic.text, hint: topic.hint, created_by: topic.created_by, creator_name: topic.creator_name, status: topic.status,
        kind: topic.kind || 'topic', target: topic.target_user_id ? fighterBrief(topic.target_user_id, roster) : null,
        headline: topic.headline, tagline: topic.tagline, lore: topic.lore, lore_updated_at: topic.lore_updated_at, keywords: parseJson(topic.keywords_json, []) || [],
        source_note: topic.source_note, heat: Math.round(heat), hot: heat >= HOT_THRESHOLD,
        expires_at: topic.expires_at && topic.kind === 'bounty' ? new Date(topic.expires_at + 'Z').toISOString() : null, resolved: parseJson(topic.resolved_json),
        mentions: { chat: topic.chat_mentions || 0, mic: topic.mic_mentions || 0, total: (topic.chat_mentions || 0) + (topic.mic_mentions || 0) },
        chatters: db.get(`SELECT COUNT(DISTINCT COALESCE(username, user_id)) AS n FROM arena_topic_moments WHERE topic_id = ? AND kind = 'chat'`, [topic.id])?.n || 0,
        threads: db.all('SELECT * FROM arena_topic_threads WHERE topic_id = ? ORDER BY moments DESC, id ASC', [topic.id]).map(t => ({ id: t.id, name: t.name, hint: t.hint, moments: t.moments || 0, last_at: t.last_at, keywords: parseJson(t.keywords_json, []) || [] })),
        talking_now: members.filter(m => m.active).map(m => fighterBrief(m.user_id, roster)),
        fighters: members.slice(0, 12).map(m => ({ ...fighterBrief(m.user_id, roster), active: !!m.active, moments: m.moments, score: Number((m.score || 0).toFixed(1)) })),
        last_moment: last ? momentView(last) : null, best_moment: best ? momentView(best) : null,
        created_at: topic.created_at, last_activity_at: topic.last_activity_at, last_mention_at: topic.last_mention_at,
    };
    if (detail) {
        out.submitted_text = topic.submitted_text || null;
        out.moments = db.all(`SELECT * FROM arena_topic_moments WHERE topic_id = ? AND (quality IS NULL OR quality >= ${MIN_JUDGED_QUALITY}) ORDER BY COALESCE(said_at, created_at) DESC, id DESC LIMIT 80`, [topic.id]).map(momentView);
        out.top_chatters = db.all(`SELECT username, chatter_key, COUNT(*) AS n FROM arena_topic_moments WHERE topic_id = ? AND kind = 'chat' AND username IS NOT NULL GROUP BY COALESCE(chatter_key, username) ORDER BY n DESC LIMIT 6`, [topic.id]).map(c => { let lvl = null; try { const r = require('./chatters').row(c.chatter_key); if (r) lvl = { level: r.level, title: require('./chatters').titleFor(r.level) }; } catch { /* */ } return { ...c, ...(lvl || {}) }; });
        out.best_lines = db.all(`SELECT * FROM arena_topic_moments WHERE topic_id = ? AND quality IS NOT NULL ORDER BY quality DESC, id DESC LIMIT 6`, [topic.id]).map(momentView);
        for (const f of out.fighters) { const bm = db.get(`SELECT * FROM arena_topic_moments WHERE topic_id = ? AND user_id = ? AND kind = 'speech' ORDER BY COALESCE(quality, -1) DESC, id DESC LIMIT 1`, [topic.id, f.user.id]); f.best = bm ? momentView(bm) : null; }
    }
    return out;
}

function boardView() {
    ensureTables();
    archiveStale();
    resolveExpired();
    const roster = arena().loadRoster();
    const topics = db.all(`SELECT * FROM arena_topics WHERE status = 'open' ORDER BY id DESC LIMIT ?`, [MAX_OPEN_TOPICS]);
    for (const t of topics) t.heat = computeHeat(t.id);
    topics.sort((x, y) => (y.heat - x.heat) || (Date.parse(y.last_activity_at) - Date.parse(x.last_activity_at)));
    const archive = db.all(`SELECT * FROM arena_topics WHERE status IN ('archived', 'resolved') AND (lore IS NOT NULL OR hits > 0) ORDER BY id DESC LIMIT 10`).map(t => topicView(t, roster));
    return { open: topics.map(t => topicView(t, roster)), archive, pulse: pulse(), hot_threshold: HOT_THRESHOLD, cooldown_hours: USER_TOPIC_COOLDOWN_HOURS };
}

function topicDetail(topicId) {
    ensureTables();
    const topic = db.get('SELECT * FROM arena_topics WHERE id = ?', [topicId]);
    if (!topic) return null;
    if (topic.status === 'open') topic.heat = computeHeat(topic.id);
    return topicView(topic, arena().loadRoster(), { detail: true });
}

function levelsLeaderboard(limit = 10) {
    ensureTables();
    const roster = arena().loadRoster();
    return db.all('SELECT * FROM arena_trash_levels WHERE xp > 0 ORDER BY xp DESC LIMIT ?', [limit]).map(r => ({ ...fighterBrief(r.user_id, roster), xp: r.xp, level: levelFor(r.xp), topic_moments: r.topic_moments || 0, topics_joined: r.topics_joined || 0, beef_hits: r.beef_hits || 0, best_line: r.best_line ? { text: r.best_line, vod_id: r.best_line_vod_id, sec: r.best_line_sec } : null }));
}

/** Viewers who keep the subjects alive from chat (moments in the last 7 days). */
function yappersLeaderboard(limit = 10) { return require('./chatters').leaderboard(limit); }

module.exports = {
    ensureTables, createTopic, submitTopic, assertCanSubmit, joinTopic, leaveTopic, activeTopicFor, threadsOf, threadFor, upsertThreads, isBotChatter, mergeCandidate, foldInto, applyTopicJudgement, hypeTopic, addMoment, noteMicMention, matchTopics, keywordsFromText,
    addXp, levelRow, levelView, levelFor, recentXp, boardView, topicDetail, levelsLeaderboard, yappersLeaderboard, fighterBrief, archiveStale,
    scanChat, discoverTopics, discoverInput, heuristicDiscover, backfillMoments, buildLore, loreSweep, templateLore, pulse, nameOf,
    computeHeat, resolveExpired, openBountyOn, recordBountyHit, HOT_THRESHOLD, KIND_TTL_HOURS, XP_PER_LEVEL, XP_JOIN, XP_HYPE, TOPIC_TTL_HOURS, SCAN_WINDOW_MIN, USER_TOPIC_COOLDOWN_HOURS,
    _resetScan: () => { _scan = { lastChatId: null, lastDiscoverAt: 0, lastDiscoverSeen: 0 }; invalidateMatchers(); },
};
