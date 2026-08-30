/**
 * OpenVibe.Live — Arena (roster, ratings, personas, portraits, quotes)
 *
 * The Arena turns the analytics + AI data the site already collects about each streamer
 * into a fighting-game roster. Everything competitive is driven by what streamers SAY on
 * stream and what chat does — see listener.js (the ears), beef.js (streamer vs streamer)
 * and board.js (topics, angles, Trash Levels). This module owns the roster:
 *
 *   stats      → seven 40–99 ratings (HYPE, GRIND, CHAT, LOYALTY, CLUTCH, VIBE, MIC)
 *                computed as percentiles across the active roster, plus an overall POWER
 *                that also carries the Trash Talk bonus (recent XP + beef wins).
 *   persona    → AI "character select" bio, cached 24 h.
 *   quotes     → AI-picked "things they actually said" from the transcripts, VOD-linked.
 *   image      → optional AI character portrait (never a likeness — persona + an
 *                identity-free scene description of the latest thumbnail).
 *
 * Nothing here touches the AI unless AI is enabled and within budget (server/ai/llm.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const llm = require('../ai/llm');

const ARENA_DIR = path.resolve(process.env.ARENA_IMAGE_PATH || './data/arena');
const ACTIVE_DAYS = 45;
const STATS_WINDOW_DAYS = 90;
const PERSONA_TTL_MS = 24 * 60 * 60 * 1000;
const QUOTES_TTL_MS = 24 * 60 * 60 * 1000;
const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATING_MIN = 40;
const MIN_QUOTE_LINES = 20;
const TALK_BONUS_MAX = 12;
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
const HYPE_PATTERNS = ["let's go", 'lets go', 'no way', 'oh my god', 'insane', 'clutch', 'holy', 'gg', 'unreal', 'what the', 'bro', 'chat,', 'chat ', 'yo ', 'welcome', 'lfg', 'poggers', 'pog'];

// ── Behavior line (NOT a vocabulary filter) ────────────────
// This platform does not censor words: offensive, controversial, provocative and taboo
// language — slurs included — is allowed and is never a reason to hide transcript text
// or void an Arena entry. What is filtered is BEHAVIOR, not speech: direct threats of
// violence, incitement to self-harm, sexual content involving minors, and doxxing.
// Matched on a lightly normalised copy (lower-case, leetspeak folded, punctuation
// stripped). Applied before model calls on transcript text and before rendering.
const BANNED_PHRASES = [
    /\bkill\s+(?:your|ur)\s*self\b/i, /\bkys\b/i, /\bgo\s+(?:die|hang\s+yourself|drink\s+bleach)\b/i,
    /\b(?:i'?ll|i will|i'?m gonna|i am going to|gonna|going to|we'?ll|we will)\s+(?:kill|shoot|stab|murder|beat\s+(?:you|him|her|them)\s+to\s+death|find\s+and\s+kill|burn)\s+(?:you|him|her|them|your\s+family|his\s+family|her\s+family)\b/i,
    /\b(?:child|kid|minor|underage|preteen)\s*(?:porn|sex|nude|nudes)\b/i, /\bcp\s+(?:link|links|pics|vid|vids)\b/i, /\b(?:molest|rape)\s+(?:a\s+|that\s+|the\s+)?(?:kid|child|minor|baby)\b/i,
    /\b(?:home|house)\s+address\s+is\s+\d/i, /\b(?:his|her|their|your)\s+(?:real\s+)?(?:home\s+)?(?:address|phone\s+number|social\s+security(?:\s+number)?)\s+is\s+(?:\d|[a-z]+\s+\d)/i, /\bdox+(?:ed|ing|x)?\s+(?:him|her|them|you)\b/i,
];
function normalizeForFilter(text) {
    return String(text || '').toLowerCase()
        .replace(/[1!]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/0/g, 'o').replace(/\$/g, 's')
        .replace(/[^a-z\s']/g, ' ').replace(/\s+/g, ' ');
}
function isBannedText(text) {
    const raw = String(text || '');
    const norm = normalizeForFilter(raw);
    return BANNED_PHRASES.some(re => re.test(raw) || re.test(norm));
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
    for (const col of ['quotes_json TEXT', 'quotes_generated_at DATETIME']) {
        try { db.run(`ALTER TABLE arena_profiles ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    try { fs.mkdirSync(ARENA_DIR, { recursive: true }); } catch { /* */ }
    try { require('./board').ensureTables(); require('./beef').ensureTables(); } catch { /* */ }
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
        SELECT DISTINCT s.user_id FROM streams s JOIN users u ON u.id = s.user_id
        WHERE s.duration_seconds > 0 AND s.started_at >= datetime('now', ?) AND COALESCE(u.is_banned, 0) = 0
    `, [`-${ACTIVE_DAYS} days`]).map(r => r.user_id);
}

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
        covered = db.get(`SELECT COALESCE(SUM(duration_seconds), 0) AS sec FROM streams WHERE user_id = ? AND duration_seconds > 0 AND id IN (SELECT DISTINCT stream_id FROM stream_timeline_events WHERE user_id = ? AND created_at >= datetime('now', ?))`, [userId, userId, win])?.sec || 0;
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
        has_data: hasData, lines: speech.lines || 0, streams_heard: speech.streams_heard || 0,
        speech_minutes: Number((speechSec / 60).toFixed(1)), talk_ratio_pct: Number((talkRatio * 100).toFixed(1)),
        wpm: Number(wpm.toFixed(0)), words: speech.words || 0, exclaims: speech.exclaims || 0, questions: speech.questions || 0,
        hype_hits: speech.hype_hits || 0, hype_per_hour: Number(hypePerHour.toFixed(1)), laughs, laughs_per_hour: Number(laughsPerHour.toFixed(1)),
        top_sounds: topSounds.map(s => ({ label: s.label, n: s.n })),
        voice_score: hasData ? Number((talkRatio * 100 + Math.min(hypePerHour, 60) * 0.5 + Math.min(laughsPerHour, 30) + Math.min(wpm, 200) / 20).toFixed(2)) : 0,
    };
}

function rawStatsFor(userId) {
    const win = `-${STATS_WINDOW_DAYS} days`;
    const agg = db.get(`
        SELECT COUNT(*) AS streams, COALESCE(SUM(s.duration_seconds), 0) / 3600.0 AS hours, COALESCE(MAX(s.peak_viewers), 0) AS peak_viewers,
               COALESCE(AVG(sa.avg_viewers), 0) AS avg_viewers, COALESCE(SUM(sa.total_messages), 0) AS messages, COALESCE(SUM(sa.unique_chatters), 0) AS unique_chatters,
               COALESCE(SUM(sa.total_watch_minutes), 0) AS watch_minutes, COALESCE(SUM(sa.clips_created), 0) AS clips, MAX(s.ended_at) AS last_live_at
        FROM streams s LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
        WHERE s.user_id = ? AND s.duration_seconds > 0 AND s.started_at >= datetime('now', ?)
    `, [userId, win]) || {};
    const allTime = db.get(`SELECT COUNT(*) AS streams, COALESCE(SUM(duration_seconds), 0) / 3600.0 AS hours, COALESCE(MAX(peak_viewers), 0) AS peak_viewers FROM streams WHERE user_id = ? AND duration_seconds > 0`, [userId]) || {};
    const followers = db.get('SELECT COUNT(*) AS n FROM follows WHERE streamer_id = ?', [userId])?.n || 0;
    const tips = db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE to_user_id = ? AND type = 'donation' AND created_at >= datetime('now', ?)`, [userId, win])?.n || 0;
    const category = db.get(`SELECT category, COUNT(*) AS n FROM streams WHERE user_id = ? AND duration_seconds > 0 AND category IS NOT NULL AND category != '' GROUP BY category ORDER BY n DESC LIMIT 1`, [userId])?.category || null;
    const hours = Math.max(Number(agg.hours) || 0, 0.1);
    return {
        window_days: STATS_WINDOW_DAYS, streams: agg.streams || 0, hours: Number((agg.hours || 0).toFixed(1)), peak_viewers: agg.peak_viewers || 0,
        avg_viewers: Number((agg.avg_viewers || 0).toFixed(1)), messages: agg.messages || 0, messages_per_hour: Number((agg.messages / hours).toFixed(1)),
        unique_chatters: agg.unique_chatters || 0, watch_hours: Number(((agg.watch_minutes || 0) / 60).toFixed(1)), clips: agg.clips || 0, tips,
        clutch_per_hour: Number((((agg.clips || 0) * 3 + tips / 100) / hours).toFixed(2)), followers, loyalty_score: followers + (agg.unique_chatters || 0) / 4,
        all_time_hours: Number((allTime.hours || 0).toFixed(1)), all_time_peak: allTime.peak_viewers || 0, all_time_streams: allTime.streams || 0,
        last_live_at: agg.last_live_at || null, category, voice: voiceStatsFor(userId, win),
    };
}

