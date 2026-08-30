/**
 * chatters.js — Yapper profiles: XP, levels, titles, streaks and an AI "yap card" for EVERYONE who
 * chats — signed-in OpenVibe users, anonymous viewers (anon<N>) and chat relayed from other
 * platforms ([Twitch] bob, [Kick] bob, [RS] bob) — keyed by one polymorphic chatter key:
 *
 *   user:<users.id>            anon:<N>            relay:<platform>:<username lowercased>
 *
 * XP comes from the board (no extra AI calls): a chat line that lands as a moment on a subject,
 * more when the subject is HOT, a bonus the first time you touch a subject, starting a subject,
 * being quoted in a subject's lore, hyping, and a daily streak of showing up. Levels use the same
 * curve as the game (1 + floor(sqrt(xp / 25))). OpenVibe accounts get site-wide OpenCoins on every
 * level-up (idempotent per level, through the network wallet); anon/relay chatters get the level,
 * the title and the card — the coins need an account.
 *
 * The yap card (title, blurb, catchphrase, "known for") is written by the AI from the chat AI's
 * existing profile of the chatter (chat_ai_summaries: user / anon / relay scopes) + their moments —
 * only for level ≥ CARD_MIN_LEVEL, at most once a day per chatter, a few per housekeeping tick.
 */
'use strict';

const db = require('../db/database');
const llm = require('../ai/llm');

const XP_MOMENT = 3;
const XP_MOMENT_HOT = 6;
const XP_FIRST_ON_SUBJECT = 4;
const XP_SUBJECT_STARTED = 15;
const XP_QUOTED_IN_LORE = 10;
const XP_HYPE = 1;
const XP_STREAK_DAY = 5;            // × min(streak, 7)
const COINS_PER_LEVEL = 10;         // OpenCoins on level-up = level × this (accounts only)
const CARD_MIN_LEVEL = 3;
const CARD_TTL_MS = 24 * 3600_000;
const CARD_BATCH = 4;

const TITLES = [[1, 'Lurker'], [2, 'Chatter'], [3, 'Yapper'], [5, 'Instigator'], [7, 'Ragebaiter'], [9, 'Menace'], [12, 'Main Character'], [15, 'Community Consciousness'], [20, 'Final Boss']];

let _ready = false;
function ensureTables() {
    if (_ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS chatter_profiles (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,              -- 'user' | 'anon' | 'relay'
        user_id INTEGER,
        platform TEXT,
        display_name TEXT,
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        moments INTEGER DEFAULT 0,
        subjects INTEGER DEFAULT 0,
        subjects_started INTEGER DEFAULT 0,
        quoted INTEGER DEFAULT 0,
        hypes INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 0,
        best_streak INTEGER DEFAULT 0,
        last_day TEXT,
        best_line TEXT,
        best_line_topic_id INTEGER,
        card_json TEXT,
        card_at DATETIME,
        card_xp INTEGER DEFAULT 0,
        coins_paid_level INTEGER DEFAULT 0,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS chatter_xp_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_chatter_xp_key ON chatter_xp_log (key, created_at)');
    db.run(`CREATE TABLE IF NOT EXISTS chatter_subjects (
        key TEXT NOT NULL,
        topic_id INTEGER NOT NULL,
        moments INTEGER DEFAULT 0,
        first_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (key, topic_id)
    )`);
    _ready = true;
}

function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function clip(t, n) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, n); }
function levelFor(xp) { return 1 + Math.floor(Math.sqrt(Math.max(0, Number(xp) || 0) / 25)); }
function xpForLevel(level) { return Math.max(0, (level - 1) ** 2 * 25); }
function titleFor(level) { let t = TITLES[0][1]; for (const [l, name] of TITLES) if (level >= l) t = name; return t; }
function today() { return new Date().toISOString().slice(0, 10); }

// ── Keys ─────────────────────────────────────────────────────

