/**
 * OpenVibe.Live — Arena Trash Talk SESSIONS (live, continuous, transcription-driven)
 *
 * A streamer who is live with the timeline transcription running starts a session. From
 * then on, every TICK_MS the session reads the new speech lines off the transcript,
 * buffers them against the CURRENT TOPIC, and — once enough new words have arrived —
 * asks the judge whether that chunk was trash talk on the topic and how good it was.
 *
 *   progress  → each judged chunk adds `progress_gain` (0–60) to the topic; at 100 the
 *               topic is CLEARED: it becomes a regular Trash Talk entry (so it counts for
 *               the POWER bonus and the Hall of Trash) and the NEXT topic is generated,
 *               shaped by what they have already cleared. Talk enough → the topic changes.
 *   xp/level  → every judged chunk adds XP (quality × trash-talkiness); levels every
 *               XP_PER_LEVEL. Viewers add XP + progress with `!hype` (one per person per
 *               topic).
 *   about     → each chunk also yields a ≤ 10-word "what they talked about" tag, so the
 *               page shows what kind of trash was talked during the session.
 *
 * Everything is visible live at /arena/talk/<username> (public) and polled every few
 * seconds; the streamer sees the same console with start / skip / stop controls.
 * Sessions end when the stream ends, after IDLE_END_MIN minutes without speech, or at
 * MAX_SESSION_HOURS. AI use is bounded: one judge call per ≥ JUDGE_MIN_INTERVAL_MS and
 * ≥ JUDGE_MIN_WORDS new words, a few hundred per session at most.
 */
'use strict';

const db = require('../db/database');
const llm = require('../ai/llm');

const TICK_MS = 15 * 1000;
const JUDGE_MIN_INTERVAL_MS = 30 * 1000;
const JUDGE_MIN_WORDS = 25;
const JUDGE_MAX_CALLS = 300;
const IDLE_END_MIN = 20;
const MAX_SESSION_HOURS = 3;
const XP_PER_LEVEL = 40;
const HYPE_XP = 2;
const HYPE_PROGRESS = 4;
const CHUNK_MAX_CHARS = 1400;

