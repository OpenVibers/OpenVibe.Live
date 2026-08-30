/**
 * OpenVibe.Live — Arena Board: topics, angles, trash levels
 *
 *   topic   → a thing to talk shit about. Made by chat (`!topic …`), by a streamer or a
 *             viewer on the page, or seeded by the AI when the board runs dry. Lives on
 *             the board for TOPIC_TTL_HOURS after its last activity.
 *   angles  → when a streamer picks a topic, the AI generates 3–4 angles inside it
 *             ("defend your schedule", "roast the rival's setup"…). The listener judges
 *             their live speech against the angles; each cleared angle gives XP, clearing
 *             all of them conquers the topic (big XP).
 *   level   → Trash Level is persistent per streamer (XP_PER_LEVEL per level) and feeds
 *             POWER (see arena-service.talkBonus): beefs, angles and chat hype all pay XP.
 */
'use strict';

const db = require('../db/database');
const llm = require('../ai/llm');

const TOPIC_TTL_HOURS = 36;
const TOPIC_MAX_LEN = 140;
const ANGLES_PER_TOPIC = 3;
const XP_PER_LEVEL = 50;
const XP_ANGLE_CLEARED = 25;
const XP_TOPIC_CONQUERED = 60;
const XP_HYPE = 2;
const MAX_OPEN_TOPICS = 24;

const SEED_TOPICS = [
    { text: 'Whose chat is actually the smartest chat on this site?', hint: 'Bring receipts, or confidence. Confidence is cheaper.' },
    { text: 'Stream schedules are a lifestyle. Defend yours against the calendar.', hint: 'Sleep is for people with fewer viewers.' },
    { text: 'The last thing that went wrong on your stream was a strategic decision. Explain.', hint: 'The audio cutting out was a bit. Obviously.' },
    { text: 'Sell your category to someone who has never heard of it.', hint: 'You have the mic. They have their doubts.' },
    { text: 'The worst possible advice for a new streamer, delivered with total confidence.', hint: 'Every word must sound like wisdom.' },
    { text: 'Your setup vs everyone else\'s setup.', hint: 'Cables count. Cable management counts double.' },
    { text: 'Rank the top three fighters and explain why you\'re about to move up.', hint: 'A plan that cannot possibly work scores double.' },
    { text: 'What your chat says about you when you step away.', hint: 'They say worse. Get ahead of it.' },
];

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
    db.run(`CREATE TABLE IF NOT EXISTS arena_topic_progress (
        topic_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        angle_idx INTEGER NOT NULL,
        progress REAL DEFAULT 0,
        score REAL DEFAULT 0,
        hits INTEGER DEFAULT 0,
        best_line TEXT,
        best_vod_id INTEGER,
        best_sec INTEGER,
        cleared_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (topic_id, user_id, angle_idx)
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
    for (const col of ["kind TEXT NOT NULL DEFAULT 'topic'", 'side_a TEXT', 'side_b TEXT', 'phrase TEXT', 'target_user_id INTEGER', 'headline TEXT', 'heat REAL DEFAULT 0', 'source_note TEXT', 'expires_at DATETIME', 'winner_side TEXT', 'resolved_json TEXT']) {
        try { db.run(`ALTER TABLE arena_topics ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    db.run(`CREATE TABLE IF NOT EXISTS arena_topic_sides (
        topic_id INTEGER NOT NULL,
        voter_key TEXT NOT NULL,
        side TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (topic_id, voter_key)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_viewer_clout (
        voter_key TEXT PRIMARY KEY,
        user_id INTEGER,
        picks INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 0,
        best_streak INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_xp_log_user ON arena_xp_log (user_id, created_at)');
    _ready = true;
}

function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function arena() { return require('./arena-service'); }
function levelFor(xp) { return 1 + Math.floor((Number(xp) || 0) / XP_PER_LEVEL); }

// ── Levels ───────────────────────────────────────────────────

function levelRow(userId) {
    ensureTables();
    return db.get('SELECT * FROM arena_trash_levels WHERE user_id = ?', [userId]) || { user_id: userId, xp: 0, level: 1, angles_cleared: 0, topics_conquered: 0, beef_hits: 0 };
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
    if (extra.angle) sets.push('angles_cleared = angles_cleared + 1');
    if (extra.topic) sets.push('topics_conquered = topics_conquered + 1');
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

/** XP earned in the last N days (POWER bonus input; recent effort matters more than history). */
function recentXp(userId, days = 7) {
    ensureTables();
    return db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM arena_xp_log WHERE user_id = ? AND created_at >= datetime('now', ?)`, [userId, `-${days} days`])?.n || 0;
}

function levelView(userId) {
    const r = levelRow(userId);
    const xp = r.xp || 0;
    return {
        level: levelFor(xp), xp, xp_into_level: xp - (levelFor(xp) - 1) * XP_PER_LEVEL, xp_per_level: XP_PER_LEVEL, next_level_xp: levelFor(xp) * XP_PER_LEVEL,
        angles_cleared: r.angles_cleared || 0, topics_conquered: r.topics_conquered || 0, beef_hits: r.beef_hits || 0,
        recent_xp: recentXp(userId),
        best_line: r.best_line ? { text: r.best_line, vod_id: r.best_line_vod_id, sec: r.best_line_sec, score: r.best_line_score } : null,
    };
}