const RELAY_LABELS = { twitch: 'twitch', kick: 'kick', yt: 'youtube', youtube: 'youtube', rs: 'rs', robotstreamer: 'rs' };
/** The chatter key for a chat_messages-shaped row / moment: { user_id, username, anon_id, source_platform }. */
function keyFor(m) {
    if (!m) return null;
    if (m.user_id) return `user:${m.user_id}`;
    const uname = String(m.username || '');
    const relay = uname.match(/^\[([A-Za-z]+)\]\s+(.+)$/);
    if (relay && (m.source_platform || RELAY_LABELS[relay[1].toLowerCase()])) return `relay:${(m.source_platform || RELAY_LABELS[relay[1].toLowerCase()] || relay[1]).toLowerCase()}:${relay[2].trim().toLowerCase()}`;
    const anon = String(m.anon_id || (/^anon\d+$/i.test(uname) ? uname : '')).match(/^anon(\d+)$/i);
    if (anon) return `anon:${anon[1]}`;
    if (uname) return `name:${uname.toLowerCase()}`;
    return null;
}
function parseKey(key) {
    const [kind, ...rest] = String(key || '').split(':');
    if (kind === 'user') return { kind, user_id: Number(rest[0]) };
    if (kind === 'anon') return { kind, anon_num: Number(rest[0]), anon_id: `anon${rest[0]}` };
    if (kind === 'relay') return { kind, platform: rest[0], username: rest.slice(1).join(':') };
    if (kind === 'name') return { kind, username: rest.join(':') };
    return null;
}
function displayFor(key, fallback = null) {
    const p = parseKey(key);
    if (!p) return fallback || 'someone';
    if (p.kind === 'user') { const u = db.getUserById(p.user_id); return u ? (u.display_name || u.username) : (fallback || `user${p.user_id}`); }
    if (p.kind === 'anon') return fallback || p.anon_id;
    if (p.kind === 'relay') return fallback || `[${p.platform}] ${p.username}`;
    return fallback || p.username;
}

// ── XP ───────────────────────────────────────────────────────

function row(key) { ensureTables(); return db.get('SELECT * FROM chatter_profiles WHERE key = ?', [key]) || null; }
function ensureRow(key, { display = null } = {}) {
    const p = parseKey(key);
    if (!p) return null;
    const existing = row(key);
    if (existing) { if (display && display !== existing.display_name) db.run('UPDATE chatter_profiles SET display_name = ? WHERE key = ?', [clip(display, 60), key]); return existing; }
    db.run('INSERT OR IGNORE INTO chatter_profiles (key, kind, user_id, platform, display_name) VALUES (?, ?, ?, ?, ?)', [key, p.kind, p.kind === 'user' ? p.user_id : null, p.kind === 'relay' ? p.platform : null, clip(display || displayFor(key), 60)]);
    return row(key);
}

/** Add XP; handles level-ups (coins for accounts, an announcement in the room when a streamId is given). */
function addXp(key, amount, reason, refId = null, { display = null, streamId = null } = {}) {
    ensureTables();
    amount = Math.round(Number(amount) || 0);
    const before = ensureRow(key, { display });
    if (!before || amount <= 0) return { leveled_up: false, level: before ? before.level : 1, gained: 0 };
    const xp = (before.xp || 0) + amount;
    const level = levelFor(xp);
    db.run('UPDATE chatter_profiles SET xp = ?, level = ?, last_seen = CURRENT_TIMESTAMP WHERE key = ?', [xp, level, key]);
    db.run('INSERT INTO chatter_xp_log (key, amount, reason, ref_id) VALUES (?, ?, ?, ?)', [key, amount, reason, refId]);
    const leveled = level > (before.level || 1);
    if (leveled) onLevelUp(key, before.level || 1, level, { streamId });
    return { leveled_up: leveled, level, xp, gained: amount, title: titleFor(level) };
}

