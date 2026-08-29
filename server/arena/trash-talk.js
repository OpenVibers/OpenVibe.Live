/**
 * OpenVibe.Live — Arena Trash Talk
 *
 * The part of the Arena streamers and viewers play themselves:
 *
 *   topic   → every TOPIC_SLOT_HOURS the Arena posts a topic ("tonight's beef"), AI-written
 *             from what is going on (main event, top of the ladder), with a templated
 *             fallback. Seeded per slot so every server/restart agrees on it.
 *   entry   → a streamer on the roster enters once per topic, either from the LIVE MIC
 *             (we read what they said on stream from the transcription timeline between
 *             "start" and "drop the mic") or by typing it.
 *   judge   → the AI scores Spice / Wit / On-topic / Delivery (0–10 each) with a verdict,
 *             a note and a stamp; slurs / harassment are zeroed and hidden (hard filter
 *             before the model, plus the model's own `flagged`). Heuristic when AI is off.
 *   crowd   → viewers add the fifth score: `!hype` in that streamer's chat (or the Hype
 *             button) — one per person, Crowd = min(10, uniques / 3).
 *   power   → an entry's total (/50) becomes a Trash Talk bonus on POWER (up to
 *             TALK_BONUS_MAX), decaying linearly over TALK_BONUS_DAYS.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/database');
const llm = require('../ai/llm');

const TOPIC_SLOT_HOURS = 6;
const MIC_WINDOW_SEC = 60;          // how long a live-mic session may run
const MIC_GRACE_SEC = 8;            // transcript lag — lines a few seconds after "drop" still count
const TEXT_MAX = 280;
const TALK_BONUS_MAX = 12;
const TALK_BONUS_DAYS = 7;
const HYPE_WINDOW_MS = 24 * 60 * 60 * 1000;   // an entry can be hyped for a day
const STAMPS = [[42, 'COOKED'], [30, 'SOLID'], [18, 'MID'], [0, 'FLOP']];

const FALLBACK_TOPICS = [
    { topic: 'Explain why your chat is the smartest chat on this site. Lie if you must.', hint: 'Bring receipts, or confidence. Confidence is cheaper.', tone: 'brag' },
    { topic: 'Your stream schedule is a lifestyle. Defend it against the calendar.', hint: 'Sleep is for people with fewer viewers.', tone: 'brag' },
    { topic: 'The Main Event has two fighters in it. Tell us why neither is the real champion.', hint: 'Name names. Lovingly.', tone: 'roast' },
    { topic: 'Describe the last thing that went wrong on your stream as if it was a strategic decision.', hint: 'The audio cutting out was a bit. Obviously.', tone: 'spin' },
    { topic: 'Your signature move vs. the #1 fighter\'s. Who taps first?', hint: 'Fighting-game energy. Frame data optional.', tone: 'roast' },
    { topic: 'Sell your stream category to someone who has never heard of it, in one breath.', hint: 'You have the mic. They have their doubts.', tone: 'brag' },
    { topic: 'What does your chat say about you when you step away? Set the record straight.', hint: 'They say worse things. Get ahead of it.', tone: 'spin' },
    { topic: 'Rank the top three fighters and explain why you\'re about to move up.', hint: 'Bonus points for a plan that could not possibly work.', tone: 'roast' },
    { topic: 'Your setup cost more than their setup. Or it cost less and it\'s better. Pick one.', hint: 'Cables count. Cable management counts double.', tone: 'brag' },
    { topic: 'A new streamer just joined the site. Give them the worst possible advice with total confidence.', hint: 'Every word must sound like wisdom.', tone: 'bit' },
    { topic: 'Your entrance music just played. Narrate your walk to the ring.', hint: 'Slow-motion. Pyro. A confused sound guy.', tone: 'bit' },
    { topic: 'Defend the most controversial opinion you have ever said on stream.', hint: 'Keep it PG-13, keep it petty.', tone: 'spin' },
];

// ── Tables ───────────────────────────────────────────────────

let _ready = false;
function ensureTables() {
    if (_ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS arena_talk_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        hint TEXT,
        tone TEXT,
        source TEXT,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_talk (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        stream_id INTEGER,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        vod_id INTEGER,
        start_sec INTEGER,
        scores_json TEXT,
        total REAL DEFAULT 0,
        crowd_uniques INTEGER DEFAULT 0,
        flagged INTEGER DEFAULT 0,
        verdict TEXT,
        note TEXT,
        stamp TEXT,
        judge_model TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        judged_at DATETIME,
        UNIQUE(topic_id, user_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_talk_hype (
        talk_id INTEGER NOT NULL,
        voter_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(talk_id, voter_key)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_talk_user ON arena_talk (user_id, created_at)');
    _ready = true;
}

function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function arena() { return require('./arena-service'); }

// ── Topic ────────────────────────────────────────────────────

function currentSlot(now = Date.now()) {
    const d = new Date(now);
    const slotIndex = Math.floor(d.getUTCHours() / TOPIC_SLOT_HOURS);
    return `${d.toISOString().slice(0, 10)}/${slotIndex}`;
}
function slotEndsAt(slot) {
    const [day, idx] = slot.split('/');
    return new Date(`${day}T00:00:00Z`).getTime() + (Number(idx) + 1) * TOPIC_SLOT_HOURS * 3600 * 1000;
}

function seededIndex(seedText, n) {
    const h = parseInt(crypto.createHash('sha256').update(seedText).digest('hex').slice(0, 8), 16);
    return h % n;
}

const TOPIC_SCHEMA = {
    name: 'arena_talk_topic',
    schema: {
        type: 'object', additionalProperties: false, required: ['topic', 'hint', 'tone'],
        properties: {
            topic: { type: 'string', description: 'One-sentence prompt a streamer answers on the mic, ≤ 140 chars' },
            hint: { type: 'string', description: 'A cheeky one-line tip, ≤ 90 chars' },
            tone: { type: 'string', enum: ['brag', 'roast', 'spin', 'bit'] },
        },
    },
};
const TOPIC_SYSTEM = `You write prompts for a live-streaming site's Trash Talk contest: a streamer answers the prompt out loud on stream, an AI judge scores spice, wit, relevance and delivery, and chat hypes them. Prompts must be answerable in 30 seconds, funny, PG-13, and about streaming life, chat, the fighters on the Arena ladder, or the day's Main Event — never about appearance, identity, health or money. Output only the JSON.`;

async function getTopic({ generate = true } = {}) {
    ensureTables();
    const slot = currentSlot();
    let row = db.get('SELECT * FROM arena_talk_topics WHERE slot = ?', [slot]);
    if (row) return { ...row, ends_at: new Date(slotEndsAt(slot)).toISOString() };
    let topic = null;
    if (generate && aiOn()) {
        try {
            const roster = arena().loadRoster();
            const names = roster.order.slice(0, 5).map(id => {
                const p = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [id])?.persona_json);
                return p?.fighter_name || roster.byId[id].user.display_name;
            });
            let mainEvent = null;
            try { const me = await arena().getMainEvent({ generate: false }); if (me) mainEvent = `${me.a.persona.fighter_name} vs ${me.b.persona.fighter_name}`; } catch { /* */ }
            const r = await llm.complete({
                role: 'summary', kind: 'arena_talk_topic', source: 'arena',
                system: TOPIC_SYSTEM,
                user: JSON.stringify({ slot, top_fighters: names, main_event: mainEvent, previous_topics: db.all('SELECT topic FROM arena_talk_topics ORDER BY id DESC LIMIT 8').map(r => r.topic) }),
                json: TOPIC_SCHEMA, maxTokens: 200, temperature: 1.0, timeoutMs: 20000,
            });
            if (r && r.json && r.json.topic) topic = { ...r.json, source: 'ai' };
        } catch (e) { console.warn('[Arena] talk topic:', e.message); }
    }
    if (!topic) topic = { ...FALLBACK_TOPICS[seededIndex(slot, FALLBACK_TOPICS.length)], source: 'template' };
    try {
        db.run('INSERT OR IGNORE INTO arena_talk_topics (slot, topic, hint, tone, source) VALUES (?, ?, ?, ?, ?)', [slot, topic.topic.slice(0, 200), (topic.hint || '').slice(0, 140), topic.tone || 'brag', topic.source]);
    } catch { /* */ }
    row = db.get('SELECT * FROM arena_talk_topics WHERE slot = ?', [slot]);
    return { ...row, ends_at: new Date(slotEndsAt(slot)).toISOString() };
}

