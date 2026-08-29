/**
 * OpenVibe.Live — Arena (streamer vs streamer)
 *
 * Turns the analytics + AI data the site already collects about each streamer into a
 * tongue-in-cheek fighting-game roster:
 *
 *   stats      → seven 40–99 ratings (HYPE, GRIND, CHAT, LOYALTY, CLUTCH, VIBE, MIC)
 *                computed as percentiles across the active roster, plus an overall POWER.
 *                Deterministic and free — no AI involved. MIC comes from the continuous
 *                audio transcription (stream_timeline_events): how much they talk, how
 *                hyped they sound, how often the room laughs.
 *   persona    → AI "character select" bio (fighter name, class, signature move, taunt,
 *                lore …) written from the streamer's AI overview, stream memories, chat-AI
 *                notes, VOD overviews and the numbers. Cached 24 h per streamer.
 *   quotes     → AI-picked "things they actually said" from the transcripts, each linked
 *                to the VOD at that second so people can go hear it. Cached 24 h.
 *   image      → optional AI character portrait. Deliberately NOT a likeness: the image
 *                model gets a description of the persona, category, colours and the
 *                *scene* of the latest thumbnail (setting/objects/mood — never faces or
 *                identity), and draws a stylised fighting-game character. Gated by the
 *                `ai_image_enabled` setting, the shared AI budget, and a 7-day cache.
 *   battles    → a seeded simulation per matchup per day (same pair, same day → same
 *                rounds) with AI hype-caster commentary, plus a crowd vote that counts
 *                as the final round.
 *
 * Nothing here touches the AI unless AI is enabled and within budget (server/ai/llm.js);
 * without it the tab still works with stats, templated commentary and avatar cards.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const llm = require('../ai/llm');

const ARENA_DIR = path.resolve(process.env.ARENA_IMAGE_PATH || './data/arena');
const ACTIVE_DAYS = 45;                       // streamed within this window → on the roster
const STATS_WINDOW_DAYS = 90;                 // ratings use the last 90 days of streams
const PERSONA_TTL_MS = 24 * 60 * 60 * 1000;
const QUOTES_TTL_MS = 24 * 60 * 60 * 1000;
const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATING_MIN = 40;                        // nobody on the roster is a 5/99
const MIN_QUOTE_LINES = 20;                   // need this many transcript lines before picking quotes
const STAT_KEYS = ['hype', 'grind', 'chat', 'loyalty', 'clutch', 'vibe', 'mic'];
const STAT_META = {
    hype:    { label: 'Hype',    desc: 'peak concurrent viewers' },
    grind:   { label: 'Grind',   desc: 'hours live' },
    chat:    { label: 'Chat',    desc: 'chat messages per hour live' },
    loyalty: { label: 'Loyalty', desc: 'followers + returning chatters' },
    clutch:  { label: 'Clutch',  desc: 'clips + tips per hour' },
    vibe:    { label: 'Vibe',    desc: 'average viewers' },
    mic:     { label: 'Mic',     desc: 'how much (and how loud) they talk — from the transcripts' },
};
const STAT_WEIGHTS = { hype: 0.22, vibe: 0.18, chat: 0.14, loyalty: 0.13, grind: 0.13, clutch: 0.1, mic: 0.1 };
const ROUNDS = [
    { key: 'hype',   label: 'Hype Check',   stat: 'hype' },
    { key: 'chat',   label: 'Chat War',     stat: 'chat' },
    { key: 'grind',  label: 'Endurance',    stat: 'grind' },
    { key: 'clutch', label: 'Clutch Time',  stat: 'clutch' },
    { key: 'mic',    label: 'Mic Drop',     stat: 'mic' },
];
// Words that count as "hyped" when they show up in the transcript.
const HYPE_PATTERNS = ["let's go", 'lets go', 'no way', 'oh my god', 'insane', 'clutch', 'holy', 'gg', 'unreal', 'what the', 'bro', 'chat,', 'chat ', 'yo ', 'welcome', 'lfg', 'poggers', 'pog'];

// Transcript text that must never be surfaced on the site, no matter what a model
// "picks": slurs, hate terms, threats and hard sexual profanity. Applied to quote
// candidates BEFORE the AI sees them, to the persona prompt's "things they said", and to
// the live hot-mic line. Deliberately broad — a false positive costs one quote, a false
// negative puts a slur on a public page. (Spelling variants: repeated letters, common
// leetspeak, and word-boundary aware so "hell" does not catch "shell".)
// Stems are matched on a NORMALISED copy of the text: lower-cased, leetspeak folded
// (1→i 3→e 4→a 0→o @→a $→s !→i), runs of 3+ identical letters collapsed to 2, and
// punctuation stripped — so "f4gg0tz", "niggaaa", "r3tards" all reduce to the stems
// below. Each stem may carry a plural/verb suffix.
const BANNED_STEMS = [
    'nigga', 'nigger', 'niggu', 'fag', 'faggot', 'fagot', 'retard', 'tranny', 'trannie', 'kike', 'spic', 'spick', 'chink', 'gook',
    'wetback', 'dyke', 'cunt', 'whore', 'slut', 'pussy', 'pussies', 'dick', 'cock', 'rape', 'rapist', 'kys', 'hitler', 'nazi',
    'molest', 'molester', 'pedo', 'pedophile', 'paedo', 'coon', 'raghead', 'towelhead', 'beaner',
];
const SUFFIX = '(?:s|es|z|ed|ing|er|ers)?';
const BANNED_STEM_RE = new RegExp(`\\b(?:${BANNED_STEMS.join('|')})${SUFFIX}\\b`, 'i');
// Fully collapsed variants ("niggaaaa" → "niga", "faggot" → "fagot") catch stretched spellings.
const collapseRepeats = (t) => t.replace(/([a-z])\1+/g, '$1');
const BANNED_STEM_COLLAPSED_RE = new RegExp(`\\b(?:${[...new Set(BANNED_STEMS.map(collapseRepeats))].join('|')})${SUFFIX}\\b`, 'i');
const BANNED_PHRASES = [/\bkill\s+(?:your|ur|him|her|them)\s*sel(?:f|ves)\b/i, /\bgo\s+die\b/i];

function normalizeForFilter(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[1!]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/0/g, 'o').replace(/\$/g, 's')
        .replace(/[^a-z\s]/g, ' ');
}
function isBannedText(text) {
    const raw = String(text || '');
    if (BANNED_PHRASES.some(re => re.test(raw))) return true;
    const norm = normalizeForFilter(raw);
    return BANNED_STEM_RE.test(norm) || BANNED_STEM_COLLAPSED_RE.test(collapseRepeats(norm));
}

// ── Tables ───────────────────────────────────────────────────

let _tablesReady = false;
function ensureTables() {
    if (_tablesReady) return;
    db.run(`CREATE TABLE IF NOT EXISTS arena_profiles (
        user_id INTEGER PRIMARY KEY,
        stats_json TEXT,
        persona_json TEXT,
        persona_model TEXT,
        persona_generated_at DATETIME,
        image_path TEXT,
        image_prompt TEXT,
        image_model TEXT,
        image_generated_at DATETIME,
        image_error TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Added later — inline ALTERs wrapped in try/catch, like the rest of the codebase.
    for (const col of ['quotes_json TEXT', 'quotes_generated_at DATETIME']) {
        try { db.run(`ALTER TABLE arena_profiles ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    db.run(`CREATE TABLE IF NOT EXISTS arena_battles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a_user_id INTEGER NOT NULL,
        b_user_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        result_json TEXT NOT NULL,
        commentary_json TEXT,
        winner_user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(a_user_id, b_user_id, day)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_votes (
        battle_id INTEGER NOT NULL,
        voter_key TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('a', 'b')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(battle_id, voter_key)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_battles_users ON arena_battles (a_user_id, b_user_id)');
    try { fs.mkdirSync(ARENA_DIR, { recursive: true }); } catch { /* */ }
    _tablesReady = true;
}

// ── Settings ─────────────────────────────────────────────────