function onLevelUp(key, from, to, { streamId = null } = {}) {
    const p = parseKey(key);
    const name = displayFor(key);
    console.log(`[Arena] yapper ${name} (${key}) → level ${to} ${titleFor(to)}`);
    // Site-wide OpenCoins for OpenVibe accounts — one payout per level, idempotent in the wallet.
    if (p && p.kind === 'user') {
        try {
            const r = row(key);
            const paidTo = r?.coins_paid_level || 0;
            let total = 0;
            for (let l = Math.max(paidTo + 1, from + 1); l <= to; l++) total += l * COINS_PER_LEVEL;
            if (total > 0) payCoins(key, p.user_id, name, total, to);
        } catch (e) { console.warn('[Arena] yap coins:', e.message); }
    }
    // Tell the room.
    try {
        const chat = require('../chat/chat-server');
        const line = `⬆️ ${name} hit Yap Level ${to} — ${titleFor(to)}${p && p.kind === 'user' ? ` (+${to * COINS_PER_LEVEL} OpenCoins)` : ''}. Keep talking. ${(() => { try { const c = require('../config'); return `${String(c.baseUrl || '').replace(/\/$/, '')}/arena/chatter/${encodeURIComponent(key)}`; } catch { return ''; } })()}`;
        if (streamId && chat.broadcastToStream) chat.broadcastToStream(streamId, { type: 'system', message: line });
    } catch { /* chat server not up in tests */ }
}

/** A chat line landed as a moment on a subject. */
/** Credit level-up coins; only marked paid once the wallet confirms (idempotent per level, so retries are safe). */
function payCoins(key, userId, name, total, level) {
    try {
        const opencoins = require('../monetization/opencoins');
        return Promise.resolve(opencoins.credit(userId, total, 'arena_yap_level', `live:arena_yap_level:${userId}:${level}`, { level })).then(res => {
            if (res) { db.run('UPDATE chatter_profiles SET coins_paid_level = ? WHERE key = ?', [level, key]); console.log(`[Arena] ${name}: +${total} OpenCoins for reaching yap level ${level}`); }
            return !!res;
        }).catch(e => { console.warn('[Arena] yap coins:', e.message); return false; });
    } catch (e) { console.warn('[Arena] yap coins:', e.message); return Promise.resolve(false); }
}
/** Housekeeping: retry unpaid level-ups (wallet down, account linked later). A few per call. */
async function settleCoins(max = 5) {
    ensureTables();
    let n = 0;
    for (const r of db.all(`SELECT key, user_id, display_name, level, coins_paid_level FROM chatter_profiles WHERE kind = 'user' AND user_id IS NOT NULL AND level > coins_paid_level ORDER BY last_seen DESC LIMIT ?`, [max])) {
        let total = 0; for (let l = (r.coins_paid_level || 0) + 1; l <= r.level; l++) total += l * COINS_PER_LEVEL;
        if (total > 0 && await payCoins(r.key, r.user_id, r.display_name || r.key, total, r.level)) n++;
    }
    return n;
}

function onMoment(moment, topic, { hot = false } = {}) {
    if (!moment || moment.kind !== 'chat') return null;
    const key = moment.chatter_key || keyFor(moment);
    if (!key) return null;
    ensureRow(key, { display: moment.username });
    const first = !db.get('SELECT 1 FROM chatter_subjects WHERE key = ? AND topic_id = ?', [key, topic.id]);
    db.run(`INSERT INTO chatter_subjects (key, topic_id, moments) VALUES (?, ?, 1) ON CONFLICT(key, topic_id) DO UPDATE SET moments = moments + 1, last_at = CURRENT_TIMESTAMP`, [key, topic.id]);
    let xp = hot ? XP_MOMENT_HOT : XP_MOMENT;
    if (first) xp += XP_FIRST_ON_SUBJECT;
    xp += streakBonus(key);
    db.run(`UPDATE chatter_profiles SET moments = moments + 1, subjects = (SELECT COUNT(*) FROM chatter_subjects s WHERE s.key = chatter_profiles.key), best_line = CASE WHEN best_line IS NULL OR LENGTH(?) > LENGTH(best_line) THEN ? ELSE best_line END, best_line_topic_id = CASE WHEN best_line IS NULL OR LENGTH(?) > LENGTH(best_line) THEN ? ELSE best_line_topic_id END WHERE key = ?`,
        [moment.text, clip(moment.text, 200), moment.text, topic.id, key]);
    return addXp(key, xp, first ? 'moment_first' : 'moment', topic.id, { display: moment.username, streamId: moment.stream_id || null });
}

