/**
 * OpenVibe.Live — Arena mic ledger (Battle Cam mode)
 *
 * The Arena runs on ONE input: what fighters say on mic (stream_timeline_events speech,
 * judged by listener.js). This module is the ledger for that:
 *
 *   moments   → every judged piece of shit talk lands here: a callout that opened/fed a
 *               beef (`beef_hit`), or free-standing trash talk aimed at chat / a group / a
 *               name that is not on the roster (`trash`). VOD-linked so every line can be
 *               replayed at the second it was said.
 *   XP        → moment quality → Trash Level (arena_trash_levels / arena_xp_log). No other
 *               source of XP exists: not chat, not votes, not check-ins.
 *   mic stats → per-fighter aggregates the roster ratings are built from (HEAT, AIM,
 *               CLAPBACK, KILLS…) — see arena-service.js.
 *   feed      → the live "shit talk feed": newest judged lines across every live cam.
 *
 * The behaviour filter (threats / minors / doxxing — never vocabulary) is applied before any
 * line is stored; see arena-service.isBannedText.
 */
'use strict';

const db = require('../db/database');

const XP_PER_LEVEL = 50;
const XP_MOMENT = 0.8;   // × quality
const XP_HYPE = 1;

let _ready = false;
function ensureTables() {
    if (_ready) return;
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
    for (const col of ['topic_moments INTEGER DEFAULT 0', 'topics_joined INTEGER DEFAULT 0', 'mic_moments INTEGER DEFAULT 0']) { try { db.run(`ALTER TABLE arena_trash_levels ADD COLUMN ${col}`); } catch { /* exists */ } }
    db.run(`CREATE TABLE IF NOT EXISTS arena_xp_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_xp_log_user ON arena_xp_log (user_id, created_at)');
    db.run(`CREATE TABLE IF NOT EXISTS arena_mic_moments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        stream_id INTEGER,
        vod_id INTEGER,
        sec INTEGER,
        kind TEXT NOT NULL DEFAULT 'trash',
        target_user_id INTEGER,
        beef_id INTEGER,
        aimed_at TEXT,
        text TEXT NOT NULL,
        about TEXT,
        quality REAL DEFAULT 0,
        announcer TEXT,
        said_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_mic_user ON arena_mic_moments (user_id, id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_mic_created ON arena_mic_moments (created_at)');
    _ready = true;
}

function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function arena() { return require('./arena-service'); }
function levelFor(xp) { return 1 + Math.floor((Number(xp) || 0) / XP_PER_LEVEL); }
function levelRow(userId) {
    ensureTables();
    return db.get('SELECT * FROM arena_trash_levels WHERE user_id = ?', [userId]) || { user_id: userId, xp: 0, level: 1, beef_hits: 0, mic_moments: 0, best_line: null, best_line_score: 0 };
}

// ── XP / Trash Level ─────────────────────────────────────────

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
    if (extra.moment) sets.push('mic_moments = mic_moments + 1');
    if (extra.beefHit) sets.push('beef_hits = beef_hits + 1');
    if (sets.length) db.run(`UPDATE arena_trash_levels SET ${sets.join(', ')} WHERE user_id = ?`, [userId]);
    if (extra.line && (extra.lineScore || 0) > (before.best_line_score || 0)) {
        db.run('UPDATE arena_trash_levels SET best_line = ?, best_line_vod_id = ?, best_line_sec = ?, best_line_score = ? WHERE user_id = ?', [String(extra.line).slice(0, 220), extra.lineVodId || null, extra.lineSec ?? null, extra.lineScore, userId]);
    }
    const after = levelRow(userId);
    if (after.level > before.level) {
        console.log(`[Arena] user ${userId} → Trash Level ${after.level}`);
        try { require('./notify').arenaNotify(userId, { type: 'level', title: `Trash Level ${after.level}`, message: `${after.xp} XP from pure mic. Keep talking.`, icon: '🎙️', url: '/arena', key: `level:${after.level}` }); } catch { /* */ }
    }
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
        mic_moments: r.mic_moments || 0, beef_hits: r.beef_hits || 0,
        recent_xp: recentXp(userId),
        best_line: r.best_line ? { text: r.best_line, vod_id: r.best_line_vod_id, sec: r.best_line_sec, score: r.best_line_score } : null,
    };
}

