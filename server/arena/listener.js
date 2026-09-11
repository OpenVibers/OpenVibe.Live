/**
 * OpenVibe.Live — Arena Listener (the ears) — Battle Cam mode
 *
 * Every TICK_MS, for every LIVE fighter whose stream is being transcribed, read the new speech
 * lines. Everything the Arena is comes from here; chat, votes and submissions do not exist.
 *
 *   name-drop → a line that names another fighter (however the transcriber spelled it — see
 *               names.js) LOCKS the ears on that fighter. Everything said while locked goes to
 *               the BEEF JUDGE with the earlier context; a judged hit → beef.recordHit() (opens
 *               the beef, scores it, puts the other side on the clock). See beef.js.
 *   free talk → everything said while NOT locked pools for the MIC JUDGE: is this shit talk at
 *               all (roast, rant, callout, brag, disrespect)? Who is it aimed at? If the judge's
 *               `aimed_at` resolves to a roster fighter, it is a callout and feeds a beef like a
 *               name-drop would; otherwise it lands in the shit-talk feed as a `trash` moment
 *               and pays Trash Level XP (mic.js).
 *
 * Bounded: at most one judge call per stream per JUDGE_MIN_INTERVAL_MS; nothing happens for
 * streams nobody is talking on; the behaviour filter voids chunks before any model call.
 * State lives in memory (offsets are re-seeded from "now" on restart, so a restart never replays
 * old speech).
 */
'use strict';

const db = require('../db/database');
const llm = require('../ai/llm');

const TICK_MS = 15 * 1000;
const JUDGE_MIN_WORDS = 20;
const JUDGE_MIN_INTERVAL_MS = 30 * 1000;
const MIC_MIN_QUALITY = 4;          // free talk must be at least this spicy to land in the feed
const CALLOUT_MIN_QUALITY = 5;      // …and this spicy for an aimed_at name to open a beef
const BUFFER_MAX_CHARS = 1400;

const state = new Map();   // streamId → { userId, lastOffset, lastJudgeAt, focus, mic: { lines } }

function aiOn() { try { return llm.isEnabled() && llm.withinBudget(); } catch { return false; } }
function arena() { return require('./arena-service'); }
function beef() { return require('./beef'); }
function mic() { return require('./mic'); }
function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function words(t) { return String(t || '').split(/\s+/).filter(Boolean).length; }

// ── Aliases: who can be called out, by which names ───────────
const names = require('./names');
let _aliasCache = { at: 0, list: [] };
function aliases(roster) {
    if (Date.now() - _aliasCache.at < 60 * 1000) return _aliasCache.list;
    const list = names.rosterEntries(roster, (id) => { const persona = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [id])?.persona_json); return [persona?.fighter_name, ...(Array.isArray(persona?.spoken_as) ? persona.spoken_as : [])]; });
    _aliasCache = { at: Date.now(), list };
    return list;
}
function mentionsIn(text, speakerId, roster) { return names.findMentions(text, aliases(roster), { excludeUserId: speakerId }).map(m => m.userId); }
function mentionsDetailed(text, speakerId, roster) { return names.findMentions(text, aliases(roster), { excludeUserId: speakerId }); }

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
const BEEF_SYSTEM = `You judge live streamer-vs-streamer shit talk (battle-cam style). You get a target fighter's name(s), what the speaker ALREADY said about them a moment ago (context), and the newest ~60 seconds of the speaker's speech-to-text. The target may not be named again in the new speech — decide from context whether they are STILL talking about that person ("he", "his chat", "that guy", "the beef", the same story) or have moved on. DEFAULT TO about_target=false: gameplay chatter, mumbling and generic sentences are NOT about them even if their name was said a minute ago; if how_the_name_was_matched is not "exact" (a sound-alike), be extra strict. Then decide if the speech is talking shit AT or ABOUT the target (roast, callout, disrespect, bragging over them, trolling them) versus a neutral mention (shout-out, thanks, gameplay chatter). Savage, profane, petty and personal is GOOD and scores high — creativity, specificity and quotability score highest; lazy generic insults score low. Pick the best verbatim line, summarise what was said about the target in ≤ 10 words. Forgive transcription noise and misheard names. Offensive, provocative and taboo language — slurs included — is allowed on this platform and is NOT a reason to flag or to score low; judge the craft. Flag ONLY behavior: direct threats of violence, sexual content about minors, doxxing (addresses, phone numbers, private info). Output only the JSON.`;