const METRIC_FOR_STAT = {
    hype: (r) => r.peak_viewers, grind: (r) => r.hours, chat: (r) => r.messages_per_hour, loyalty: (r) => r.loyalty_score,
    clutch: (r) => r.clutch_per_hour, vibe: (r) => r.avg_viewers, mic: (r) => (r.voice ? r.voice.voice_score : 0),
};

/** Percentile ratings across a roster: rating = 40 + 59 × percentile; a roster of one is a flat 70. */
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
            else { const below = sorted.filter(x => x < v).length; const equal = sorted.filter(x => x === v).length; pct = (below + (equal - 1) / 2) / (ids.length - 1); }
            out[id][stat] = Math.round(RATING_MIN + (99 - RATING_MIN) * Math.max(0, Math.min(1, pct)));
        });
    }
    for (const id of ids) out[id].power = Math.round(STAT_KEYS.reduce((sum, k) => sum + out[id][k] * STAT_WEIGHTS[k], 0));
    return out;
}

/** Trash Talk bonus on POWER: recent XP (7 days) + beef wins, capped. */
function talkBonus(userId) {
    try {
        const board = require('./board'), beef = require('./beef');
        return Math.min(TALK_BONUS_MAX, Math.round(board.recentXp(userId) / 25) + beef.recentWins(userId) * 3);
    } catch { return 0; }
}