let _ready = false;
function ensureTables() {
    if (_ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS arena_talk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        stream_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'live',
        level INTEGER DEFAULT 1,
        xp INTEGER DEFAULT 0,
        topics_cleared INTEGER DEFAULT 0,
        lines_seen INTEGER DEFAULT 0,
        words_seen INTEGER DEFAULT 0,
        judge_calls INTEGER DEFAULT 0,
        last_offset_sec REAL DEFAULT 0,
        offset_start_sec REAL DEFAULT 0,
        last_judge_at DATETIME,
        last_speech_at DATETIME,
        about_json TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        end_reason TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_talk_session_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        topic TEXT NOT NULL,
        hint TEXT,
        tone TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        progress REAL DEFAULT 0,
        score REAL DEFAULT 0,
        chunks INTEGER DEFAULT 0,
        best_line TEXT,
        best_line_score REAL DEFAULT 0,
        best_line_sec INTEGER,
        best_vod_id INTEGER,
        pending_json TEXT,
        judged_json TEXT,
        entry_id INTEGER,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        cleared_at DATETIME
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_talk_session_hype (
        topic_id INTEGER NOT NULL,
        voter_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(topic_id, voter_key)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_talk_sessions_live ON arena_talk_sessions (status, user_id)');
    _ready = true;
}

function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function arena() { return require('./arena-service'); }
function talk() { return require('./trash-talk'); }
function levelFor(xp) { return 1 + Math.floor((Number(xp) || 0) / XP_PER_LEVEL); }
function words(t) { return String(t || '').split(/\s+/).filter(Boolean).length; }

// ── Lookups ──────────────────────────────────────────────────

function liveSessionFor(userId) {
    ensureTables();
    return db.get(`SELECT * FROM arena_talk_sessions WHERE user_id = ? AND status = 'live' ORDER BY id DESC LIMIT 1`, [userId]) || null;
}
function activeTopic(sessionId) {
    return db.get(`SELECT * FROM arena_talk_session_topics WHERE session_id = ? AND status = 'active' ORDER BY idx DESC LIMIT 1`, [sessionId]) || null;
}
function liveSessions() {
    ensureTables();
    return db.all(`SELECT * FROM arena_talk_sessions WHERE status = 'live'`);
}

// ── Topics for a session ─────────────────────────────────────

const TOPIC_SCHEMA = {
    name: 'arena_session_topic',
    schema: { type: 'object', additionalProperties: false, required: ['topic', 'hint', 'tone'], properties: { topic: { type: 'string' }, hint: { type: 'string' }, tone: { type: 'string', enum: ['brag', 'roast', 'spin', 'bit'] } } },
};
const TOPIC_SYSTEM = `You feed topics to a live-streamer who is trash-talking on stream in real time, one topic at a time. Each topic must be answerable in 30–60 seconds of talking, funny, PG-13, and about streaming life, their chat, the Arena ladder, their category, or the day's Main Event — never appearance, identity, health or money. Vary tone and angle from the topics they already cleared. Output only the JSON.`;

async function nextTopic(session, idx) {
    const cleared = db.all('SELECT topic FROM arena_talk_session_topics WHERE session_id = ? ORDER BY idx ASC', [session.id]).map(r => r.topic);
    let t = null;
    if (aiOn()) {
        try {
            const roster = arena().loadRoster();
            const me = roster.byId[session.user_id];
            const persona = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [session.user_id])?.persona_json);
            const rivals = roster.order.filter(id => id !== session.user_id).slice(0, 4).map(id => (parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [id])?.persona_json) || {}).fighter_name || roster.byId[id].user.display_name);
            const r = await llm.complete({
                role: 'summary', kind: 'arena_session_topic', source: 'arena', ownerUserId: session.user_id,
                system: TOPIC_SYSTEM,
                user: JSON.stringify({ fighter: persona?.fighter_name || me?.user?.display_name, category: me?.raw?.category, rank: roster.order.indexOf(session.user_id) + 1, rivals, already_cleared: cleared, topic_number: idx + 1 }),
                json: TOPIC_SCHEMA, maxTokens: 200, temperature: 1.05, timeoutMs: 20000,
            });
            if (r && r.json && r.json.topic) t = r.json;
        } catch (e) { console.warn('[Arena] session topic:', e.message); }
    }
    if (!t) {
        const pool = talk().FALLBACK_TOPICS || [];
        const seed = (session.id * 7 + idx * 13) % Math.max(1, pool.length);
        t = pool[seed] || { topic: 'Talk your talk. Anything goes, PG-13.', hint: 'Chat is listening.', tone: 'bit' };
    }
    db.run('INSERT INTO arena_talk_session_topics (session_id, idx, topic, hint, tone) VALUES (?, ?, ?, ?, ?)', [session.id, idx, String(t.topic).slice(0, 200), String(t.hint || '').slice(0, 140), t.tone || 'bit']);
    return activeTopic(session.id);
}

// ── Lifecycle ────────────────────────────────────────────────

async function startSession(userId) {
    ensureTables();
    const existing = liveSessionFor(userId);
    if (existing) return existing;
    const roster = arena().loadRoster();
    if (!roster.byId[userId]) throw new Error('Only fighters on the roster can run a session — stream once and come back');
    const mic = talk().micAvailable(userId);
    if (!mic.available) throw new Error(mic.reason === 'not_live' ? 'Go live first — sessions run off your live transcription' : 'You are live, but no transcription has come through yet. Talk for a few seconds and try again.');
    const stream = db.get('SELECT id, started_at FROM streams WHERE id = ?', [mic.stream_id]);
    const startedMs = stream?.started_at ? Date.parse(String(stream.started_at).replace(' ', 'T') + 'Z') : Date.now();
    const offset = Math.max(0, (Date.now() - startedMs) / 1000);
    db.run(`INSERT INTO arena_talk_sessions (user_id, stream_id, last_offset_sec, offset_start_sec, last_speech_at, about_json) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, '[]')`, [userId, mic.stream_id, offset, offset]);
    const session = liveSessionFor(userId);
    await nextTopic(session, 0);
    console.log(`[Arena] trash-talk session ${session.id} started for user ${userId} on stream ${mic.stream_id}`);
    return session;
}

