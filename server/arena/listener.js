/**
 * OpenVibe.Live — Arena Listener (the ears)
 *
 * Every TICK_MS, for every LIVE fighter whose stream is being transcribed, read the new
 * speech lines and route them:
 *
 *   mentions → a line that names another fighter (username, display name, fighter name,
 *              "@name") starts/extends a MENTION BUFFER for that target; the next few
 *              lines without a name stay in it (people keep ranting after the name drop).
 *              Once the buffer has ≥ JUDGE_MIN_WORDS and ≥ JUDGE_MIN_INTERVAL_MS passed,
 *              the beef judge decides whether it was trash talk AIMED AT that fighter.
 *              Yes → beef.recordHit() (opens the beef, scores it, starts the other side's
 *              clock). See beef.js.
 *   topic    → everything else goes to the streamer's ACTIVE BOARD TOPIC (if they picked
 *              one): the topic judge says which angle (if any) the chunk addressed and how
 *              well → board.applyTopicJudgement() (progress, XP, levels).
 *
 * Bounded: at most one judge call per stream per JUDGE_MIN_INTERVAL_MS; nothing happens
 * for streams nobody is talking on; the slur filter voids chunks before any model call.
 * State lives in memory (offsets are re-seeded from "now" on restart, so a restart never
 * replays old speech).
 */
'use strict';

const db = require('../db/database');
const llm = require('../ai/llm');

const TICK_MS = 15 * 1000;
const JUDGE_MIN_WORDS = 20;
const JUDGE_MIN_INTERVAL_MS = 30 * 1000;
const MENTION_TAIL_SEC = 45;         // lines within this many seconds after a name-drop stay in the buffer
const BUFFER_MAX_CHARS = 1400;
const STALE_BUFFER_MS = 3 * 60 * 1000;

const state = new Map();   // streamId → { userId, lastOffset, lastJudgeAt, mention: { [targetId]: { lines, lastAt } }, topic: { lines } }

function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function arena() { return require('./arena-service'); }
function beef() { return require('./beef'); }
function board() { return require('./board'); }
function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function words(t) { return String(t || '').split(/\s+/).filter(Boolean).length; }

// ── Aliases: who can be called out, by which names ───────────