function setting(key, fallback = '') {
    try { const v = db.getSetting(key); return v === undefined || v === null || v === '' ? fallback : v; } catch { return fallback; }
}
function boolSetting(key, fallback = false) {
    const v = setting(key, null);
    if (v === null) return fallback;
    return v === true || v === 'true' || v === 1 || v === '1';
}
function arenaEnabled() { return boolSetting('arena_enabled', true); }
function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function imageGenAvailable() {
    if (!aiOn() || !boolSetting('ai_image_enabled', false)) return false;
    try { return llm.resolveProvider('vision').kind === 'openai'; } catch { return false; }
}

// ── Raw stats ────────────────────────────────────────────────

function activeStreamerIds() {
    return db.all(`
        SELECT DISTINCT s.user_id
        FROM streams s JOIN users u ON u.id = s.user_id
        WHERE s.duration_seconds > 0
          AND s.started_at >= datetime('now', ?)
          AND COALESCE(u.is_banned, 0) = 0
    `, [`-${ACTIVE_DAYS} days`]).map(r => r.user_id);
}

/** Voice metrics from the continuous transcription (stream_timeline_events). */
function voiceStatsFor(userId, win) {
    const hypeSql = HYPE_PATTERNS.map(() => "(LOWER(text) LIKE ?)").join(' + ');
    const hypeParams = HYPE_PATTERNS.map(p => `%${p}%`);
    let speech = {};
    try {
        speech = db.get(`
            SELECT COUNT(*) AS lines,
                   COALESCE(SUM(COALESCE(end_sec, start_sec + 3) - start_sec), 0) AS speech_sec,
                   COALESCE(SUM(LENGTH(text) - LENGTH(REPLACE(text, ' ', '')) + 1), 0) AS words,
                   COALESCE(SUM(text LIKE '%!%'), 0) AS exclaims,
                   COALESCE(SUM(text LIKE '%?%'), 0) AS questions,
                   COALESCE(SUM(${hypeSql}), 0) AS hype_hits,
                   COUNT(DISTINCT stream_id) AS streams_heard
            FROM stream_timeline_events
            WHERE user_id = ? AND kind = 'speech' AND created_at >= datetime('now', ?)
        `, [...hypeParams, userId, win]) || {};
    } catch { speech = {}; }
    let covered = 0, laughs = 0, topSounds = [];
    try {
        covered = db.get(`
            SELECT COALESCE(SUM(duration_seconds), 0) AS sec FROM streams
            WHERE user_id = ? AND duration_seconds > 0
              AND id IN (SELECT DISTINCT stream_id FROM stream_timeline_events WHERE user_id = ? AND created_at >= datetime('now', ?))
        `, [userId, userId, win])?.sec || 0;
        laughs = db.get(`SELECT COUNT(*) AS n FROM stream_timeline_events WHERE user_id = ? AND kind = 'sound' AND (LOWER(label) LIKE '%laugh%' OR LOWER(label) LIKE '%giggle%' OR LOWER(label) LIKE '%chuckle%') AND created_at >= datetime('now', ?)`, [userId, win])?.n || 0;
        topSounds = db.all(`SELECT label, COUNT(*) AS n FROM stream_timeline_events WHERE user_id = ? AND kind = 'sound' AND label IS NOT NULL AND created_at >= datetime('now', ?) GROUP BY label ORDER BY n DESC LIMIT 5`, [userId, win]);
    } catch { /* */ }
    const speechSec = Number(speech.speech_sec) || 0;
    const coveredHours = Math.max(covered / 3600, 0.05);
    const speechMin = Math.max(speechSec / 60, 0.1);
    const talkRatio = covered > 0 ? Math.min(1, speechSec / covered) : 0;
    const wpm = speech.words ? speech.words / speechMin : 0;
    const hypePerHour = (speech.hype_hits || 0) / coveredHours;
    const laughsPerHour = laughs / coveredHours;
    const hasData = (speech.lines || 0) >= 5;
    return {
        has_data: hasData,
        lines: speech.lines || 0,
        streams_heard: speech.streams_heard || 0,
        speech_minutes: Number((speechSec / 60).toFixed(1)),
        talk_ratio_pct: Number((talkRatio * 100).toFixed(1)),
        wpm: Number(wpm.toFixed(0)),
        words: speech.words || 0,
        exclaims: speech.exclaims || 0,
        questions: speech.questions || 0,
        hype_hits: speech.hype_hits || 0,
        hype_per_hour: Number(hypePerHour.toFixed(1)),
        laughs, laughs_per_hour: Number(laughsPerHour.toFixed(1)),
        top_sounds: topSounds.map(s => ({ label: s.label, n: s.n })),
        // The single number MIC is ranked on: talk share carries it, hype + laughter spice it.
        voice_score: hasData ? Number((talkRatio * 100 + Math.min(hypePerHour, 60) * 0.5 + Math.min(laughsPerHour, 30) + Math.min(wpm, 200) / 20).toFixed(2)) : 0,
    };
}