// ── Roster cache ─────────────────────────────────────────────

let _roster = null;
const ROSTER_TTL_MS = 3 * 60 * 1000;

function loadRoster(force = false) {
    if (!force && _roster && Date.now() - _roster.at < ROSTER_TTL_MS) return _roster;
    ensureTables();
    const ids = activeStreamerIds();
    const rawById = {};
    for (const id of ids) rawById[id] = rawStatsFor(id);
    const ratings = computeRatings(rawById);
    const byId = {};
    for (const id of ids) {
        const user = db.getUserById(id);
        if (!user) continue;
        const bonus = talkBonus(id);
        ratings[id].base_power = ratings[id].power;
        ratings[id].talk_bonus = bonus;
        ratings[id].power = Math.min(99 + TALK_BONUS_MAX, ratings[id].power + bonus);
        byId[id] = { user: publicUser(user), raw: rawById[id], ratings: ratings[id] };
        try { db.run('INSERT INTO arena_profiles (user_id, stats_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET stats_json = excluded.stats_json, updated_at = CURRENT_TIMESTAMP', [id, JSON.stringify({ raw: rawById[id], ratings: ratings[id] })]); } catch { /* */ }
    }
    const order = Object.keys(byId).map(Number).sort((a, b) => byId[b].ratings.power - byId[a].ratings.power || a - b);
    _roster = { at: Date.now(), byId, order };
    return _roster;
}

function publicUser(u) {
    return { id: u.id, username: u.username, display_name: u.display_name || u.username, avatar_url: u.avatar_url || null, profile_color: u.profile_color || null, bio: u.bio || '' };
}

// ── Persona (AI) ─────────────────────────────────────────────

function profileRow(userId) { ensureTables(); return db.get('SELECT * FROM arena_profiles WHERE user_id = ?', [userId]) || null; }
function parseJson(text, fallback = null) { if (!text) return fallback; try { return JSON.parse(text); } catch { return fallback; } }
function freshWithin(ts, ttl) { return !!ts && Date.now() - Date.parse(ts + 'Z') < ttl; }
function personaIsFresh(row) { return !!(row && row.persona_json) && freshWithin(row.persona_generated_at, PERSONA_TTL_MS); }
function quotesAreFresh(row) { return !!(row && row.quotes_json) && freshWithin(row.quotes_generated_at, QUOTES_TTL_MS); }