/** Daily streak: the first moment of a day extends the streak (or restarts it) and pays a bonus. */
function streakBonus(key) {
    const r = row(key);
    const d = today();
    if (!r || r.last_day === d) return 0;
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const streak = r.last_day === yesterday ? (r.streak || 0) + 1 : 1;
    db.run('UPDATE chatter_profiles SET streak = ?, best_streak = MAX(best_streak, ?), last_day = ? WHERE key = ?', [streak, streak, d, key]);
    return XP_STREAK_DAY * Math.min(streak, 7);
}

function onSubjectStarted(key, topicId, { display = null } = {}) {
    if (!key) return null;
    db.run('UPDATE chatter_profiles SET subjects_started = subjects_started + 1 WHERE key = ?', [key]);
    return addXp(key, XP_SUBJECT_STARTED, 'subject_started', topicId, { display });
}
function onHype(voterKey, topicId) {
    // voter keys from the API are user:<id> / anon:<anonId> / ip:<…>; only user/anon map to a chatter.
    const m = String(voterKey || '').match(/^(user:\d+|anon:\d+)$/);
    if (!m) return null;
    db.run('UPDATE chatter_profiles SET hypes = hypes + 1 WHERE key = ?', [m[1]]);
    return addXp(m[1], XP_HYPE, 'hype', topicId);
}
/** After a lore rewrite: every chatter whose name appears in the lore text gets quoted-XP (once per rewrite). */
function onLore(topic, loreText, moments) {
    const text = String(loreText || '').toLowerCase();
    if (!text) return 0;
    const seen = new Set();
    let n = 0;
    for (const m of moments || []) {
        if (m.kind !== 'chat') continue;
        const key = m.chatter_key || keyFor(m);
        if (!key || seen.has(key)) continue;
        const name = String(m.username || '').replace(/^\[[^\]]+\]\s+/, '').toLowerCase();
        if (name.length >= 3 && text.includes(name)) { seen.add(key); db.run('UPDATE chatter_profiles SET quoted = quoted + 1 WHERE key = ?', [key]); addXp(key, XP_QUOTED_IN_LORE, 'quoted_in_lore', topic.id, { display: m.username }); n++; }
    }
    return n;
}

// ── Yap card (AI, cheap and rare) ────────────────────────────

const CARD_SCHEMA = { name: 'arena_yap_card', schema: { type: 'object', additionalProperties: false, required: ['title', 'blurb', 'catchphrase', 'known_for', 'archetype'], properties: {
    title: { type: 'string', description: 'a ridiculous 2–5 word title for this chatter based on what they actually do in chat' },
    blurb: { type: 'string', description: '2–3 sentences, tabloid voice, dumb-funny, about who they are in chat: their bits, grudges, subjects, timing' },
    catchphrase: { type: 'string', description: 'one line in THEIR typing style (casing, punctuation, slang) they would actually send' },
    known_for: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' }, description: '≤ 6 words each' },
    archetype: { type: 'string', description: 'one of: instigator, hype man, lore keeper, contrarian, one-liner, spammer, moralist, lurker-turned-menace, brand ambassador, glazer' },
} } };
const CARD_SYSTEM = `You write the "yap card" for a chatter on a live-streaming site — a trading-card style profile of who they are IN CHAT. You get the chat AI's notes about them (overview, long-term memory, timeline), their best lines that landed on the community board, the subjects they pile onto, and their streak. Be specific and funny; take the piss; this platform does not censor language. Copy their typing style for the catchphrase. Hard line: no direct threats of violence, nothing sexual about minors, no doxxing. Output only the JSON.`;

