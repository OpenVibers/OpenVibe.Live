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
    for (const col of ['chatter_key TEXT', 'source_platform TEXT', 'anon_id TEXT']) { try { db.run(`ALTER TABLE arena_topic_moments ADD COLUMN ${col}`); } catch { /* exists */ } }
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
        'keywords_json TEXT', 'lore TEXT', 'tagline TEXT', 'lore_updated_at DATETIME', 'lore_moment_count INTEGER DEFAULT 0', 'chat_mentions INTEGER DEFAULT 0', 'mic_mentions INTEGER DEFAULT 0', 'last_mention_at DATETIME', 'origin_json TEXT', 'creator_ip_hash TEXT', 'submitted_text TEXT']) {
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
    if (after.level > before.level) console.log(`[Arena] user ${userId} → Trash Level ${after.level}`);
    try { arena().loadRoster(true); } catch { /* */ }
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
function normalizeKeywords(list) {
    return [...new Set((Array.isArray(list) ? list : []).map(k => String(k || '').toLowerCase().replace(/^@/, '').trim()).filter(k => k.length >= 3 && !STOPWORDS.has(k)))].slice(0, 10);
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

function createTopic({ text, hint = null, createdBy, creatorUserId = null, creatorName = null, creatorIp = null, kind = 'topic', targetUserId = null, headline = null, sourceNote = null, keywords = null, tagline = null, origin = null, submittedText = null }) {
    ensureTables();
    const clean = cleanTopicText(text);
    kind = ['topic', 'bounty'].includes(kind) ? kind : 'topic';
    if (kind === 'bounty' && !targetUserId) throw new Error('A bounty needs a target');
    if (kind === 'bounty' && db.get(`SELECT id FROM arena_topics WHERE status = 'open' AND kind = 'bounty' AND target_user_id = ?`, [targetUserId])) throw new Error('There is already a bounty on them');
    const dup = db.get(`SELECT id FROM arena_topics WHERE status = 'open' AND LOWER(text) = LOWER(?)`, [clean]);
    if (dup) throw new Error('That topic is already on the board');
    let kws = normalizeKeywords(keywords);
    if (!kws.length) kws = keywordsFromText(clean);
    if (kind === 'bounty' && targetUserId) { const u = db.getUserById(targetUserId); if (u) { const nm = require('./names'); kws = normalizeKeywords([...kws, u.username, u.display_name, ...nm.variants(u.username), ...nm.variants(u.display_name)]); } }
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
    invalidateMatchers();
    console.log(`[Arena] ${kind} #${row.id} by ${createdBy}${creatorName ? ' ' + creatorName : ''}: "${clean}" [${kws.join(', ')}]`);
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

const REFINE_SCHEMA = { name: 'arena_refine_topic', schema: { type: 'object', additionalProperties: false, required: ['subject', 'headline', 'tagline', 'hint', 'keywords', 'reject'], properties: {
    subject: { type: 'string', description: 'the subject as a short noun phrase ≤ 70 chars, punchy, dumb-funny' },
    headline: { type: 'string', description: 'tabloid headline ≤ 90 chars, inflammatory and stupid in a good way' },
    tagline: { type: 'string', description: '≤ 100 chars, who submitted it and why everyone should care' },
    hint: { type: 'string', description: '≤ 90 chars: how to pile on / bait for streamers' },
    keywords: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string' }, description: 'lowercase words/slang people would actually type or say about it' },
    reject: { type: 'boolean', description: 'true ONLY if it is a direct threat of violence, sexual content about a minor, or doxxing' },
} } };
const REFINE_SYSTEM = `A user typed a topic for the shit-talking board of a live-streaming site. Rewrite it into a proper board SUBJECT that looks good and baits people: a short noun-phrase subject, a tabloid headline, a tagline crediting the submitter, a hint on how to pile on, and the keywords people would actually type or say about it (slang, variants, misspellings). Make it dumber, funnier and more provocative than what they typed; keep their actual meaning. Slurs, profanity and taboo topics are allowed and never a reason to reject — this platform does not censor language. Reject ONLY direct threats of violence, sexual content about minors, or doxxing. Output only the JSON.`;

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
    const t = createTopic({ text: refined?.subject || raw, hint: refined?.hint || null, createdBy: onRoster ? 'streamer' : 'viewer', creatorUserId: userId, creatorName, creatorIp: ip, headline: refined?.headline || null, tagline: refined?.tagline || `Put up by ${creatorName}`, sourceNote: creatorName, keywords: refined?.keywords || null, submittedText: raw });
    backfillMoments([t]);
    try { require('./chatters').onSubjectStarted(`user:${userId}`, t.id, { display: creatorName }); } catch { /* */ }
    return t;
}

/** A moment: something someone said (chat or on mic) about the topic. */
function addMoment(topicId, { kind, source, userId = null, username = null, streamId = null, vodId = null, sec = null, text, quality = null, about = null, platform = null, anonId = null }) {
    ensureTables();
    const t = db.get(`SELECT id, kind, status, heat FROM arena_topics WHERE id = ?`, [topicId]);
    if (!t || t.status !== 'open') return null;
    const body = clip(text, 240);
    if (!body || arena()._isBannedText(body)) return null;
    const chatters = require('./chatters');
    const chatterKey = chatters.keyFor({ user_id: userId, username, anon_id: anonId, source_platform: platform });
    db.run(`INSERT INTO arena_topic_moments (topic_id, kind, source, user_id, username, stream_id, vod_id, sec, text, quality, about, chatter_key, source_platform, anon_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [topicId, kind, source, userId, username ? clip(username, 60) : null, streamId, vodId, sec, body, quality, about ? clip(about, 80) : null, chatterKey, platform, anonId]);
    db.run(`UPDATE arena_topics SET hits = hits + 1, ${kind === 'chat' ? 'chat_mentions = chat_mentions + 1' : 'mic_mentions = mic_mentions + 1'}, last_mention_at = CURRENT_TIMESTAMP, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?`, [topicId]);
    if (kind === 'speech' && userId && arena().loadRoster().byId[userId]) {
        const m = db.get('SELECT 1 FROM arena_topic_members WHERE topic_id = ? AND user_id = ?', [topicId, userId]);
        if (!m) { db.run('INSERT INTO arena_topic_members (topic_id, user_id, active) VALUES (?, ?, 1)', [topicId, userId]); db.run('UPDATE arena_topics SET joins = joins + 1 WHERE id = ?', [topicId]); addXp(userId, XP_JOIN, 'topic_joined', topicId, { joined: true }); }
    }
    const m = db.get('SELECT * FROM arena_topic_moments ORDER BY id DESC LIMIT 1');
    // Yapper XP for chat lines (seeded backfills count too — they are real lines people typed).
    if (kind === 'chat' && chatterKey) { try { chatters.onMoment(m, t, { hot: (t.heat || 0) >= HOT_THRESHOLD }); } catch (e) { console.warn('[Arena] yapper xp:', e.message); } }
    return m;
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
function applyTopicJudgement(userId, topic, judgement, lineRef) {
    if (judgement.flagged || !judgement.on_topic) return { applied: false };
    const quality = Math.max(0, Math.min(10, Number(judgement.quality) || 0));
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
    db.run('UPDATE arena_topics SET heat = ? WHERE id = ?', [heat, topicId]);
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

// ── Discovery: what is the community actually talking about? ─

let _scan = { lastChatId: null, lastDiscoverAt: 0, lastDiscoverSeen: 0 };

/** Every minute: new chat messages → moments on matching topics. */
function scanChat() {
    ensureTables();
    if (_scan.lastChatId == null) { _scan.lastChatId = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages')?.id || 0; return { scanned: 0, moments: 0 }; }
    const rows = db.all(`SELECT id, stream_id, user_id, username, message, source_platform, anon_id FROM chat_messages WHERE id > ? AND COALESCE(is_deleted, 0) = 0 AND message IS NOT NULL AND COALESCE(message_type, 'chat') = 'chat' AND COALESCE(source_platform, '') != 'ai' AND LENGTH(message) BETWEEN 6 AND 300 ORDER BY id ASC LIMIT 400`, [_scan.lastChatId]);
    if (!rows.length) return { scanned: 0, moments: 0 };
    _scan.lastChatId = rows[rows.length - 1].id;
    let moments = 0;
    for (const r of rows) {
        if (/^!/.test(r.message)) continue;
        for (const t of matchTopics(r.message)) { if (addMoment(t.id, { kind: 'chat', source: 'chat', userId: r.user_id, username: r.username, streamId: r.stream_id, text: r.message, platform: r.source_platform || null, anonId: r.anon_id || null })) moments++; }
    }
    return { scanned: rows.length, moments };
}

const DISCOVER_SCHEMA = { name: 'arena_discover', schema: { type: 'object', additionalProperties: false, required: ['pulse', 'topics', 'bounties'], properties: {
    pulse: { type: 'string', description: 'One sentence ≤ 140 chars: what the community is on about right now, dumb hype-caster voice, name names, funny' },
    topics: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['subject', 'headline', 'tagline', 'keywords', 'source', 'hint'], properties: {
        subject: { type: 'string', description: 'The SUBJECT people are talking about, as a short noun phrase ≤ 70 chars — e.g. "Pakistanis", "the cat enema joke", "Maticus\'s vet bill", "Meshtastic tent streams". Not a question, not a prompt.' },
        headline: { type: 'string', description: 'Tabloid headline ≤ 90 chars, inflammatory, stupid-funny' },
        tagline: { type: 'string', description: '≤ 100 chars: current state of it — who started it, who is on which end' },
        keywords: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string' }, description: 'lowercase words/short phrases people actually use for this subject (incl. slang and misspellings) — used to match future chat and speech' },
        source: { type: 'string', description: '≤ 6 words: where it came from ("global chat", "Goosely\'s stream")' },
        hint: { type: 'string', description: '≤ 90 chars, how to pile on' },
    } } },
    bounties: { type: 'array', minItems: 0, maxItems: 1, items: { type: 'object', additionalProperties: false, required: ['target_username', 'headline', 'why'], properties: { target_username: { type: 'string', description: 'exact username from the snapshot the community keeps naming/dunking on' }, headline: { type: 'string' }, why: { type: 'string', description: '≤ 90 chars' } } } },
} } };
const DISCOVER_SYSTEM = `You are the community consciousness of a live-streaming site's Arena — part tabloid editor, part fight promoter, part 4chan ragebaiter with a head injury. You get what people ACTUALLY said in the last while: global + stream chat lines and what streamers said on mic, plus the subjects already on the board. Find the SUBJECTS the community is really on about — a group of people, a person, a running joke, an argument, a product, a drama, a meme — the more provocative, taboo, petty or stupid the better; nothing generic, nothing wholesome. Ignore small talk. Do not repeat subjects already on the board (match by meaning). For each: a noun-phrase subject, a tabloid headline, a tagline (who started it, who is where on it), the keywords/slang people use for it, the source, and a hint on how to pile on. If the community keeps naming one specific streamer (dunking, defending, calling out), add ONE bounty on that exact username. Profanity, disrespect, slurs and trolling are welcome and are never a reason to skip a subject — this platform does not censor language. Hard line: no direct threats of violence, nothing sexual about minors, no doxxing. Return empty arrays if nothing real is going on. Output only the JSON.`;

function discoverInput() {
    const out = { at: new Date().toISOString() };
    try { out.chat = db.all(`SELECT c.username, c.message, c.stream_id FROM chat_messages c WHERE COALESCE(c.is_deleted, 0) = 0 AND COALESCE(c.source_platform, '') != 'ai' AND COALESCE(c.message_type, 'chat') = 'chat' AND c.timestamp >= datetime('now', ?) AND LENGTH(c.message) BETWEEN 8 AND 200 AND c.message NOT LIKE '!%' ORDER BY c.id DESC LIMIT 80`, [`-${SCAN_WINDOW_MIN} minutes`]).reverse().filter(r => !arena()._isBannedText(r.message)).map(r => clip(`[${r.stream_id ? 'stream' : 'global'}] ${r.username}: ${r.message}`, 180)); } catch { out.chat = []; }
    try { out.on_mic = db.all(`SELECT u.username, e.text FROM stream_timeline_events e JOIN users u ON u.id = e.user_id WHERE e.kind = 'speech' AND e.created_at >= datetime('now', ?) AND LENGTH(e.text) BETWEEN 25 AND 220 ORDER BY e.id DESC LIMIT 60`, [`-${SCAN_WINDOW_MIN} minutes`]).reverse().filter(r => !arena()._isBannedText(r.text)).map(r => clip(`${r.username}: ${r.text}`, 200)); } catch { out.on_mic = []; }
    try { out.chat_timeline = db.all(`SELECT label, detail FROM chat_timeline_events WHERE created_at >= datetime('now', '-6 hours') ORDER BY id DESC LIMIT 8`).map(r => clip(`${r.label}: ${r.detail || ''}`, 140)); } catch { out.chat_timeline = []; }
    try { const g = db.getChatAiSummary('global', 0, 'rolling'); if (g) { const ov = parseJson(g.overview, null); out.global_chat_overview = clip(ov ? (ov.today || ov.alltime) : g.overview, 500); } } catch { /* */ }
    try { const roster = arena().loadRoster(); out.roster_usernames = roster.order.map(id => roster.byId[id].user.username); } catch { out.roster_usernames = []; }
    out.already_on_board = db.all(`SELECT text, keywords_json FROM arena_topics WHERE status = 'open' ORDER BY id DESC LIMIT 20`).map(r => `${r.text} [${(parseJson(r.keywords_json, []) || []).join(', ')}]`);
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
        .map(([w, c]) => ({ subject: w.charAt(0).toUpperCase() + w.slice(1), headline: `Everyone is suddenly on about "${w}"`, tagline: `${c.people.size} people, ${c.n} mentions in ${SCAN_WINDOW_MIN} minutes`, keywords: [w], source: 'chat burst', hint: 'Say it on mic. Make it worse.' }));
}

let _pulse = { text: null, at: null, sources: [] };
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
            if (r && r.json) { topics = r.json.topics || []; bounties = r.json.bounties || []; if (r.json.pulse) _pulse = { text: clip(r.json.pulse, 200), at: Date.now(), sources: ['chat', 'on_mic'].filter(k => input[k].length) }; }
        } catch (e) { console.warn('[Arena] discover:', e.message); }
    } else {
        topics = heuristicDiscover(input);
    }
    let made = 0;
    const created = [];
    for (const t of topics.slice(0, 4)) {
        try { created.push(createTopic({ text: t.subject, hint: t.hint, createdBy: 'community', creatorName: clip(t.source || 'the community', 40), headline: t.headline, tagline: t.tagline, sourceNote: t.source, keywords: t.keywords })); made++; } catch { /* dup */ }
    }
    for (const b of bounties.slice(0, 1)) {
        try {
            const u = db.getUserByUsername(String(b.target_username || '').replace(/^@/, ''));
            if (!u || !arena().loadRoster().byId[u.id]) continue;
            created.push(createTopic({ text: `Bounty: ${nameOf(u.id)}`, hint: clip(b.why, 90), createdBy: 'community', creatorName: 'the community', kind: 'bounty', targetUserId: u.id, headline: b.headline, tagline: b.why, sourceNote: 'community' })); made++;
        } catch { /* dup */ }
    }
    if (created.length) backfillMoments(created);
    if (made) console.log(`[Arena] discovered ${made} subject(s) from the last ${SCAN_WINDOW_MIN} min`);
    return { made, pulse: _pulse.text };
}

/** Seed a fresh topic with the lines from the window that match it, so it never starts empty. */
function backfillMoments(topics) {
    const chat = db.all(`SELECT id, stream_id, user_id, username, message, source_platform, anon_id FROM chat_messages WHERE COALESCE(is_deleted, 0) = 0 AND COALESCE(message_type, 'chat') = 'chat' AND COALESCE(source_platform, '') != 'ai' AND timestamp >= datetime('now', ?) AND LENGTH(message) BETWEEN 6 AND 300 ORDER BY id ASC LIMIT 400`, [`-${SCAN_WINDOW_MIN * 4} minutes`]);
    const speech = db.all(`SELECT e.stream_id, e.user_id, e.vod_id, e.start_sec, e.text, u.username FROM stream_timeline_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.kind = 'speech' AND e.created_at >= datetime('now', ?) ORDER BY e.id ASC LIMIT 300`, [`-${SCAN_WINDOW_MIN * 4} minutes`]);
    for (const t of topics) {
        const kws = normalizeKeywords(parseJson(t.keywords_json, [])).map(keywordRegex);
        let n = 0;
        for (const c of chat) if (!/^!/.test(c.message) && kws.some(re => re.test(c.message))) { if (addMoment(t.id, { kind: 'chat', source: 'seed', userId: c.user_id, username: c.username, streamId: c.stream_id, text: c.message, platform: c.source_platform || null, anonId: c.anon_id || null })) n++; }
        for (const s of speech) if (kws.some(re => re.test(s.text || ''))) { if (addMoment(t.id, { kind: 'speech', source: 'seed', userId: s.user_id, username: s.username, streamId: s.stream_id, vodId: s.vod_id, sec: Math.max(0, Math.floor(s.start_sec) - 2), text: s.text })) n++; }
        if (n) console.log(`[Arena] topic #${t.id} seeded with ${n} moment(s)`);
    }
}
function pulse() { return { text: _pulse.text, at: _pulse.at ? new Date(_pulse.at).toISOString() : null, sources: _pulse.sources }; }

// ── Lore ─────────────────────────────────────────────────────

const LORE_SCHEMA = { name: 'arena_lore', schema: { type: 'object', additionalProperties: false, required: ['lore', 'headline', 'tagline', 'keywords'], properties: {
    lore: { type: 'string', description: '3–6 sentences. The evolving story of this subject on the site: who brought it up and where, who said what (quote the best lines verbatim, name usernames), who is on which end of it, how it escalated, current state. Tabloid / fight-promoter voice, dumb, petty, funny.' },
    headline: { type: 'string', description: 'Updated tabloid headline ≤ 90 chars' },
    tagline: { type: 'string', description: '≤ 100 chars: where it stands right now' },
    keywords: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'string' }, description: 'updated lowercase keywords/slang people use for it (keep the good existing ones)' },
} } };
const LORE_SYSTEM = `You write and update the LORE of a subject the community of a live-streaming site is talking about. You get the subject, the previous lore (if any), and the newest moments: chat lines and on-mic lines with usernames. Rewrite the lore so it tells the whole story so far and the new developments — who started it, who said the wildest things (quote them verbatim with their username), who is defending, who is dunking, streamers vs chat, escalations, plot twists. Keep what still matters from the previous lore, drop filler. Voice: tabloid meets fight promoter meets the dumbest guy in the group chat; provocative and funny; take the piss out of everyone. This platform does not censor language: slurs, profanity and taboo talk are allowed and should be quoted as said. Hard line: no direct threats of violence, nothing sexual about minors, no doxxing. Output only the JSON.`;

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
                user: JSON.stringify({ subject: topic.text, kind: topic.kind, bounty_target: topic.target_user_id ? nameOf(topic.target_user_id) : null, started_by: topic.creator_name || topic.created_by, source: topic.source_note, previous_lore: topic.lore, previous_headline: topic.headline, keywords: parseJson(topic.keywords_json, []),
                    fighters_on_it: members.map(m => m.fighter_name), moments: moments.slice().reverse().map(m => ({ who: m.username || 'anon', where: m.kind === 'chat' ? 'chat' : 'on mic', text: m.text, quality: m.quality })) }) });
            if (r && r.json && r.json.lore) out = r.json;
        } catch (e) { console.warn('[Arena] lore:', e.message); }
    }
    if (!out) out = { lore: templateLore(topic, moments, members), headline: topic.headline, tagline: topic.tagline, keywords: parseJson(topic.keywords_json, []) };
    const kws = normalizeKeywords([...(parseJson(topic.keywords_json, []) || []), ...(out.keywords || [])]);
    db.run('UPDATE arena_topics SET lore = ?, headline = COALESCE(?, headline), tagline = COALESCE(?, tagline), keywords_json = ?, lore_updated_at = CURRENT_TIMESTAMP, lore_moment_count = ? WHERE id = ?',
        [clip(out.lore, 1400), out.headline ? clip(out.headline, 160) : null, out.tagline ? clip(out.tagline, 120) : null, JSON.stringify(kws), total, topicId]);
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
function momentView(m) { return { id: m.id, kind: m.kind, source: m.source, user_id: m.user_id, username: m.username, chatter_key: m.chatter_key || null, platform: m.source_platform || null, stream_id: m.stream_id, vod_id: m.vod_id, sec: m.sec, text: m.text, quality: m.quality, about: m.about, at: m.created_at }; }