function gatherContext(userId) {
    const ctx = {};
    try { ctx.overview = db.getStreamerOverview(userId)?.overview || null; } catch { /* */ }
    try { ctx.memories = db.all('SELECT description FROM stream_memories WHERE user_id = ? ORDER BY captured_at DESC LIMIT 4', [userId]).map(m => m.description).filter(Boolean); } catch { ctx.memories = []; }
    try {
        const chatAi = db.getChatAiSummary('user', userId, 'rolling');
        if (chatAi) { const ov = parseJson(chatAi.overview, null); ctx.chat_notes = ov ? [ov.alltime, ov.today].filter(Boolean).join(' ') : String(chatAi.overview || ''); }
    } catch { /* */ }
    try { ctx.vods = db.all(`SELECT v.title, va.ai_overview_short AS overview FROM vods v LEFT JOIN vod_ai_state va ON va.vod_id = v.id WHERE v.user_id = ? AND v.is_public = 1 ORDER BY v.created_at DESC LIMIT 5`, [userId]).map(v => ({ title: v.title, overview: v.overview || null })); }
    catch { try { ctx.vods = db.all('SELECT title FROM vods WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [userId]).map(v => ({ title: v.title })); } catch { ctx.vods = []; } }
    try { ctx.titles = db.all('SELECT DISTINCT title FROM streams WHERE user_id = ? AND duration_seconds > 0 ORDER BY started_at DESC LIMIT 8', [userId]).map(r => r.title).filter(Boolean); } catch { ctx.titles = []; }
    try { ctx.said = db.all(`SELECT text FROM stream_timeline_events WHERE user_id = ? AND kind = 'speech' AND LENGTH(text) BETWEEN 30 AND 140 ORDER BY created_at DESC LIMIT 24`, [userId]).map(r => r.text).filter(t => !isBannedText(t)).slice(0, 12); } catch { ctx.said = []; }
    // How they type when they are a chatter themselves (their own chat lines, newest first) — the taunts copy this voice.
    try { ctx.typed = db.all(`SELECT message FROM chat_messages WHERE user_id = ? AND COALESCE(is_deleted, 0) = 0 AND message NOT LIKE '!%' AND LENGTH(message) BETWEEN 6 AND 200 ORDER BY id DESC LIMIT 40`, [userId]).map(r => r.message).filter(t => !isBannedText(t)).slice(0, 20); } catch { ctx.typed = []; }
    try { ctx.chat_rooms = db.all(`SELECT u.username, COUNT(*) AS n FROM chat_messages c JOIN streams s ON s.id = c.stream_id JOIN users u ON u.id = s.user_id WHERE c.user_id = ? AND s.user_id != ? GROUP BY u.username ORDER BY n DESC LIMIT 4`, [userId, userId]).map(r => `${r.username} (${r.n} msgs)`); } catch { ctx.chat_rooms = []; }
    return ctx;
}

const PERSONA_SCHEMA = {
    name: 'arena_persona',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['fighter_name', 'title', 'class', 'element', 'signature_move', 'special', 'weakness', 'taunt', 'taunts', 'typing_style', 'lore', 'catchphrase', 'entrance_music', 'stat_quips'],
        properties: {
            fighter_name: { type: 'string', description: 'Arena ring name, 2–5 words, based on the streamer' },
            title: { type: 'string', description: 'Epithet like "The Midnight Menace of Cozy Corner"' },
            class: { type: 'string', description: 'Fighting-game archetype, e.g. Grappler, Zoner, Rushdown, Summoner, Bard, Tank' },
            element: { type: 'string', description: 'Single word element/vibe' },
            signature_move: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: { type: 'string' }, description: { type: 'string' } } },
            special: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: { type: 'string' }, description: { type: 'string' } } },
            weakness: { type: 'string' }, taunt: { type: 'string', description: 'Their signature ragebait line: one sentence, written EXACTLY the way this person types/talks (their punctuation, caps, slang, emoji habits, typos), aimed at rivals or their chat, designed to make people reply' },
            taunts: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' }, description: 'three more ragebait/troll lines in their own voice: one at a specific rival from the roster, one at their own chat, one about a topic they will not shut up about' },
            typing_style: { type: 'string', description: '≤ 12 words describing how they type/talk (e.g. "all lowercase, no punctuation, calls everyone bud")' },
            lore: { type: 'string', description: '2–3 sentence character-select bio' }, catchphrase: { type: 'string' }, entrance_music: { type: 'string' },
            stat_quips: { type: 'object', additionalProperties: false, required: STAT_KEYS, properties: Object.fromEntries(STAT_KEYS.map(k => [k, { type: 'string', description: `≤ 8 words explaining their ${k} rating in character` }])) },
        },
    },
};
const PERSONA_SYSTEM = `You write fighting-game "character select" bios for a live-streaming site's Arena, where streamers rank each other and talk shit about each other on stream. This is a banter arena: be savage, profane, petty and funny — roast their habits, their chat, their schedule, their takes, their gimmicks, how they talk (transcript lines are provided). Trolling energy is welcome; make it quotable.
TAUNTS ARE THE MOST IMPORTANT PART. They must be RAGEBAIT: provocative, trolly, specific, the kind of line that makes a rival or a chat reply instantly — never generic gamer fluff like "try to keep up". Write every taunt in THIS PERSON'S OWN VOICE: study \`things_they_typed_in_chat\` (how they type as a chatter: caps, punctuation, slang, emoji, typos, pet names) and \`things_they_said_on_stream\`, plus \`ai_overview\` and \`chat_ai_notes\` (what they are known for, their opinions, their beefs, what they will not shut up about) and \`rooms_they_lurk_in\` (whose chat they hang in). Reference real recurring subjects, rivals from the roster and their obsessions. If there is no chat/transcript data, infer a voice from the overview and category and say so in typing_style.
This platform does not censor language — offensive and taboo words are allowed. The only hard line: no direct threats of violence, nothing sexual about minors, no doxxing. Everything is Arena lore, not real-life claims. Output only the JSON.`;

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
        name: entry.user.display_name, handle: entry.user.username, category: entry.raw.category, ratings: stats,
        numbers: { hours_live_90d: entry.raw.hours, peak_viewers_90d: entry.raw.peak_viewers, avg_viewers: entry.raw.avg_viewers, chat_messages_per_hour: entry.raw.messages_per_hour, followers: entry.raw.followers, clips: entry.raw.clips, all_time_hours: entry.raw.all_time_hours, all_time_peak: entry.raw.all_time_peak,
            on_mic: entry.raw.voice.has_data ? { talk_share_pct: entry.raw.voice.talk_ratio_pct, words_per_minute: entry.raw.voice.wpm, hype_words_per_hour: entry.raw.voice.hype_per_hour, laughs_per_hour: entry.raw.voice.laughs_per_hour, stream_sounds: entry.raw.voice.top_sounds.map(s => s.label) } : 'no transcript data yet' },
        ai_overview: ctx.overview, recent_stream_titles: ctx.titles, what_the_camera_saw_recently: ctx.memories, chat_ai_notes: ctx.chat_notes, recent_vods: ctx.vods, things_they_said_on_stream: ctx.said,
        things_they_typed_in_chat: ctx.typed, rooms_they_lurk_in: ctx.chat_rooms,
        roster_rivals: (() => { try { return loadRoster().order.filter(id => id !== userId).slice(0, 8).map(id => { const p = parseJson(profileRow(id)?.persona_json); return `${loadRoster().byId[id].user.username}${p?.fighter_name ? ` (${p.fighter_name})` : ''}`; }); } catch { return []; } })(),
    };
    const r = await llm.complete({ role: 'summary', kind: 'arena_persona', source: 'arena', ownerUserId: userId, system: PERSONA_SYSTEM, user: `Write the Arena persona for this fighter. Facts (JSON):\n${JSON.stringify(facts)}`, json: PERSONA_SCHEMA, maxTokens: 1200, temperature: 0.95, timeoutMs: 30000 });
    const persona = r && r.json && r.json.fighter_name ? r.json : null;
    if (!persona) { console.warn(`[Arena] persona generation failed for user ${userId}`); return row ? parseJson(row.persona_json) : null; }
    db.run(`INSERT INTO arena_profiles (user_id, persona_json, persona_model, persona_generated_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET persona_json = excluded.persona_json, persona_model = excluded.persona_model, persona_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [userId, JSON.stringify(persona), r.model || null]);
    console.log(`[Arena] persona for ${entry.user.username}: "${persona.fighter_name}" (${persona.class})`);
    return persona;
}

function fallbackPersona(entry) {
    const r = entry.ratings || {};
    const best = STAT_KEYS.reduce((a, b) => ((r[b] || 0) > (r[a] || 0) ? b : a), STAT_KEYS[0]);
    const cls = { hype: 'Rushdown', grind: 'Tank', chat: 'Bard', loyalty: 'Summoner', clutch: 'Assassin', vibe: 'Zoner', mic: 'Caster' }[best];
    return {
        fighter_name: entry.user.display_name, title: `The ${STAT_META[best].label} Specialist`, class: cls,
        element: entry.raw.category ? entry.raw.category.replace(/[-_]/g, ' ') : 'Static',
        signature_move: { name: `${STAT_META[best].label} Surge`, description: `Turns ${STAT_META[best].desc} into raw damage.` },
        special: { name: 'Go Live', description: 'Hits the button. The arena fills up.' }, weakness: 'Sleep schedules.', taunt: 'Chat, are you seeing this?',
        lore: `${entry.user.display_name} shows up, streams, and leaves the leaderboard slightly different than they found it.`,
        catchphrase: 'Let him cook.', entrance_music: 'Untitled Loop (feat. Notification Sound)', taunts: [], typing_style: null,
        stat_quips: Object.fromEntries(STAT_KEYS.map(k => [k, STAT_META[k].desc])), _fallback: true,
    };
}

// ── Quotes ───────────────────────────────────────────────────

function quoteCandidates(userId, limit = 90) {
    let rows = [];
    try { rows = db.all(`SELECT id, stream_id, vod_id, start_sec, text FROM stream_timeline_events WHERE user_id = ? AND kind = 'speech' AND created_at >= datetime('now', ?) AND LENGTH(text) BETWEEN 25 AND 220 ORDER BY created_at DESC LIMIT 1500`, [userId, `-${STATS_WINDOW_DAYS} days`]); } catch { rows = []; }
    const score = (t) => { const s = t.toLowerCase(); let n = (t.match(/!/g) || []).length * 2 + (t.match(/\?/g) || []).length; for (const p of HYPE_PATTERNS) if (s.includes(p)) n += 3; if (/\b(i|we|you|chat)\b/.test(s)) n += 1; if (/\b(um+|uh+|like like)\b/.test(s)) n -= 1; return n; };
    const scored = rows.filter(r => !isBannedText(r.text)).map(r => ({ ...r, score: score(r.text) })).sort((x, y) => y.score - x.score);
    const picked = scored.slice(0, Math.ceil(limit / 2));
    const rest = scored.slice(Math.ceil(limit / 2));
    const step = Math.max(1, Math.floor(rest.length / Math.max(1, limit - picked.length)));
    for (let i = 0; i < rest.length && picked.length < limit; i += step) picked.push(rest[i]);
    return picked;
}
const QUOTES_SCHEMA = { name: 'arena_quotes', schema: { type: 'object', additionalProperties: false, required: ['picks', 'walkout', 'voice_verdict', 'mic_style'], properties: { picks: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['index', 'why'], properties: { index: { type: 'integer' }, why: { type: 'string' } } } }, walkout: { type: 'integer' }, voice_verdict: { type: 'string' }, mic_style: { type: 'string' } } } };
const QUOTES_SYSTEM = `You pick the most quotable lines a live-streamer actually said, from raw speech-to-text (expect transcription noise). Choose lines that are funny, savage, unhinged, weirdly profound, or perfect trash talk out of context — swearing and disrespect are a plus. Offensive or taboo language is allowed on this platform and is not a reason to skip a line. Skip only direct threats of violence, anything sexual about minors, doxxing, and lines that are pure transcription garbage. Prefer complete sentences. Return indexes into the list you are given. Output only the JSON.`;
function materializeQuotes(candidates, sel) {
    const pick = (i, why) => { const c = candidates[i]; return c && !isBannedText(c.text) ? { text: c.text, stream_id: c.stream_id, vod_id: c.vod_id, start_sec: Math.max(0, Math.floor(Number(c.start_sec) || 0) - 2), why } : null; };
    const picks = (sel.picks || []).map(p => pick(p.index, p.why)).filter(Boolean);
    return { picks, walkout: pick(sel.walkout, 'walkout line') || picks[0] || null, voice_verdict: sel.voice_verdict || null, mic_style: sel.mic_style || null };
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
            const r = await llm.complete({ role: 'summary', kind: 'arena_quotes', source: 'arena', ownerUserId: userId, system: QUOTES_SYSTEM, user: `Lines (index: text):\n${candidates.map((c, i) => `${i}: ${c.text}`).join('\n')}`, json: QUOTES_SCHEMA, maxTokens: 500, temperature: 0.7, timeoutMs: 30000 });
            if (r && r.json && Array.isArray(r.json.picks)) result = materializeQuotes(candidates, r.json);
        } catch (e) { console.warn('[Arena] quotes:', e.message); }
    }
    if (!result || !result.picks.length) result = materializeQuotes(candidates, { picks: candidates.slice(0, 5).map((c, i) => ({ index: i, why: 'straight from the transcript' })), walkout: 0 });
    if (!aiOn()) result._fallback = true;
    db.run(`INSERT INTO arena_profiles (user_id, quotes_json, quotes_generated_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET quotes_json = excluded.quotes_json, quotes_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [userId, JSON.stringify(result)]);
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
    return fs.existsSync(path.join(ARENA_DIR, base)) ? `/data/arena/${base}` : null;
}
function latestThumbnailFor(userId) {
    try {
        const live = db.get('SELECT id FROM streams WHERE user_id = ? AND is_live = 1 ORDER BY started_at DESC LIMIT 1', [userId]);
        if (live) {
            const thumbs = require('../media-proxy/live-thumbs');
            const url = thumbs.getCurrentLiveThumbnailUrl(live.id);
            if (url) { const local = path.resolve('./data/live-thumbs', path.basename(url)); if (fs.existsSync(local)) return local; return url.startsWith('http') ? url : null; }
        }
    } catch { /* */ }
    try { const v = db.get('SELECT thumbnail_url FROM vods WHERE user_id = ? AND thumbnail_url IS NOT NULL AND is_public = 1 ORDER BY created_at DESC LIMIT 1', [userId]); if (v && /^https?:\/\//i.test(v.thumbnail_url)) return v.thumbnail_url; } catch { /* */ }
    return null;
}
const SCENE_SYSTEM = 'Describe this stream thumbnail as a SCENE for an illustrator in ≤ 60 words: setting, objects, lighting, colours, mood, what activity is happening. Do NOT describe any person\'s face, body, skin, hair, age, gender or identity — refer to a person only as "the host" if at all. Plain text only.';
const _imageInFlight = new Map();
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
        if (thumb) { try { const d = await llm.complete({ role: 'vision', kind: 'arena_scene', source: 'arena', ownerUserId: userId, system: SCENE_SYSTEM, user: 'Describe the scene.', image: thumb, maxTokens: 120, temperature: 0.4, timeoutMs: 30000 }); scene = (d && d.text || '').trim(); } catch { scene = ''; } }
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
        if (/^dall-e/i.test(model)) body.response_format = 'b64_json'; else body.quality = String(setting('ai_image_quality', 'low'));
        const started = Date.now();
        let b64 = null;
        try {
            const res = await fetch(`${p.baseUrl}/images/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error((j.error && (j.error.message || j.error)) || `HTTP ${res.status}`);
            const item = j.data && j.data[0];
            if (item?.b64_json) b64 = item.b64_json;
            else if (item?.url) { const r2 = await fetch(item.url, { signal: AbortSignal.timeout(60000) }); b64 = Buffer.from(await r2.arrayBuffer()).toString('base64'); }
            if (!b64) throw new Error('no image in response');
        } catch (err) {
            console.warn(`[Arena] image generation failed for user ${userId}:`, err.message);
            db.run('INSERT INTO arena_profiles (user_id, image_error, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET image_error = excluded.image_error, updated_at = CURRENT_TIMESTAMP', [userId, err.message.slice(0, 300)]);
            return imageUrlFor(row);
        }
        const file = `u${userId}-${Date.now().toString(36)}.png`;
        fs.writeFileSync(path.join(ARENA_DIR, file), Buffer.from(b64, 'base64'));
        if (row?.image_path) { try { fs.unlinkSync(path.join(ARENA_DIR, path.basename(row.image_path))); } catch { /* */ } }
        db.run(`INSERT INTO arena_profiles (user_id, image_path, image_prompt, image_model, image_generated_at, image_error, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET image_path = excluded.image_path, image_prompt = excluded.image_prompt, image_model = excluded.image_model, image_generated_at = CURRENT_TIMESTAMP, image_error = NULL, updated_at = CURRENT_TIMESTAMP`, [userId, file, prompt, model]);
        try { db.recordAiUsage({ kind: 'arena_image', model, cost_usd: Number(setting('ai_image_cost_usd', 0.011)) || 0, owner_user_id: userId, source: 'arena', role: 'image', provider: 'shared', latency_ms: Date.now() - started }); } catch { /* */ }
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
function isLive(userId) { return !!db.get('SELECT 1 FROM streams WHERE user_id = ? AND is_live = 1 LIMIT 1', [userId]); }

function cardFor(userId, roster, { includeRaw = true, includeQuotes = false } = {}) {
    const entry = roster.byId[userId];
    if (!entry) return null;
    const row = profileRow(userId);
    const persona = parseJson(row?.persona_json) || fallbackPersona(entry);
    const board = require('./board'), beef = require('./beef');
    const card = {
        user: entry.user, rank: roster.order.indexOf(userId) + 1, roster_size: roster.order.length,
        ratings: entry.ratings, stat_meta: STAT_META, raw: includeRaw ? entry.raw : undefined, voice: entry.raw.voice,
        persona, persona_is_fallback: !!persona._fallback, persona_generated_at: row?.persona_generated_at || null,
        image_url: imageUrlFor(row), image_prompt: row?.image_prompt || null, image_model: row?.image_model || null, image_pending: false,
        record: beef.recordFor(userId), level: board.levelView(userId), live: isLive(userId),
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
        if (aiOn() && !imageIsFresh(profileRow(user.id)) && imageGenAvailable()) generateImage(user.id).catch(() => {});
    }
    const card = cardFor(user.id, roster, { includeQuotes: true });
    card.image_pending = !card.image_url && _imageInFlight.has(user.id);
    card.image_generation = imageGenAvailable() ? 'ai' : 'off';
    try { card.beefs = require('./beef').forUser(user.id, 8); } catch { card.beefs = []; }
    try { const t = require('./board').activeTopicFor(user.id); card.active_topic = t ? { id: t.id, text: t.text } : null; } catch { card.active_topic = null; }
    return card;
}

function listFighters() {
    const roster = loadRoster();
    return roster.order.map(id => {
        const c = cardFor(id, roster, { includeRaw: false });
        return {
            user: c.user, rank: c.rank, ratings: c.ratings, record: c.record, live: c.live, image_url: c.image_url, level: { level: c.level.level, xp: c.level.xp },
            persona: { fighter_name: c.persona.fighter_name, title: c.persona.title, class: c.persona.class, element: c.persona.element, taunt: c.persona.taunt, lore: c.persona.lore, signature_move: c.persona.signature_move, stat_quips: c.persona.stat_quips },
            persona_is_fallback: c.persona_is_fallback, category: roster.byId[id].raw.category, last_live_at: roster.byId[id].raw.last_live_at,
            voice: { has_data: c.voice.has_data, talk_ratio_pct: c.voice.talk_ratio_pct, speech_minutes: c.voice.speech_minutes },
        };
    });
}

function getStatDetail(userId, stat) {
    if (!STAT_KEYS.includes(stat)) return null;
    const roster = loadRoster();
    const entry = roster.byId[userId];
    if (!entry) return null;
    const win = `-${STATS_WINDOW_DAYS} days`;
    let series = [];
    try {
        const rows = db.all(`
            SELECT s.id, s.title, s.started_at, s.duration_seconds, s.peak_viewers, sa.avg_viewers, sa.total_messages, sa.unique_chatters, sa.new_followers, sa.clips_created,
                   (SELECT COALESCE(SUM(COALESCE(e.end_sec, e.start_sec + 3) - e.start_sec), 0) FROM stream_timeline_events e WHERE e.stream_id = s.id AND e.kind = 'speech') AS speech_sec
            FROM streams s LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
            WHERE s.user_id = ? AND s.duration_seconds > 0 AND s.started_at >= datetime('now', ?) ORDER BY s.started_at DESC LIMIT 14`, [userId, win]).reverse();
        const per = {
            hype: r => r.peak_viewers || 0, grind: r => Number(((r.duration_seconds || 0) / 3600).toFixed(2)),
            chat: r => Number(((r.total_messages || 0) / Math.max((r.duration_seconds || 0) / 3600, 0.1)).toFixed(1)), loyalty: r => (r.new_followers || 0) + (r.unique_chatters || 0) / 4,
            clutch: r => Number((((r.clips_created || 0) * 3) / Math.max((r.duration_seconds || 0) / 3600, 0.1)).toFixed(2)), vibe: r => Number((r.avg_viewers || 0).toFixed(1)),
            mic: r => (r.duration_seconds ? Number(((r.speech_sec || 0) / r.duration_seconds * 100).toFixed(1)) : 0),
        };
        series = rows.map(r => ({ stream_id: r.id, title: r.title, date: r.started_at, value: per[stat](r) }));
    } catch { series = []; }
    const unit = { hype: 'peak viewers', grind: 'hours', chat: 'msgs / hour', loyalty: 'loyalty points', clutch: 'clutch / hour', vibe: 'avg viewers', mic: '% of stream talking' }[stat];
    const shown = (raw) => (stat === 'mic' ? (raw.voice?.talk_ratio_pct || 0) : (METRIC_FOR_STAT[stat](raw) || 0));
    const ranked = roster.order.map(id => ({ id, value: METRIC_FOR_STAT[stat](roster.byId[id].raw) || 0, shown: shown(roster.byId[id].raw), rating: roster.byId[id].ratings[stat] })).sort((x, y) => y.value - x.value);
    const position = ranked.findIndex(r => r.id === userId) + 1;
    const top = ranked.slice(0, 3).map(r => ({ user: roster.byId[r.id].user, fighter_name: (parseJson(profileRow(r.id)?.persona_json) || fallbackPersona(roster.byId[r.id])).fighter_name, value: Number(Number(r.shown).toFixed(1)), rating: r.rating }));
    return { stat, label: STAT_META[stat].label, desc: STAT_META[stat].desc, unit, rating: entry.ratings[stat], value: Number(Number(shown(entry.raw)).toFixed(1)), position, roster_size: roster.order.length, weight: STAT_WEIGHTS[stat], series, top, voice: stat === 'mic' ? entry.raw.voice : undefined };
}

/** Live fighters with what the transcript last heard — the "on the mic now" strip. */
function liveFighters() {
    const roster = loadRoster();
    let live = [];
    try { live = db.getLiveStreams() || []; } catch { live = []; }
    const byUser = new Map();
    for (const s of live) { if (!roster.byId[s.user_id]) continue; const cur = byUser.get(s.user_id); if (!cur || (s.viewer_count || 0) > (cur.viewer_count || 0)) byUser.set(s.user_id, s); }
    let thumbs = null; try { thumbs = require('../media-proxy/live-thumbs'); } catch { /* */ }
    const board = require('./board'), beef = require('./beef');
    return [...byUser.values()].map(s => {
        const c = cardFor(s.user_id, roster, { includeRaw: false });
        let hotMic = null;
        try { const r = db.all(`SELECT text, start_sec FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND LENGTH(text) > 15 ORDER BY start_sec DESC LIMIT 5`, [s.id]).find(row => !isBannedText(row.text)); if (r) hotMic = { text: r.text, start_sec: Math.floor(r.start_sec) }; } catch { /* */ }
        const transcribed = !!db.get(`SELECT 1 FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND created_at >= datetime('now', '-30 minutes') LIMIT 1`, [s.id]);
        const t = board.activeTopicFor(s.user_id);
        return {
            user: c.user, rank: c.rank, ratings: c.ratings, record: c.record, image_url: c.image_url, level: c.level.level,
            persona: { fighter_name: c.persona.fighter_name, title: c.persona.title, class: c.persona.class, taunt: c.persona.taunt },
            stream: { id: s.id, title: s.title, category: s.category, viewer_count: s.viewer_count || 0, started_at: s.started_at },
            thumbnail_url: thumbs ? (thumbs.getCurrentLiveThumbnailUrl(s.id) || null) : null,
            hot_mic: hotMic, transcribed, active_topic: t ? { id: t.id, text: t.text } : null, open_beefs: beef.openBeefsFor(s.user_id).length,
        };
    }).sort((x, y) => y.ratings.power - x.ratings.power);
}

function voterKeyFor(req) {
    if (req.user && req.user.id) return `user:${req.user.id}`;
    const ip = String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');
    const salt = String(setting('arena_vote_salt', '') || process.env.JWT_SECRET || 'arena');
    return `anon:${crypto.createHash('sha256').update(ip + '|' + salt).digest('hex').slice(0, 24)}`;
}

function status() {
    ensureTables();
    const roster = loadRoster();
    const counts = db.get(`SELECT SUM(persona_json IS NOT NULL) AS personas, SUM(image_path IS NOT NULL) AS images, SUM(quotes_json IS NOT NULL) AS quotes FROM arena_profiles`) || {};
    let beefs = {}, topics = 0;
    try { beefs = db.get(`SELECT SUM(status = 'open') AS open, SUM(status = 'resolved') AS resolved FROM arena_beefs`) || {}; topics = db.get(`SELECT COUNT(*) AS n FROM arena_topics WHERE status = 'open'`)?.n || 0; } catch { /* */ }
    return {
        enabled: arenaEnabled(), ai: aiOn(), image_generation: imageGenAvailable(), image_model: imageGenAvailable() ? String(setting('ai_image_model', 'gpt-image-1')) : null,
        roster: roster.order.length, with_voice_data: roster.order.filter(id => roster.byId[id].raw.voice.has_data).length,
        personas: counts.personas || 0, quotes: counts.quotes || 0, images: counts.images || 0,
        beefs_open: beefs.open || 0, beefs_resolved: beefs.resolved || 0, topics_open: topics, live_fighters: liveFighters().length,
        listener: (() => { try { return require('./listener').TICK_MS; } catch { return null; } })(), active_days: ACTIVE_DAYS,
    };
}

module.exports = {
    ensureTables, arenaEnabled, aiOn, imageGenAvailable, loadRoster, listFighters, getFighter, getStatDetail, liveFighters,
    generatePersona, generateQuotes, generateImage, voterKeyFor, status, publicUser,
    getFighterImageUrl: (userId) => imageUrlFor(profileRow(userId)),
    STAT_KEYS, STAT_META, STAT_WEIGHTS, ARENA_DIR, TALK_BONUS_MAX,
    _computeRatings: computeRatings, _fallbackPersona: fallbackPersona, _voiceStatsFor: voiceStatsFor, _quoteCandidates: quoteCandidates, _isBannedText: isBannedText, _talkBonus: talkBonus,
};