const MIC_SCHEMA = {
    name: 'arena_mic_judgement',
    schema: {
        type: 'object', additionalProperties: false,
        required: ['is_trash_talk', 'quality', 'best_line', 'about', 'aimed_at', 'announcer', 'flagged'],
        properties: {
            is_trash_talk: { type: 'boolean', description: 'true ONLY if the speaker is actually talking shit: roasting, calling someone out, bragging over someone, ranting AT someone (chat, a group, a person), disrespect, trolling, "come see me" energy' },
            quality: { type: 'integer', minimum: 0, maximum: 10, description: 'how good the shit talk is: savage, specific, funny, quotable = high; lazy generic = low; 0 when not trash talk' },
            best_line: { type: 'string', description: 'the single best line, VERBATIM from the speech (empty if none)' },
            about: { type: 'string', description: '≤ 10 words: what the shit talk was about' },
            aimed_at: { type: 'string', description: 'who or what it is aimed at, as said or clearly implied: a streamer name, "chat", "the mods", "twitch streamers", a game, "nobody" — ≤ 6 words, lowercase' },
            announcer: { type: 'string', description: 'one-line ring-announcer call of the moment, ≤ 110 chars, hype and funny (empty if not trash talk)' },
            flagged: { type: 'boolean', description: 'ONLY for direct threats of violence, sexual content about minors, or doxxing — never for offensive language' },
        },
    },
};
const MIC_SYSTEM = `You judge a live streamer's raw mic chatter for BATTLE-CAM style shit talk. You get ~60 seconds of speech-to-text (expect noise). DEFAULT TO is_trash_talk=false: gameplay narration, reading chat, small talk, "um", stories, neutral opinions → false, quality 0. Say true only when they are genuinely talking shit — roasting someone, calling someone out, bragging over someone, ranting AT chat or a group, disrespect, trolling, "pull up" energy. When true: score the craft (savage, specific, petty, funny, quotable = high; generic = low), pick the best verbatim line, say who it is aimed at (a name if one is said or clearly meant, else "chat", "the mods", a group, a game, or "nobody"), summarise in ≤ 10 words, and write a one-line ring-announcer call. Offensive, provocative and taboo language — slurs included — is allowed on this platform and is NOT a reason to flag or to score low; judge the craft. Flag ONLY behavior: direct threats of violence, sexual content about minors, doxxing. Output only the JSON.`;