function endSession(session, reason = 'stopped') {
    db.run(`UPDATE arena_talk_sessions SET status = 'ended', ended_at = CURRENT_TIMESTAMP, end_reason = ? WHERE id = ? AND status = 'live'`, [reason, session.id]);
    db.run(`UPDATE arena_talk_session_topics SET status = 'skipped' WHERE session_id = ? AND status = 'active'`, [session.id]);
    console.log(`[Arena] trash-talk session ${session.id} ended (${reason})`);
}

function stopSession(userId) {
    const s = liveSessionFor(userId);
    if (!s) throw new Error('No live session');
    endSession(s, 'stopped');
    return db.get('SELECT * FROM arena_talk_sessions WHERE id = ?', [s.id]);
}

async function skipTopic(userId) {
    const s = liveSessionFor(userId);
    if (!s) throw new Error('No live session');
    const t = activeTopic(s.id);
    if (t) db.run(`UPDATE arena_talk_session_topics SET status = 'skipped' WHERE id = ?`, [t.id]);
    return nextTopic(s, (t ? t.idx : -1) + 1);
}

// ── Judge (chunk mode) ───────────────────────────────────────

const CHUNK_SCHEMA = {
    name: 'arena_session_chunk',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['is_trash_talk', 'spice', 'wit', 'on_topic', 'delivery', 'progress_gain', 'best_line', 'about', 'flagged'],
        properties: {
            is_trash_talk: { type: 'boolean', description: 'true if a meaningful part of this chunk is trash talk / bragging / roasting aimed at the topic' },
            spice: { type: 'integer', minimum: 0, maximum: 10 },
            wit: { type: 'integer', minimum: 0, maximum: 10 },
            on_topic: { type: 'integer', minimum: 0, maximum: 10 },
            delivery: { type: 'integer', minimum: 0, maximum: 10 },
            progress_gain: { type: 'integer', minimum: 0, maximum: 60, description: 'how much of the topic this chunk covered: 0 = not about it, 60 = nailed it completely' },
            best_line: { type: 'string', description: 'the single best line, copied VERBATIM from the chunk (empty if none)' },
            about: { type: 'string', description: '≤ 10 words: what they were actually talking about in this chunk' },
            flagged: { type: 'boolean', description: 'slurs / hate / threats / attacks on appearance, identity, health or money' },
        },
    },
};
const CHUNK_SYSTEM = `You judge a LIVE trash-talk session. You get the current topic and the newest ~60 seconds of a streamer's speech-to-text. Decide whether they were trash-talking (bragging, roasting, hyping themselves, calling people out — in good fun) ON that topic, score it, say how much of the topic they covered, pick the best verbatim line, and summarise what they talked about in ≤ 10 words. Ordinary gameplay chatter, silence or off-topic talk → is_trash_talk false, low progress. Forgive transcription noise. Flag cruelty (appearance, identity, health, money, threats, hate). Output only the JSON.`;

function heuristicChunk(text, topic) {
    const h = talk()._heuristicJudge(text, topic.topic);
    const trash = h.spice >= 5 || /\b(chat|champ|bet|weak|scared|better|best|nobody|clown|cook|ratio)\b/i.test(text);
    const lines = String(text).split(/(?<=[.!?])\s+/).filter(l => l.length > 12);
    const best = lines.sort((a, b) => (b.match(/[!?]/g) || []).length - (a.match(/[!?]/g) || []).length)[0] || '';
    return { is_trash_talk: trash, spice: h.spice, wit: h.wit, on_topic: h.on_topic, delivery: h.delivery, progress_gain: trash ? Math.min(60, 10 + h.on_topic * 4) : Math.min(15, h.on_topic * 2), best_line: best.slice(0, 200), about: text.split(/\s+/).slice(0, 8).join(' '), flagged: false, _fallback: true };
}