let _aliasCache = { at: 0, list: [] };
function aliases(roster) {
    if (Date.now() - _aliasCache.at < 60 * 1000) return _aliasCache.list;
    const list = [];
    for (const id of roster.order) {
        const f = roster.byId[id];
        const persona = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [id])?.persona_json);
        const names = new Set([f.user.username, f.user.display_name, persona?.fighter_name].filter(Boolean).map(s => String(s).toLowerCase().trim()));
        for (const n of names) {
            if (n.length < 3) continue;
            // "@name", "name", and names with underscores/dots spoken as spaces.
            const spoken = n.replace(/[_.-]+/g, ' ');
            const variants = new Set([n, spoken]);
            for (const v of variants) list.push({ userId: id, name: v, re: new RegExp(`(?:^|[^a-z0-9])@?${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i') });
        }
    }
    // Longer names first so "goosely" beats "goose" style prefixes.
    list.sort((a, b) => b.name.length - a.name.length);
    _aliasCache = { at: Date.now(), list };
    return list;
}

function mentionsIn(text, speakerId, roster) {
    const found = new Set();
    for (const a of aliases(roster)) {
        if (a.userId === speakerId || found.has(a.userId)) continue;
        if (a.re.test(text)) found.add(a.userId);
    }
    return [...found];
}

// ── Judges ───────────────────────────────────────────────────

const BEEF_SCHEMA = {
    name: 'arena_beef_judgement',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['aimed_at_target', 'quality', 'best_line', 'about', 'announcer', 'flagged'],
        properties: {
            aimed_at_target: { type: 'boolean', description: 'true if the speaker is trash-talking, roasting, calling out or bragging AT/ABOUT the named target (in good fun)' },
            announcer: { type: 'string', description: 'one-line ring-announcer call of this moment, ≤ 110 chars, hype and funny (empty if not aimed at the target)' },
            quality: { type: 'integer', minimum: 0, maximum: 10, description: 'how good the trash talk is: spice, wit, specificity, quotability' },
            best_line: { type: 'string', description: 'the single best line, VERBATIM from the speech (empty if none)' },
            about: { type: 'string', description: '≤ 10 words: what they said about the target' },
            flagged: { type: 'boolean', description: 'ONLY for direct threats of violence, sexual content about minors, or doxxing — never for offensive language' },
        },
    },
};
const BEEF_SYSTEM = `You judge live streamer-vs-streamer shit talk. You get a target fighter's name(s) and the last ~60 seconds of a streamer's speech-to-text in which the target was named. Decide if the speaker is talking shit AT or ABOUT the target (roast, callout, disrespect, bragging over them, trolling them) versus just mentioning them neutrally (shout-out, thanks, gameplay chatter). Savage, profane, petty and personal is GOOD and scores high — creativity, specificity and quotability score highest; lazy generic insults score low. Pick the best verbatim line, summarise what was said about the target in ≤ 10 words. Forgive transcription noise. Offensive, provocative and taboo language — slurs included — is allowed on this platform and is NOT a reason to flag or to score low; judge the craft. Flag ONLY behavior: direct threats of violence, sexual content about minors, doxxing (addresses, phone numbers, private info). Output only the JSON.`;

const TOPIC_SCHEMA = {
    name: 'arena_topic_judgement',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['on_topic', 'quality', 'best_line', 'about', 'flagged'],
        properties: {
            on_topic: { type: 'boolean', description: 'true if the speech is actually about the SUBJECT (talking shit, taking a side, riffing, ranting, a bit) — not just a passing word' },
            quality: { type: 'integer', minimum: 0, maximum: 10, description: 'how good it is: savage, specific, funny, quotable = high; generic = low' },
            best_line: { type: 'string', description: 'the single best line, VERBATIM from the speech (empty if none)' },
            about: { type: 'string', description: '≤ 10 words: what they said about it' },
            flagged: { type: 'boolean', description: 'ONLY for direct threats of violence, sexual content about minors, or doxxing — never for offensive language' },
        },
    },
};
const TOPIC_SYSTEM = `You judge a live streamer talking about a SUBJECT the community is on about (a person, a group, a joke, a drama…). You get the subject, its current lore, the keywords people use for it, and the last ~60 seconds of the streamer's speech-to-text. Decide whether the speech is really about the subject (shit talk, a take, a rant, a bit, dunking, defending — all count), score its quality (savage, specific, petty, funny, quotable = high; generic = low), pick the best verbatim line and summarise in ≤ 10 words. Ordinary gameplay chatter or unrelated talk → on_topic false. Forgive transcription noise. Offensive, provocative and taboo language — slurs included — is allowed on this platform and is NOT a reason to flag or to score low; judge the craft. Flag ONLY behavior: direct threats of violence, sexual content about minors, doxxing. Output only the JSON.`;

function heuristicBeef(text, targetNames) {
    const t = text.toLowerCase();
    const spicy = /\b(clown|weak|scared|duck|ducking|trash|garbage|mid|washed|bum|ratio|cook|cooked|better than|can't|cannot|never|nobody|beat|fraud|ass|bet|catch (these|this)|come see|fight me|square up|run it|talk (that|your))\b/.test(t);
    const excl = (text.match(/!/g) || []).length;
    const quality = Math.min(10, (spicy ? 5 : 1) + excl + (words(text) > 30 ? 1 : 0));
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const named = sentences.filter(l => targetNames.some(n => l.toLowerCase().includes(n)));
    const pick = (named.length ? named : sentences).sort((a, b) => b.length - a.length)[0] || text;
    return { aimed_at_target: spicy, quality, best_line: pick.trim().slice(0, 200), about: text.split(/\s+/).slice(0, 8).join(' '), flagged: false, _fallback: true };
}
function heuristicTopic(text, topic) {
    const kws = (parseJson(topic.keywords_json, []) || []).map(k => String(k).toLowerCase());
    const t = text.toLowerCase();
    const hits = kws.filter(k => t.includes(k)).length;
    const spicy = /\b(clown|weak|scared|trash|garbage|mid|washed|bum|ratio|cook|cooked|never|nobody|fraud|ass|bet|shut up|cope|seethe|cry|worst|best|hate|love)\b/.test(t);
    const excl = (text.match(/!/g) || []).length;
    const quality = Math.min(10, 2 + (spicy ? 3 : 0) + excl + Math.min(3, hits));
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const named = sentences.filter(l => kws.some(k => l.toLowerCase().includes(k)));
    return { on_topic: hits > 0, quality, best_line: ((named.length ? named : sentences).sort((a, b) => b.length - a.length)[0] || text).trim().slice(0, 200), about: text.split(/\s+/).slice(0, 8).join(' '), flagged: false, _fallback: true };
}

async function judgeBeef(speakerId, targetId, text, roster) {
    if (arena()._isBannedText(text)) return { aimed_at_target: false, quality: 0, best_line: '', about: 'voided', flagged: true };
    const tf = roster.byId[targetId];
    const targetNames = [tf.user.username, tf.user.display_name, (parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [targetId])?.persona_json) || {}).fighter_name].filter(Boolean);
    let j = null;
    if (aiOn()) {
        try {
            const r = await llm.complete({ role: 'chat', kind: 'arena_beef_judge', source: 'arena', ownerUserId: speakerId, system: BEEF_SYSTEM, user: JSON.stringify({ target_names: targetNames, speech: text }), json: BEEF_SCHEMA, maxTokens: 220, temperature: 0.4, timeoutMs: 25000 });
            if (r && r.json && typeof r.json.quality === 'number') j = r.json;
        } catch (e) { console.warn('[Arena] beef judge:', e.message); }
    }
    if (!j) j = heuristicBeef(text, targetNames.map(n => n.toLowerCase()));
    return { aimed_at_target: !!j.aimed_at_target && !j.flagged, quality: Math.max(0, Math.min(10, Math.round(Number(j.quality) || 0))), best_line: String(j.best_line || '').slice(0, 220), about: String(j.about || '').slice(0, 80), announcer: String(j.announcer || '').slice(0, 140), flagged: !!j.flagged, fallback: !!j._fallback };
}

async function judgeTopic(speakerId, topic, text) {
    if (arena()._isBannedText(text)) return { on_topic: false, quality: 0, best_line: '', about: 'voided', flagged: true };
    let j = null;
    if (aiOn()) {
        try {
            const r = await llm.complete({ role: 'chat', kind: 'arena_topic_judge', source: 'arena', ownerUserId: speakerId, system: TOPIC_SYSTEM, user: JSON.stringify({ subject: topic.text, headline: topic.headline, lore: topic.lore ? String(topic.lore).slice(0, 500) : null, keywords: parseJson(topic.keywords_json, []), speech: text }), json: TOPIC_SCHEMA, maxTokens: 200, temperature: 0.4, timeoutMs: 25000 });
            if (r && r.json && typeof r.json.quality === 'number') j = r.json;
        } catch (e) { console.warn('[Arena] topic judge:', e.message); }
    }
    if (!j) j = heuristicTopic(text, topic);
    return { on_topic: !!j.on_topic && !j.flagged, quality: Math.max(0, Math.min(10, Math.round(Number(j.quality) || 0))), best_line: String(j.best_line || '').slice(0, 220), about: String(j.about || '').slice(0, 80), flagged: !!j.flagged, fallback: !!j._fallback };
}

// ── Tick ─────────────────────────────────────────────────────

function liveTranscribedStreams(roster) {
    return db.all(`SELECT s.id, s.user_id, s.started_at FROM streams s WHERE s.is_live = 1 AND EXISTS (SELECT 1 FROM stream_timeline_events e WHERE e.stream_id = s.id AND e.kind = 'speech' AND e.created_at >= datetime('now', '-30 minutes'))`)
        .filter(s => roster.byId[s.user_id]);
}

function streamOffsetNow(stream) {
    const startedMs = stream.started_at ? Date.parse(String(stream.started_at).replace(' ', 'T') + 'Z') : Date.now();
    return Math.max(0, (Date.now() - startedMs) / 1000);
}

function bufferText(lines) { return lines.map(l => l.t.replace(/^\s*(?:>>|--?)\s*/, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(-BUFFER_MAX_CHARS); }
function lineRefFor(lines, bestLine) {
    const needle = String(bestLine || '').toLowerCase().slice(0, 30);
    const hit = (needle && lines.find(l => l.t.toLowerCase().includes(needle))) || lines[0];
    return hit ? { vod_id: hit.v || null, sec: Math.max(0, hit.s - 2) } : { vod_id: null, sec: null };
}

async function tickStream(stream, roster, events) {
    let st = state.get(stream.id);
    if (!st) { st = { userId: stream.user_id, lastOffset: streamOffsetNow(stream) - 20, lastJudgeAt: 0, mention: {}, topic: { lines: [] } }; state.set(stream.id, st); }
    const rows = db.all(`SELECT text, start_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec > ? ORDER BY start_sec ASC LIMIT 100`, [stream.id, st.lastOffset]);
    if (rows.length) st.lastOffset = rows[rows.length - 1].start_sec;
    const now = Date.now();
    for (const r of rows) {
        const line = { t: String(r.text || ''), s: Math.floor(r.start_sec), v: r.vod_id || null };
        // Board subjects said on mic → a moment on the topic (raw mention; the judge scores the chunk later).
        try {
            for (const t of board().matchTopics(line.t)) {
                const m = board().noteMicMention(t.id, { userId: stream.user_id, username: roster.byId[stream.user_id]?.user?.username || null, streamId: stream.id, vodId: line.v, sec: Math.max(0, line.s - 2), text: line.t });
                if (m) events.push({ kind: 'topic_mention', streamId: stream.id, speakerId: stream.user_id, topicId: t.id });
                st.lastTopic = { id: t.id, at: now };
            }
        } catch (e) { console.warn('[Arena] topic match:', e.message); }
        const targets = mentionsIn(line.t, stream.user_id, roster);
        if (targets.length) {
            for (const tid of targets) { const m = st.mention[tid] || (st.mention[tid] = { lines: [], lastAt: 0, lastSec: 0 }); m.lines.push(line); m.lastAt = now; m.lastSec = line.s; }
        } else {
            // Tail: keep feeding the most recent mention buffer for a bit after the name drop.
            const recent = Object.entries(st.mention).filter(([, m]) => line.s - m.lastSec <= MENTION_TAIL_SEC && now - m.lastAt < STALE_BUFFER_MS).sort((x, y) => y[1].lastSec - x[1].lastSec)[0];
            if (recent) recent[1].lines.push(line);
            else st.topic.lines.push(line);
        }
    }
    // Drop stale mention buffers that never reached the judge.
    for (const [tid, m] of Object.entries(st.mention)) if (now - m.lastAt > STALE_BUFFER_MS) delete st.mention[tid];
    if (st.topic.lines.length > 60) st.topic.lines = st.topic.lines.slice(-60);

    if (now - st.lastJudgeAt < JUDGE_MIN_INTERVAL_MS) return;

    // 1) Mention buffers first (a callout is the interesting thing).
    for (const [tidStr, m] of Object.entries(st.mention)) {
        const tid = Number(tidStr);
        if (m.lines.reduce((n, l) => n + words(l.t), 0) < JUDGE_MIN_WORDS) continue;
        const text = bufferText(m.lines);
        const lines = m.lines; delete st.mention[tidStr];
        st.lastJudgeAt = Date.now();
        const j = await judgeBeef(stream.user_id, tid, text, roster);
        if (j.aimed_at_target) {
            const ref = lineRefFor(lines, j.best_line);
            const res = beef().recordHit(stream.user_id, tid, { quality: j.quality, best_line: j.best_line, about: j.about, announcer: j.announcer, vod_id: ref.vod_id, sec: ref.sec });
            st.lastBeefJudgement = { at: new Date().toISOString(), target_id: tid, ...j, opened: res?.opened, bounty: res?.bounty };
            events.push({ kind: 'beef_hit', streamId: stream.id, speakerId: stream.user_id, targetId: tid, opened: res?.opened, quality: j.quality, line: j.best_line });
        } else {
            events.push({ kind: 'beef_miss', streamId: stream.id, speakerId: stream.user_id, targetId: tid, about: j.about });
        }
        return; // one judge call per stream per tick
    }

    // 2) Board subject: the one they chose, else the one they just brought up on mic.
    let topic = board().activeTopicFor(stream.user_id);
    if (!topic && st.lastTopic && now - st.lastTopic.at < 3 * 60 * 1000) topic = db.get(`SELECT * FROM arena_topics WHERE id = ? AND status = 'open'`, [st.lastTopic.id]);
    if (topic && st.topic.lines.reduce((n, l) => n + words(l.t), 0) >= JUDGE_MIN_WORDS) {
        const lines = st.topic.lines; st.topic.lines = [];
        const text = bufferText(lines);
        st.lastJudgeAt = Date.now();
        const j = await judgeTopic(stream.user_id, topic, text);
        const ref = { ...lineRefFor(lines, j.best_line), stream_id: stream.id };
        const res = board().applyTopicJudgement(stream.user_id, topic, j, ref);
        st.lastTopicJudgement = { at: new Date().toISOString(), topic_id: topic.id, topic: topic.text, ...j, applied: res.applied, xp: res.xp || 0 };
        events.push({ kind: res.applied ? 'topic_hit' : 'topic_miss', streamId: stream.id, speakerId: stream.user_id, topicId: topic.id, ...res });
    } else if (!topic && st.topic.lines.length > 80) {
        st.topic.lines = st.topic.lines.slice(-40);
    }
}

let _timer = null, _busy = false;
async function tick() {
    if (_busy) return [];
    _busy = true;
    const events = [];
    try {
        const roster = arena().loadRoster();
        const streams = liveTranscribedStreams(roster);
        for (const s of streams) { try { await tickStream(s, roster, events); } catch (e) { console.warn(`[Arena] listener stream ${s.id}:`, e.message); } }
        for (const id of [...state.keys()]) if (!streams.find(s => s.id === id)) state.delete(id);
        try { beef().tick(); } catch (e) { console.warn('[Arena] beef tick:', e.message); }
    } finally { _busy = false; }
    return events;
}

function consoleState(userId) {
    for (const [streamId, st] of state) if (st.userId === userId) {
        return { stream_id: streamId, listening: true, mention_buffers: Object.keys(st.mention).length, pending_topic_words: st.topic.lines.reduce((n, l) => n + words(l.t), 0), last_topic_judgement: st.lastTopicJudgement || null, last_beef_judgement: st.lastBeefJudgement || null, last_judge_at: st.lastJudgeAt ? new Date(st.lastJudgeAt).toISOString() : null };
    }
    return { listening: false };
}

function start() {
    if (_timer) return;
    _timer = setInterval(() => tick().catch(e => console.warn('[Arena] listener:', e.message)), TICK_MS);
    if (_timer.unref) _timer.unref();
    console.log('[Arena] listener started (every 15 s)');
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, tick, consoleState, TICK_MS, JUDGE_MIN_WORDS, JUDGE_MIN_INTERVAL_MS, _mentionsIn: mentionsIn, _aliases: aliases, _heuristicBeef: heuristicBeef, _heuristicTopic: heuristicTopic, _state: state };