function rawStatsFor(userId) {
    const win = `-${STATS_WINDOW_DAYS} days`;
    const agg = db.get(`
        SELECT COUNT(*) AS streams,
               COALESCE(SUM(s.duration_seconds), 0) / 3600.0 AS hours,
               COALESCE(MAX(s.peak_viewers), 0) AS peak_viewers,
               COALESCE(AVG(sa.avg_viewers), 0) AS avg_viewers,
               COALESCE(SUM(sa.total_messages), 0) AS messages,
               COALESCE(SUM(sa.unique_chatters), 0) AS unique_chatters,
               COALESCE(SUM(sa.total_watch_minutes), 0) AS watch_minutes,
               COALESCE(SUM(sa.clips_created), 0) AS clips,
               MAX(s.ended_at) AS last_live_at
        FROM streams s LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
        WHERE s.user_id = ? AND s.duration_seconds > 0 AND s.started_at >= datetime('now', ?)
    `, [userId, win]) || {};
    const allTime = db.get(`
        SELECT COUNT(*) AS streams, COALESCE(SUM(duration_seconds), 0) / 3600.0 AS hours, COALESCE(MAX(peak_viewers), 0) AS peak_viewers
        FROM streams WHERE user_id = ? AND duration_seconds > 0
    `, [userId]) || {};
    const followers = db.get('SELECT COUNT(*) AS n FROM follows WHERE streamer_id = ?', [userId])?.n || 0;
    const tips = db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE to_user_id = ? AND type = 'donation' AND created_at >= datetime('now', ?)`, [userId, win])?.n || 0;
    const category = db.get(`
        SELECT category, COUNT(*) AS n FROM streams
        WHERE user_id = ? AND duration_seconds > 0 AND category IS NOT NULL AND category != ''
        GROUP BY category ORDER BY n DESC LIMIT 1
    `, [userId])?.category || null;
    const hours = Math.max(Number(agg.hours) || 0, 0.1);
    const voice = voiceStatsFor(userId, win);
    return {
        window_days: STATS_WINDOW_DAYS,
        streams: agg.streams || 0,
        hours: Number((agg.hours || 0).toFixed(1)),
        peak_viewers: agg.peak_viewers || 0,
        avg_viewers: Number((agg.avg_viewers || 0).toFixed(1)),
        messages: agg.messages || 0,
        messages_per_hour: Number((agg.messages / hours).toFixed(1)),
        unique_chatters: agg.unique_chatters || 0,
        watch_hours: Number(((agg.watch_minutes || 0) / 60).toFixed(1)),
        clips: agg.clips || 0,
        tips,
        clutch_per_hour: Number((((agg.clips || 0) * 3 + tips / 100) / hours).toFixed(2)),
        followers,
        loyalty_score: followers + (agg.unique_chatters || 0) / 4,
        all_time_hours: Number((allTime.hours || 0).toFixed(1)),
        all_time_peak: allTime.peak_viewers || 0,
        all_time_streams: allTime.streams || 0,
        last_live_at: agg.last_live_at || null,
        category,
        voice,
    };
}

const METRIC_FOR_STAT = {
    hype: (r) => r.peak_viewers,
    grind: (r) => r.hours,
    chat: (r) => r.messages_per_hour,
    loyalty: (r) => r.loyalty_score,
    clutch: (r) => r.clutch_per_hour,
    vibe: (r) => r.avg_viewers,
    mic: (r) => (r.voice ? r.voice.voice_score : 0),
};

/**
 * Percentile ratings across a roster: rating = 40 + 59 × percentile. Ties share a rank,
 * a roster of one is a flat 70 across the board (no population to compare against).
 */
function computeRatings(rosterRaw) {
    const ids = Object.keys(rosterRaw);
    const out = {};
    for (const id of ids) out[id] = {};
    for (const stat of STAT_KEYS) {
        const values = ids.map(id => METRIC_FOR_STAT[stat](rosterRaw[id]) || 0);
        const sorted = [...values].sort((a, b) => a - b);
        ids.forEach((id, i) => {
            const v = values[i];
            let pct;
            if (ids.length < 2) pct = 0.5;
            else {
                const below = sorted.filter(x => x < v).length;
                const equal = sorted.filter(x => x === v).length;
                pct = (below + (equal - 1) / 2) / (ids.length - 1);
            }
            out[id][stat] = Math.round(RATING_MIN + (99 - RATING_MIN) * Math.max(0, Math.min(1, pct)));
        });
    }
    for (const id of ids) {
        out[id].power = Math.round(STAT_KEYS.reduce((sum, k) => sum + out[id][k] * STAT_WEIGHTS[k], 0));
    }
    return out;
}

// ── Roster cache (stats are cheap but not free — recompute every few minutes) ──

let _roster = null;      // { at, byId: { [userId]: { user, raw, ratings } }, order: [userId…] }
const ROSTER_TTL_MS = 3 * 60 * 1000;

function loadRoster(force = false) {
    if (!force && _roster && Date.now() - _roster.at < ROSTER_TTL_MS) return _roster;
    ensureTables();
    const ids = activeStreamerIds();
    const rawById = {};
    for (const id of ids) rawById[id] = rawStatsFor(id);
    const ratings = computeRatings(rawById);
    // Trash Talk bonus (server/arena/trash-talk.js): recent judged entries add up to
    // TALK_BONUS_MAX POWER, decaying over a week — the one lever streamers pull themselves.
    let bonuses = {};
    try { bonuses = require('./trash-talk').talkBonuses(); } catch { bonuses = {}; }
    const byId = {};
    for (const id of ids) {
        const user = db.getUserById(id);
        if (!user) continue;
        const talkBonus = bonuses[id] || 0;
        ratings[id].base_power = ratings[id].power;
        ratings[id].talk_bonus = talkBonus;
        ratings[id].power = Math.min(99 + require('./trash-talk').TALK_BONUS_MAX, ratings[id].power + talkBonus);
        byId[id] = { user: publicUser(user), raw: rawById[id], ratings: ratings[id] };
        try { db.run('INSERT INTO arena_profiles (user_id, stats_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET stats_json = excluded.stats_json, updated_at = CURRENT_TIMESTAMP', [id, JSON.stringify({ raw: rawById[id], ratings: ratings[id] })]); } catch { /* */ }
    }
    const order = Object.keys(byId).map(Number).sort((a, b) => byId[b].ratings.power - byId[a].ratings.power || a - b);
    _roster = { at: Date.now(), byId, order };
    return _roster;
}

function publicUser(u) {
    return {
        id: u.id,
        username: u.username,
        display_name: u.display_name || u.username,
        avatar_url: u.avatar_url || null,
        profile_color: u.profile_color || null,
        bio: u.bio || '',
    };
}

// ── Records, history, rivalries ──────────────────────────────

function recordFor(userId) {
    const r = db.get(`
        SELECT
            SUM(CASE WHEN winner_user_id = ? THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN winner_user_id IS NOT NULL AND winner_user_id != ? THEN 1 ELSE 0 END) AS losses
        FROM arena_battles WHERE a_user_id = ? OR b_user_id = ?
    `, [userId, userId, userId, userId]) || {};
    return { wins: r.wins || 0, losses: r.losses || 0 };
}

function recentBattles(userId, roster, limit = 8) {
    const rows = db.all(`
        SELECT id, a_user_id, b_user_id, day, winner_user_id, result_json FROM arena_battles
        WHERE a_user_id = ? OR b_user_id = ? ORDER BY day DESC, id DESC LIMIT ?
    `, [userId, userId, limit]);
    return rows.map(b => {
        const oppId = b.a_user_id === userId ? b.b_user_id : b.a_user_id;
        const opp = roster.byId[oppId];
        const oppUser = opp ? opp.user : publicUser(db.getUserById(oppId) || { id: oppId, username: `user${oppId}` });
        const rounds = parseJson(b.result_json, { rounds: [] }).rounds || [];
        const mine = b.a_user_id === userId ? 'a' : 'b';
        return {
            id: b.id, day: b.day,
            opponent: oppUser,
            opponent_fighter_name: opp ? (parseJson(profileRow(oppId)?.persona_json) || fallbackPersona(opp)).fighter_name : oppUser.display_name,
            result: b.winner_user_id == null ? 'draw' : (b.winner_user_id === userId ? 'win' : 'loss'),
            rounds_won: rounds.filter(r => r.winner === mine).length,
            rounds_total: rounds.length,
        };
    });
}

function rivalryFor(userId, roster) {
    const row = db.get(`
        SELECT CASE WHEN a_user_id = ? THEN b_user_id ELSE a_user_id END AS opp, COUNT(*) AS fights,
               SUM(CASE WHEN winner_user_id = ? THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN winner_user_id IS NOT NULL AND winner_user_id != ? THEN 1 ELSE 0 END) AS losses
        FROM arena_battles WHERE a_user_id = ? OR b_user_id = ?
        GROUP BY opp ORDER BY fights DESC, wins ASC LIMIT 1
    `, [userId, userId, userId, userId, userId]);
    if (!row || row.fights < 2) return null;
    const opp = roster.byId[row.opp];
    if (!opp) return null;
    return { opponent: opp.user, fighter_name: (parseJson(profileRow(row.opp)?.persona_json) || fallbackPersona(opp)).fighter_name, fights: row.fights, wins: row.wins || 0, losses: row.losses || 0 };
}

function headToHead(ida, idb) {
    const r = db.get(`
        SELECT COUNT(*) AS fights,
               SUM(CASE WHEN winner_user_id = ? THEN 1 ELSE 0 END) AS a_wins,
               SUM(CASE WHEN winner_user_id = ? THEN 1 ELSE 0 END) AS b_wins
        FROM arena_battles WHERE a_user_id = ? AND b_user_id = ?
    `, [ida, idb, ida, idb]) || {};
    return { fights: r.fights || 0, a_wins: r.a_wins || 0, b_wins: r.b_wins || 0 };
}

// ── Persona (AI) ─────────────────────────────────────────────

function profileRow(userId) {
    ensureTables();
    return db.get('SELECT * FROM arena_profiles WHERE user_id = ?', [userId]) || null;
}

function parseJson(text, fallback = null) {
    if (!text) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

function freshWithin(ts, ttl) { return !!ts && Date.now() - Date.parse(ts + 'Z') < ttl; }
function personaIsFresh(row) { return !!(row && row.persona_json) && freshWithin(row.persona_generated_at, PERSONA_TTL_MS); }
function quotesAreFresh(row) { return !!(row && row.quotes_json) && freshWithin(row.quotes_generated_at, QUOTES_TTL_MS); }

/** Everything the site knows about a streamer that a writer could riff on. */
function gatherContext(userId) {
    const ctx = {};
    try { ctx.overview = db.getStreamerOverview(userId)?.overview || null; } catch { /* */ }
    try {
        const mems = db.all('SELECT description, tags FROM stream_memories WHERE user_id = ? ORDER BY captured_at DESC LIMIT 4', [userId]);
        ctx.memories = mems.map(m => m.description).filter(Boolean);
    } catch { ctx.memories = []; }
    try {
        const chatAi = db.getChatAiSummary('user', userId, 'rolling');
        if (chatAi) {
            const ov = parseJson(chatAi.overview, null);
            ctx.chat_notes = ov ? [ov.alltime, ov.today].filter(Boolean).join(' ') : String(chatAi.overview || '');
        }
    } catch { /* */ }
    try {
        ctx.vods = db.all(`
            SELECT v.title, va.ai_overview_short AS overview FROM vods v
            LEFT JOIN vod_ai_state va ON va.vod_id = v.id
            WHERE v.user_id = ? AND v.is_public = 1 ORDER BY v.created_at DESC LIMIT 5
        `, [userId]).map(v => ({ title: v.title, overview: v.overview || null }));
    } catch {
        try { ctx.vods = db.all('SELECT title FROM vods WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [userId]).map(v => ({ title: v.title })); } catch { ctx.vods = []; }
    }
    try { ctx.titles = db.all('SELECT DISTINCT title FROM streams WHERE user_id = ? AND duration_seconds > 0 ORDER BY started_at DESC LIMIT 8', [userId]).map(r => r.title).filter(Boolean); } catch { ctx.titles = []; }
    try {
        // A taste of how they actually talk — short, recent, non-empty lines.
        ctx.said = db.all(`SELECT text FROM stream_timeline_events WHERE user_id = ? AND kind = 'speech' AND LENGTH(text) BETWEEN 30 AND 140 ORDER BY created_at DESC LIMIT 24`, [userId]).map(r => r.text).filter(t => !isBannedText(t)).slice(0, 12);
    } catch { ctx.said = []; }
    return ctx;
}

const PERSONA_SCHEMA = {
    name: 'arena_persona',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['fighter_name', 'title', 'class', 'element', 'signature_move', 'special', 'weakness', 'taunt', 'lore', 'catchphrase', 'entrance_music', 'stat_quips'],
        properties: {
            fighter_name: { type: 'string', description: 'Arena ring name, 2–5 words, based on the streamer' },
            title: { type: 'string', description: 'Epithet like "The Midnight Menace of Cozy Corner"' },
            class: { type: 'string', description: 'Fighting-game archetype, e.g. Grappler, Zoner, Rushdown, Summoner, Bard, Tank' },
            element: { type: 'string', description: 'Single word element/vibe, e.g. Caffeine, Static, Lo-fi, Chaos' },
            signature_move: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: { type: 'string' }, description: { type: 'string' } } },
            special: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: { type: 'string' }, description: { type: 'string' } } },
            weakness: { type: 'string' },
            taunt: { type: 'string', description: 'One-line trash talk they would say to an opponent' },
            lore: { type: 'string', description: '2–3 sentence character-select bio' },
            catchphrase: { type: 'string' },
            entrance_music: { type: 'string', description: 'Invented track name + fake artist' },
            stat_quips: {
                type: 'object', additionalProperties: false, required: STAT_KEYS,
                properties: Object.fromEntries(STAT_KEYS.map(k => [k, { type: 'string', description: `≤ 8 words explaining their ${k} rating in character` }])),
            },
        },
    },
};

const PERSONA_SYSTEM = `You write fighting-game "character select" bios for a live-streaming site's tongue-in-cheek Arena tab, where streamers are ranked and pitted against each other for laughs.
Voice: hype-caster energy, absurd, affectionate roast. Riff on what they actually stream, how they talk (transcript lines are provided), their running jokes, chat culture, schedule and the numbers you are given.
Hard rules: never mock appearance, body, voice quality, accent, disability, age, ethnicity, gender, religion, health, money troubles or anything a streamer cannot laugh at. Never invent real-life facts; everything is Arena lore. Keep it PG-13. Do not use the word "streamer" more than once. Output only the JSON.`;

async function generatePersona(userId, { force = false } = {}) {
    ensureTables();
    const row = profileRow(userId);
    if (!force && personaIsFresh(row)) return parseJson(row.persona_json);
    if (!aiOn()) return row ? parseJson(row.persona_json) : null;

    const roster = loadRoster();
    const entry = roster.byId[userId] || { user: publicUser(db.getUserById(userId) || { id: userId, username: `user${userId}` }), raw: rawStatsFor(userId), ratings: null };
    const ctx = gatherContext(userId);
    const stats = entry.ratings || Object.fromEntries(STAT_KEYS.map(k => [k, 70]).concat([['power', 70]]));
    const facts = {
        name: entry.user.display_name,
        handle: entry.user.username,
        category: entry.raw.category,
        ratings: stats,
        numbers: {
            hours_live_90d: entry.raw.hours, peak_viewers_90d: entry.raw.peak_viewers, avg_viewers: entry.raw.avg_viewers,
            chat_messages_per_hour: entry.raw.messages_per_hour, followers: entry.raw.followers, clips: entry.raw.clips,
            all_time_hours: entry.raw.all_time_hours, all_time_peak: entry.raw.all_time_peak,
            on_mic: entry.raw.voice.has_data ? { talk_share_pct: entry.raw.voice.talk_ratio_pct, words_per_minute: entry.raw.voice.wpm, hype_words_per_hour: entry.raw.voice.hype_per_hour, laughs_per_hour: entry.raw.voice.laughs_per_hour, stream_sounds: entry.raw.voice.top_sounds.map(s => s.label) } : 'no transcript data yet',
        },
        ai_overview: ctx.overview,
        recent_stream_titles: ctx.titles,
        what_the_camera_saw_recently: ctx.memories,
        chat_ai_notes: ctx.chat_notes,
        recent_vods: ctx.vods,
        things_they_said_on_stream: ctx.said,
    };
    const r = await llm.complete({
        role: 'summary', kind: 'arena_persona', source: 'arena', ownerUserId: userId,
        system: PERSONA_SYSTEM,
        user: `Write the Arena persona for this fighter. Facts (JSON):\n${JSON.stringify(facts)}`,
        json: PERSONA_SCHEMA, maxTokens: 950, temperature: 0.95, timeoutMs: 30000,
    });
    const persona = r && r.json && r.json.fighter_name ? r.json : null;
    if (!persona) {
        console.warn(`[Arena] persona generation failed for user ${userId}`);
        return row ? parseJson(row.persona_json) : null;
    }
    db.run(`INSERT INTO arena_profiles (user_id, persona_json, persona_model, persona_generated_at, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET persona_json = excluded.persona_json, persona_model = excluded.persona_model,
                persona_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
        [userId, JSON.stringify(persona), r.model || null]);
    console.log(`[Arena] persona for ${entry.user.username}: "${persona.fighter_name}" (${persona.class})`);
    return persona;
}