async function judgeChunk(session, topic, text) {
    if (arena()._isBannedText(text)) return { is_trash_talk: false, spice: 0, wit: 0, on_topic: 0, delivery: 0, progress_gain: 0, best_line: '', about: 'crossed the line — voided', flagged: true };
    let s = null;
    if (aiOn()) {
        try {
            const r = await llm.complete({
                role: 'chat', kind: 'arena_session_judge', source: 'arena', ownerUserId: session.user_id,
                system: CHUNK_SYSTEM,
                user: JSON.stringify({ topic: topic.topic, hint: topic.hint, tone: topic.tone, progress_so_far: Math.round(topic.progress), speech: text }),
                json: CHUNK_SCHEMA, maxTokens: 260, temperature: 0.5, timeoutMs: 25000,
            });
            if (r && r.json && typeof r.json.spice === 'number') s = r.json;
        } catch (e) { console.warn('[Arena] session judge:', e.message); }
    }
    if (!s) s = heuristicChunk(text, topic);
    const c = (v, max = 10) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    return { is_trash_talk: !!s.is_trash_talk && !s.flagged, spice: c(s.spice), wit: c(s.wit), on_topic: c(s.on_topic), delivery: c(s.delivery), progress_gain: s.flagged ? 0 : c(s.progress_gain, 60), best_line: String(s.best_line || '').slice(0, 220), about: String(s.about || '').slice(0, 80), flagged: !!s.flagged, fallback: !!s._fallback };
}

// ── Tick ─────────────────────────────────────────────────────

async function clearTopic(session, topic) {
    const judged = parseJson(topic.judged_json, []);
    const hits = judged.filter(j => j.is_trash_talk);
    const avg = (k) => hits.length ? hits.reduce((a, j) => a + j[k], 0) / hits.length : 0;
    const scores = { spice: Math.round(avg('spice')), wit: Math.round(avg('wit')), on_topic: Math.round(avg('on_topic')), delivery: Math.round(avg('delivery')), verdict: `Cleared live on stream — ${hits.length} chunk${hits.length === 1 ? '' : 's'} of trash talk`, note: `Best line: “${topic.best_line || '—'}”`, flagged: false };
    const text = (hits.map(j => j.best_line).filter(Boolean).join(' … ') || topic.best_line || '').slice(0, 400) || 'Cleared on the live mic.';
    let entryId = null;
    try {
        const t = talk();
        const topicRow = await t.getTopic({ generate: false });
        // Session clears live outside the 6-hour slot topic, so they are stored against their
        // own topic text (in the note) but under the current slot id for the board.
        const total = t._totalFor(scores, 0);
        db.run(`INSERT INTO arena_talk (topic_id, user_id, stream_id, source, text, vod_id, start_sec, scores_json, total, flagged, verdict, note, stamp, judge_model, judged_at)
                VALUES (?, ?, ?, 'session', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(topic_id, user_id) DO UPDATE SET text = CASE WHEN excluded.total > arena_talk.total THEN excluded.text ELSE arena_talk.text END,
                    scores_json = CASE WHEN excluded.total > arena_talk.total THEN excluded.scores_json ELSE arena_talk.scores_json END,
                    total = MAX(arena_talk.total, excluded.total), stamp = CASE WHEN excluded.total > arena_talk.total THEN excluded.stamp ELSE arena_talk.stamp END,
                    verdict = excluded.verdict, note = excluded.note, source = 'session', vod_id = COALESCE(excluded.vod_id, arena_talk.vod_id), start_sec = COALESCE(excluded.start_sec, arena_talk.start_sec)`,
            [topicRow.id, session.user_id, session.stream_id, text, topic.best_vod_id, topic.best_line_sec, JSON.stringify(scores), total, scores.verdict, `${topic.topic} — ${scores.note}`, t._stampFor(total), hits[0]?.fallback ? null : 'session']);
        entryId = db.get('SELECT id FROM arena_talk WHERE topic_id = ? AND user_id = ?', [topicRow.id, session.user_id])?.id || null;
    } catch (e) { console.warn('[Arena] session clear → entry:', e.message); }
    db.run(`UPDATE arena_talk_session_topics SET status = 'cleared', progress = 100, cleared_at = CURRENT_TIMESTAMP, entry_id = ? WHERE id = ?`, [entryId, topic.id]);
    db.run(`UPDATE arena_talk_sessions SET topics_cleared = topics_cleared + 1 WHERE id = ?`, [session.id]);
    console.log(`[Arena] session ${session.id}: topic ${topic.idx + 1} cleared (“${topic.topic.slice(0, 50)}…”)`);
    try { arena().loadRoster(true); } catch { /* */ }
    return nextTopic(session, topic.idx + 1);
}