function levelsLeaderboard(limit = 10) {
    ensureTables();
    const roster = arena().loadRoster();
    return db.all('SELECT * FROM arena_trash_levels WHERE xp > 0 ORDER BY xp DESC LIMIT ?', [limit])
        .map(r => ({ ...fighterBrief(r.user_id, roster), xp: r.xp, level: levelFor(r.xp), beef_hits: r.beef_hits || 0, mic_moments: r.mic_moments || 0, best_line: r.best_line ? { text: r.best_line, vod_id: r.best_line_vod_id, sec: r.best_line_sec, score: r.best_line_score } : null }));
}

// ── Names + briefs ───────────────────────────────────────────

// Real names only — no AI ring names. The fighter IS the streamer.
function nameOf(userId) {
    const u = db.getUserById(userId);
    return u?.display_name || u?.username || `user${userId}`;
}

function fighterBrief(userId, roster) {
    const f = roster && roster.byId ? roster.byId[userId] : null;
    return {
        user: f ? f.user : (db.getUserById(userId) ? arena().publicUser(db.getUserById(userId)) : { id: userId, username: `user${userId}`, display_name: `user${userId}` }),
        fighter_name: nameOf(userId),
        rank: f ? roster.order.indexOf(userId) + 1 : null,
        image_url: (() => { try { return arena().getFighterImageUrl(userId); } catch { return null; } })(),
        live: !!db.get('SELECT 1 FROM streams WHERE user_id = ? AND is_live = 1 LIMIT 1', [userId]),
        level: levelFor(levelRow(userId).xp || 0),
    };
}

// ── Moments ──────────────────────────────────────────────────

/**
 * Store a judged mic line. kind: 'trash' (aimed at chat / a group / a non-roster name),
 * 'beef_hit' (fed a beef; target_user_id + beef_id set). Pays XP for 'trash' here; beef hits
 * are paid by beef.recordHit. Returns the row or null when the line is behaviour-filtered.
 */
