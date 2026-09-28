/**
 * OpenVibe.Live — Arena (roster, ratings, personas, portraits, quotes) — Battle Cam mode
 *
 * The Arena is PURE MIC. Viewer counts, chat volume, followers, clips and tips do not exist
 * here; the only input is what a streamer says into the microphone (the continuous audio
 * transcription in stream_timeline_events), judged by listener.js and stored by mic.js.
 * This module owns the roster:
 *
 *   roster     → every streamer with transcribed speech in the last ACTIVE_DAYS days.
 *   stats      → seven 40–99 ratings, all from the mic ledger, as percentiles across the
 *                roster: HEAT (how good the shit talk is), AIM (callouts + beef hits per
 *                hour on mic), KILLS (beef wins), MOUTH (share of stream time talking),
 *                CLAPBACK (answering when called out), STAMINA (minutes of speech), PACE
 *                (words per minute) — plus an overall POWER carrying the mouth bonus
 *                (recent XP + beef wins).
 *   persona    → AI "character select" bio written from their TRANSCRIPTS, cached 24 h.
 *   quotes     → AI-picked "things they actually said" from the transcripts, VOD-linked.
 *   image      → a character portrait drawn earlier from their own stream frames (no new ones).
 *
 * Nothing here touches the AI unless AI is enabled and within budget (server/ai/llm.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const llm = require('../ai/llm');

const paths = require('../paths');
const ARENA_DIR = paths.dir('ARENA_IMAGE_PATH', 'arena');
const ACTIVE_DAYS = 45;
const STATS_WINDOW_DAYS = 90;
const PERSONA_TTL_MS = 24 * 60 * 60 * 1000;
const QUOTES_TTL_MS = 24 * 60 * 60 * 1000;
const RATING_MIN = 40;
const MIN_QUOTE_LINES = 20;
const TALK_BONUS_MAX = 12;
const MIC_WINDOW_DAYS = 30;
const STAT_KEYS = ['heat', 'aim', 'kills', 'mouth', 'clapback', 'stamina', 'pace'];
const STAT_META = {
    heat:     { label: 'Heat',     desc: 'how good the shit talk is — average judge score of their mic moments (30d)' },
    aim:      { label: 'Aim',      desc: 'callouts + beef hits per hour on mic (30d)' },
    kills:    { label: 'Kills',    desc: 'beefs won' },
    mouth:    { label: 'Mouth',    desc: 'share of stream time spent talking' },
    clapback: { label: 'Clapback', desc: 'answering when called out — beefs answered on the clock' },
    stamina:  { label: 'Stamina',  desc: 'minutes of speech heard (90d)' },
    pace:     { label: 'Pace',     desc: 'words per minute on mic' },
};
const STAT_WEIGHTS = { heat: 0.22, aim: 0.18, kills: 0.16, mouth: 0.14, clapback: 0.12, stamina: 0.10, pace: 0.08 };
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
    try { require('./mic').ensureTables(); require('./beef').ensureTables(); } catch { /* */ }
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
function imageGenAvailable() { return false; }   // see "Image" below

// ── Raw stats ────────────────────────────────────────────────