const SPICY = /\b(clown|clowns|weak|scared|duck|ducking|ducked|trash|garbage|mid|washed|bum|bums|ratio|cook|cooked|better than|can't|cannot|never|nobody|beat|fraud|frauds|ass|bet|catch (these|this)|come see|pull up|fight me|square up|run it|talk (that|your)|cope|seethe|cry|loser|losers|bozo|bozos|goofy|fake|scam|dogshit|shit at|suck|sucks|pathetic|embarrassing|sit down|shut up|nobody cares|delusional|coward|cowards)\b/;
function heuristicBeef(text, targetNames, { named = true } = {}) {
    const t = text.toLowerCase();
    const spicy = SPICY.test(t);
    const pronouns = /\b(he|him|his|she|her|they|them|their|that (guy|dude|man|girl|streamer)|this (guy|dude|man|girl|streamer)|the (guy|dude|beef)|bro's|bros)\b/.test(t);
    const aboutTarget = named || pronouns;
    const excl = (text.match(/!/g) || []).length;
    const quality = Math.min(10, (spicy ? 5 : 1) + excl + (words(text) > 30 ? 1 : 0));
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const namedLines = sentences.filter(l => targetNames.some(n => l.toLowerCase().includes(n)));
    const pick = (namedLines.length ? namedLines : sentences).sort((a, b) => b.length - a.length)[0] || text;
    return { about_target: aboutTarget, aimed_at_target: aboutTarget && spicy, quality, best_line: pick.trim().slice(0, 200), about: text.split(/\s+/).slice(0, 8).join(' '), announcer: '', flagged: false, _fallback: true };
}
function heuristicMic(text) {
    const t = text.toLowerCase();
    const spicy = SPICY.test(t);
    const excl = (text.match(/!/g) || []).length;
    const aimed = /\b(chat|you guys|y'all|yall|all of you)\b/.test(t) ? 'chat' : /\bmods?\b/.test(t) ? 'the mods' : /\b(twitch|kick|youtube) streamers?\b/.test(t) ? 'other streamers' : '';
    const quality = spicy ? Math.min(10, 4 + excl + (words(text) > 30 ? 1 : 0) + (/\b(never|nobody|fraud|washed|cooked|ratio)\b/.test(t) ? 1 : 0)) : 0;
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const spicyLines = sentences.filter(l => SPICY.test(l.toLowerCase()));
    const pick = (spicyLines.length ? spicyLines : sentences).sort((a, b) => b.length - a.length)[0] || text;
    return { is_trash_talk: spicy, quality, best_line: pick.trim().slice(0, 200), about: text.split(/\s+/).slice(0, 8).join(' '), aimed_at: aimed, announcer: '', flagged: false, _fallback: true };
}

async function judgeBeef(speakerId, targetId, text, roster, { context = null, named = true, how = 'exact' } = {}) {
    if (arena()._isBannedText(text)) return { about_target: false, aimed_at_target: false, quality: 0, best_line: '', about: 'voided', announcer: '', flagged: true };
    const tf = roster.byId[targetId];
    const targetNames = [tf.user.username, tf.user.display_name, (parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [targetId])?.persona_json) || {}).fighter_name].filter(Boolean);
    const spokenForms = [...new Set(targetNames.flatMap(n => names.variants(n)))].slice(0, 8);
    let j = null;
    if (aiOn()) {
        try {
            const r = await llm.complete({ role: 'chat', kind: 'arena_beef_judge', source: 'arena', ownerUserId: speakerId, system: BEEF_SYSTEM,
                user: JSON.stringify({ target_names: targetNames, target_as_transcribed: spokenForms, target_named_in_new_speech: named, how_the_name_was_matched: how, what_speaker_already_said_about_target: context || null, new_speech: text }),
                json: BEEF_SCHEMA, maxTokens: 240, temperature: 0.4, timeoutMs: 25000 });
            if (r && r.json && typeof r.json.quality === 'number') j = r.json;
        } catch (e) { console.warn('[Arena] beef judge:', e.message); }
    }
    if (!j) j = heuristicBeef(text, spokenForms.length ? spokenForms : targetNames.map(n => n.toLowerCase()), { named });
    const about = (j.about_target !== false) && !j.flagged;
    return { about_target: about, aimed_at_target: about && !!j.aimed_at_target, quality: Math.max(0, Math.min(10, Math.round(Number(j.quality) || 0))), best_line: String(j.best_line || '').slice(0, 220), about: String(j.about || '').slice(0, 80), announcer: String(j.announcer || '').slice(0, 140), flagged: !!j.flagged, fallback: !!j._fallback };
}

async function judgeMic(speakerId, text) {
    if (arena()._isBannedText(text)) return { is_trash_talk: false, quality: 0, best_line: '', about: 'voided', aimed_at: '', announcer: '', flagged: true };
    let j = null;
    if (aiOn()) {
        try {
            const r = await llm.complete({ role: 'chat', kind: 'arena_mic_judge', source: 'arena', ownerUserId: speakerId, system: MIC_SYSTEM, user: JSON.stringify({ speech: text }), json: MIC_SCHEMA, maxTokens: 240, temperature: 0.4, timeoutMs: 25000 });
            if (r && r.json && typeof r.json.quality === 'number') j = r.json;
        } catch (e) { console.warn('[Arena] mic judge:', e.message); }
    }
    if (!j) j = heuristicMic(text);
    return { is_trash_talk: !!j.is_trash_talk && !j.flagged, quality: Math.max(0, Math.min(10, Math.round(Number(j.quality) || 0))), best_line: String(j.best_line || '').slice(0, 220), about: String(j.about || '').slice(0, 80), aimed_at: String(j.aimed_at || '').toLowerCase().slice(0, 60), announcer: String(j.announcer || '').slice(0, 140), flagged: !!j.flagged, fallback: !!j._fallback };
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
 * following line goes to the beef judge with the earlier context. Each judged hit extends the lock
 * (FOCUS_EXTEND_MS); two chunks in a row that are not about the target, or FOCUS_MAX_MS since the
 * last actual name-drop, drop it. A different name-drop switches focus.
 */
const FOCUS_TAIL_MS = 2 * 60 * 1000;
const FOCUS_EXTEND_MS = 3 * 60 * 1000;
const FOCUS_MAX_MS = 20 * 60 * 1000;
const FOCUS_MISSES_TO_DROP = 2;

function newFocus(targetId, now, how) { return { targetId, since: now, namedAt: now, lockUntil: now + FOCUS_TAIL_MS, lines: [], misses: 0, hits: 0, context: null, how }; }

async function judgeFocus(stream, roster, st, events, { reason }) {
    const f = st.focus;
    if (!f || !f.lines.length) return false;
    const text = bufferText(f.lines);
    const lines = f.lines; f.lines = [];
    const named = lines.some(l => l.named);
    st.lastJudgeAt = Date.now();
    const j = await judgeBeef(stream.user_id, f.targetId, text, roster, { context: f.context, named, how: f.how });
    const now = Date.now();
    const minQ = f.hits > 0 ? 3 : (f.how === 'exact' ? 3 : 5);
    if (j.aimed_at_target && j.quality >= minQ) {
        const ref = lineRefFor(lines, j.best_line);
        const res = beef().recordHit(stream.user_id, f.targetId, { quality: j.quality, best_line: j.best_line, about: j.about, announcer: j.announcer, vod_id: ref.vod_id, sec: ref.sec, stream_id: stream.id });
        f.hits++; f.misses = 0; f.lockUntil = Math.min(now + FOCUS_EXTEND_MS, f.namedAt + FOCUS_MAX_MS);
        f.context = `${f.context ? f.context + ' | ' : ''}${j.about}${j.best_line ? ` ("${j.best_line.slice(0, 120)}")` : ''}`.slice(-600);
        st.lastBeefJudgement = { at: new Date().toISOString(), target_id: f.targetId, ...j, opened: res?.opened, named, reason };
        events.push({ kind: 'beef_hit', streamId: stream.id, speakerId: stream.user_id, targetId: f.targetId, opened: res?.opened, quality: j.quality, line: j.best_line, named, continued: !named });
        return true;
    }
    if (j.about_target) {
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

/** Free talk (not locked on anyone): is it shit talk at all, and at whom? */
async function judgeFreeTalk(stream, roster, st, events) {
    const lines = st.mic.lines; st.mic.lines = [];
    const text = bufferText(lines);
    st.lastJudgeAt = Date.now();
    const j = await judgeMic(stream.user_id, text);
    st.lastMicJudgement = { at: new Date().toISOString(), ...j };
    if (!j.is_trash_talk || j.quality < MIC_MIN_QUALITY) { events.push({ kind: 'mic_miss', streamId: stream.id, speakerId: stream.user_id, about: j.about }); return; }
    const ref = lineRefFor(lines, j.best_line);
    // "aimed_at" that resolves to a roster fighter = a callout → it feeds a beef exactly like a name-drop.
    const target = j.aimed_at ? mentionsDetailed(j.aimed_at, stream.user_id, roster)[0] : null;
    if (target && j.quality >= CALLOUT_MIN_QUALITY) {
        const res = beef().recordHit(stream.user_id, target.userId, { quality: j.quality, best_line: j.best_line, about: j.about, announcer: j.announcer, vod_id: ref.vod_id, sec: ref.sec, stream_id: stream.id });
        st.lastMicJudgement.target_id = target.userId; st.lastMicJudgement.opened = res?.opened;
        events.push({ kind: 'beef_hit', streamId: stream.id, speakerId: stream.user_id, targetId: target.userId, opened: res?.opened, quality: j.quality, line: j.best_line, named: false, callout: true });
        return;
    }
    const m = mic().addMoment({ userId: stream.user_id, streamId: stream.id, vodId: ref.vod_id, sec: ref.sec, kind: 'trash', aimedAt: j.aimed_at || null, text: j.best_line || text.slice(0, 220), about: j.about, quality: j.quality, announcer: j.announcer });
    if (m) events.push({ kind: 'mic_hit', streamId: stream.id, speakerId: stream.user_id, quality: j.quality, line: j.best_line, aimedAt: j.aimed_at, momentId: m.id });
}

async function tickStream(stream, roster, events) {
    let st = state.get(stream.id);
    if (!st) { st = { userId: stream.user_id, lastOffset: streamOffsetNow(stream) - 20, lastJudgeAt: 0, focus: null, mic: { lines: [] } }; state.set(stream.id, st); }
    const rows = db.all(`SELECT text, start_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec > ? ORDER BY start_sec ASC LIMIT 100`, [stream.id, st.lastOffset]);
    if (rows.length) st.lastOffset = rows[rows.length - 1].start_sec;
    const now = Date.now();
    if (st.focus && now > st.focus.lockUntil) {
        if (st.focus.lines.length && st.focus.lines.reduce((n, l) => n + words(l.t), 0) >= JUDGE_MIN_WORDS && now - st.lastJudgeAt >= JUDGE_MIN_INTERVAL_MS) await judgeFocus(stream, roster, st, events, { reason: 'lock expired' });
        if (st.focus) { events.push({ kind: 'focus_dropped', streamId: stream.id, targetId: st.focus.targetId, hits: st.focus.hits, why: 'timeout' }); st.focus = null; }
    }
    for (const r of rows) {
        const line = { t: String(r.text || ''), s: Math.floor(r.start_sec), v: r.vod_id || null, named: false };
        const mentions = mentionsDetailed(line.t, stream.user_id, roster);
        if (mentions.length) {
            const m = mentions[0];
            line.named = true;
            if (st.focus && st.focus.targetId !== m.userId) {
                if (st.focus.lines.reduce((n, l) => n + words(l.t), 0) >= JUDGE_MIN_WORDS) await judgeFocus(stream, roster, st, events, { reason: 'target switch' });
                st.focus = null;
            }
            if (!st.focus) { st.focus = newFocus(m.userId, now, m.how); events.push({ kind: 'focus', streamId: stream.id, speakerId: stream.user_id, targetId: m.userId, how: m.how, hit: m.hit }); }
            else { st.focus.namedAt = now; st.focus.lockUntil = Math.max(st.focus.lockUntil, now + FOCUS_TAIL_MS); st.focus.misses = 0; }
            st.focus.lines.push(line);
        } else if (st.focus) {
            st.focus.lines.push(line);
        } else {
            st.mic.lines.push(line);
        }
    }
    if (st.focus && st.focus.lines.length > 80) st.focus.lines = st.focus.lines.slice(-80);
    if (st.mic.lines.length > 60) st.mic.lines = st.mic.lines.slice(-60);

    if (now - st.lastJudgeAt < JUDGE_MIN_INTERVAL_MS) return;

    // 1) Locked on a fighter → the beef judge (a callout is the interesting thing).
    if (st.focus && st.focus.lines.reduce((n, l) => n + words(l.t), 0) >= JUDGE_MIN_WORDS) {
        await judgeFocus(stream, roster, st, events, { reason: st.focus.lines.some(l => l.named) ? 'name-drop' : 'continuation' });
        return; // one judge call per stream per tick
    }
    // 2) Free talk → the mic judge.
    if (!st.focus && st.mic.lines.reduce((n, l) => n + words(l.t), 0) >= JUDGE_MIN_WORDS) await judgeFreeTalk(stream, roster, st, events);
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
            focus: f ? { target_id: f.targetId, target: (() => { try { return mic().nameOf(f.targetId); } catch { return null; } })(), how: f.how, since: new Date(f.since).toISOString(), lock_seconds_left: Math.max(0, Math.round((f.lockUntil - Date.now()) / 1000)), hits: f.hits, misses: f.misses, pending_words: f.lines.reduce((n, l) => n + words(l.t), 0), context: f.context } : null,
            pending_mic_words: st.mic.lines.reduce((n, l) => n + words(l.t), 0),
            last_mic_judgement: st.lastMicJudgement || null, last_beef_judgement: st.lastBeefJudgement || null, last_judge_at: st.lastJudgeAt ? new Date(st.lastJudgeAt).toISOString() : null,
        };
    }
    return { listening: false };
}

function start() {
    if (_timer) return;
    _timer = setInterval(() => tick().catch(e => console.warn('[Arena] listener:', e.message)), TICK_MS);
    if (_timer.unref) _timer.unref();
    console.log('[Arena] listener started (every 15 s — name-drops → beef judge, free talk → mic judge)');
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, tick, consoleState, TICK_MS, JUDGE_MIN_WORDS, JUDGE_MIN_INTERVAL_MS, MIC_MIN_QUALITY, CALLOUT_MIN_QUALITY, FOCUS_TAIL_MS, FOCUS_EXTEND_MS, FOCUS_MAX_MS, SPICY, _mentionsIn: mentionsIn, _mentionsDetailed: mentionsDetailed, _aliases: aliases, _heuristicBeef: heuristicBeef, _heuristicMic: heuristicMic, _judgeBeef: judgeBeef, _judgeMic: judgeMic, _state: state };