// ── Live mic sessions (in memory — a session is a minute long) ──

const sessions = new Map(); // userId → { streamId, startedAt, streamStartedMs }

function liveStreamFor(userId) {
    return db.get('SELECT id, started_at FROM streams WHERE user_id = ? AND is_live = 1 ORDER BY started_at DESC LIMIT 1', [userId]) || null;
}
function streamOffsetNow(stream) {
    const startedMs = stream?.started_at ? Date.parse(String(stream.started_at).replace(' ', 'T') + 'Z') : Date.now();
    return Math.max(0, (Date.now() - startedMs) / 1000);
}
function micAvailable(userId) {
    const live = liveStreamFor(userId);
    if (!live) return { available: false, reason: 'not_live' };
    const recent = db.get(`SELECT COUNT(*) AS n FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND created_at >= datetime('now', '-15 minutes')`, [live.id])?.n || 0;
    if (!recent) return { available: false, reason: 'no_transcription', stream_id: live.id };
    return { available: true, stream_id: live.id };
}

function startMic(userId) {
    const live = liveStreamFor(userId);
    if (!live) throw new Error('You need to be live for the live mic — type your entry instead');
    const s = { streamId: live.id, startedAt: Date.now(), offsetStart: streamOffsetNow(live) };
    sessions.set(userId, s);
    return { stream_id: live.id, started_at: new Date(s.startedAt).toISOString(), window_sec: MIC_WINDOW_SEC };
}

