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
const BUFFER_MAX_CHARS = 1400;

const state = new Map();   // streamId → { userId, lastOffset, lastJudgeAt, mention: { [targetId]: { lines, lastAt } }, topic: { lines } }

function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function arena() { return require('./arena-service'); }
function beef() { return require('./beef'); }
function board() { return require('./board'); }
function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function words(t) { return String(t || '').split(/\s+/).filter(Boolean).length; }

// ── Aliases: who can be called out, by which names ───────────
// Every predicted spoken form of every roster name (see names.js): camelCase and snake_case
// split the way a transcriber hears them, digits and decorations dropped, leet undone, plus the
// persona's AI-written "spoken_as" list (nicknames, misspellings). Matching is exact → fuzzy →
// phonetic, so "Matticus", "japanese-old-guy" and "goose lee" all resolve.

const names = require('./names');
let _aliasCache = { at: 0, list: [] };
function aliases(roster) {
    if (Date.now() - _aliasCache.at < 60 * 1000) return _aliasCache.list;
    const list = [];
    for (const id of roster.order) {
        const f = roster.byId[id];
        const persona = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [id])?.persona_json);
        const spoken = Array.isArray(persona?.spoken_as) ? persona.spoken_as : [];
        list.push(...names.aliasEntries(id, [f.user.username, f.user.display_name, persona?.fighter_name, ...spoken]));
    }
    // Longer names first so "goosely" beats "goose" style prefixes.
    list.sort((a, b) => b.name.length - a.name.length);
    _aliasCache = { at: Date.now(), list };
    return list;
}

/** User ids mentioned in a line (never the speaker). */
function mentionsIn(text, speakerId, roster) {
    return names.findMentions(text, aliases(roster), { excludeUserId: speakerId }).map(m => m.userId);
}
/** Same, with how each was matched — for the console. */
function mentionsDetailed(text, speakerId, roster) {
    return names.findMentions(text, aliases(roster), { excludeUserId: speakerId });
}

// ── Judges ───────────────────────────────────────────────────

const BEEF_SCHEMA = {
    name: 'arena_beef_judgement',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['about_target', 'aimed_at_target', 'quality', 'best_line', 'about', 'announcer', 'flagged'],
        properties: {
            about_target: { type: 'boolean', description: 'true if this speech is (still) about the target — by name OR by reference ("he", "his stream", "that guy", "the beef", continuing the same rant)' },
            aimed_at_target: { type: 'boolean', description: 'true if the speaker is trash-talking, roasting, calling out, dunking on or bragging over the target (in good fun) — requires about_target' },
            announcer: { type: 'string', description: 'one-line ring-announcer call of this moment, ≤ 110 chars, hype and funny (empty if not aimed at the target)' },
            quality: { type: 'integer', minimum: 0, maximum: 10, description: 'how good the trash talk is: spice, wit, specificity, quotability' },
            best_line: { type: 'string', description: 'the single best line, VERBATIM from the speech (empty if none)' },
            about: { type: 'string', description: '≤ 10 words: what they said about the target' },
            flagged: { type: 'boolean', description: 'ONLY for direct threats of violence, sexual content about minors, or doxxing — never for offensive language' },
        },
    },
};
const BEEF_SYSTEM = `You judge live streamer-vs-streamer shit talk. You get a target fighter's name(s), what the speaker ALREADY said about them a moment ago (context), and the newest ~60 seconds of the speaker's speech-to-text. The target may not be named again in the new speech — decide from context whether they are STILL talking about that person ("he", "his chat", "that guy", "the beef", the same story) or have moved on to something else. Then decide if the speech is talking shit AT or ABOUT the target (roast, callout, disrespect, bragging over them, trolling them) versus neutral mention (shout-out, thanks, gameplay chatter). Savage, profane, petty and personal is GOOD and scores high — creativity, specificity and quotability score highest; lazy generic insults score low. Pick the best verbatim line, summarise what was said about the target in ≤ 10 words. Forgive transcription noise and misheard names. Offensive, provocative and taboo language — slurs included — is allowed on this platform and is NOT a reason to flag or to score low; judge the craft. Flag ONLY behavior: direct threats of violence, sexual content about minors, doxxing (addresses, phone numbers, private info). Output only the JSON.`;

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