/** Non-AI stand-in so the tab is never empty. */
function fallbackPersona(entry) {
    const r = entry.ratings || {};
    const best = STAT_KEYS.reduce((a, b) => ((r[b] || 0) > (r[a] || 0) ? b : a), STAT_KEYS[0]);
    const cls = { hype: 'Rushdown', grind: 'Tank', chat: 'Bard', loyalty: 'Summoner', clutch: 'Assassin', vibe: 'Zoner', mic: 'Caster' }[best];
    return {
        fighter_name: entry.user.display_name,
        title: `The ${STAT_META[best].label} Specialist`,
        class: cls,
        element: entry.raw.category ? entry.raw.category.replace(/[-_]/g, ' ') : 'Static',
        signature_move: { name: `${STAT_META[best].label} Surge`, description: `Turns ${STAT_META[best].desc} into raw damage.` },
        special: { name: 'Go Live', description: 'Hits the button. The arena fills up.' },
        weakness: 'Sleep schedules.',
        taunt: 'Chat, are you seeing this?',
        lore: `${entry.user.display_name} shows up, streams, and leaves the leaderboard slightly different than they found it.`,
        catchphrase: 'Let him cook.',
        entrance_music: 'Untitled Loop (feat. Notification Sound)',
        stat_quips: Object.fromEntries(STAT_KEYS.map(k => [k, STAT_META[k].desc])),
        _fallback: true,
    };
}

// ── Quotes (from the transcripts; AI picks the good ones) ────