// ── Topics ───────────────────────────────────────────────────

function cleanTopicText(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length < 8) throw new Error('Give the topic a few more words');
    if (arena()._isBannedText(t)) throw new Error('That topic crosses the line (threats, minors, doxxing)');
    t = t.slice(0, TOPIC_MAX_LEN);
    if (!/[.?!]$/.test(t)) t += /^(who|what|why|how|when|where|which|is|are|does|do|can|should)\b/i.test(t) ? '?' : '.';
    return t.charAt(0).toUpperCase() + t.slice(1);
}

const KIND_TTL_HOURS = { topic: TOPIC_TTL_HOURS, debate: 24, phrase: 6, bounty: 6 };

function createTopic({ text, hint = null, createdBy, creatorUserId = null, creatorName = null, kind = 'topic', sideA = null, sideB = null, phrase = null, targetUserId = null, headline = null, sourceNote = null }) {
    ensureTables();
    const clean = cleanTopicText(text);
    kind = ['topic', 'debate', 'phrase', 'bounty'].includes(kind) ? kind : 'topic';
    if (kind === 'debate' && !(sideA && sideB)) throw new Error('A debate needs two sides');
    if (kind === 'phrase' && !phrase) throw new Error('A phrase challenge needs the phrase');
    if (kind === 'bounty' && !targetUserId) throw new Error('A bounty needs a target');
    if (kind === 'bounty' && db.get(`SELECT id FROM arena_topics WHERE status = 'open' AND kind = 'bounty' AND target_user_id = ?`, [targetUserId])) throw new Error('There is already a bounty on them');
    const dup = db.get(`SELECT id FROM arena_topics WHERE status = 'open' AND LOWER(text) = LOWER(?)`, [clean]);
    if (dup) throw new Error('That topic is already on the board');
    const open = db.get(`SELECT COUNT(*) AS n FROM arena_topics WHERE status = 'open'`)?.n || 0;
    if (open >= MAX_OPEN_TOPICS) archiveStale(true);
    const expires = new Date(Date.now() + (KIND_TTL_HOURS[kind] || TOPIC_TTL_HOURS) * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    // Debates carry their sides as the first two angles so the judge can classify a rant.
    const angles = kind === 'debate' ? JSON.stringify([{ text: `FOR: ${sideA}`, hint: 'Argue this side like your channel depends on it.' }, { text: `AGAINST: ${sideB}`, hint: 'Tear the other side apart.' }, { text: 'Roast everyone who took this seriously', hint: 'The third option is always chaos.' }]) : null;
    db.run(`INSERT INTO arena_topics (text, hint, created_by, creator_user_id, creator_name, kind, side_a, side_b, phrase, target_user_id, headline, source_note, expires_at, angles_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [clean, hint ? String(hint).slice(0, 120) : null, createdBy, creatorUserId, creatorName ? String(creatorName).slice(0, 40) : null, kind, sideA ? String(sideA).slice(0, 80) : null, sideB ? String(sideB).slice(0, 80) : null, phrase ? String(phrase).slice(0, 60) : null, targetUserId, headline ? String(headline).slice(0, 160) : null, sourceNote ? String(sourceNote).slice(0, 80) : null, expires, angles]);
    const row = db.get('SELECT * FROM arena_topics ORDER BY id DESC LIMIT 1');
    console.log(`[Arena] ${kind} #${row.id} by ${createdBy}${creatorName ? ' ' + creatorName : ''}: "${clean}"`);
    return row;
}

/** Heat = activity in the last hour (hits, joins, hype, side picks), decays with age. Hot things rise. */
function computeHeat(topicId) {
    const hits = db.get(`SELECT COUNT(*) AS n FROM arena_xp_log WHERE ref_id = ? AND reason IN ('topic_hit', 'angle_cleared', 'topic_conquered', 'phrase_hit', 'bounty_hit') AND created_at >= datetime('now', '-60 minutes')`, [topicId])?.n || 0;
    const hype = db.get(`SELECT COUNT(*) AS n FROM arena_topic_hype WHERE topic_id = ? AND created_at >= datetime('now', '-60 minutes')`, [topicId])?.n || 0;
    const sides = db.get(`SELECT COUNT(*) AS n FROM arena_topic_sides WHERE topic_id = ? AND created_at >= datetime('now', '-60 minutes')`, [topicId])?.n || 0;
    const talking = db.get(`SELECT COUNT(*) AS n FROM arena_topic_members WHERE topic_id = ? AND active = 1`, [topicId])?.n || 0;
    const heat = hits * 3 + hype + sides + talking * 4;
    db.run('UPDATE arena_topics SET heat = ? WHERE id = ?', [heat, topicId]);
    return heat;
}
const HOT_THRESHOLD = 12;

/** Viewers pick a side on a debate (chat `!side a|b` or the page). Clout is settled at resolution. */
function pickSide(topicId, voterKey, side, userId = null) {
    ensureTables();
    const t = db.get(`SELECT * FROM arena_topics WHERE id = ? AND status = 'open' AND kind = 'debate'`, [topicId]);
    if (!t) throw new Error('No open debate with that id');
    if (!['a', 'b'].includes(side)) throw new Error('side must be a or b');
    db.run('INSERT INTO arena_topic_sides (topic_id, voter_key, side) VALUES (?, ?, ?) ON CONFLICT(topic_id, voter_key) DO UPDATE SET side = excluded.side, created_at = CURRENT_TIMESTAMP', [topicId, voterKey, side]);
    db.run('INSERT INTO arena_viewer_clout (voter_key, user_id, picks) VALUES (?, ?, 0) ON CONFLICT(voter_key) DO UPDATE SET user_id = COALESCE(excluded.user_id, arena_viewer_clout.user_id)', [voterKey, userId]);
    db.run('UPDATE arena_topics SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [topicId]);
    return sideTally(topicId);
}
function sideTally(topicId) {
    const r = db.get(`SELECT SUM(side = 'a') AS a, SUM(side = 'b') AS b FROM arena_topic_sides WHERE topic_id = ?`, [topicId]) || {};
    const a = r.a || 0, b = r.b || 0;
    return { a, b, share_a: a + b ? Math.round((a / (a + b)) * 100) : 50 };
}
function settleClout(voterKeys, wonKeys) {
    for (const k of voterKeys) {
        const won = wonKeys.has(k);
        db.run(`INSERT INTO arena_viewer_clout (voter_key, picks, wins, streak, best_streak) VALUES (?, 1, ?, ?, ?)
                ON CONFLICT(voter_key) DO UPDATE SET picks = picks + 1, wins = wins + ?, streak = CASE WHEN ? THEN streak + 1 ELSE 0 END, best_streak = MAX(best_streak, CASE WHEN ? THEN streak + 1 ELSE 0 END), updated_at = CURRENT_TIMESTAMP`,
            [k, won ? 1 : 0, won ? 1 : 0, won ? 1 : 0, won ? 1 : 0, won ? 1 : 0, won ? 1 : 0]);
    }
}
function cloutLeaderboard(limit = 10) {
    ensureTables();
    return db.all('SELECT * FROM arena_viewer_clout WHERE picks >= 2 ORDER BY wins DESC, streak DESC LIMIT ?', [limit]).map(r => {
        const u = r.user_id ? db.getUserById(r.user_id) : null;
        return { name: u ? (u.display_name || u.username) : 'anonymous', username: u ? u.username : null, picks: r.picks, wins: r.wins, streak: r.streak, best_streak: r.best_streak, accuracy: r.picks ? Math.round((r.wins / r.picks) * 100) : 0 };
    });
}

/** Debates and challenges resolve when they expire: side with more talk + more chat wins; clout settles. */
function resolveExpired() {
    ensureTables();
    const due = db.all(`SELECT * FROM arena_topics WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= datetime('now')`);
    const results = [];
    for (const t of due) {
        let resolved = { kind: t.kind };
        if (t.kind === 'debate') {
            const talk = db.get(`SELECT SUM(CASE WHEN angle_idx = 0 THEN score ELSE 0 END) AS a, SUM(CASE WHEN angle_idx = 1 THEN score ELSE 0 END) AS b FROM arena_topic_progress WHERE topic_id = ?`, [t.id]) || {};
            const tally = sideTally(t.id);
            const scoreA = (talk.a || 0) * 2 + tally.a, scoreB = (talk.b || 0) * 2 + tally.b;
            const winner = scoreA === scoreB ? null : (scoreA > scoreB ? 'a' : 'b');
            const mvp = db.get(`SELECT user_id, SUM(score) AS s FROM arena_topic_progress WHERE topic_id = ? AND angle_idx = ? GROUP BY user_id ORDER BY s DESC LIMIT 1`, [t.id, winner === 'b' ? 1 : 0]);
            resolved = { kind: 'debate', winner, score_a: Number(scoreA.toFixed(1)), score_b: Number(scoreB.toFixed(1)), chat: tally, mvp_user_id: mvp?.user_id || null };
            const voters = db.all('SELECT voter_key, side FROM arena_topic_sides WHERE topic_id = ?', [t.id]);
            settleClout(voters.map(v => v.voter_key), new Set(voters.filter(v => v.side === winner).map(v => v.voter_key)));
            if (mvp?.user_id) addXp(mvp.user_id, 30, 'debate_mvp', t.id);
        } else if (t.kind === 'bounty') {
            const top = db.get(`SELECT user_id, SUM(amount) AS s FROM arena_xp_log WHERE reason = 'bounty_hit' AND ref_id = ? GROUP BY user_id ORDER BY s DESC LIMIT 1`, [t.id]);
            resolved = { kind: 'bounty', claimed_by: top?.user_id || null, total: top?.s || 0 };
            if (top?.user_id) addXp(top.user_id, 40, 'bounty_claimed', t.id);
        } else if (t.kind === 'phrase') {
            const top = db.get(`SELECT user_id, SUM(amount) AS s FROM arena_xp_log WHERE reason = 'phrase_hit' AND ref_id = ? GROUP BY user_id ORDER BY s DESC LIMIT 1`, [t.id]);
            resolved = { kind: 'phrase', top_user_id: top?.user_id || null };
        }
        db.run(`UPDATE arena_topics SET status = 'resolved', winner_side = ?, resolved_json = ? WHERE id = ?`, [resolved.winner || null, JSON.stringify(resolved), t.id]);
        db.run('UPDATE arena_topic_members SET active = 0 WHERE topic_id = ?', [t.id]);
        results.push({ id: t.id, ...resolved });
        console.log(`[Arena] ${t.kind} #${t.id} resolved: ${JSON.stringify(resolved)}`);
    }
    return results;
}

/** Bounty check for a beef hit: doubles XP while a bounty on the target is open. Returns the bounty topic or null. */
function openBountyOn(targetUserId) {
    ensureTables();
    return db.get(`SELECT * FROM arena_topics WHERE status = 'open' AND kind = 'bounty' AND target_user_id = ?`, [targetUserId]) || null;
}
function recordBountyHit(hitterId, bounty, quality) {
    addXp(hitterId, Math.round(quality), 'bounty_hit', bounty.id);
    db.run('UPDATE arena_topics SET hits = hits + 1, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [bounty.id]);
}
/** Phrase challenges: no model needed — the phrase either came out of their mouth or it didn't. */
function checkPhrases(userId, text, lineRef) {
    ensureTables();
    const hits = [];
    for (const t of db.all(`SELECT * FROM arena_topics WHERE status = 'open' AND kind = 'phrase'`)) {
        if (!t.phrase || !String(text).toLowerCase().includes(String(t.phrase).toLowerCase())) continue;
        const already = db.get(`SELECT COUNT(*) AS n FROM arena_xp_log WHERE user_id = ? AND reason = 'phrase_hit' AND ref_id = ?`, [userId, t.id])?.n || 0;
        const xp = already === 0 ? 15 : 5;
        addXp(userId, xp, 'phrase_hit', t.id, { line: text.slice(0, 200), lineScore: 6, lineVodId: lineRef?.vod_id, lineSec: lineRef?.sec });
        db.run('UPDATE arena_topics SET hits = hits + 1, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [t.id]);
        db.run('INSERT OR IGNORE INTO arena_topic_members (topic_id, user_id, active) VALUES (?, ?, 0)', [t.id, userId]);
        hits.push({ topic_id: t.id, phrase: t.phrase, xp });
    }
    return hits;
}

function archiveStale(force = false) {
    ensureTables();
    db.run(`UPDATE arena_topics SET status = 'archived' WHERE status = 'open' AND last_activity_at < datetime('now', ?)`, [`-${TOPIC_TTL_HOURS} hours`]);
    if (force) {
        const extra = db.all(`SELECT id FROM arena_topics WHERE status = 'open' ORDER BY last_activity_at ASC`).slice(0, Math.max(0, (db.get(`SELECT COUNT(*) AS n FROM arena_topics WHERE status = 'open'`)?.n || 0) - MAX_OPEN_TOPICS + 1));
        for (const r of extra) db.run(`UPDATE arena_topics SET status = 'archived' WHERE id = ?`, [r.id]);
    }
}

const TOPIC_SEED_SCHEMA = { name: 'arena_pulse', schema: { type: 'object', additionalProperties: false, required: ['pulse', 'events'], properties: {
    pulse: { type: 'string', description: 'One sentence, ≤ 140 chars: what the community is on about right now, hype-caster voice, name names' },
    events: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['kind', 'text', 'hint', 'source', 'headline', 'side_a', 'side_b', 'phrase', 'target_username'], properties: {
        kind: { type: 'string', enum: ['topic', 'debate', 'phrase', 'bounty'], description: 'topic = thing to rant on; debate = a take people are split on (fill side_a/side_b); phrase = a trending phrase/meme to work into your trash talk (fill phrase); bounty = someone the community keeps naming (fill target_username with an exact username from the snapshot)' },
        text: { type: 'string', description: '≤ 120 chars' }, hint: { type: 'string', description: '≤ 90 chars, cheeky' },
        source: { type: 'string', description: '≤ 6 words: where it came from, e.g. "global chat", "Goosely\'s stream", "the Maticus beef"' },
        headline: { type: 'string', description: 'Tabloid headline for the board, ≤ 90 chars, inflammatory but funny' },
        side_a: { type: 'string', description: 'debate only, else empty' }, side_b: { type: 'string', description: 'debate only, else empty' },
        phrase: { type: 'string', description: 'phrase only, else empty; 2–6 words exactly as people say it' }, target_username: { type: 'string', description: 'bounty only, else empty' },
    } } } } } };

/**
 * What the site is talking about right now — the raw material for community topics.
 * Pulled from every AI/data source we have: the global chat AI summary + memory, the
 * chat timeline, the last hour of transcripts across live streams, recent stream
 * memories (what the vision model saw), streamer and VOD overviews, open beefs.
 */
function communityPulseInput() {
    const clip = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const out = { at: new Date().toISOString() };
    try { const g = db.getChatAiSummary('global', 0, 'rolling'); if (g) { const ov = parseJson(g.overview, null); out.global_chat = clip(ov ? (ov.today || ov.alltime) : g.overview, 700); out.global_chat_memory = clip(g.memory_json, 500); } } catch { /* */ }
    try { out.chat_timeline = db.all(`SELECT label, detail FROM chat_timeline_events WHERE scope = 'global' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 12`).map(r => clip(`${r.label}: ${r.detail || ''}`, 140)); } catch { out.chat_timeline = []; }
    try { out.chat_now = db.all(`SELECT username, message FROM chat_messages WHERE COALESCE(is_deleted, 0) = 0 AND timestamp >= datetime('now', '-2 hours') AND LENGTH(message) BETWEEN 12 AND 160 ORDER BY id DESC LIMIT 40`).filter(r => !arena()._isBannedText(r.message)).slice(0, 25).map(r => clip(`${r.username}: ${r.message}`, 160)); } catch { out.chat_now = []; }
    try { out.on_stream_now = db.all(`SELECT u.username, e.text FROM stream_timeline_events e JOIN users u ON u.id = e.user_id WHERE e.kind = 'speech' AND e.created_at >= datetime('now', '-60 minutes') AND LENGTH(e.text) BETWEEN 30 AND 180 ORDER BY e.id DESC LIMIT 60`).filter(r => !arena()._isBannedText(r.text)).slice(0, 25).map(r => clip(`${r.username}: ${r.text}`, 180)); } catch { out.on_stream_now = []; }
    try { out.what_streams_looked_like = db.all(`SELECT u.username, m.description FROM stream_memories m JOIN users u ON u.id = m.user_id WHERE m.captured_at >= datetime('now', '-24 hours') ORDER BY m.id DESC LIMIT 10`).map(r => clip(`${r.username}: ${r.description}`, 200)); } catch { out.what_streams_looked_like = []; }
    try { out.streamer_overviews = db.all(`SELECT u.username, o.overview FROM streamer_overviews o JOIN users u ON u.id = o.user_id WHERE o.generated_at >= datetime('now', '-3 days') ORDER BY o.generated_at DESC LIMIT 6`).map(r => clip(`${r.username}: ${r.overview}`, 220)); } catch { out.streamer_overviews = []; }
    try { out.recent_vods = db.all(`SELECT v.title, va.ai_overview_short AS o FROM vods v LEFT JOIN vod_ai_state va ON va.vod_id = v.id WHERE v.is_public = 1 AND v.created_at >= datetime('now', '-3 days') ORDER BY v.created_at DESC LIMIT 6`).map(r => clip(`${r.title}: ${r.o || ''}`, 160)); } catch { out.recent_vods = []; }
    try { out.open_beefs = db.all(`SELECT a.username AS a, b.username AS b, x.opener_line FROM arena_beefs x JOIN users a ON a.id = x.a_user_id JOIN users b ON b.id = x.b_user_id WHERE x.status = 'open' ORDER BY x.opened_at DESC LIMIT 5`).map(r => clip(`${r.a} vs ${r.b}: ${r.opener_line || ''}`, 160)); } catch { out.open_beefs = []; }
    try { const roster = arena().loadRoster(); out.ladder_top = roster.order.slice(0, 6).map(id => (parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [id])?.persona_json) || {}).fighter_name || roster.byId[id].user.display_name); } catch { out.ladder_top = []; }
    out.existing_topics = db.all(`SELECT text FROM arena_topics ORDER BY id DESC LIMIT 15`).map(r => r.text);
    return out;
}

const PULSE_SYSTEM = `You are the community consciousness of a live-streaming site's Arena — part tabloid editor, part fight promoter, part ragebaiter. You get a snapshot of what the community is ACTUALLY talking about right now: global chat, what people said on their streams in the last hour, what the streams looked like, AI overviews, open beefs, the ladder. Turn it into (1) one hype-caster sentence about what everyone is on about (name names), and (2) 2–5 EVENTS for the board, specific to what is really going on — never generic:
- an argument or split opinion → a DEBATE with two sharp sides;
- a phrase, meme or running joke people keep saying → a PHRASE challenge (the exact words);
- someone the community keeps naming, dunking on or defending → a BOUNTY on that username;
- anything else spicy → a TOPIC to rant on.
Every event gets a tabloid HEADLINE that is inflammatory but funny and a source tag. Provoke: the point is to bait streamers into responding on stream and chat into picking sides. Profanity, disrespect, provocation and trolling are welcome; this platform does not censor language. Hard line: no direct threats of violence, nothing sexual about minors, no doxxing. Output only the JSON.`;

let _pulse = { text: null, at: null, sources: [] };
const PULSE_REFRESH_MS = 30 * 60 * 1000;
const PULSE_MIN_OPEN = 6;

/** Refresh the community pulse + add community topics. Called by the job; safe to call often. */
async function refreshPulse({ force = false } = {}) {
    ensureTables();
    archiveStale();
    if (!force && _pulse.at && Date.now() - _pulse.at < PULSE_REFRESH_MS) return { skipped: true };
    const open = db.get(`SELECT COUNT(*) AS n FROM arena_topics WHERE status = 'open'`)?.n || 0;
    let made = 0;
    if (aiOn()) {
        try {
            const input = communityPulseInput();
            const r = await llm.complete({ role: 'summary', kind: 'arena_pulse', source: 'arena', system: PULSE_SYSTEM, user: JSON.stringify(input), json: TOPIC_SEED_SCHEMA, maxTokens: 600, temperature: 0.95, timeoutMs: 30000 });
            if (r && r.json) {
                _pulse = { text: String(r.json.pulse || '').slice(0, 200), at: Date.now(), sources: Object.entries(input).filter(([k, v]) => Array.isArray(v) ? v.length : (v && k !== 'at' && k !== 'existing_topics')).map(([k]) => k) };
                const want = Math.max(2, PULSE_MIN_OPEN - open);
                for (const e of (r.json.events || []).slice(0, want)) {
                    try {
                        let targetUserId = null;
                        if (e.kind === 'bounty') { const u = db.getUserByUsername(String(e.target_username || '').replace(/^@/, '')); if (!u || !arena().loadRoster().byId[u.id]) continue; targetUserId = u.id; }
                        createTopic({ text: e.text, hint: e.hint, createdBy: 'community', creatorName: String(e.source || 'the community').slice(0, 40), kind: e.kind, sideA: e.side_a || null, sideB: e.side_b || null, phrase: e.phrase || null, targetUserId, headline: e.headline || null, sourceNote: e.source || null });
                        made++;
                    } catch { /* dup / invalid */ }
                }
            }
        } catch (e) { console.warn('[Arena] pulse:', e.message); }
    }
    if (!_pulse.at) _pulse = { text: null, at: Date.now(), sources: [] };
    if (open + made < 3) {
        for (const t of SEED_TOPICS.slice().sort(() => Math.random() - 0.5).slice(0, 3 - open - made)) { try { createTopic({ text: t.text, hint: t.hint, createdBy: 'ai' }); made++; } catch { /* dup */ } }
    }
    if (made) console.log(`[Arena] pulse refreshed — ${made} community topic(s) added`);
    return { made, pulse: _pulse.text };
}
function pulse() { return { text: _pulse.text, at: _pulse.at ? new Date(_pulse.at).toISOString() : null, sources: _pulse.sources }; }
async function seedIfEmpty() { return (await refreshPulse({ force: (db.get(`SELECT COUNT(*) AS n FROM arena_topics WHERE status = 'open'`)?.n || 0) < 3 })).made || 0; }

const ANGLES_SCHEMA = { name: 'arena_topic_angles', schema: { type: 'object', additionalProperties: false, required: ['angles'], properties: { angles: { type: 'array', minItems: ANGLES_PER_TOPIC, maxItems: ANGLES_PER_TOPIC, items: { type: 'object', additionalProperties: false, required: ['text', 'hint'], properties: { text: { type: 'string', description: 'a specific angle inside the topic to talk shit about, ≤ 90 chars' }, hint: { type: 'string', description: '≤ 70 chars' } } } } } } };

async function ensureAngles(topic) {
    let angles = parseJson(topic.angles_json, null);
    if (Array.isArray(angles) && angles.length) return angles;
    if (aiOn()) {
        try {
            const r = await llm.complete({
                role: 'summary', kind: 'arena_topic_angles', source: 'arena',
                system: 'Break a shit-talk topic into distinct ANGLES a live-streamer can rant on for 30–60 seconds each: one brag angle, one roast angle (name names), one bit/absurd/troll angle. Savage and funny; this platform does not censor language. Hard line only: no direct threats of violence, nothing sexual about minors, no doxxing. Output only the JSON.',
                user: JSON.stringify({ topic: topic.text, hint: topic.hint, created_by: topic.created_by }),
                json: ANGLES_SCHEMA, maxTokens: 300, temperature: 0.9, timeoutMs: 20000,
            });
            if (r && r.json && Array.isArray(r.json.angles)) angles = r.json.angles.map(a => ({ text: String(a.text).slice(0, 120), hint: String(a.hint || '').slice(0, 100) }));
        } catch (e) { console.warn('[Arena] angles:', e.message); }
    }
    if (!angles) angles = [
        { text: `Brag: why you win this — "${topic.text}"`, hint: 'Numbers optional, confidence mandatory.' },
        { text: `Roast: who is worst at this and why`, hint: 'Name a fighter. Lovingly.' },
        { text: `Bit: the most unhinged take on it`, hint: 'Commit to the bit.' },
    ];
    db.run('UPDATE arena_topics SET angles_json = ? WHERE id = ?', [JSON.stringify(angles), topic.id]);
    return angles;
}

async function joinTopic(topicId, userId) {
    ensureTables();
    const topic = db.get(`SELECT * FROM arena_topics WHERE id = ? AND status = 'open'`, [topicId]);
    if (!topic) throw new Error('That topic is gone');
    if (!arena().loadRoster().byId[userId]) throw new Error('Only fighters on the roster can talk on a topic — stream once and come back');
    // One active topic per streamer: the listener judges their speech against it.
    db.run('UPDATE arena_topic_members SET active = 0 WHERE user_id = ? AND active = 1', [userId]);
    const existing = db.get('SELECT * FROM arena_topic_members WHERE topic_id = ? AND user_id = ?', [topicId, userId]);
    if (existing) db.run('UPDATE arena_topic_members SET active = 1 WHERE topic_id = ? AND user_id = ?', [topicId, userId]);
    else { db.run('INSERT INTO arena_topic_members (topic_id, user_id) VALUES (?, ?)', [topicId, userId]); db.run('UPDATE arena_topics SET joins = joins + 1 WHERE id = ?', [topicId]); }
    db.run('UPDATE arena_topics SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [topicId]);
    const angles = await ensureAngles(topic);
    return { topic: { ...topic, angles }, angles };
}

function leaveTopic(userId) {
    ensureTables();
    db.run('UPDATE arena_topic_members SET active = 0 WHERE user_id = ? AND active = 1', [userId]);
}

function activeTopicFor(userId) {
    ensureTables();
    const m = db.get(`SELECT t.* FROM arena_topic_members m JOIN arena_topics t ON t.id = m.topic_id WHERE m.user_id = ? AND m.active = 1 AND t.status = 'open' ORDER BY m.joined_at DESC LIMIT 1`, [userId]);
    return m || null;
}

function progressFor(topicId, userId) {
    return db.all('SELECT * FROM arena_topic_progress WHERE topic_id = ? AND user_id = ? ORDER BY angle_idx ASC', [topicId, userId]);
}

/**
 * Apply a judged chunk to the streamer's active topic. `judgement` is the listener's
 * topic judgement: { angle_idx (or -1), quality, progress_gain, best_line, about, flagged }.
 */
function applyTopicJudgement(userId, topic, judgement, lineRef) {
    if (judgement.flagged || judgement.angle_idx == null || judgement.angle_idx < 0) return { applied: false };
    const angles = parseJson(topic.angles_json, []);
    const idx = Math.max(0, Math.min(angles.length - 1, judgement.angle_idx));
    const cur = db.get('SELECT * FROM arena_topic_progress WHERE topic_id = ? AND user_id = ? AND angle_idx = ?', [topic.id, userId, idx]) || { progress: 0, score: 0, hits: 0, best_line: null, cleared_at: null };
    const wasCleared = !!cur.cleared_at;
    const progress = Math.min(100, (cur.progress || 0) + (judgement.progress_gain || 0));
    const better = judgement.best_line && (judgement.quality || 0) > (cur.best_score || 0);
    db.run(`INSERT INTO arena_topic_progress (topic_id, user_id, angle_idx, progress, score, hits, best_line, best_vod_id, best_sec, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(topic_id, user_id, angle_idx) DO UPDATE SET progress = ?, score = score + ?, hits = hits + 1,
                best_line = CASE WHEN ? THEN ? ELSE best_line END, best_vod_id = CASE WHEN ? THEN ? ELSE best_vod_id END, best_sec = CASE WHEN ? THEN ? ELSE best_sec END, updated_at = CURRENT_TIMESTAMP`,
        [topic.id, userId, idx, progress, judgement.quality || 0, judgement.best_line || null, lineRef?.vod_id || null, lineRef?.sec ?? null,
            progress, judgement.quality || 0, better ? 1 : 0, judgement.best_line || null, better ? 1 : 0, lineRef?.vod_id || null, better ? 1 : 0, lineRef?.sec ?? null]);
    db.run('UPDATE arena_topics SET hits = hits + 1, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [topic.id]);
    let xp = Math.round((judgement.quality || 0) * 0.8);
    let clearedAngle = false, conquered = false;
    if (progress >= 100 && !wasCleared) {
        db.run('UPDATE arena_topic_progress SET cleared_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND user_id = ? AND angle_idx = ?', [topic.id, userId, idx]);
        xp += XP_ANGLE_CLEARED; clearedAngle = true;
        const clearedCount = db.get('SELECT COUNT(*) AS n FROM arena_topic_progress WHERE topic_id = ? AND user_id = ? AND cleared_at IS NOT NULL', [topic.id, userId])?.n || 0;
        if (clearedCount >= angles.length) {
            const m = db.get('SELECT conquered_at FROM arena_topic_members WHERE topic_id = ? AND user_id = ?', [topic.id, userId]);
            if (!m?.conquered_at) {
                db.run('UPDATE arena_topic_members SET conquered_at = CURRENT_TIMESTAMP, active = 0 WHERE topic_id = ? AND user_id = ?', [topic.id, userId]);
                db.run('UPDATE arena_topics SET conquered = conquered + 1 WHERE id = ?', [topic.id]);
                xp += XP_TOPIC_CONQUERED; conquered = true;
            }
        }
    }
    const lvl = addXp(userId, xp, clearedAngle ? (conquered ? 'topic_conquered' : 'angle_cleared') : 'topic_hit', topic.id, { angle: clearedAngle, topic: conquered, line: judgement.best_line, lineScore: judgement.quality, lineVodId: lineRef?.vod_id, lineSec: lineRef?.sec });
    return { applied: true, angle_idx: idx, progress, cleared_angle: clearedAngle, conquered, xp, level: lvl };
}

function hypeTopic(topicId, userId, voterKey) {
    ensureTables();
    if (voterKey === `user:${userId}`) throw new Error("You can't hype yourself");
    const ins = db.run('INSERT OR IGNORE INTO arena_topic_hype (topic_id, user_id, voter_key) VALUES (?, ?, ?)', [topicId, userId, voterKey]);
    if (ins.changes) addXp(userId, XP_HYPE, 'hype', topicId);
    const n = db.get('SELECT COUNT(*) AS n FROM arena_topic_hype WHERE topic_id = ? AND user_id = ?', [topicId, userId])?.n || 0;
    return { added: !!ins.changes, hypers: n };
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

function topicView(topic, roster, { detail = false } = {}) {
    const angles = parseJson(topic.angles_json, []);
    const members = db.all(`SELECT m.*, COALESCE((SELECT COUNT(*) FROM arena_topic_progress p WHERE p.topic_id = m.topic_id AND p.user_id = m.user_id AND p.cleared_at IS NOT NULL), 0) AS cleared, COALESCE((SELECT SUM(score) FROM arena_topic_progress p WHERE p.topic_id = m.topic_id AND p.user_id = m.user_id), 0) AS score FROM arena_topic_members m WHERE m.topic_id = ? ORDER BY score DESC`, [topic.id]);
    const heat = topic.heat || 0;
    const out = {
        id: topic.id, text: topic.text, hint: topic.hint, created_by: topic.created_by, creator_name: topic.creator_name, status: topic.status,
        kind: topic.kind || 'topic', side_a: topic.side_a, side_b: topic.side_b, phrase: topic.phrase, target: topic.target_user_id ? fighterBrief(topic.target_user_id, roster) : null,
        headline: topic.headline, source_note: topic.source_note, heat: Math.round(heat), hot: heat >= HOT_THRESHOLD,
        expires_at: topic.expires_at ? new Date(topic.expires_at + 'Z').toISOString() : null, winner_side: topic.winner_side, resolved: parseJson(topic.resolved_json),
        sides: topic.kind === 'debate' ? sideTally(topic.id) : null,
        angles: angles.map((a, i) => ({ idx: i, text: a.text, hint: a.hint })),
        joins: topic.joins || 0, hits: topic.hits || 0, conquered: topic.conquered || 0,
        talking_now: members.filter(m => m.active).map(m => fighterBrief(m.user_id, roster)),
        members: members.slice(0, 12).map(m => ({ ...fighterBrief(m.user_id, roster), active: !!m.active, cleared: m.cleared, score: Number((m.score || 0).toFixed(1)), conquered_at: m.conquered_at })),
        created_at: topic.created_at, last_activity_at: topic.last_activity_at,
    };
    if (detail) {
        out.progress = {};
        for (const m of members) out.progress[m.user_id] = progressFor(topic.id, m.user_id).map(p => ({ angle_idx: p.angle_idx, progress: Math.round(p.progress || 0), score: Number((p.score || 0).toFixed(1)), hits: p.hits, best_line: p.best_line, best_vod_id: p.best_vod_id, best_sec: p.best_sec, cleared: !!p.cleared_at }));
        out.best_lines = db.all(`SELECT p.*, p.user_id FROM arena_topic_progress p WHERE p.topic_id = ? AND p.best_line IS NOT NULL ORDER BY p.score DESC LIMIT 8`, [topic.id]).map(p => ({ ...fighterBrief(p.user_id, roster), text: p.best_line, vod_id: p.best_vod_id, sec: p.best_sec, angle_idx: p.angle_idx }));
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
    const recent = db.all(`SELECT * FROM arena_topics WHERE status = 'resolved' AND kind != 'topic' ORDER BY id DESC LIMIT 6`).map(t => topicView(t, roster));
    return { open: topics.map(t => topicView(t, roster)), resolved: recent, pulse: pulse(), hot_threshold: HOT_THRESHOLD };
}

function topicDetail(topicId) {
    ensureTables();
    const topic = db.get('SELECT * FROM arena_topics WHERE id = ?', [topicId]);
    if (!topic) return null;
    return topicView(topic, arena().loadRoster(), { detail: true });
}

function levelsLeaderboard(limit = 10) {
    ensureTables();
    const roster = arena().loadRoster();
    return db.all('SELECT * FROM arena_trash_levels ORDER BY xp DESC LIMIT ?', [limit]).map(r => ({ ...fighterBrief(r.user_id, roster), xp: r.xp, level: levelFor(r.xp), angles_cleared: r.angles_cleared, topics_conquered: r.topics_conquered, beef_hits: r.beef_hits, best_line: r.best_line ? { text: r.best_line, vod_id: r.best_line_vod_id, sec: r.best_line_sec } : null }));
}

module.exports = {
    ensureTables, createTopic, seedIfEmpty, ensureAngles, joinTopic, leaveTopic, activeTopicFor, progressFor, applyTopicJudgement, hypeTopic,
    addXp, levelRow, levelView, levelFor, recentXp, boardView, topicDetail, levelsLeaderboard, fighterBrief, archiveStale, refreshPulse, pulse, communityPulseInput,
    computeHeat, pickSide, sideTally, cloutLeaderboard, resolveExpired, openBountyOn, recordBountyHit, checkPhrases, HOT_THRESHOLD, KIND_TTL_HOURS,
    XP_PER_LEVEL, XP_ANGLE_CLEARED, XP_TOPIC_CONQUERED, XP_HYPE, TOPIC_TTL_HOURS, SEED_TOPICS,
};