function heuristicBeef(text, targetNames, { named = true } = {}) {
    const t = text.toLowerCase();
    const spicy = /\b(clown|weak|scared|duck|ducking|trash|garbage|mid|washed|bum|ratio|cook|cooked|better than|can't|cannot|never|nobody|beat|fraud|ass|bet|catch (these|this)|come see|fight me|square up|run it|talk (that|your)|cope|seethe|cry|loser|bozo|goofy|clown)\b/.test(t);
    const pronouns = /\b(he|him|his|she|her|they|them|their|that (guy|dude|man|girl|streamer)|this (guy|dude|man|girl|streamer)|the (guy|dude|beef)|bro's|bros)\b/.test(t);
    const aboutTarget = named || pronouns;
    const excl = (text.match(/!/g) || []).length;
    const quality = Math.min(10, (spicy ? 5 : 1) + excl + (words(text) > 30 ? 1 : 0));
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const namedLines = sentences.filter(l => targetNames.some(n => l.toLowerCase().includes(n)));
    const pick = (namedLines.length ? namedLines : sentences).sort((a, b) => b.length - a.length)[0] || text;
    return { about_target: aboutTarget, aimed_at_target: aboutTarget && spicy, quality, best_line: pick.trim().slice(0, 200), about: text.split(/\s+/).slice(0, 8).join(' '), flagged: false, _fallback: true };
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

async function judgeBeef(speakerId, targetId, text, roster, { context = null, named = true } = {}) {
    if (arena()._isBannedText(text)) return { about_target: false, aimed_at_target: false, quality: 0, best_line: '', about: 'voided', flagged: true };
    const tf = roster.byId[targetId];
    const targetNames = [tf.user.username, tf.user.display_name, (parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [targetId])?.persona_json) || {}).fighter_name].filter(Boolean);
    const spokenForms = [...new Set(targetNames.flatMap(n => names.variants(n)))].slice(0, 8);
    let j = null;
    if (aiOn()) {
        try {
            const r = await llm.complete({ role: 'chat', kind: 'arena_beef_judge', source: 'arena', ownerUserId: speakerId, system: BEEF_SYSTEM,
                user: JSON.stringify({ target_names: targetNames, target_as_transcribed: spokenForms, target_named_in_new_speech: named, what_speaker_already_said_about_target: context || null, new_speech: text }),
                json: BEEF_SCHEMA, maxTokens: 240, temperature: 0.4, timeoutMs: 25000 });
            if (r && r.json && typeof r.json.quality === 'number') j = r.json;
        } catch (e) { console.warn('[Arena] beef judge:', e.message); }
    }
    if (!j) j = heuristicBeef(text, spokenForms.length ? spokenForms : targetNames.map(n => n.toLowerCase()), { named });
    const about = (j.about_target !== false) && !j.flagged;
    return { about_target: about, aimed_at_target: about && !!j.aimed_at_target, quality: Math.max(0, Math.min(10, Math.round(Number(j.quality) || 0))), best_line: String(j.best_line || '').slice(0, 220), about: String(j.about || '').slice(0, 80), announcer: String(j.announcer || '').slice(0, 140), flagged: !!j.flagged, fallback: !!j._fallback };
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

/**
 * Per-stream focus: after a fighter's name is said, the listener LOCKS ON to that fighter. Every
 * following line goes to the beef judge with the earlier context, so "…and his chat is 12 alts,
 * he's scared of the smoke" still counts without the name being repeated. Each judged hit
 * extends the lock (FOCUS_EXTEND_MS); two chunks in a row that are not about the target, or
 * FOCUS_MAX_MS since the last time they were actually named, drop it. A different name-drop
 * switches focus (the pending chunk is judged first if it is big enough).
 */
const FOCUS_TAIL_MS = 2 * 60 * 1000;      // how long a bare name-drop keeps the ears on the target
const FOCUS_EXTEND_MS = 3 * 60 * 1000;    // every hit while locked extends the lock by this
const FOCUS_MAX_MS = 20 * 60 * 1000;      // hard cap without a fresh name-drop
const FOCUS_MISSES_TO_DROP = 2;

function newFocus(targetId, now, how) { return { targetId, since: now, namedAt: now, lockUntil: now + FOCUS_TAIL_MS, lines: [], misses: 0, hits: 0, context: null, how }; }

async function judgeFocus(stream, roster, st, events, { reason }) {
    const f = st.focus;
    if (!f || !f.lines.length) return false;
    const text = bufferText(f.lines);
    const lines = f.lines; f.lines = [];
    const named = lines.some(l => l.named);
    st.lastJudgeAt = Date.now();
    const j = await judgeBeef(stream.user_id, f.targetId, text, roster, { context: f.context, named });
    const now = Date.now();
    if (j.aimed_at_target) {
        const ref = lineRefFor(lines, j.best_line);
        const res = beef().recordHit(stream.user_id, f.targetId, { quality: j.quality, best_line: j.best_line, about: j.about, announcer: j.announcer, vod_id: ref.vod_id, sec: ref.sec });
        f.hits++; f.misses = 0; f.lockUntil = Math.min(now + FOCUS_EXTEND_MS, f.namedAt + FOCUS_MAX_MS);
        f.context = `${f.context ? f.context + ' | ' : ''}${j.about}${j.best_line ? ` ("${j.best_line.slice(0, 120)}")` : ''}`.slice(-600);
        st.lastBeefJudgement = { at: new Date().toISOString(), target_id: f.targetId, ...j, opened: res?.opened, bounty: res?.bounty, named, reason };
        events.push({ kind: 'beef_hit', streamId: stream.id, speakerId: stream.user_id, targetId: f.targetId, opened: res?.opened, quality: j.quality, line: j.best_line, named, continued: !named });
        return true;
    }
    if (j.about_target) {
        // Still on the subject but not shit talk (a story, a shout-out) — keep listening a little.
        f.misses = 0; f.lockUntil = Math.min(Math.max(f.lockUntil, now + FOCUS_TAIL_MS / 2), f.namedAt + FOCUS_MAX_MS);
        f.context = `${f.context ? f.context + ' | ' : ''}(neutral) ${j.about}`.slice(-600);
        st.lastBeefJudgement = { at: new Date().toISOString(), target_id: f.targetId, ...j, named, reason };
        events.push({ kind: 'beef_neutral', streamId: stream.id, speakerId: stream.user_id, targetId: f.targetId, about: j.about, named });
        return true;
    }
    f.misses++;
    st.lastBeefJudgement = { at: new Date().toISOString(), target_id: f.targetId, ...j, named, reason };
    events.push({ kind: 'beef_miss', streamId: stream.id, speakerId: stream.user_id, targetId: f.targetId, about: j.about, named });
    if (f.misses >= FOCUS_MISSES_TO_DROP) { events.push({ kind: 'focus_dropped', streamId: stream.id, targetId: f.targetId, hits: f.hits }); st.focus = null; }
    return true;
}

async function tickStream(stream, roster, events) {
    let st = state.get(stream.id);
    if (!st) { st = { userId: stream.user_id, lastOffset: streamOffsetNow(stream) - 20, lastJudgeAt: 0, focus: null, topic: { lines: [] } }; state.set(stream.id, st); }
    const rows = db.all(`SELECT text, start_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec > ? ORDER BY start_sec ASC LIMIT 100`, [stream.id, st.lastOffset]);
    if (rows.length) st.lastOffset = rows[rows.length - 1].start_sec;
    const now = Date.now();
    if (st.focus && now > st.focus.lockUntil) {
        // Lock expired: judge whatever is pending if it is worth a call, then let go.
        if (st.focus.lines.length && st.focus.lines.reduce((n, l) => n + words(l.t), 0) >= JUDGE_MIN_WORDS && now - st.lastJudgeAt >= JUDGE_MIN_INTERVAL_MS) await judgeFocus(stream, roster, st, events, { reason: 'lock expired' });
        if (st.focus) { events.push({ kind: 'focus_dropped', streamId: stream.id, targetId: st.focus.targetId, hits: st.focus.hits, why: 'timeout' }); st.focus = null; }
    }
    for (const r of rows) {
        const line = { t: String(r.text || ''), s: Math.floor(r.start_sec), v: r.vod_id || null, named: false };
        // Board subjects said on mic → a moment on the topic (raw mention; the judge scores the chunk later).
        try {
            for (const t of board().matchTopics(line.t)) {
                const m = board().noteMicMention(t.id, { userId: stream.user_id, username: roster.byId[stream.user_id]?.user?.username || null, streamId: stream.id, vodId: line.v, sec: Math.max(0, line.s - 2), text: line.t });
                if (m) events.push({ kind: 'topic_mention', streamId: stream.id, speakerId: stream.user_id, topicId: t.id });
                st.lastTopic = { id: t.id, at: now };
            }
        } catch (e) { console.warn('[Arena] topic match:', e.message); }
        const mentions = mentionsDetailed(line.t, stream.user_id, roster);
        if (mentions.length) {
            const m = mentions[0];                                   // best match (exact > fuzzy > phonetic)
            line.named = true;
            if (st.focus && st.focus.targetId !== m.userId) {
                // Switching targets: judge the pending chunk on the old target first if it is big enough.
                if (st.focus.lines.reduce((n, l) => n + words(l.t), 0) >= JUDGE_MIN_WORDS) await judgeFocus(stream, roster, st, events, { reason: 'target switch' });
                st.focus = null;
            }
            if (!st.focus) { st.focus = newFocus(m.userId, now, m.how); events.push({ kind: 'focus', streamId: stream.id, speakerId: stream.user_id, targetId: m.userId, how: m.how, hit: m.hit }); }
            else { st.focus.namedAt = now; st.focus.lockUntil = Math.max(st.focus.lockUntil, now + FOCUS_TAIL_MS); st.focus.misses = 0; }
            st.focus.lines.push(line);
        } else if (st.focus) {
            st.focus.lines.push(line);                               // locked on: everything they say goes to the target's judge
        } else {
            st.topic.lines.push(line);
        }
    }
    if (st.focus && st.focus.lines.length > 80) st.focus.lines = st.focus.lines.slice(-80);
    if (st.topic.lines.length > 60) st.topic.lines = st.topic.lines.slice(-60);

    if (now - st.lastJudgeAt < JUDGE_MIN_INTERVAL_MS) return;

    // 1) Focused target first (a callout is the interesting thing).
    if (st.focus && st.focus.lines.reduce((n, l) => n + words(l.t), 0) >= JUDGE_MIN_WORDS) {
        await judgeFocus(stream, roster, st, events, { reason: st.focus.lines.some(l => l.named) ? 'name-drop' : 'continuation' });
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
        const f = st.focus;
        return {
            stream_id: streamId, listening: true,
            focus: f ? { target_id: f.targetId, target: (() => { try { return board().nameOf(f.targetId); } catch { return null; } })(), how: f.how, since: new Date(f.since).toISOString(), lock_seconds_left: Math.max(0, Math.round((f.lockUntil - Date.now()) / 1000)), hits: f.hits, misses: f.misses, pending_words: f.lines.reduce((n, l) => n + words(l.t), 0), context: f.context } : null,
            pending_topic_words: st.topic.lines.reduce((n, l) => n + words(l.t), 0),
            last_topic_judgement: st.lastTopicJudgement || null, last_beef_judgement: st.lastBeefJudgement || null, last_judge_at: st.lastJudgeAt ? new Date(st.lastJudgeAt).toISOString() : null,
        };
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

module.exports = { start, stop, tick, consoleState, TICK_MS, JUDGE_MIN_WORDS, JUDGE_MIN_INTERVAL_MS, FOCUS_TAIL_MS, FOCUS_EXTEND_MS, FOCUS_MAX_MS, _mentionsIn: mentionsIn, _mentionsDetailed: mentionsDetailed, _aliases: aliases, _heuristicBeef: heuristicBeef, _heuristicTopic: heuristicTopic, _state: state };