/** The roster is whoever has been HEARD: transcribed speech in the last ACTIVE_DAYS days. */
function activeStreamerIds() {
    return db.all(`
        SELECT DISTINCT e.user_id FROM stream_timeline_events e JOIN users u ON u.id = e.user_id
        WHERE e.kind = 'speech' AND e.user_id IS NOT NULL AND e.created_at >= datetime('now', ?) AND COALESCE(u.is_banned, 0) = 0
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

/** Everything the ratings are built from: the transcripts (voice) + the mic ledger (mic). No audience numbers. */
function rawStatsFor(userId) {
    const win = `-${STATS_WINDOW_DAYS} days`;
    const agg = db.get(`SELECT COUNT(*) AS streams, COALESCE(SUM(duration_seconds), 0) / 3600.0 AS hours, MAX(ended_at) AS last_live_at FROM streams WHERE user_id = ? AND duration_seconds > 0 AND started_at >= datetime('now', ?)`, [userId, win]) || {};
    const category = db.get(`SELECT COALESCE(NULLIF(ai_category, ''), category) AS category, COUNT(*) AS n FROM streams WHERE user_id = ? AND duration_seconds > 0 AND COALESCE(NULLIF(ai_category, ''), category) IS NOT NULL AND COALESCE(NULLIF(ai_category, ''), category) != '' GROUP BY 1 ORDER BY n DESC LIMIT 1`, [userId])?.category || null;
    let micStats = {};
    try { micStats = require('./mic').micStats(userId, MIC_WINDOW_DAYS); } catch { micStats = {}; }
    return {
        window_days: STATS_WINDOW_DAYS, mic_window_days: MIC_WINDOW_DAYS, streams: agg.streams || 0, hours: Number((agg.hours || 0).toFixed(1)),
        last_live_at: agg.last_live_at || null, category, voice: voiceStatsFor(userId, win), mic: micStats,
    };
}

const METRIC_FOR_STAT = {
    heat: (r) => (r.mic ? r.mic.avg_quality : 0),
    aim: (r) => (r.mic ? r.mic.hits_per_mic_hour : 0),
    kills: (r) => (r.mic ? r.mic.wins : 0),
    mouth: (r) => (r.voice ? r.voice.talk_ratio_pct : 0),
    clapback: (r) => (r.mic ? r.mic.clapback_rate : 0),
    stamina: (r) => (r.voice ? r.voice.speech_minutes : 0),
    pace: (r) => (r.voice ? r.voice.wpm : 0),
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
        const mic = require('./mic'), beef = require('./beef');
        return Math.min(TALK_BONUS_MAX, Math.round(mic.recentXp(userId) / 25) + beef.recentWins(userId) * 3);
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
    // Pure mic: the voice comes from what they SAY. Their most recent lines, their spiciest judged
    // lines, who they have called out, their beef record and what the camera saw are the facts.
    try { ctx.overview = db.getStreamerOverview(userId)?.overview || null; } catch { /* */ }
    try { ctx.memories = db.all('SELECT description FROM stream_memories WHERE user_id = ? ORDER BY captured_at DESC LIMIT 4', [userId]).map(m => m.description).filter(Boolean); } catch { ctx.memories = []; }
    try { ctx.titles = db.all('SELECT DISTINCT title FROM streams WHERE user_id = ? AND duration_seconds > 0 ORDER BY started_at DESC LIMIT 8', [userId]).map(r => r.title).filter(Boolean); } catch { ctx.titles = []; }
    try { ctx.said = db.all(`SELECT text FROM stream_timeline_events WHERE user_id = ? AND kind = 'speech' AND LENGTH(text) BETWEEN 30 AND 160 ORDER BY created_at DESC LIMIT 60`, [userId]).map(r => r.text).filter(t => !isBannedText(t)).slice(0, 30); } catch { ctx.said = []; }
    try {
        const mic = require('./mic');
        ctx.shit_talk = mic.bestLines(userId, 8).map(m => `${m.text}${m.aimed_at ? ` [at ${m.aimed_at}]` : ''} (${m.quality}/10)`);
        ctx.called_out = db.all(`SELECT target_user_id, COUNT(*) AS n FROM arena_mic_moments WHERE user_id = ? AND target_user_id IS NOT NULL GROUP BY target_user_id ORDER BY n DESC LIMIT 5`, [userId]).map(r => `${mic.nameOf(r.target_user_id)} (${r.n}×)`);
        ctx.called_out_by = db.all(`SELECT user_id, COUNT(*) AS n FROM arena_mic_moments WHERE target_user_id = ? GROUP BY user_id ORDER BY n DESC LIMIT 5`, [userId]).map(r => `${mic.nameOf(r.user_id)} (${r.n}×)`);
        ctx.aimed_at = db.all(`SELECT aimed_at, COUNT(*) AS n FROM arena_mic_moments WHERE user_id = ? AND aimed_at IS NOT NULL AND target_user_id IS NULL GROUP BY aimed_at ORDER BY n DESC LIMIT 6`, [userId]).map(r => `${r.aimed_at} (${r.n}×)`);
    } catch { ctx.shit_talk = []; ctx.called_out = []; ctx.called_out_by = []; ctx.aimed_at = []; }
    try { const q = parseJson(profileRow(userId)?.quotes_json); ctx.quotes = q && Array.isArray(q.picks) ? q.picks.map(p => p.text).slice(0, 6) : []; ctx.mic_style = q?.mic_style || null; } catch { ctx.quotes = []; }
    return ctx;
}


async function generatePersona(userId, { force = false } = {}) {
    ensureTables();
    const row = profileRow(userId);
    if (!force && personaIsFresh(row)) return parseJson(row.persona_json);
    if (!aiOn()) return row ? parseJson(row.persona_json) : null;
    const roster = loadRoster();
    const entry = roster.byId[userId] || { user: publicUser(db.getUserById(userId) || { id: userId, username: `user${userId}` }), raw: rawStatsFor(userId), ratings: null };
    const ctx = gatherContext(userId);
    const stats = entry.ratings || Object.fromEntries(STAT_KEYS.map(k => [k, 70]).concat([['power', 70]]));
    const m = entry.raw.mic || {};
    const facts = {
        name: entry.user.display_name, handle: entry.user.username, category: entry.raw.category, ratings: stats,
        numbers: { hours_live_90d: entry.raw.hours,
            on_mic: entry.raw.voice.has_data ? { talk_share_pct: entry.raw.voice.talk_ratio_pct, words_per_minute: entry.raw.voice.wpm, speech_minutes: entry.raw.voice.speech_minutes, hype_words_per_hour: entry.raw.voice.hype_per_hour, laughs_per_hour: entry.raw.voice.laughs_per_hour, stream_sounds: entry.raw.voice.top_sounds.map(s => s.label) } : 'no transcript data yet',
            shit_talk_30d: { judged_moments: m.moments || 0, average_quality: m.avg_quality || 0, bangers_7_plus: m.bangers || 0, beef_hits: m.beef_hits || 0, beefs_won: m.wins || 0, beefs_lost: m.losses || 0, times_called_out: m.targeted || 0, times_answered: m.answered || 0 } },
        ai_overview: ctx.overview, recent_stream_titles: ctx.titles, what_the_camera_saw_recently: ctx.memories, things_they_said_on_stream: ctx.said,
        their_best_shit_talk: ctx.shit_talk || [], who_they_call_out: ctx.called_out || [], who_calls_them_out: ctx.called_out_by || [], what_they_rant_at: ctx.aimed_at || [], quotes: ctx.quotes || [], mic_style: ctx.mic_style || null,
        roster_rivals: (() => { try { return loadRoster().order.filter(id => id !== userId).slice(0, 8).map(id => { const p = parseJson(profileRow(id)?.persona_json); return `${loadRoster().byId[id].user.username}${p?.fighter_name ? ` (${p.fighter_name})` : ''}`; }); } catch { return []; } })(),
    };
    // The bio's rules and shape are OpenVibe.AI's versioned template live.arena.persona (WS-O task 2); Live sends the facts.
    const persona = await require('../ai/ai-service').structured('live.arena.persona', { facts }, { meter: { kind: 'arena_persona', role: 'summary', ownerUserId: userId, source: 'arena' } });
    if (!persona) { console.warn(`[Arena] persona generation failed for user ${userId}`); return row ? parseJson(row.persona_json) : null; }
    db.run(`INSERT INTO arena_profiles (user_id, persona_json, persona_model, persona_generated_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET persona_json = excluded.persona_json, persona_model = excluded.persona_model, persona_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [userId, JSON.stringify(persona), 'openvibe-ai:live.arena.persona']);
    console.log(`[Arena] persona for ${entry.user.username}: "${persona.fighter_name}" (${persona.class})`);
    return persona;
}

function fallbackPersona(entry) {
    const r = entry.ratings || {};
    const best = STAT_KEYS.reduce((a, b) => ((r[b] || 0) > (r[a] || 0) ? b : a), STAT_KEYS[0]);
    const cls = { heat: 'Rushdown', aim: 'Sniper', kills: 'Assassin', mouth: 'Caster', clapback: 'Counter', stamina: 'Tank', pace: 'Zoner' }[best];
    return {
        fighter_name: entry.user.display_name, title: `The ${STAT_META[best].label} Specialist`, class: cls,
        element: entry.raw.category ? entry.raw.category.replace(/[-_]/g, ' ') : 'Static',
        signature_move: { name: `${STAT_META[best].label} Surge`, description: `Turns ${STAT_META[best].desc} into raw damage.` },
        special: { name: 'Hot Mic', description: 'Forgets the mic is on. That is the move.' }, weakness: 'Dead air.', taunt: 'Say my name on stream and see what happens.',
        lore: `${entry.user.display_name} shows up, talks, and leaves the ladder slightly different than they found it.`,
        catchphrase: 'Let him cook.', entrance_music: 'Untitled Loop (feat. Notification Sound)', taunts: [], typing_style: null, spoken_as: [], custom_stats: [],
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
            // The picking rules are OpenVibe.AI's versioned template live.arena.quotes (WS-O task 2); Live sends the lines.
            const sel = await require('../ai/ai-service').structured('live.arena.quotes', { lines: candidates.map(c => String(c.text).slice(0, 400)).slice(0, 120) }, { meter: { kind: 'arena_quotes', role: 'summary', ownerUserId: userId, source: 'arena' } });
            if (sel && Array.isArray(sel.picks)) result = materializeQuotes(candidates, sel);
        } catch (e) { console.warn('[Arena] quotes:', e.message); }
    }
    if (!result || !result.picks.length) result = materializeQuotes(candidates, { picks: candidates.slice(0, 5).map((c, i) => ({ index: i, why: 'straight from the transcript' })), walkout: 0 });
    if (!aiOn()) result._fallback = true;
    db.run(`INSERT INTO arena_profiles (user_id, quotes_json, quotes_generated_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET quotes_json = excluded.quotes_json, quotes_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [userId, JSON.stringify(result)]);
    return result;
}

// ── Image ────────────────────────────────────────────────────
// Portraits drawn earlier stay on the cards; no new ones are drawn. They came from the site's image
// provider called with the shared key, and Live calls no model provider itself any more (roadmap
// WS-O task 2); OpenVibe.AI has no image workflow yet.

function imageUrlFor(row) {
    if (!row || !row.image_path) return null;
    const base = path.basename(row.image_path);
    return fs.existsSync(path.join(ARENA_DIR, base)) ? `/data/arena/${base}` : null;
}
async function generateImage(userId) {
    ensureTables();
    return imageUrlFor(profileRow(userId));
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
    const mic = require('./mic'), beef = require('./beef');
    const card = {
        user: entry.user, rank: roster.order.indexOf(userId) + 1, roster_size: roster.order.length,
        ratings: entry.ratings, stat_meta: STAT_META, raw: includeRaw ? entry.raw : undefined, voice: entry.raw.voice, mic: entry.raw.mic || null,
        persona, persona_is_fallback: !!persona._fallback, persona_generated_at: row?.persona_generated_at || null,
        image_url: imageUrlFor(row), image_prompt: row?.image_prompt || null, image_model: row?.image_model || null, image_pending: false,
        record: beef.recordFor(userId), level: mic.levelView(userId), live: isLive(userId),
    };
    if (includeQuotes) card.quotes = parseJson(row?.quotes_json) || null;
    return card;
}

async function getFighter(usernameOrId, { generate = true } = {}) {
    const user = resolveUser(usernameOrId);
    if (!user) return null;
    const roster = loadRoster();
    if (!roster.byId[user.id]) return { user: publicUser(user), not_on_roster: true, reason: `nothing heard on mic in the last ${ACTIVE_DAYS} days — the Arena only knows what the transcription hears` };
    // Battle Cam: no persona / portrait / quote generation on view — the page shows only what
    // was said on mic (mic.js). `generate` is kept for the admin refresh route.
    if (generate === 'force') {
        try { await generatePersona(user.id); } catch (e) { console.warn('[Arena] persona:', e.message); }
    }
    const card = cardFor(user.id, roster, { includeQuotes: true });
    card.image_pending = false;
    card.image_generation = imageGenAvailable() ? 'ai' : 'off';
    try { card.beefs = require('./beef').forUser(user.id, 8); } catch { card.beefs = []; }
    return card;
}

function listFighters() {
    const roster = loadRoster();
    return roster.order.map(id => {
        const c = cardFor(id, roster, { includeRaw: false });
        return {
            user: c.user, rank: c.rank, ratings: c.ratings, record: c.record, live: c.live, image_url: c.image_url, level: { level: c.level.level, xp: c.level.xp }, mic: c.mic,
            persona: { fighter_name: c.persona.fighter_name, title: c.persona.title, class: c.persona.class, element: c.persona.element, taunt: c.persona.taunt, taunts: c.persona.taunts || [], typing_style: c.persona.typing_style || null, lore: c.persona.lore, signature_move: c.persona.signature_move, stat_quips: c.persona.stat_quips, custom_stats: Array.isArray(c.persona.custom_stats) ? c.persona.custom_stats : [] },
            persona_is_fallback: c.persona_is_fallback, category: roster.byId[id].raw.category, last_live_at: roster.byId[id].raw.last_live_at,
            voice: { has_data: c.voice.has_data, talk_ratio_pct: c.voice.talk_ratio_pct, speech_minutes: c.voice.speech_minutes, wpm: c.voice.wpm },
            last_line: (() => { try { const m = require('./mic').latestFor(id); return m ? { text: m.text, quality: m.quality, aimed_at: m.aimed_at, target: m.target, at: m.at, vod_id: m.vod_id, sec: m.sec } : null; } catch { return null; } })(),
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
        // One point per stream in the window — every value comes from the transcript / mic ledger of that stream.
        const rows = db.all(`
            SELECT s.id, s.title, s.started_at, s.duration_seconds,
                   (SELECT COALESCE(SUM(COALESCE(e.end_sec, e.start_sec + 3) - e.start_sec), 0) FROM stream_timeline_events e WHERE e.stream_id = s.id AND e.kind = 'speech') AS speech_sec,
                   (SELECT COALESCE(SUM(LENGTH(e.text) - LENGTH(REPLACE(e.text, ' ', '')) + 1), 0) FROM stream_timeline_events e WHERE e.stream_id = s.id AND e.kind = 'speech') AS words,
                   (SELECT COUNT(*) FROM arena_mic_moments m WHERE m.stream_id = s.id) AS moments,
                   (SELECT COALESCE(AVG(m.quality), 0) FROM arena_mic_moments m WHERE m.stream_id = s.id) AS avg_q,
                   (SELECT COUNT(*) FROM arena_mic_moments m WHERE m.stream_id = s.id AND m.kind = 'beef_hit') AS hits,
                   (SELECT COUNT(*) FROM arena_beefs b WHERE b.winner_user_id = s.user_id AND b.resolved_at BETWEEN s.started_at AND COALESCE(s.ended_at, s.started_at)) AS wins
            FROM streams s
            WHERE s.user_id = ? AND s.duration_seconds > 0 AND s.started_at >= datetime('now', ?) ORDER BY s.started_at DESC LIMIT 14`, [userId, win]).reverse();
        const per = {
            heat: r => Number((r.avg_q || 0).toFixed(1)),
            aim: r => Number(((r.moments || 0) / Math.max((r.speech_sec || 0) / 3600, 0.05)).toFixed(2)),
            kills: r => r.wins || 0,
            mouth: r => (r.duration_seconds ? Number(((r.speech_sec || 0) / r.duration_seconds * 100).toFixed(1)) : 0),
            clapback: r => r.hits || 0,
            stamina: r => Number(((r.speech_sec || 0) / 60).toFixed(1)),
            pace: r => Number(((r.words || 0) / Math.max((r.speech_sec || 0) / 60, 0.1)).toFixed(0)),
        };
        series = rows.map(r => ({ stream_id: r.id, title: r.title, date: r.started_at, value: per[stat](r) }));
    } catch { series = []; }
    const unit = { heat: 'avg judge score', aim: 'hits / mic hour', kills: 'beefs won', mouth: '% of stream talking', clapback: 'answer rate', stamina: 'minutes of speech', pace: 'words / minute' }[stat];
    const shown = (raw) => (METRIC_FOR_STAT[stat](raw) || 0);
    const ranked = roster.order.map(id => ({ id, value: METRIC_FOR_STAT[stat](roster.byId[id].raw) || 0, shown: shown(roster.byId[id].raw), rating: roster.byId[id].ratings[stat] })).sort((x, y) => y.value - x.value);
    const position = ranked.findIndex(r => r.id === userId) + 1;
    const top = ranked.slice(0, 3).map(r => ({ user: roster.byId[r.id].user, fighter_name: (parseJson(profileRow(r.id)?.persona_json) || fallbackPersona(roster.byId[r.id])).fighter_name, value: Number(Number(r.shown).toFixed(1)), rating: r.rating }));
    return { stat, label: STAT_META[stat].label, desc: STAT_META[stat].desc, unit, rating: entry.ratings[stat], value: Number(Number(shown(entry.raw)).toFixed(2)), position, roster_size: roster.order.length, weight: STAT_WEIGHTS[stat], series, top, voice: ['mouth', 'stamina', 'pace'].includes(stat) ? entry.raw.voice : undefined, mic: entry.raw.mic };
}

/** Live fighters with what the transcript last heard — the "on the mic now" strip. */
function liveFighters() {
    const roster = loadRoster();
    let live = [];
    try { live = db.getLiveStreams() || []; } catch { live = []; }
    const byUser = new Map();
    for (const s of live) { if (!roster.byId[s.user_id]) continue; const cur = byUser.get(s.user_id); if (!cur || (s.viewer_count || 0) > (cur.viewer_count || 0)) byUser.set(s.user_id, s); }
    let thumbs = null; try { thumbs = require('../media-proxy/live-thumbs'); } catch { /* */ }
    const mic = require('./mic'), beef = require('./beef');
    let listener = null; try { listener = require('./listener'); } catch { /* */ }
    return [...byUser.values()].map(s => {
        const c = cardFor(s.user_id, roster, { includeRaw: false });
        let hotMic = null;
        try { const r = db.all(`SELECT text, start_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND LENGTH(text) > 15 ORDER BY start_sec DESC LIMIT 5`, [s.id]).find(row => !isBannedText(row.text)); if (r) hotMic = { text: r.text, start_sec: Math.floor(r.start_sec), vod_id: r.vod_id || null }; } catch { /* */ }
        const transcribed = !!db.get(`SELECT 1 FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND created_at >= datetime('now', '-30 minutes') LIMIT 1`, [s.id]);
        let ears = null; try { const cs = listener ? listener.consoleState(s.user_id) : null; if (cs && cs.listening) ears = { focus: cs.focus ? { target_id: cs.focus.target_id, target: cs.focus.target, hits: cs.focus.hits, lock_seconds_left: cs.focus.lock_seconds_left } : null, pending_words: cs.pending_mic_words + (cs.focus ? cs.focus.pending_words : 0) }; } catch { ears = null; }
        let lastMoment = null; try { lastMoment = mic.latestFor(s.user_id); } catch { lastMoment = null; }
        return {
            user: c.user, rank: c.rank, ratings: c.ratings, record: c.record, image_url: c.image_url, level: c.level.level,
            persona: { fighter_name: c.persona.fighter_name, title: c.persona.title, class: c.persona.class, taunt: c.persona.taunt },
            stream: { id: s.id, title: s.title, category: s.category, viewer_count: s.viewer_count || 0, started_at: s.started_at, slug: s.managed_stream_slug || null, managed_stream_id: s.managed_stream_id || null },
            thumbnail_url: thumbs ? (thumbs.getCurrentLiveThumbnailUrl(s.id) || null) : null,
            hot_mic: hotMic, transcribed, ears, last_moment: lastMoment, open_beefs: beef.openBeefsFor(s.user_id).length,
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
    let beefs = {}, moments = 0;
    try { beefs = db.get(`SELECT SUM(status = 'open') AS open, SUM(status = 'resolved') AS resolved FROM arena_beefs`) || {}; moments = db.get(`SELECT COUNT(*) AS n FROM arena_mic_moments WHERE created_at >= datetime('now', '-1 day')`)?.n || 0; } catch { /* */ }
    return {
        mode: 'battle-cam', enabled: arenaEnabled(), ai: aiOn(), image_generation: imageGenAvailable(), image_model: null,
        roster: roster.order.length, with_voice_data: roster.order.filter(id => roster.byId[id].raw.voice.has_data).length,
        personas: counts.personas || 0, quotes: counts.quotes || 0, images: counts.images || 0,
        beefs_open: beefs.open || 0, beefs_resolved: beefs.resolved || 0, mic_moments_24h: moments, live_fighters: liveFighters().length,
        listener: (() => { try { return require('./listener').TICK_MS; } catch { return null; } })(), active_days: ACTIVE_DAYS,
    };
}

module.exports = {
    ensureTables, arenaEnabled, aiOn, imageGenAvailable, loadRoster, listFighters, getFighter, getStatDetail, liveFighters,
    generatePersona, generateQuotes, generateImage, voterKeyFor, status, publicUser,
    getFighterImageUrl: (userId) => imageUrlFor(profileRow(userId)),
    STAT_KEYS, STAT_META, STAT_WEIGHTS, ARENA_DIR, TALK_BONUS_MAX, ACTIVE_DAYS, MIC_WINDOW_DAYS,
    _computeRatings: computeRatings, _fallbackPersona: fallbackPersona, _voiceStatsFor: voiceStatsFor, _quoteCandidates: quoteCandidates, _isBannedText: isBannedText, _talkBonus: talkBonus,
};