function addMoment({ userId, streamId = null, vodId = null, sec = null, kind = 'trash', targetUserId = null, beefId = null, aimedAt = null, text, about = null, quality = 0, announcer = null, saidAt = null }) {
    ensureTables();
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!t) return null;
    try { if (arena()._isBannedText(t)) return null; } catch { /* */ }
    const q = Math.max(0, Math.min(10, Number(quality) || 0));
    const r = db.run(`INSERT INTO arena_mic_moments (user_id, stream_id, vod_id, sec, kind, target_user_id, beef_id, aimed_at, text, about, quality, announcer, said_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
        [userId, streamId, vodId, sec == null ? null : Math.max(0, Math.floor(sec)), kind, targetUserId, beefId, aimedAt ? String(aimedAt).slice(0, 80) : null, t, about ? String(about).slice(0, 80) : null, q, announcer ? String(announcer).slice(0, 140) : null, saidAt]);
    const id = Number(r.lastInsertRowid);
    if (kind === 'trash' || kind === 'callout') addXp(userId, q * XP_MOMENT, kind === 'callout' ? 'mic_callout' : 'mic_trash', id, { moment: true, line: t, lineScore: q, lineVodId: vodId, lineSec: sec });
    return db.get('SELECT * FROM arena_mic_moments WHERE id = ?', [id]);
}

function momentView(m, roster) {
    const brief = fighterBrief(m.user_id, roster);
    return {
        id: m.id, kind: m.kind, user: brief.user, fighter_name: brief.fighter_name, rank: brief.rank, image_url: brief.image_url, level: brief.level, live: brief.live,
        target: m.target_user_id ? (() => { const b = fighterBrief(m.target_user_id, roster); return { user: b.user, fighter_name: b.fighter_name, rank: b.rank }; })() : null,
        beef_id: m.beef_id || null, aimed_at: m.aimed_at || null, text: m.text, about: m.about, quality: Number(m.quality) || 0, announcer: m.announcer || null,
        stream_id: m.stream_id, vod_id: m.vod_id, sec: m.sec, at: m.said_at || m.created_at,
    };
}

/** The shit-talk feed: newest judged lines across the roster. */
function feed({ limit = 40, since = null, userId = null } = {}) {
    ensureTables();
    const roster = arena().loadRoster();
    const params = [];
    let where = '1 = 1';
    if (userId) { where += ' AND user_id = ?'; params.push(userId); }
    if (since) { where += ' AND id > ?'; params.push(Number(since) || 0); }
    params.push(Math.min(200, Math.max(1, limit)));
    return db.all(`SELECT * FROM arena_mic_moments WHERE ${where} ORDER BY COALESCE(said_at, created_at) DESC, id DESC LIMIT ?`, params).map(m => momentView(m, roster));
}
function momentsFor(userId, limit = 12) { return feed({ limit, userId }); }
function bestLines(userId, limit = 5) {
    ensureTables();
    const roster = arena().loadRoster();
    return db.all('SELECT * FROM arena_mic_moments WHERE user_id = ? AND quality >= 5 ORDER BY quality DESC, id DESC LIMIT ?', [userId, limit]).map(m => momentView(m, roster));
}
function latestFor(userId) {
    ensureTables();
    const m = db.get('SELECT * FROM arena_mic_moments WHERE user_id = ? ORDER BY COALESCE(said_at, created_at) DESC, id DESC LIMIT 1', [userId]);
    return m ? momentView(m, arena().loadRoster()) : null;
}

/** Aggregates the ratings are built from. All from the mic ledger + beefs — nothing else. */
function micStats(userId, days = 30) {
    ensureTables();
    const win = `-${days} days`;
    const m = db.get(`SELECT COUNT(*) AS n, COALESCE(AVG(quality), 0) AS avg_q, COALESCE(MAX(quality), 0) AS best_q,
                             COALESCE(SUM(kind IN ('beef_hit', 'callout')), 0) AS beef_hits, COALESCE(SUM(kind = 'trash'), 0) AS trash,
                             COALESCE(SUM(quality >= 7), 0) AS bangers
                      FROM arena_mic_moments WHERE user_id = ? AND created_at >= datetime('now', ?)`, [userId, win]) || {};
    let b = {};
    try { b = db.get(`SELECT COALESCE(SUM(b_user_id = ?), 0) AS targeted, COALESCE(SUM(b_user_id = ? AND responded = 1), 0) AS answered, COALESCE(SUM(winner_user_id = ?), 0) AS wins, COALESCE(SUM(status = 'resolved' AND winner_user_id IS NOT NULL AND winner_user_id != ?), 0) AS losses, COALESCE(SUM(status = 'resolved' AND resolution = 'forfeit' AND winner_user_id != ? AND winner_user_id IS NOT NULL), 0) AS ducked FROM arena_beefs WHERE a_user_id = ? OR b_user_id = ?`, [userId, userId, userId, userId, userId, userId, userId]) || {}; } catch { b = {}; }
    const speechMin = (() => { try { return (db.get(`SELECT COALESCE(SUM(COALESCE(end_sec, start_sec + 3) - start_sec), 0) AS s FROM stream_timeline_events WHERE user_id = ? AND kind = 'speech' AND created_at >= datetime('now', ?)`, [userId, win])?.s || 0) / 60; } catch { return 0; } })();
    const hours = Math.max(speechMin / 60, 0.05);
    const targeted = b.targeted || 0;
    return {
        window_days: days, moments: m.n || 0, trash: m.trash || 0, beef_hits: m.beef_hits || 0, bangers: m.bangers || 0,
        avg_quality: Number((m.avg_q || 0).toFixed(2)), best_quality: Number(m.best_q || 0),
        hits_per_mic_hour: Number((((m.beef_hits || 0) + (m.trash || 0)) / hours).toFixed(2)),
        targeted, answered: b.answered || 0, clapback_rate: targeted ? Number(((b.answered || 0) / targeted).toFixed(2)) : 0,
        wins: b.wins || 0, losses: b.losses || 0, ducked: b.ducked || 0, speech_minutes: Number(speechMin.toFixed(1)),
    };
}

module.exports = {
    ensureTables, addXp, recentXp, levelView, levelFor, levelRow, levelsLeaderboard, nameOf, fighterBrief,
    addMoment, momentView, feed, momentsFor, bestLines, latestFor, micStats,
    XP_PER_LEVEL, XP_MOMENT, XP_HYPE,
};