function quoteCandidates(userId, limit = 90) {
    let rows = [];
    try {
        rows = db.all(`
            SELECT id, stream_id, vod_id, start_sec, text FROM stream_timeline_events
            WHERE user_id = ? AND kind = 'speech' AND created_at >= datetime('now', ?)
              AND LENGTH(text) BETWEEN 25 AND 220
            ORDER BY created_at DESC LIMIT 1500
        `, [userId, `-${STATS_WINDOW_DAYS} days`]);
    } catch { rows = []; }
    const score = (t) => {
        const s = t.toLowerCase();
        let n = (t.match(/!/g) || []).length * 2 + (t.match(/\?/g) || []).length;
        for (const p of HYPE_PATTERNS) if (s.includes(p)) n += 3;
        if (/\b(i|we|you|chat)\b/.test(s)) n += 1;
        if (/\b(um+|uh+|like like)\b/.test(s)) n -= 1;
        return n;
    };
    // Hard filter first — nothing on the banned list is ever a candidate, so the model
    // cannot pick it. Then keep the spiciest, and fill with a spread across time so one
    // stream cannot dominate.
    const scored = rows.filter(r => !isBannedText(r.text)).map(r => ({ ...r, score: score(r.text) })).sort((x, y) => y.score - x.score);
    const picked = scored.slice(0, Math.ceil(limit / 2));
    const rest = scored.slice(Math.ceil(limit / 2));
    const step = Math.max(1, Math.floor(rest.length / Math.max(1, limit - picked.length)));
    for (let i = 0; i < rest.length && picked.length < limit; i += step) picked.push(rest[i]);
    return picked;
}

const QUOTES_SCHEMA = {
    name: 'arena_quotes',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['picks', 'walkout', 'voice_verdict', 'mic_style'],
        properties: {
            picks: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['index', 'why'], properties: { index: { type: 'integer' }, why: { type: 'string', description: '≤ 10 words: why this line is a banger' } } } },
            walkout: { type: 'integer', description: 'index of the line that should play as their walkout' },
            voice_verdict: { type: 'string', description: 'One sentence on how they sound on the mic, announcer voice' },
            mic_style: { type: 'string', description: '2–3 words, e.g. "Rapid-fire tech sermon"' },
        },
    },
};

const QUOTES_SYSTEM = `You pick the most quotable lines a live-streamer actually said, from raw speech-to-text (expect transcription noise). Choose lines that are funny, hype, weirdly profound, or perfect trash talk out of context. Skip anything that would embarrass them or anyone else: no insults about people, nothing about health/money/family, nothing offensive. Prefer complete sentences. Return indexes into the list you are given. Output only the JSON.`;

function fallbackQuotes(candidates) {
    const picks = candidates.slice(0, 5).map(c => ({ ...c, why: 'straight from the transcript' }));
    return { picks, walkout: picks[0] || null, voice_verdict: null, mic_style: null, _fallback: true };
}

function materializeQuotes(candidates, sel) {
    // Belt and braces: candidates are pre-filtered, but never trust an index blindly.
    const pick = (i, why) => { const c = candidates[i]; return c && !isBannedText(c.text) ? { text: c.text, stream_id: c.stream_id, vod_id: c.vod_id, start_sec: Math.max(0, Math.floor(Number(c.start_sec) || 0) - 2), why } : null; };
    const picks = (sel.picks || []).map(p => pick(p.index, p.why)).filter(Boolean);
    const walkout = pick(sel.walkout, 'walkout line') || picks[0] || null;
    return { picks, walkout, voice_verdict: sel.voice_verdict || null, mic_style: sel.mic_style || null };
}

async function generateQuotes(userId, { force = false } = {}) {
    ensureTables();
    const row = profileRow(userId);
    if (!force && quotesAreFresh(row)) return parseJson(row.quotes_json);
    const candidates = quoteCandidates(userId);
    if (candidates.length < MIN_QUOTE_LINES) return null;
    let result = null;
    if (aiOn()) {
        try {
            const r = await llm.complete({
                role: 'summary', kind: 'arena_quotes', source: 'arena', ownerUserId: userId,
                system: QUOTES_SYSTEM,
                user: `Lines (index: text):\n${candidates.map((c, i) => `${i}: ${c.text}`).join('\n')}`,
                json: QUOTES_SCHEMA, maxTokens: 500, temperature: 0.7, timeoutMs: 30000,
            });
            if (r && r.json && Array.isArray(r.json.picks)) result = materializeQuotes(candidates, r.json);
        } catch (e) { console.warn('[Arena] quotes:', e.message); }
    }
    if (!result || !result.picks.length) result = materializeQuotes(candidates, { picks: fallbackQuotes(candidates).picks.map((p, i) => ({ index: i, why: p.why })), walkout: 0 });
    if (!aiOn()) result._fallback = true;
    db.run(`INSERT INTO arena_profiles (user_id, quotes_json, quotes_generated_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET quotes_json = excluded.quotes_json, quotes_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
        [userId, JSON.stringify(result)]);
    return result;
}

// ── Image (AI, optional) ─────────────────────────────────────

function imageIsFresh(row) {
    if (!row || !row.image_path || !row.image_generated_at) return false;
    if (!fs.existsSync(path.join(ARENA_DIR, path.basename(row.image_path)))) return false;
    return Date.now() - Date.parse(row.image_generated_at + 'Z') < IMAGE_TTL_MS;
}

function imageUrlFor(row) {
    if (!row || !row.image_path) return null;
    const base = path.basename(row.image_path);
    if (!fs.existsSync(path.join(ARENA_DIR, base))) return null;
    return `/data/arena/${base}`;
}

/** Latest visual of the streamer's stream: live thumb if live, else newest VOD thumbnail. */
function latestThumbnailFor(userId) {
    try {
        const live = db.get('SELECT id FROM streams WHERE user_id = ? AND is_live = 1 ORDER BY started_at DESC LIMIT 1', [userId]);
        if (live) {
            const thumbs = require('../media-proxy/live-thumbs');
            const url = thumbs.getCurrentLiveThumbnailUrl(live.id);
            if (url) {
                const local = path.resolve('./data/live-thumbs', path.basename(url));
                if (fs.existsSync(local)) return local;
                return url.startsWith('http') ? url : null;
            }
        }
    } catch { /* */ }
    try {
        const v = db.get('SELECT thumbnail_url FROM vods WHERE user_id = ? AND thumbnail_url IS NOT NULL AND is_public = 1 ORDER BY created_at DESC LIMIT 1', [userId]);
        if (v && /^https?:\/\//i.test(v.thumbnail_url)) return v.thumbnail_url;
    } catch { /* */ }
    return null;
}

const SCENE_SYSTEM = 'Describe this stream thumbnail as a SCENE for an illustrator in ≤ 60 words: setting, objects, lighting, colours, mood, what activity is happening. Do NOT describe any person\'s face, body, skin, hair, age, gender or identity — refer to a person only as "the host" if at all. Plain text only.';

const _imageInFlight = new Map(); // userId → Promise

async function generateImage(userId, { force = false } = {}) {
    ensureTables();
    const row = profileRow(userId);
    if (!force && imageIsFresh(row)) return imageUrlFor(row);
    if (!imageGenAvailable()) return imageUrlFor(row);
    if (_imageInFlight.has(userId)) return _imageInFlight.get(userId);

    const task = (async () => {
        const entry = loadRoster().byId[userId];
        const persona = parseJson(row?.persona_json) || (entry ? fallbackPersona(entry) : null);
        if (!persona) return null;
        let scene = '';
        const thumb = latestThumbnailFor(userId);
        if (thumb) {
            try {
                const d = await llm.complete({ role: 'vision', kind: 'arena_scene', source: 'arena', ownerUserId: userId, system: SCENE_SYSTEM, user: 'Describe the scene.', image: thumb, maxTokens: 120, temperature: 0.4, timeoutMs: 30000 });
                scene = (d && d.text || '').trim();
            } catch { scene = ''; }
        }
        const color = entry?.user?.profile_color || '#8b5cf6';
        const prompt = [
            `Fighting-game character-select portrait of an original stylised hero called "${persona.fighter_name}" — ${persona.title}.`,
            `Class: ${persona.class}. Element: ${persona.element}. Signature move: ${persona.signature_move?.name} (${persona.signature_move?.description}).`,
            entry?.raw?.category ? `Costume and props inspired by ${String(entry.raw.category).replace(/[-_]/g, ' ')} streaming.` : '',
            scene ? `Background inspired by this scene: ${scene}` : 'Background: dark neon arena.',
            `Colour palette led by ${color}. Bold comic-book line art, dramatic rim light, dynamic pose, three-quarter view, waist up.`,
            'Fictional character, not a real person. No text, no letters, no logos, no watermark.',
        ].filter(Boolean).join(' ');

        const p = llm.resolveProvider('vision');
        const model = String(setting('ai_image_model', 'gpt-image-1'));
        const body = { model, prompt, n: 1, size: '1024x1024' };
        if (/^dall-e/i.test(model)) body.response_format = 'b64_json';
        else body.quality = String(setting('ai_image_quality', 'low'));
        const started = Date.now();
        let b64 = null;
        try {
            const res = await fetch(`${p.baseUrl}/images/generations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120000),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error((j.error && (j.error.message || j.error)) || `HTTP ${res.status}`);
            const item = j.data && j.data[0];
            if (item?.b64_json) b64 = item.b64_json;
            else if (item?.url) {
                const r2 = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
                b64 = Buffer.from(await r2.arrayBuffer()).toString('base64');
            }
            if (!b64) throw new Error('no image in response');
        } catch (err) {
            console.warn(`[Arena] image generation failed for user ${userId}:`, err.message);
            db.run('INSERT INTO arena_profiles (user_id, image_error, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET image_error = excluded.image_error, updated_at = CURRENT_TIMESTAMP', [userId, err.message.slice(0, 300)]);
            return imageUrlFor(row);
        }
        const file = `u${userId}-${Date.now().toString(36)}.png`;
        fs.writeFileSync(path.join(ARENA_DIR, file), Buffer.from(b64, 'base64'));
        if (row?.image_path) { try { fs.unlinkSync(path.join(ARENA_DIR, path.basename(row.image_path))); } catch { /* */ } }
        db.run(`INSERT INTO arena_profiles (user_id, image_path, image_prompt, image_model, image_generated_at, image_error, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET image_path = excluded.image_path, image_prompt = excluded.image_prompt, image_model = excluded.image_model,
                    image_generated_at = CURRENT_TIMESTAMP, image_error = NULL, updated_at = CURRENT_TIMESTAMP`,
            [userId, file, prompt, model]);
        try {
            db.recordAiUsage({ kind: 'arena_image', model, cost_usd: Number(setting('ai_image_cost_usd', 0.011)) || 0, owner_user_id: userId, source: 'arena', role: 'image', provider: 'shared', latency_ms: Date.now() - started });
        } catch { /* */ }
        console.log(`[Arena] portrait generated for user ${userId} (${model}, ${Date.now() - started} ms)`);
        return `/data/arena/${file}`;
    })().finally(() => _imageInFlight.delete(userId));
    _imageInFlight.set(userId, task);
    return task;
}