function chatAiFor(key) {
    const p = parseKey(key);
    try {
        if (p.kind === 'user') return db.getChatAiSummary('user', p.user_id, 'rolling');
        if (p.kind === 'anon') return db.getChatAiSummary('anon', p.anon_num, 'rolling');
        if (p.kind === 'relay') { const ru = db.getRelayUser ? db.getRelayUser(p.platform, p.username) : null; return ru ? db.getChatAiSummary('relay', ru.id, 'rolling') : null; }
    } catch { /* */ }
    return null;
}

async function buildCard(key, { force = false } = {}) {
    const r = row(key);
    if (!r) return null;
    if (!force) {
        if (r.level < CARD_MIN_LEVEL) return { skipped: 'level' };
        if (r.card_json && r.card_at && Date.now() - Date.parse(r.card_at + 'Z') < CARD_TTL_MS) return { skipped: 'fresh' };
        if (r.card_json && (r.xp - (r.card_xp || 0)) < 25) return { skipped: 'no change' };
    }
    if (!aiOn()) return { skipped: 'ai off' };
    const ai = chatAiFor(key);
    const ov = ai ? parseJson(ai.overview, null) : null;
    const lines = db.all(`SELECT m.text, t.text AS subject FROM arena_topic_moments m JOIN arena_topics t ON t.id = m.topic_id WHERE m.chatter_key = ? AND m.kind = 'chat' ORDER BY m.id DESC LIMIT 12`, [key]);
    const subjects = db.all('SELECT t.text, s.moments FROM chatter_subjects s JOIN arena_topics t ON t.id = s.topic_id WHERE s.key = ? ORDER BY s.moments DESC LIMIT 6', [key]);
    let out = null;
    try {
        const res = await llm.complete({ role: 'chat', kind: 'arena_yap_card', source: 'arena', ownerUserId: r.user_id || null, system: CARD_SYSTEM, json: CARD_SCHEMA, maxTokens: 320, temperature: 0.95, timeoutMs: 25000,
            user: JSON.stringify({ name: r.display_name, kind: r.kind, level: r.level, title: titleFor(r.level), streak: r.streak, chat_ai_overview: ov ? clip([ov.alltime, ov.today].filter(Boolean).join(' '), 900) : (ai ? clip(ai.overview, 900) : null), chat_ai_memory: ai ? clip(ai.memory_json, 700) : null, chat_ai_timeline: ai ? (parseJson(ai.timeline_json, []) || []).slice(-8).map(e => clip(typeof e === 'string' ? e : `${e.label || ''}: ${e.detail || ''}`, 140)) : [], best_lines: lines.map(l => `[${l.subject}] ${l.text}`), subjects: subjects.map(s => `${s.text} (${s.moments})`) }) });
        if (res && res.json && res.json.title) out = res.json;
    } catch (e) { console.warn('[Arena] yap card:', e.message); }
    if (!out) return { skipped: 'failed' };
    db.run('UPDATE chatter_profiles SET card_json = ?, card_at = CURRENT_TIMESTAMP, card_xp = xp WHERE key = ?', [JSON.stringify(out), key]);
    console.log(`[Arena] yap card for ${r.display_name}: "${out.title}"`);
    return out;
}

async function cardSweep(max = CARD_BATCH) {
    ensureTables();
    if (!aiOn()) return 0;
    const due = db.all(`SELECT key FROM chatter_profiles WHERE level >= ? AND (card_json IS NULL OR card_at IS NULL OR card_at < datetime('now', '-24 hours')) AND (card_json IS NULL OR xp - card_xp >= 25) ORDER BY xp DESC LIMIT ?`, [CARD_MIN_LEVEL, max]);
    let n = 0;
    for (const d of due) { try { const r = await buildCard(d.key); if (r && !r.skipped) n++; } catch { /* */ } }
    return n;
}

// ── Views ────────────────────────────────────────────────────