function micFeed(userId) {
    const s = sessions.get(userId);
    if (!s) return { active: false, lines: [] };
    const elapsed = (Date.now() - s.startedAt) / 1000;
    const rows = db.all(`SELECT text, start_sec FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec >= ? ORDER BY start_sec ASC LIMIT 60`, [s.streamId, Math.floor(s.offsetStart) - 2]);
    return {
        active: true,
        elapsed_sec: Math.round(elapsed),
        remaining_sec: Math.max(0, Math.round(MIC_WINDOW_SEC - elapsed)),
        lines: rows.map(r => ({ text: r.text, at: Math.max(0, Math.round(r.start_sec - s.offsetStart)) })),
    };
}

function collectMic(userId) {
    const s = sessions.get(userId);
    if (!s) throw new Error('No live-mic session — press "I\'m about to cook" first');
    sessions.delete(userId);
    const elapsed = Math.min(MIC_WINDOW_SEC, (Date.now() - s.startedAt) / 1000) + MIC_GRACE_SEC;
    const rows = db.all(`SELECT text, start_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec >= ? AND start_sec <= ? ORDER BY start_sec ASC LIMIT 80`,
        [s.streamId, Math.floor(s.offsetStart) - 2, Math.ceil(s.offsetStart + elapsed)]);
    const text = rows.map(r => String(r.text || '').replace(/^\s*(?:>>|--?)\s*/, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return { text: text.slice(0, 1200), stream_id: s.streamId, vod_id: rows[0]?.vod_id || null, start_sec: rows.length ? Math.max(0, Math.floor(rows[0].start_sec) - 2) : Math.floor(s.offsetStart), lines: rows.length };
}

// ── Judge ────────────────────────────────────────────────────

const JUDGE_SCHEMA = {
    name: 'arena_talk_judgement',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['spice', 'wit', 'on_topic', 'delivery', 'verdict', 'note', 'flagged'],
        properties: {
            spice: { type: 'integer', minimum: 0, maximum: 10, description: 'attitude and bite' },
            wit: { type: 'integer', minimum: 0, maximum: 10, description: 'cleverness, jokes, wordplay' },
            on_topic: { type: 'integer', minimum: 0, maximum: 10, description: 'actually answers the topic' },
            delivery: { type: 'integer', minimum: 0, maximum: 10, description: 'rhythm, quotability, confidence (read as a transcript — forgive filler words)' },
            verdict: { type: 'string', description: 'One-line ring-announcer verdict, ≤ 120 chars' },
            note: { type: 'string', description: "Judge's note: what landed and what to do better, ≤ 160 chars" },
            flagged: { type: 'boolean', description: 'true if it attacks appearance/identity/health/money, threatens, or is hateful — then the entry is void' },
        },
    },
};
const JUDGE_SYSTEM = `You judge a wholesome trash-talk contest between live streamers. Score the entry against the topic. Reward attitude, jokes, specificity about streaming life and the Arena, and lines chat would clip. Punish generic filler and anything cruel. Entries arrive as speech-to-text: forgive "um", repeats and odd punctuation — judge the content. Flag (and it becomes void) anything targeting appearance, body, disability, ethnicity, gender, religion, health or money, or containing threats or hate. Output only the JSON.`;

function heuristicJudge(text, topic) {
    const t = String(text || '');
    const words = t.split(/\s+/).filter(Boolean).length;
    const excl = (t.match(/!/g) || []).length;
    // Stem-ish match so "smartest" in the topic counts "smarter" in the entry.
    const stems = [...new Set((String(topic || '').toLowerCase().match(/[a-z]{4,}/g) || []).map(w => w.slice(0, 5)))].filter(w => !['your', 'this', 'that', 'with', 'what', 'from', 'they', 'them', 'have', 'must', 'about', 'which', 'their'].includes(w));
    const hits = stems.filter(w => t.toLowerCase().includes(w)).length;
    const spice = Math.min(10, 3 + excl + (/\b(you|your|chat|arena|champ|weak|scared|bet)\b/i.test(t) ? 2 : 0));
    const wit = Math.min(10, Math.round(Math.min(words, 60) / 8) + (/\b(like|than|because|but)\b/i.test(t) ? 2 : 0));
    const on_topic = Math.min(10, 2 + hits * 2);
    const delivery = Math.min(10, words < 8 ? 2 : words > 120 ? 5 : 7);
    return { spice, wit, on_topic, delivery, verdict: 'The judge is out — scored on instinct.', note: 'AI judging is off; this is a rough heuristic score.', flagged: false, _fallback: true };
}

function stampFor(total) { return STAMPS.find(([min]) => total >= min)[1]; }
function crowdScore(uniques) { return Math.min(10, Math.round((Number(uniques) || 0) / 3 * 10) / 10); }

async function judge(text, topic, context) {
    const banned = arena()._isBannedText(text);
    let s = null;
    if (!banned && aiOn()) {
        try {
            const r = await llm.complete({
                role: 'chat', kind: 'arena_talk_judge', source: 'arena', ownerUserId: context.userId,
                system: JUDGE_SYSTEM,
                user: JSON.stringify({ topic: topic.topic, tone: topic.tone, fighter: context.fighter, entry: text, source: context.source }),
                json: JUDGE_SCHEMA, maxTokens: 300, temperature: 0.6, timeoutMs: 25000,
            });
            if (r && r.json && typeof r.json.spice === 'number') s = { ...r.json, _model: r.model };
        } catch (e) { console.warn('[Arena] talk judge:', e.message); }
    }
    if (!s) s = heuristicJudge(text, topic.topic);
    if (banned) s = { ...s, spice: 0, wit: 0, on_topic: 0, delivery: 0, flagged: true, verdict: 'Void — that crossed the line.', note: 'Slurs, hate or threats void an entry. Keep it petty, not cruel.' };
    const clamp = (v) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
    return { spice: clamp(s.spice), wit: clamp(s.wit), on_topic: clamp(s.on_topic), delivery: clamp(s.delivery), verdict: String(s.verdict || '').slice(0, 200), note: String(s.note || '').slice(0, 240), flagged: !!s.flagged, model: s._model || null, fallback: !!s._fallback };
}

// ── Entries ──────────────────────────────────────────────────

function totalFor(scores, crowdUniques) {
    if (!scores || scores.flagged) return 0;
    return Number((scores.spice + scores.wit + scores.on_topic + scores.delivery + crowdScore(crowdUniques)).toFixed(1));
}

async function submit(userId, { mode, text }) {
    ensureTables();
    const roster = arena().loadRoster();
    const entry = roster.byId[userId];
    if (!entry) throw new Error('Only fighters on the roster can enter — stream once and come back');
    const topic = await getTopic();
    if (db.get('SELECT id FROM arena_talk WHERE topic_id = ? AND user_id = ?', [topic.id, userId])) throw new Error('You already entered this topic — wait for the next one');
    let source = 'text', streamId = null, vodId = null, startSec = null, body = String(text || '').trim();
    if (mode === 'mic') {
        const c = collectMic(userId);
        if (!c.text || c.lines < 1) throw new Error("The mic didn't catch anything — the transcription needs a few seconds after you speak. Try again, or type it.");
        source = 'mic'; body = c.text; streamId = c.stream_id; vodId = c.vod_id; startSec = c.start_sec;
    } else {
        if (body.length < 12) throw new Error('Say a little more than that');
        body = body.slice(0, TEXT_MAX);
        const live = liveStreamFor(userId); if (live) streamId = live.id;
    }
    const fighter = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [userId])?.persona_json)?.fighter_name || entry.user.display_name;
    const scores = await judge(body, topic, { userId, fighter, source });
    const total = totalFor(scores, 0);
    db.run(`INSERT INTO arena_talk (topic_id, user_id, stream_id, source, text, vod_id, start_sec, scores_json, total, flagged, verdict, note, stamp, judge_model, judged_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [topic.id, userId, streamId, source, body, vodId, startSec, JSON.stringify(scores), total, scores.flagged ? 1 : 0, scores.verdict, scores.note, stampFor(total), scores.model]);
    try { arena().loadRoster(true); } catch { /* */ }
    const row = db.get('SELECT * FROM arena_talk WHERE topic_id = ? AND user_id = ?', [topic.id, userId]);
    console.log(`[Arena] trash talk by user ${userId} (${source}): ${total}/50 ${stampFor(total)}${scores.flagged ? ' FLAGGED' : ''}`);
    return formatEntry(row, roster, { own: true });
}

function hype(talkId, voterKey) {
    ensureTables();
    const row = db.get('SELECT * FROM arena_talk WHERE id = ?', [talkId]);
    if (!row) throw new Error('No such entry');
    if (row.flagged) throw new Error('That entry is void');
    if (Date.now() - Date.parse(row.created_at + 'Z') > HYPE_WINDOW_MS) throw new Error('Hype window closed');
    if (voterKey === `user:${row.user_id}`) throw new Error("You can't hype yourself");
    const ins = db.run('INSERT OR IGNORE INTO arena_talk_hype (talk_id, voter_key) VALUES (?, ?)', [talkId, voterKey]);
    const uniques = db.get('SELECT COUNT(*) AS n FROM arena_talk_hype WHERE talk_id = ?', [talkId])?.n || 0;
    const scores = parseJson(row.scores_json);
    const total = totalFor(scores, uniques);
    db.run('UPDATE arena_talk SET crowd_uniques = ?, total = ?, stamp = ? WHERE id = ?', [uniques, total, stampFor(total), talkId]);
    if (ins.changes) { try { arena().loadRoster(true); } catch { /* */ } }
    return { added: !!ins.changes, crowd_uniques: uniques, crowd: crowdScore(uniques), total, stamp: stampFor(total) };
}

/** Latest hypeable entry by a streamer (for `!hype` in their chat). */
function latestEntryFor(userId) {
    ensureTables();
    return db.get(`SELECT * FROM arena_talk WHERE user_id = ? AND flagged = 0 AND created_at >= datetime('now', '-1 day') ORDER BY id DESC LIMIT 1`, [userId]) || null;
}

function formatEntry(row, roster, { own = false } = {}) {
    const f = roster.byId[row.user_id];
    const persona = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [row.user_id])?.persona_json);
    const scores = parseJson(row.scores_json) || {};
    const flagged = !!row.flagged;
    return {
        id: row.id,
        user: f ? f.user : { id: row.user_id, username: `user${row.user_id}`, display_name: `user${row.user_id}` },
        fighter_name: persona?.fighter_name || f?.user?.display_name || `user${row.user_id}`,
        rank: f ? roster.order.indexOf(row.user_id) + 1 : null,
        source: row.source,
        text: flagged && !own ? null : row.text,
        vod_id: row.vod_id, start_sec: row.start_sec,
        scores: flagged ? null : { spice: scores.spice, wit: scores.wit, on_topic: scores.on_topic, delivery: scores.delivery, crowd: crowdScore(row.crowd_uniques) },
        crowd_uniques: row.crowd_uniques || 0,
        total: row.total || 0,
        stamp: row.stamp,
        verdict: row.verdict, note: own || !flagged ? row.note : null,
        flagged,
        judged_by_ai: !!row.judge_model,
        created_at: row.created_at,
        hype_open: Date.now() - Date.parse(row.created_at + 'Z') <= HYPE_WINDOW_MS,
    };
}

/** POWER bonus per user from entries in the last TALK_BONUS_DAYS, decaying linearly. */
function talkBonuses() {
    ensureTables();
    const rows = db.all(`SELECT user_id, total, created_at FROM arena_talk WHERE flagged = 0 AND created_at >= datetime('now', ?)`, [`-${TALK_BONUS_DAYS} days`]);
    const out = {};
    for (const r of rows) {
        const ageDays = (Date.now() - Date.parse(r.created_at + 'Z')) / 86400000;
        const decay = Math.max(0, 1 - ageDays / TALK_BONUS_DAYS);
        out[r.user_id] = (out[r.user_id] || 0) + (r.total / 50) * TALK_BONUS_MAX * decay;
    }
    for (const id of Object.keys(out)) out[id] = Math.min(TALK_BONUS_MAX, Math.round(out[id]));
    return out;
}

async function board({ userId = null, generate = true } = {}) {
    ensureTables();
    const roster = arena().loadRoster();
    const topic = await getTopic({ generate });
    const entries = db.all('SELECT * FROM arena_talk WHERE topic_id = ? ORDER BY total DESC, id ASC', [topic.id]).map(r => formatEntry(r, roster, { own: r.user_id === userId }));
    const hall = db.all(`SELECT t.*, tp.topic AS topic_text FROM arena_talk t JOIN arena_talk_topics tp ON tp.id = t.topic_id WHERE t.flagged = 0 AND t.created_at >= datetime('now', '-30 days') ORDER BY t.total DESC, t.id ASC LIMIT 10`)
        .map(r => ({ ...formatEntry(r, roster), topic: r.topic_text }));
    const my = userId ? entries.find(e => e.user.id === userId) || null : null;
    const onRoster = !!(userId && roster.byId[userId]);
    return {
        topic, entries, hall_of_trash: hall,
        my_entry: my,
        can_enter: onRoster && !my,
        on_roster: onRoster,
        mic: userId ? micAvailable(userId) : { available: false, reason: 'anon' },
        mic_session: userId && sessions.has(userId) ? micFeed(userId) : null,
        rules: { text_max: TEXT_MAX, mic_window_sec: MIC_WINDOW_SEC, bonus_max: TALK_BONUS_MAX, bonus_days: TALK_BONUS_DAYS, topic_slot_hours: TOPIC_SLOT_HOURS, crowd_per_point: 3 },
        ai: aiOn(),
    };
}

function entriesFor(userId, limit = 6) {
    ensureTables();
    const roster = arena().loadRoster();
    return db.all(`SELECT t.*, tp.topic AS topic_text FROM arena_talk t JOIN arena_talk_topics tp ON tp.id = t.topic_id WHERE t.user_id = ? ORDER BY t.id DESC LIMIT ?`, [userId, limit])
        .map(r => ({ ...formatEntry(r, roster, { own: true }), topic: r.topic_text }));
}

module.exports = {
    ensureTables, getTopic, currentSlot, startMic, micFeed, micAvailable, submit, hype, latestEntryFor, board, entriesFor, talkBonuses,
    TALK_BONUS_MAX, TALK_BONUS_DAYS, TEXT_MAX, MIC_WINDOW_SEC, FALLBACK_TOPICS,
    _judge: judge, _heuristicJudge: heuristicJudge, _totalFor: totalFor, _crowdScore: crowdScore, _stampFor: stampFor, _sessions: sessions,
};