function topicView(topic, roster, { detail = false } = {}) {
    const members = db.all(`SELECT m.*, (SELECT COUNT(*) FROM arena_topic_moments x WHERE x.topic_id = m.topic_id AND x.user_id = m.user_id AND x.kind = 'speech') AS moments, (SELECT COALESCE(SUM(quality), 0) FROM arena_topic_moments x WHERE x.topic_id = m.topic_id AND x.user_id = m.user_id) AS score FROM arena_topic_members m WHERE m.topic_id = ? ORDER BY score DESC, moments DESC`, [topic.id]);
    const heat = topic.heat || 0;
    const last = db.get('SELECT * FROM arena_topic_moments WHERE topic_id = ? ORDER BY id DESC LIMIT 1', [topic.id]);
    const best = db.get('SELECT * FROM arena_topic_moments WHERE topic_id = ? AND quality IS NOT NULL ORDER BY quality DESC, id DESC LIMIT 1', [topic.id]);
    const out = {
        id: topic.id, text: topic.text, hint: topic.hint, created_by: topic.created_by, creator_name: topic.creator_name, status: topic.status,
        kind: topic.kind || 'topic', target: topic.target_user_id ? fighterBrief(topic.target_user_id, roster) : null,
        headline: topic.headline, tagline: topic.tagline, lore: topic.lore, lore_updated_at: topic.lore_updated_at, keywords: parseJson(topic.keywords_json, []) || [],
        source_note: topic.source_note, heat: Math.round(heat), hot: heat >= HOT_THRESHOLD,
        expires_at: topic.expires_at && topic.kind === 'bounty' ? new Date(topic.expires_at + 'Z').toISOString() : null, resolved: parseJson(topic.resolved_json),
        mentions: { chat: topic.chat_mentions || 0, mic: topic.mic_mentions || 0, total: (topic.chat_mentions || 0) + (topic.mic_mentions || 0) },
        chatters: db.get(`SELECT COUNT(DISTINCT COALESCE(username, user_id)) AS n FROM arena_topic_moments WHERE topic_id = ? AND kind = 'chat'`, [topic.id])?.n || 0,
        talking_now: members.filter(m => m.active).map(m => fighterBrief(m.user_id, roster)),
        fighters: members.slice(0, 12).map(m => ({ ...fighterBrief(m.user_id, roster), active: !!m.active, moments: m.moments, score: Number((m.score || 0).toFixed(1)) })),
        last_moment: last ? momentView(last) : null, best_moment: best ? momentView(best) : null,
        created_at: topic.created_at, last_activity_at: topic.last_activity_at, last_mention_at: topic.last_mention_at,
    };
    if (detail) {
        out.submitted_text = topic.submitted_text || null;
        out.moments = db.all('SELECT * FROM arena_topic_moments WHERE topic_id = ? ORDER BY id DESC LIMIT 80', [topic.id]).map(momentView);
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
    ensureTables, createTopic, submitTopic, assertCanSubmit, joinTopic, leaveTopic, activeTopicFor, applyTopicJudgement, hypeTopic, addMoment, noteMicMention, matchTopics, keywordsFromText,
    addXp, levelRow, levelView, levelFor, recentXp, boardView, topicDetail, levelsLeaderboard, yappersLeaderboard, fighterBrief, archiveStale,
    scanChat, discoverTopics, discoverInput, heuristicDiscover, backfillMoments, buildLore, loreSweep, templateLore, pulse, nameOf,
    computeHeat, resolveExpired, openBountyOn, recordBountyHit, HOT_THRESHOLD, KIND_TTL_HOURS, XP_PER_LEVEL, XP_JOIN, XP_HYPE, TOPIC_TTL_HOURS, SCAN_WINDOW_MIN, USER_TOPIC_COOLDOWN_HOURS,
    _resetScan: () => { _scan = { lastChatId: null, lastDiscoverAt: 0, lastDiscoverSeen: 0 }; invalidateMatchers(); },
};