function view(r, { detail = false } = {}) {
    if (!r) return null;
    const level = r.level || levelFor(r.xp);
    const nextXp = xpForLevel(level + 1), curXp = xpForLevel(level);
    const p = parseKey(r.key) || {};
    const user = p.kind === 'user' ? db.getUserById(p.user_id) : null;
    const out = {
        key: r.key, kind: r.kind, platform: r.platform || null, name: r.display_name || displayFor(r.key),
        user: user ? { id: user.id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url, profile_color: user.profile_color } : null,
        level, title: titleFor(level), xp: r.xp || 0, xp_into_level: (r.xp || 0) - curXp, xp_for_next: nextXp - curXp, next_level_xp: nextXp,
        moments: r.moments || 0, subjects: r.subjects || 0, subjects_started: r.subjects_started || 0, quoted: r.quoted || 0, hypes: r.hypes || 0,
        streak: r.last_day === today() || r.last_day === new Date(Date.now() - 86400_000).toISOString().slice(0, 10) ? (r.streak || 0) : 0, best_streak: r.best_streak || 0,
        best_line: r.best_line ? { text: r.best_line, topic_id: r.best_line_topic_id } : null,
        card: parseJson(r.card_json, null), card_at: r.card_at, coins: p.kind === 'user', first_seen: r.first_seen, last_seen: r.last_seen,
        titles: TITLES.map(([l, t]) => ({ level: l, title: t, xp: xpForLevel(l) })),
    };
    if (detail) {
        out.recent_moments = db.all(`SELECT m.*, t.text AS subject, t.headline AS subject_headline FROM arena_topic_moments m JOIN arena_topics t ON t.id = m.topic_id WHERE m.chatter_key = ? ORDER BY m.id DESC LIMIT 40`, [r.key]).map(m => ({ id: m.id, topic_id: m.topic_id, subject: m.subject, subject_headline: m.subject_headline, text: m.text, at: m.created_at, stream_id: m.stream_id }));
        out.top_subjects = db.all('SELECT t.id, t.text, t.headline, t.status, s.moments FROM chatter_subjects s JOIN arena_topics t ON t.id = s.topic_id WHERE s.key = ? ORDER BY s.moments DESC LIMIT 8', [r.key]);
        out.xp_log = db.all('SELECT amount, reason, ref_id, created_at FROM chatter_xp_log WHERE key = ? ORDER BY id DESC LIMIT 30', [r.key]);
        const ai = chatAiFor(r.key);
        if (ai) { const ov = parseJson(ai.overview, null); out.chat_ai = { overview: ov ? (ov.today || ov.alltime) : clip(ai.overview, 600), memory: clip(ai.memory_json, 500) }; }
        out.rank = (db.get('SELECT COUNT(*) AS n FROM chatter_profiles WHERE xp > ?', [r.xp || 0])?.n || 0) + 1;
    }
    return out;
}
function profile(key) { ensureTables(); return view(row(key), { detail: true }); }
function leaderboard(limit = 10, { days = null } = {}) {
    ensureTables();
    if (days) {
        const rows = db.all(`SELECT key, SUM(amount) AS gained FROM chatter_xp_log WHERE created_at >= datetime('now', ?) GROUP BY key ORDER BY gained DESC LIMIT ?`, [`-${days} days`, limit]);
        return rows.map(x => ({ ...view(row(x.key)), gained: x.gained }));
    }
    return db.all('SELECT * FROM chatter_profiles WHERE xp > 0 ORDER BY xp DESC LIMIT ?', [limit]).map(r => view(r));
}
function count() { ensureTables(); return db.get('SELECT COUNT(*) AS n FROM chatter_profiles WHERE xp > 0')?.n || 0; }

module.exports = { ensureTables, settleCoins, payCoins, keyFor, parseKey, displayFor, levelFor, xpForLevel, titleFor, addXp, onMoment, onSubjectStarted, onHype, onLore, buildCard, cardSweep, profile, leaderboard, count, view, row, TITLES, XP_MOMENT, XP_MOMENT_HOT, XP_FIRST_ON_SUBJECT, XP_SUBJECT_STARTED, XP_QUOTED_IN_LORE, COINS_PER_LEVEL, CARD_MIN_LEVEL };