// ── Fighter cards ────────────────────────────────────────────

function resolveUser(usernameOrId) {
    if (/^\d+$/.test(String(usernameOrId))) return db.getUserById(Number(usernameOrId));
    return db.getUserByUsername(String(usernameOrId));
}

function isLive(userId) {
    return !!db.get('SELECT 1 FROM streams WHERE user_id = ? AND is_live = 1 LIMIT 1', [userId]);
}

function cardFor(userId, roster, { includeRaw = true, includeQuotes = false } = {}) {
    const entry = roster.byId[userId];
    if (!entry) return null;
    const row = profileRow(userId);
    const persona = parseJson(row?.persona_json) || fallbackPersona(entry);
    const rank = roster.order.indexOf(userId) + 1;
    const card = {
        user: entry.user,
        rank,
        roster_size: roster.order.length,
        ratings: entry.ratings,
        stat_meta: STAT_META,
        raw: includeRaw ? entry.raw : undefined,
        voice: entry.raw.voice,
        persona,
        persona_is_fallback: !!persona._fallback,
        persona_generated_at: row?.persona_generated_at || null,
        image_url: imageUrlFor(row),
        image_prompt: row?.image_prompt || null,
        image_model: row?.image_model || null,
        image_pending: false,
        record: recordFor(userId),
        live: isLive(userId),
    };
    if (includeQuotes) card.quotes = parseJson(row?.quotes_json) || null;
    return card;
}

async function getFighter(usernameOrId, { generate = true } = {}) {
    const user = resolveUser(usernameOrId);
    if (!user) return null;
    const roster = loadRoster();
    if (!roster.byId[user.id]) return { user: publicUser(user), not_on_roster: true, reason: `No streams in the last ${ACTIVE_DAYS} days` };
    if (generate) {
        const row = profileRow(user.id);
        if (aiOn() && !personaIsFresh(row)) { try { await generatePersona(user.id); } catch (e) { console.warn('[Arena] persona:', e.message); } }
        if (!quotesAreFresh(profileRow(user.id))) { try { await generateQuotes(user.id); } catch (e) { console.warn('[Arena] quotes:', e.message); } }
        if (aiOn() && !imageIsFresh(profileRow(user.id)) && imageGenAvailable()) {
            // Fire and forget — the client polls until image_url is present.
            generateImage(user.id).catch(() => {});
        }
    }
    const card = cardFor(user.id, roster, { includeQuotes: true });
    card.image_pending = !card.image_url && _imageInFlight.has(user.id);
    card.image_generation = imageGenAvailable() ? 'ai' : 'off';
    card.recent_battles = recentBattles(user.id, roster);
    card.rivalry = rivalryFor(user.id, roster);
    try { card.trash_talk = require('./trash-talk').entriesFor(user.id, 5); } catch { card.trash_talk = []; }
    return card;
}

function listFighters() {
    const roster = loadRoster();
    return roster.order.map(id => {
        const c = cardFor(id, roster, { includeRaw: false });
        return {
            user: c.user, rank: c.rank, ratings: c.ratings, record: c.record, live: c.live, image_url: c.image_url,
            persona: { fighter_name: c.persona.fighter_name, title: c.persona.title, class: c.persona.class, element: c.persona.element, taunt: c.persona.taunt, lore: c.persona.lore, signature_move: c.persona.signature_move, stat_quips: c.persona.stat_quips },
            persona_is_fallback: c.persona_is_fallback,
            category: roster.byId[id].raw.category,
            last_live_at: roster.byId[id].raw.last_live_at,
            voice: { has_data: c.voice.has_data, talk_ratio_pct: c.voice.talk_ratio_pct, speech_minutes: c.voice.speech_minutes },
        };
    });
}

/** Per-stream series for one stat (for the expandable stat view) + where they rank on it. */
function getStatDetail(userId, stat) {
    if (!STAT_KEYS.includes(stat)) return null;
    const roster = loadRoster();
    const entry = roster.byId[userId];
    if (!entry) return null;
    const win = `-${STATS_WINDOW_DAYS} days`;
    let series = [];
    try {
        const rows = db.all(`
            SELECT s.id, s.title, s.started_at, s.duration_seconds, s.peak_viewers,
                   sa.avg_viewers, sa.total_messages, sa.unique_chatters, sa.new_followers, sa.clips_created,
                   (SELECT COALESCE(SUM(COALESCE(e.end_sec, e.start_sec + 3) - e.start_sec), 0) FROM stream_timeline_events e WHERE e.stream_id = s.id AND e.kind = 'speech') AS speech_sec
            FROM streams s LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
            WHERE s.user_id = ? AND s.duration_seconds > 0 AND s.started_at >= datetime('now', ?)
            ORDER BY s.started_at DESC LIMIT 14
        `, [userId, win]).reverse();
        const per = {
            hype: r => r.peak_viewers || 0,
            grind: r => Number(((r.duration_seconds || 0) / 3600).toFixed(2)),
            chat: r => Number(((r.total_messages || 0) / Math.max((r.duration_seconds || 0) / 3600, 0.1)).toFixed(1)),
            loyalty: r => (r.new_followers || 0) + (r.unique_chatters || 0) / 4,
            clutch: r => Number((((r.clips_created || 0) * 3) / Math.max((r.duration_seconds || 0) / 3600, 0.1)).toFixed(2)),
            vibe: r => Number((r.avg_viewers || 0).toFixed(1)),
            mic: r => (r.duration_seconds ? Number(((r.speech_sec || 0) / r.duration_seconds * 100).toFixed(1)) : 0),
        };
        series = rows.map(r => ({ stream_id: r.id, title: r.title, date: r.started_at, value: per[stat](r) }));
    } catch { series = []; }
    const unit = { hype: 'peak viewers', grind: 'hours', chat: 'msgs / hour', loyalty: 'loyalty points', clutch: 'clutch / hour', vibe: 'avg viewers', mic: '% of stream talking' }[stat];
    // MIC is ranked on a composite voice score, but people are shown the talk-time share
    // (the same number the voice card uses) so the drill-down never contradicts the card.
    const shown = (raw) => (stat === 'mic' ? (raw.voice?.talk_ratio_pct || 0) : (METRIC_FOR_STAT[stat](raw) || 0));
    const ranked = roster.order.map(id => ({ id, value: METRIC_FOR_STAT[stat](roster.byId[id].raw) || 0, shown: shown(roster.byId[id].raw), rating: roster.byId[id].ratings[stat] })).sort((x, y) => y.value - x.value);
    const position = ranked.findIndex(r => r.id === userId) + 1;
    const top = ranked.slice(0, 3).map(r => ({ user: roster.byId[r.id].user, fighter_name: (parseJson(profileRow(r.id)?.persona_json) || fallbackPersona(roster.byId[r.id])).fighter_name, value: Number(Number(r.shown).toFixed(1)), rating: r.rating }));
    return {
        stat, label: STAT_META[stat].label, desc: STAT_META[stat].desc, unit,
        rating: entry.ratings[stat], value: Number(Number(shown(entry.raw)).toFixed(1)),
        position, roster_size: roster.order.length, weight: STAT_WEIGHTS[stat],
        series, top,
        voice: stat === 'mic' ? entry.raw.voice : undefined,
    };
}