async function tickSession(session) {
    const stream = db.get('SELECT id, is_live, started_at FROM streams WHERE id = ?', [session.stream_id]);
    if (!stream || !stream.is_live) return endSession(session, 'stream_ended');
    if (Date.now() - Date.parse(session.started_at + 'Z') > MAX_SESSION_HOURS * 3600 * 1000) return endSession(session, 'max_duration');
    const lastSpeech = session.last_speech_at ? Date.parse(session.last_speech_at + 'Z') : Date.parse(session.started_at + 'Z');
    if (Date.now() - lastSpeech > IDLE_END_MIN * 60 * 1000) return endSession(session, 'idle');
    if (session.judge_calls >= JUDGE_MAX_CALLS) return endSession(session, 'judge_cap');

    let topic = activeTopic(session.id);
    if (!topic) topic = await nextTopic(session, 0);

    const rows = db.all(`SELECT text, start_sec, end_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec > ? ORDER BY start_sec ASC LIMIT 120`, [session.stream_id, session.last_offset_sec]);
    if (rows.length) {
        const pending = parseJson(topic.pending_json, []);
        for (const r of rows) pending.push({ t: r.text, s: Math.floor(r.start_sec), v: r.vod_id || null });
        const newWords = rows.reduce((n, r) => n + words(r.text), 0);
        db.run(`UPDATE arena_talk_sessions SET last_offset_sec = ?, lines_seen = lines_seen + ?, words_seen = words_seen + ?, last_speech_at = CURRENT_TIMESTAMP WHERE id = ?`, [rows[rows.length - 1].start_sec, rows.length, newWords, session.id]);
        db.run('UPDATE arena_talk_session_topics SET pending_json = ? WHERE id = ?', [JSON.stringify(pending.slice(-60)), topic.id]);
        topic.pending_json = JSON.stringify(pending.slice(-60));
    }

    const pending = parseJson(topic.pending_json, []);
    const pendingWords = pending.reduce((n, l) => n + words(l.t), 0);
    const sinceJudge = session.last_judge_at ? Date.now() - Date.parse(session.last_judge_at + 'Z') : Infinity;
    if (pendingWords < JUDGE_MIN_WORDS || sinceJudge < JUDGE_MIN_INTERVAL_MS) return;

    const text = pending.map(l => l.t.replace(/^\s*(?:>>|--?)\s*/, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(-CHUNK_MAX_CHARS);
    const j = await judgeChunk(session, topic, text);
    const quality = (j.spice + j.wit + j.on_topic + j.delivery) / 4;
    const xpGain = j.flagged ? 0 : Math.round(quality * (j.is_trash_talk ? 1 : 0.15));
    const judged = parseJson(topic.judged_json, []);
    judged.push({ at: new Date().toISOString(), ...j, words: pendingWords, quality: Number(quality.toFixed(1)), xp: xpGain });
    // Locate the best line in the pending buffer for a VOD link.
    let bestSec = topic.best_line_sec, bestVod = topic.best_vod_id, bestLine = topic.best_line, bestScore = topic.best_line_score || 0;
    if (j.is_trash_talk && j.best_line && quality > bestScore) {
        const needle = j.best_line.toLowerCase().slice(0, 30);
        const hit = pending.find(l => l.t.toLowerCase().includes(needle)) || pending[0];
        bestLine = j.best_line; bestScore = quality; bestSec = hit ? Math.max(0, hit.s - 2) : null; bestVod = hit ? hit.v : null;
    }
    const about = parseJson(session.about_json, []);
    if (j.about && !j.flagged) { about.push({ text: j.about, topic_idx: topic.idx, hit: j.is_trash_talk, at: new Date().toISOString() }); }
    const newProgress = Math.min(100, (topic.progress || 0) + (j.is_trash_talk ? j.progress_gain : Math.min(5, j.progress_gain)));
    const newScore = (topic.score || 0) + (j.is_trash_talk ? quality : 0);
    const newXp = (session.xp || 0) + xpGain;
    const newLevel = levelFor(newXp);
    if (newLevel > (session.level || 1)) console.log(`[Arena] session ${session.id}: level ${newLevel}`);
    db.run(`UPDATE arena_talk_session_topics SET progress = ?, score = ?, chunks = chunks + 1, judged_json = ?, pending_json = '[]', best_line = ?, best_line_score = ?, best_line_sec = ?, best_vod_id = ? WHERE id = ?`,
        [newProgress, newScore, JSON.stringify(judged.slice(-40)), bestLine, bestScore, bestSec, bestVod, topic.id]);
    db.run(`UPDATE arena_talk_sessions SET xp = ?, level = ?, judge_calls = judge_calls + 1, last_judge_at = CURRENT_TIMESTAMP, about_json = ? WHERE id = ?`, [newXp, newLevel, JSON.stringify(about.slice(-60)), session.id]);
    if (newProgress >= 100) {
        const fresh = db.get('SELECT * FROM arena_talk_session_topics WHERE id = ?', [topic.id]);
        await clearTopic({ ...session, xp: newXp }, fresh);
    }
}

let _timer = null, _busy = false;
async function tick() {
    if (_busy) return;
    _busy = true;
    try {
        for (const s of liveSessions()) {
            try { await tickSession(s); } catch (e) { console.warn(`[Arena] session ${s.id} tick:`, e.message); }
        }
    } finally { _busy = false; }
}
function start() {
    if (_timer) return;
    ensureTables();
    _timer = setInterval(() => tick().catch(() => {}), TICK_MS);
    if (_timer.unref) _timer.unref();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

// ── Hype (chat / button) ─────────────────────────────────────

function hypeSession(userId, voterKey) {
    const s = liveSessionFor(userId);
    if (!s) return null;
    const t = activeTopic(s.id);
    if (!t) return null;
    if (voterKey === `user:${userId}`) throw new Error("You can't hype yourself");
    const ins = db.run('INSERT OR IGNORE INTO arena_talk_session_hype (topic_id, voter_key) VALUES (?, ?)', [t.id, voterKey]);
    const uniques = db.get('SELECT COUNT(*) AS n FROM arena_talk_session_hype WHERE topic_id = ?', [t.id])?.n || 0;
    if (ins.changes) {
        const xp = (s.xp || 0) + HYPE_XP;
        db.run('UPDATE arena_talk_sessions SET xp = ?, level = ? WHERE id = ?', [xp, levelFor(xp), s.id]);
        db.run('UPDATE arena_talk_session_topics SET progress = MIN(100, progress + ?) WHERE id = ?', [HYPE_PROGRESS, t.id]);
    }
    return { added: !!ins.changes, hypers: uniques, session_id: s.id, level: levelFor((s.xp || 0) + (ins.changes ? HYPE_XP : 0)), xp: (s.xp || 0) + (ins.changes ? HYPE_XP : 0), progress: Math.min(100, (t.progress || 0) + (ins.changes ? HYPE_PROGRESS : 0)) };
}

// ── Views ────────────────────────────────────────────────────

function formatTopic(t) {
    if (!t) return null;
    const judged = parseJson(t.judged_json, []);
    const hypers = db.get('SELECT COUNT(*) AS n FROM arena_talk_session_hype WHERE topic_id = ?', [t.id])?.n || 0;
    return {
        id: t.id, idx: t.idx, topic: t.topic, hint: t.hint, tone: t.tone, status: t.status,
        progress: Math.round(t.progress || 0), score: Number((t.score || 0).toFixed(1)), chunks: t.chunks || 0,
        best_line: t.best_line || null, best_line_sec: t.best_line_sec, best_vod_id: t.best_vod_id,
        hits: judged.filter(j => j.is_trash_talk).length, hypers,
        last_judgement: judged.length ? { at: judged[judged.length - 1].at, is_trash_talk: judged[judged.length - 1].is_trash_talk, quality: judged[judged.length - 1].quality, about: judged[judged.length - 1].about, fallback: !!judged[judged.length - 1].fallback } : null,
        entry_id: t.entry_id || null, started_at: t.started_at, cleared_at: t.cleared_at,
    };
}

function sessionView(session, { includeLines = true } = {}) {
    if (!session) return null;
    const topics = db.all('SELECT * FROM arena_talk_session_topics WHERE session_id = ? ORDER BY idx ASC', [session.id]);
    const active = topics.find(t => t.status === 'active') || null;
    const lines = includeLines ? db.all(`SELECT text, start_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec >= ? ORDER BY start_sec DESC LIMIT 14`, [session.stream_id, session.offset_start_sec])
        .reverse().filter(l => !arena()._isBannedText(l.text)).map(l => ({ text: l.text, at: Math.max(0, Math.round(l.start_sec - session.offset_start_sec)), sec: Math.floor(l.start_sec), vod_id: l.vod_id })) : [];
    const about = parseJson(session.about_json, []);
    return {
        id: session.id, status: session.status, started_at: session.started_at, ended_at: session.ended_at, end_reason: session.end_reason,
        level: session.level || 1, xp: session.xp || 0, next_level_xp: levelFor(session.xp || 0) * XP_PER_LEVEL, xp_per_level: XP_PER_LEVEL,
        topics_cleared: session.topics_cleared || 0, lines_seen: session.lines_seen || 0, words_seen: session.words_seen || 0,
        active_topic: formatTopic(active),
        cleared_topics: topics.filter(t => t.status !== 'active').map(formatTopic),
        talked_about: about.slice(-20).reverse(),
        recent_lines: lines,
        stream_id: session.stream_id,
        judge_is_ai: aiOn(),
    };
}

function viewFor(usernameOrId) {
    ensureTables();
    const user = /^\d+$/.test(String(usernameOrId)) ? db.getUserById(Number(usernameOrId)) : db.getUserByUsername(String(usernameOrId));
    if (!user) return null;
    const session = liveSessionFor(user.id) || db.get(`SELECT * FROM arena_talk_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [user.id]);
    const roster = arena().loadRoster();
    const f = roster.byId[user.id];
    const persona = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [user.id])?.persona_json);
    return {
        user: f ? f.user : { id: user.id, username: user.username, display_name: user.display_name || user.username, avatar_url: user.avatar_url, profile_color: user.profile_color },
        fighter_name: persona?.fighter_name || user.display_name || user.username,
        rank: f ? roster.order.indexOf(user.id) + 1 : null,
        power: f ? f.ratings.power : null,
        talk_bonus: f ? f.ratings.talk_bonus : 0,
        image_url: (() => { try { return arena().getFighterImageUrl ? arena().getFighterImageUrl(user.id) : null; } catch { return null; } })(),
        session: sessionView(session),
    };
}

function liveSessionSummaries() {
    ensureTables();
    const roster = arena().loadRoster();
    return liveSessions().map(s => {
        const f = roster.byId[s.user_id];
        const t = activeTopic(s.id);
        const persona = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [s.user_id])?.persona_json);
        return { user: f ? f.user : { id: s.user_id, username: `user${s.user_id}`, display_name: `user${s.user_id}` }, fighter_name: persona?.fighter_name || f?.user?.display_name, level: s.level, xp: s.xp, topics_cleared: s.topics_cleared, topic: t ? t.topic : null, progress: t ? Math.round(t.progress || 0) : 0, started_at: s.started_at };
    });
}

module.exports = {
    ensureTables, start, stop, tick, tickSession,
    startSession, stopSession, skipTopic, hypeSession, liveSessionFor, viewFor, sessionView, liveSessionSummaries,
    TICK_MS, XP_PER_LEVEL, JUDGE_MIN_WORDS, JUDGE_MIN_INTERVAL_MS, IDLE_END_MIN,
    _judgeChunk: judgeChunk, _heuristicChunk: heuristicChunk, _levelFor: levelFor, _activeTopic: activeTopic, _nextTopic: nextTopic,
};