// ── Battles ──────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }

function seededRandom(seedText) {
    let h = parseInt(crypto.createHash('sha256').update(seedText).digest('hex').slice(0, 8), 16) >>> 0;
    return () => {
        h += 0x6D2B79F5;
        let t = h;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Same pair on the same day → identical rounds. Order-independent. */
function simulateRounds(aRatings, bRatings, seedText) {
    const rand = seededRandom(seedText);
    return ROUNDS.map(r => {
        const a = aRatings[r.stat] + rand() * 30;
        const b = bRatings[r.stat] + rand() * 30;
        const winner = a === b ? (aRatings.power >= bRatings.power ? 'a' : 'b') : (a > b ? 'a' : 'b');
        const margin = Math.abs(a - b);
        return { key: r.key, label: r.label, stat: r.stat, a: Math.round(a), b: Math.round(b), winner, margin: Math.round(margin), upset: (winner === 'a' ? aRatings[r.stat] < bRatings[r.stat] : bRatings[r.stat] < aRatings[r.stat]) };
    });
}

function tallyVotes(battleId) {
    const r = db.get(`SELECT SUM(CASE WHEN side = 'a' THEN 1 ELSE 0 END) AS a, SUM(CASE WHEN side = 'b' THEN 1 ELSE 0 END) AS b FROM arena_votes WHERE battle_id = ?`, [battleId]) || {};
    return { a: r.a || 0, b: r.b || 0 };
}

function scoreBattle(rounds, votes, aPower, bPower) {
    let a = rounds.filter(r => r.winner === 'a').length;
    let b = rounds.filter(r => r.winner === 'b').length;
    let crowd = null;
    if (votes.a !== votes.b) { crowd = votes.a > votes.b ? 'a' : 'b'; if (crowd === 'a') a++; else b++; }
    let winner = a === b ? (aPower === bPower ? null : (aPower > bPower ? 'a' : 'b')) : (a > b ? 'a' : 'b');
    return { a, b, crowd, winner, tiebreak: a === b && winner ? 'power' : null };
}

const COMMENTARY_SCHEMA = {
    name: 'arena_commentary',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['intro', 'rounds', 'finisher', 'verdict'],
        properties: {
            intro: { type: 'string', description: 'Announcer intro, ≤ 2 sentences, name both fighters' },
            rounds: { type: 'array', minItems: ROUNDS.length, maxItems: ROUNDS.length, items: { type: 'string', description: 'One vivid play-by-play sentence per round, in order' } },
            finisher: { type: 'string', description: 'The finishing move that decided it, 1 sentence' },
            verdict: { type: 'string', description: 'Announcer verdict + a wink at the crowd vote, ≤ 2 sentences' },
        },
    },
};

const COMMENTARY_SYSTEM = `You are the over-caffeinated ring announcer of a streaming site's Arena, where streamers battle as fighting-game characters. Call the fight from the round results you are given: name the signature moves, riff on their lore, quote their walkout lines if given, celebrate upsets. The "Mic Drop" round is about who talks more and louder on stream. Affectionate roast only — never cruel, never about appearance/body/voice quality/accent/health/identity. PG-13. Output only the JSON.`;

function templateCommentary(A, B, rounds, outcome) {
    const name = (s) => (s === 'a' ? A.persona.fighter_name : B.persona.fighter_name);
    return {
        intro: `${A.persona.fighter_name} versus ${B.persona.fighter_name}. The arena is loud, the chat is louder.`,
        rounds: rounds.map(r => `${r.label}: ${name(r.winner)} takes it${r.upset ? ' — an upset!' : ''} (${r.a}–${r.b}).`),
        finisher: outcome.winner ? `${name(outcome.winner)} closes it out with ${(outcome.winner === 'a' ? A : B).persona.signature_move.name}.` : 'Nobody lands the finisher. The crowd decides.',
        verdict: outcome.winner ? `${name(outcome.winner)} wins ${outcome.a}–${outcome.b}${outcome.tiebreak ? ' on Power' : ''}.` : 'Dead even — vote to break the tie.',
        _fallback: true,
    };
}

async function getBattle(aName, bName, { generate = true } = {}) {
    const ua = resolveUser(aName), ub = resolveUser(bName);
    if (!ua || !ub || ua.id === ub.id) return null;
    const roster = loadRoster();
    if (!roster.byId[ua.id] || !roster.byId[ub.id]) return { error: 'both fighters must be on the roster' };
    // Canonical order so a-vs-b and b-vs-a are the same battle.
    const [ida, idb] = ua.id < ub.id ? [ua.id, ub.id] : [ub.id, ua.id];
    const day = today();
    ensureTables();
    let row = db.get('SELECT * FROM arena_battles WHERE a_user_id = ? AND b_user_id = ? AND day = ?', [ida, idb, day]);

    if (generate) {
        for (const id of [ida, idb]) {
            if (aiOn() && !personaIsFresh(profileRow(id))) { try { await generatePersona(id); } catch { /* */ } }
            if (!quotesAreFresh(profileRow(id))) { try { await generateQuotes(id); } catch { /* */ } }
        }
    }
    const A = cardFor(ida, roster, { includeRaw: true, includeQuotes: true });
    const B = cardFor(idb, roster, { includeRaw: true, includeQuotes: true });

    if (!row) {
        const rounds = simulateRounds(A.ratings, B.ratings, `${ida}:${idb}:${day}`);
        db.run('INSERT OR IGNORE INTO arena_battles (a_user_id, b_user_id, day, result_json) VALUES (?, ?, ?, ?)', [ida, idb, day, JSON.stringify({ rounds })]);
        row = db.get('SELECT * FROM arena_battles WHERE a_user_id = ? AND b_user_id = ? AND day = ?', [ida, idb, day]);
    }
    const rounds = parseJson(row.result_json, { rounds: [] }).rounds;
    const votes = tallyVotes(row.id);
    const outcome = scoreBattle(rounds, votes, A.ratings.power, B.ratings.power);
    const winnerId = outcome.winner === 'a' ? ida : outcome.winner === 'b' ? idb : null;
    if (row.winner_user_id !== winnerId) db.run('UPDATE arena_battles SET winner_user_id = ? WHERE id = ?', [winnerId, row.id]);

    let commentary = parseJson(row.commentary_json);
    if (!commentary && generate && aiOn()) {
        try {
            const brief = (X) => ({ name: X.persona.fighter_name, title: X.persona.title, class: X.persona.class, signature_move: X.persona.signature_move, special: X.persona.special, weakness: X.persona.weakness, lore: X.persona.lore, ratings: X.ratings, walkout_line: X.quotes?.walkout?.text || null, mic_style: X.quotes?.mic_style || null });
            const r = await llm.complete({
                role: 'chat', kind: 'arena_commentary', source: 'arena',
                system: COMMENTARY_SYSTEM,
                user: JSON.stringify({
                    a: brief(A), b: brief(B),
                    rounds: rounds.map(r => ({ round: r.label, stat: r.stat, a_score: r.a, b_score: r.b, winner: r.winner === 'a' ? A.persona.fighter_name : B.persona.fighter_name, upset: r.upset })),
                    result_before_crowd_vote: { a_rounds: rounds.filter(r => r.winner === 'a').length, b_rounds: rounds.filter(r => r.winner === 'b').length },
                }),
                json: COMMENTARY_SCHEMA, maxTokens: 700, temperature: 0.95, timeoutMs: 25000,
            });
            if (r && r.json && Array.isArray(r.json.rounds)) {
                commentary = r.json;
                db.run('UPDATE arena_battles SET commentary_json = ? WHERE id = ?', [JSON.stringify(commentary), row.id]);
            }
        } catch (e) { console.warn('[Arena] commentary:', e.message); }
    }
    if (!commentary) commentary = templateCommentary(A, B, rounds, outcome);

    const strip = (X) => ({ ...X, quotes: undefined, walkout: X.quotes?.walkout || null, mic_style: X.quotes?.mic_style || null, voice_verdict: X.quotes?.voice_verdict || null });
    return {
        id: row.id, day, a: strip(A), b: strip(B), rounds, votes, outcome,
        winner: winnerId ? (winnerId === ida ? A.user : B.user) : null,
        commentary,
        commentary_is_fallback: !!commentary._fallback,
        history: headToHead(ida, idb),
        stat_meta: STAT_META,
    };
}

/** Today's featured fight: a seeded pick of two fighters from the top of the ladder. */
async function getMainEvent({ generate = true } = {}) {
    const roster = loadRoster();
    if (roster.order.length < 2) return null;
    const pool = roster.order.slice(0, Math.min(8, roster.order.length));
    const rand = seededRandom(`main-event:${today()}`);
    const i = Math.floor(rand() * pool.length);
    let j = Math.floor(rand() * (pool.length - 1)); if (j >= i) j++;
    const battle = await getBattle(String(pool[i]), String(pool[j]), { generate });
    return battle && !battle.error ? battle : null;
}

function castVote(battleId, voterKey, side) {
    if (!['a', 'b'].includes(side)) throw new Error('side must be a or b');
    ensureTables();
    const battle = db.get('SELECT * FROM arena_battles WHERE id = ?', [battleId]);
    if (!battle) throw new Error('battle not found');
    if (battle.day !== today()) throw new Error('voting closed for this battle');
    db.run('INSERT INTO arena_votes (battle_id, voter_key, side) VALUES (?, ?, ?) ON CONFLICT(battle_id, voter_key) DO UPDATE SET side = excluded.side, created_at = CURRENT_TIMESTAMP', [battleId, voterKey, side]);
    const votes = tallyVotes(battleId);
    const rounds = parseJson(battle.result_json, { rounds: [] }).rounds;
    const roster = loadRoster();
    const pa = roster.byId[battle.a_user_id]?.ratings.power ?? 0, pb = roster.byId[battle.b_user_id]?.ratings.power ?? 0;
    const outcome = scoreBattle(rounds, votes, pa, pb);
    const winnerId = outcome.winner === 'a' ? battle.a_user_id : outcome.winner === 'b' ? battle.b_user_id : null;
    db.run('UPDATE arena_battles SET winner_user_id = ? WHERE id = ?', [winnerId, battleId]);
    return { votes, outcome, your_side: side };
}

function voterKeyFor(req) {
    if (req.user && req.user.id) return `user:${req.user.id}`;
    const ip = String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');
    const salt = String(setting('arena_vote_salt', '') || process.env.JWT_SECRET || 'arena');
    return `anon:${crypto.createHash('sha256').update(ip + '|' + salt).digest('hex').slice(0, 24)}`;
}

// ── Live matchups ────────────────────────────────────────────

function getLiveMatchups() {
    const roster = loadRoster();
    let live = [];
    try { live = db.getLiveStreams() || []; } catch { live = []; }
    const byUser = new Map();
    for (const s of live) {
        if (!roster.byId[s.user_id]) continue;
        const cur = byUser.get(s.user_id);
        if (!cur || (s.viewer_count || 0) > (cur.viewer_count || 0)) byUser.set(s.user_id, s);
    }
    let thumbs = null; try { thumbs = require('../media-proxy/live-thumbs'); } catch { /* */ }
    const fighters = [...byUser.values()].map(s => {
        const c = cardFor(s.user_id, roster, { includeRaw: false });
        // What they said most recently on this live stream — the arena "hot mic".
        let lastLine = null;
        try {
            const r = db.all(`SELECT text, start_sec FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND LENGTH(text) > 15 ORDER BY start_sec DESC LIMIT 5`, [s.id])
                .find(row => !isBannedText(row.text));
            if (r) lastLine = { text: r.text, start_sec: Math.floor(r.start_sec) };
        } catch { /* */ }
        return {
            user: c.user, rank: c.rank, ratings: c.ratings, record: c.record, image_url: c.image_url,
            persona: { fighter_name: c.persona.fighter_name, title: c.persona.title, class: c.persona.class, taunt: c.persona.taunt },
            stream: { id: s.id, title: s.title, category: s.category, viewer_count: s.viewer_count || 0, slug: s.slug || null, managed_stream_id: s.managed_stream_id || null, started_at: s.started_at },
            thumbnail_url: thumbs ? (thumbs.getCurrentLiveThumbnailUrl(s.id) || null) : null,
            hot_mic: lastLine,
        };
    }).sort((x, y) => y.ratings.power - x.ratings.power);
    // Pair neighbours on the power ladder so live fights are close ones.
    const matchups = [];
    for (let i = 0; i + 1 < fighters.length; i += 2) matchups.push({ a: fighters[i], b: fighters[i + 1] });
    const odd = fighters.length % 2 ? fighters[fighters.length - 1] : null;
    return { live_count: fighters.length, matchups, waiting: odd };
}

function status() {
    ensureTables();
    const roster = loadRoster();
    const counts = db.get(`SELECT SUM(persona_json IS NOT NULL) AS personas, SUM(image_path IS NOT NULL) AS images, SUM(quotes_json IS NOT NULL) AS quotes FROM arena_profiles`) || {};
    const battles = db.get('SELECT COUNT(*) AS n FROM arena_battles')?.n || 0;
    const votes = db.get('SELECT COUNT(*) AS n FROM arena_votes')?.n || 0;
    const withVoice = roster.order.filter(id => roster.byId[id].raw.voice.has_data).length;
    return {
        enabled: arenaEnabled(),
        ai: aiOn(),
        image_generation: imageGenAvailable(),
        image_model: imageGenAvailable() ? String(setting('ai_image_model', 'gpt-image-1')) : null,
        roster: roster.order.length,
        with_voice_data: withVoice,
        personas: counts.personas || 0,
        quotes: counts.quotes || 0,
        images: counts.images || 0,
        battles, votes,
        active_days: ACTIVE_DAYS,
        rounds: ROUNDS.map(r => r.label),
    };
}

module.exports = {
    ensureTables,
    arenaEnabled,
    aiOn,
    imageGenAvailable,
    loadRoster,
    listFighters,
    getFighter,
    getStatDetail,
    generatePersona,
    generateQuotes,
    generateImage,
    getBattle,
    getMainEvent,
    castVote,
    voterKeyFor,
    getLiveMatchups,
    status,
    STAT_KEYS,
    STAT_META,
    STAT_WEIGHTS,
    ROUNDS,
    ARENA_DIR,
    // pure helpers (tests)
    _computeRatings: computeRatings,
    _simulateRounds: simulateRounds,
    _scoreBattle: scoreBattle,
    _seededRandom: seededRandom,
    _fallbackPersona: fallbackPersona,
    _voiceStatsFor: voiceStatsFor,
    _quoteCandidates: quoteCandidates,
    _isBannedText: isBannedText,
};
