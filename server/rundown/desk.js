'use strict';
/**
 * The Rundown's desk (docs/rundown.md): what streamers talk about, written up.
 *
 * Every TICK_MS it reads streams' speech-to-text (stream_timeline_events, kind 'speech') a stretch at a time and asks
 * OpenVibe.AI (`live.rundown.segment`) what the streamer talked about in it. Each answer becomes segments
 * (rundown_segments): a topic, a headline, what they said, their take, the desk's quip and up to two of their own lines.
 * A finished stream becomes an episode (`live.rundown.episode`: title, logline, recap, chapters); a topic that gathers
 * takes gets its page rewritten (`live.rundown.topic`).
 *
 *   A live stream is read once its unread talk holds READ_WORDS words or spans READ_SPAN_SEC seconds; an ended one,
 *   whatever is left (TAIL_WORDS or more), then its episode. Streams that ended within BACKFILL_DAYS are read too, newest
 *   first, so the page has the last week the day it ships.
 *   At most CALLS_PER_TICK AI calls a tick and CALLS_PER_HOUR an hour, only while AI is on and within budget.
 *
 * What is kept (server/rundown/filters.js): a game's announcer lines never reach the AI; a quote survives only when it
 * is in the transcript word for word; a headline, account or take that uses an accusing word the transcript never used
 * drops the segment (a quip, only the quip); every text passes db.noLooks(). Streamers in arena_opt_outs (the Arena's
 * opt-out, kept for the Rundown) are never read. A streamer named in a segment is named by their whole username or
 * display name in the segment's own lines (server/arena/names.js, wholeOnly), never a sound-alike.
 */
const db = require('../db/database');
const filters = require('./filters');

const TICK_MS = 5 * 60 * 1000;
const READ_WORDS = 700;
const READ_SPAN_SEC = 10 * 60;
const MIN_WORDS = 150;
const TAIL_WORDS = 120;
const MAX_WORDS = 2400;
const MAX_LINES = 380;          // the workflow takes at most 400 lines (Greek and other short-line speech hit it first)
const MAX_FAILS = 3;            // a stretch the AI refused this often is skipped, not retried every tick
const BACKFILL_DAYS = 7;
const CALLS_PER_TICK = 4;
const CALLS_PER_HOUR = 40;
const KNOWN_TOPICS = 50;
const MIN_SCORE = 3;            // a 1-2 is filler ("heading out for coffee", a garbled stretch): not kept
const ANNOUNCE_PER_HOUR = 3;
const ANNOUNCE_WITHIN_H = 6;

let _calls = [];
let _fails = new Map();          // stream id → { at: read_to_sec, n }
let _repeated = { at: 0, set: new Set() };
let _langs = new Map();          // user id → { at, set } of the languages they speak
const OWN_LANGUAGE_SHARE = 0.1;  // a language is theirs at 10% of their lines or more
let _announced = [];
let _busy = false;
let _job = null;

const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const toMs = (t) => { const ms = Date.parse(String(t || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(t || '')) ? '' : 'Z')); return Number.isFinite(ms) ? ms : null; };
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const daysAgo = (n) => sqlTime(Date.now() - n * 86400000);

async function enabled() {
    try { const v = await db.getSetting('rundown_enabled'); return v === null || v === undefined || v === true || v === 'true' || v === 1 || v === '1'; } catch { return true; }
}
async function aiOn() {
    try { const llm = require('../ai/llm'); return await llm.isEnabled() && await llm.withinBudget(); } catch { return false; }
}
function budgetLeft() {
    const now = Date.now();
    _calls = _calls.filter((t) => now - t < 3600_000);
    return _calls.length < CALLS_PER_HOUR;
}
async function ai(workflow, input, userId) {
    _calls.push(Date.now());
    return await require('../ai/ai-service').structured(workflow, input, { meter: { kind: workflow.replace(/^live\./, '').replace(/\./g, '_'), role: 'chat', ownerUserId: userId, source: 'rundown' } });
}
const clean = (t, n) => {
    const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    const out = s ? (db.noLooks ? db.noLooks(s) : s) : '';
    return String(out || '').trim().slice(0, n) || null;
};

// ── Who can be named ─────────────────────────────────────────
let _people = { at: 0, entries: [] };
/**
 * Name entries for every streamer who streamed in the last 60 days. Only a whole name counts (server/arena/names.js),
 * and never a name that is an everyday word or shorter than 5 letters: "you rubes" names nobody.
 */
async function nameEntries() {
    if (Date.now() - _people.at < 10 * 60 * 1000) return _people.entries;
    const rows = await db.all('SELECT u.id, u.username, u.display_name FROM users u WHERE u.id IN (SELECT DISTINCT user_id FROM streams WHERE started_at >= ?)', [daysAgo(60)]);
    const names = require('../arena/names');
    const roster = { order: rows.map((r) => r.id), byId: Object.fromEntries(rows.map((r) => [r.id, { user: r }])) };
    const entries = names.rosterEntries(roster).filter((e) => e.whole && String(e.name).replace(/[^a-z0-9]/gi, '').length >= 5 && !names.COMMON.has(String(e.name).toLowerCase()));
    _people = { at: Date.now(), entries };
    return _people.entries;
}
async function mentionsIn(text, speakerId) {
    const found = require('../arena/names').findMentions(text, await nameEntries(), { excludeUserId: speakerId, wholeOnly: true });
    return [...new Set(found.map((m) => Number(m.userId)).filter(Boolean))];
}

// ── Topics ───────────────────────────────────────────────────
async function knownTopics() {
    return (await db.all("SELECT title FROM rundown_topics WHERE status = 'live' AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT ?", [daysAgo(30), KNOWN_TOPICS])).map((r) => r.title);
}
/** The topic for a name: the same slug, else a recent topic with most of the same key words, else a new one. */
async function topicFor(title, kind, at) {
    const slug = filters.slugify(title);
    if (!slug) return null;
    let row = await db.get('SELECT id, title FROM rundown_topics WHERE slug = ?', [slug]);
    if (!row) {
        const recent = await db.all('SELECT id, title FROM rundown_topics WHERE last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 300', [daysAgo(60)]);
        row = recent.find((t) => filters.sameTopic(t.title, title)) || null;
    }
    if (!row) {
        row = await db.get(`INSERT INTO rundown_topics (slug, title, kind, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (slug) DO UPDATE SET last_seen_at = rundown_topics.last_seen_at RETURNING id, title`, [slug, String(title).slice(0, 120), kind || 'other', at, at]);
    }
    return row;
}
async function recountTopic(topicId) {
    await db.run(`UPDATE rundown_topics SET
        takes = (SELECT COUNT(*) FROM rundown_segments WHERE topic_id = ? AND status = 'live'),
        streamers = (SELECT COUNT(DISTINCT user_id) FROM rundown_segments WHERE topic_id = ? AND status = 'live'),
        last_seen_at = COALESCE((SELECT MAX(said_at) FROM rundown_segments WHERE topic_id = ? AND status = 'live'), last_seen_at)
        WHERE id = ?`, [topicId, topicId, topicId, topicId]);
}

// ── Reading a stream ─────────────────────────────────────────
async function optedOut(userId) { try { return !!await db.get('SELECT 1 FROM arena_opt_outs WHERE user_id = ?', [userId]); } catch { return false; } }

/** Streams with unread speech or a missing episode: live ones first, then the newest ended ones. */
async function candidates() {
    return await db.all(`SELECT s.id, s.user_id, s.title, s.category, s.is_live, s.started_at, s.ended_at, s.peak_viewers, s.duration_seconds,
            COALESCE(p.read_to_sec, -1) AS read_to_sec
        FROM streams s LEFT JOIN rundown_progress p ON p.stream_id = s.id
        WHERE COALESCE(p.done, 0) = 0 AND (s.is_live = 1 OR s.ended_at >= ? OR s.started_at >= ?)
          AND EXISTS (SELECT 1 FROM stream_timeline_events e WHERE e.stream_id = s.id AND e.kind = 'speech')
        ORDER BY s.is_live DESC, COALESCE(s.ended_at, s.started_at) DESC
        LIMIT 60`, [daysAgo(BACKFILL_DAYS), daysAgo(BACKFILL_DAYS)]);
}
async function setProgress(streamId, readTo, done = 0) {
    await db.run(`INSERT INTO rundown_progress (stream_id, read_to_sec, done, updated_at) VALUES (?, ?, ?, ov_now())
        ON CONFLICT (stream_id) DO UPDATE SET read_to_sec = GREATEST(rundown_progress.read_to_sec, excluded.read_to_sec), done = excluded.done, updated_at = ov_now()`, [streamId, readTo, done]);
}

/**
 * Lines heard word for word on 3+ different streams in 30 days: a game's voice lines ("Wanna see a trick?", "An ally has
 * been slain."), speech-to-text's hallucinations on silence ("Thanks for watching, and I'll see you in the next video.",
 * "ご視聴ありがとうございました") and stock filler. None is anyone's take, so none reaches the AI or can be quoted.
 */
async function repeatedLines() {
    if (Date.now() - _repeated.at < 3600_000) return _repeated.set;
    const rows = await db.all(`SELECT text FROM stream_timeline_events WHERE kind = 'speech' AND created_at >= ? AND length(text) >= 8
        GROUP BY text HAVING COUNT(DISTINCT stream_id) >= 3`, [daysAgo(30)]);
    _repeated = { at: Date.now(), set: new Set(rows.map((r) => filters.norm(r.text))) };
    return _repeated.set;
}

/**
 * The languages a streamer speaks: those in 10% or more of their lines over 30 days (their top one always). A line in
 * any other language is something playing on their stream (iZoR_One speaks Greek and English; a Portuguese clip in the
 * background was written up as their story, 2026-10-19). null when there are too few lines to tell.
 */
async function ownLanguages(userId) {
    const c = _langs.get(userId);
    if (c && Date.now() - c.at < 6 * 3600_000) return c.set;
    const rows = await db.all("SELECT text FROM stream_timeline_events WHERE user_id = ? AND kind = 'speech' AND created_at >= ? ORDER BY id DESC LIMIT 4000", [userId, daysAgo(30)]);
    const counts = new Map();
    let total = 0;
    for (const r of rows) { const l = filters.lineLang(r.text); if (l) { counts.set(l, (counts.get(l) || 0) + 1); total++; } }
    let set = null;
    if (total >= 50) {
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        set = new Set(ranked.filter(([, n], i) => i === 0 || n / total >= OWN_LANGUAGE_SHARE).map(([l]) => l));
    }
    _langs.set(userId, { at: Date.now(), set });
    return set;
}

/** The next stretch: speech lines after read_to_sec; game lines, repeated lines and lines in a language the streamer does not speak out; at most MAX_WORDS. */
async function nextStretch(stream) {
    const rows = await db.all(`SELECT start_sec, text, vod_id FROM stream_timeline_events
        WHERE stream_id = ? AND kind = 'speech' AND start_sec > ? ORDER BY start_sec ASC LIMIT 800`, [stream.id, stream.read_to_sec]);
    const repeated = await repeatedLines();
    const langs = await ownLanguages(stream.user_id);
    const theirs = (text) => { if (!langs) return true; const l = filters.lineLang(text); return !l || langs.has(l); };
    const lines = [];
    let n = 0, lastSec = Number(stream.read_to_sec);
    for (const r of rows) {
        const text = String(r.text || '').replace(/\s+/g, ' ').trim();
        const w = words(text);
        if (text && !filters.gameLine(text) && !repeated.has(filters.norm(text)) && theirs(text)) {
            if ((n + w > MAX_WORDS || lines.length >= MAX_LINES) && lines.length) break;
            lines.push({ t: Math.round(Number(r.start_sec) * 10) / 10, text: text.slice(0, 1000), vod_id: r.vod_id });
            n += w;
        }
        lastSec = Number(r.start_sec);   // read up to here (a game line or an empty one is read too)
    }
    return { lines, words: n, lastSec, unread: rows.length };
}

/** Is this stretch ready to read now? A live stream waits for enough talk; an ended one is read to the end. */
function ready(stream, stretch) {
    if (!stretch.lines.length) return false;
    if (!Number(stream.is_live)) return stretch.words >= TAIL_WORDS;
    const span = stretch.lines[stretch.lines.length - 1].t - stretch.lines[0].t;
    return stretch.words >= MAX_WORDS * 0.9 || stretch.words >= READ_WORDS || (span >= READ_SPAN_SEC && stretch.words >= MIN_WORDS);
}

/**
 * Store the AI's segments for one stretch. Returns the number kept. `others` are the times of the lines the AI decided
 * were not the streamer (a game character, a video, other people): a quote from one goes, and a segment whose lines are
 * mostly theirs goes too.
 */
async function keepSegments(stream, stretch, segments, user, others = []) {
    const notTheirs = new Set((others || []).map((t) => Math.round(Number(t) * 10)));
    const isOther = (l) => notTheirs.has(Math.round(Number(l.t) * 10));
    const own = stretch.lines.filter((l) => !isOther(l));
    const source = own.map((l) => l.text).join('\n');
    const startedMs = toMs(stream.started_at) || Date.now();
    let kept = 0;
    for (const s of segments || []) {
        const title = clean(s.title, 90), what = clean(s.what, 500), take = clean(s.take, 300);
        let quip = clean(s.quip, 220);
        if (!title || !what || !s.topic || (Number(s.score) || 1) < MIN_SCORE) continue;
        // An accusation the transcript never made is the desk's invention: the segment goes (its quip alone, the quip).
        if (filters.addsAccusation(`${title} ${what} ${take || ''}`, source)) continue;
        // A detail that places someone (a time zone, a school, an address…) drops the segment; in a quip, the quip.
        if (filters.privateDetail(`${s.topic} ${title} ${what} ${take || ''}`)) continue;
        if (quip && (filters.addsAccusation(quip, source) || filters.privateDetail(quip))) quip = null;
        const span = stretch.lines.filter((l) => l.t >= Number(s.start) - 1 && l.t <= Number(s.end) + 1);
        if (span.length && span.filter(isOther).length / span.length > 0.6) continue;
        const spanText = (span.length ? span.filter((l) => !isOther(l)) : own).map((l) => l.text).join('\n');
        const quotes = (s.quotes || []).map((q) => {
            const text = filters.verifiedQuote(q.text, source);
            if (!text || filters.privateDetail(text) || (q.en && filters.privateDetail(q.en))) return null;
            return { text, sec: Number(q.t) || Number(s.start) || 0, en: q.en ? clean(q.en, 400) : null };
        }).filter(Boolean).slice(0, 2);
        const at = sqlTime(startedMs + (Number(s.start) || 0) * 1000);
        const topic = await topicFor(clean(s.topic, 120), s.kind, at);
        const vod = (span.find((l) => l.vod_id) || stretch.lines.find((l) => l.vod_id) || {}).vod_id || null;
        await db.run(`INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, take, quip, score, quotes_json, mentions, vod_id, said_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stream.id, user.id, topic ? topic.id : null, Number(s.start) || 0, Number(s.end) || Number(s.start) || 0, title, what, take, quip,
            Math.min(5, Math.max(1, Number(s.score) || 1)), JSON.stringify(quotes), await mentionsIn(spanText, user.id), vod, at]);
        if (topic) await recountTopic(topic.id);
        kept++;
    }
    return kept;
}

async function readStretch(stream, user) {
    const stretch = await nextStretch(stream);
    if (!stretch.unread) return { called: false };
    if (!ready(stream, stretch)) {
        // An ended stream's last few words, or nothing but game lines: nothing to read; move past them.
        if (!Number(stream.is_live) || (!stretch.lines.length && stretch.unread)) await setProgress(stream.id, stretch.lastSec);
        return { called: false };
    }
    const earlier = (await db.all('SELECT title FROM rundown_segments WHERE stream_id = ? ORDER BY start_sec DESC LIMIT 6', [stream.id])).map((r) => r.title).reverse().join('; ');
    const out = await ai('live.rundown.segment', {
        streamer: user.display_name || user.username, title: String(stream.title || '').slice(0, 200), category: String(stream.category || '').slice(0, 80),
        topics: await knownTopics(), earlier: earlier.slice(0, 800), lines: stretch.lines.map(({ t, text }) => ({ t, text })),
    }, user.id);
    if (!out || !Array.isArray(out.segments)) {
        // Refused or failed: try again next tick, but a stretch that keeps failing is skipped rather than retried forever.
        const f = _fails.get(stream.id);
        const n = f && f.at === stream.read_to_sec ? f.n + 1 : 1;
        _fails.set(stream.id, { at: stream.read_to_sec, n });
        if (n >= MAX_FAILS) { _fails.delete(stream.id); await setProgress(stream.id, stretch.lastSec); console.warn(`[Rundown] stream ${stream.id}: skipped a stretch the AI refused ${n} times`); }
        return { called: true, failed: true };
    }
    _fails.delete(stream.id);
    const kept = await keepSegments(stream, stretch, out.segments, user, out.others);
    await setProgress(stream.id, stretch.lastSec);
    return { called: true, kept };
}

// ── Episodes ─────────────────────────────────────────────────
async function writeEpisode(stream, user) {
    const segs = await db.all("SELECT id, start_sec, title, what, take, quotes_json, vod_id, topic_id FROM rundown_segments WHERE stream_id = ? AND status = 'live' ORDER BY start_sec ASC LIMIT 40", [stream.id]);
    if (!segs.length) { await setProgress(stream.id, stream.read_to_sec, 1); return { called: false }; }
    const topics = new Map((await db.all('SELECT id, title FROM rundown_topics WHERE id = ANY(?)', [[...new Set(segs.map((s) => s.topic_id).filter(Boolean))]])).map((t) => [t.id, t.title]));
    let chat = null;
    const minutes = Math.max(0, Math.round((Number(stream.duration_seconds) || ((toMs(stream.ended_at) || Date.now()) - (toMs(stream.started_at) || Date.now())) / 1000) / 60));
    const out = await ai('live.rundown.episode', {
        streamer: user.display_name || user.username, title: String(stream.title || '').slice(0, 200), category: String(stream.category || '').slice(0, 80), minutes,
        peak_viewers: Number.isFinite(Number(stream.peak_viewers)) ? Number(stream.peak_viewers) : null, chat_messages: Number.isFinite(Number(chat)) ? Number(chat) : null,
        segments: segs.map((s) => ({ t: Math.round(Number(s.start_sec)), topic: topics.get(s.topic_id) || undefined, title: s.title, what: s.what, take: s.take || null, quotes: parseJson(s.quotes_json, []).map((q) => q.en || q.text).slice(0, 2) })),
    }, user.id);
    if (!out || !out.title || !out.recap) return { called: true, failed: true };
    const source = segs.map((s) => `${s.title} ${s.what} ${s.take || ''} ${parseJson(s.quotes_json, []).map((q) => q.text).join(' ')}`).join('\n');
    const recap = filters.addsAccusation(out.recap, source) || filters.privateDetail(out.recap) ? null : clean(out.recap.replace(/\n\s*\n/g, ' ¶ '), 1400);
    const title = clean(out.title, 80);
    if (!title || filters.addsAccusation(`${out.title} ${out.logline || ''}`, source) || filters.privateDetail(`${out.title} ${out.logline || ''}`)) { await setProgress(stream.id, stream.read_to_sec, 1); return { called: true, failed: true }; }
    const chapters = (out.chapters || []).map((c) => segs[c.index] ? { sec: Math.round(Number(segs[c.index].start_sec)), title: clean(c.title, 60), segment_id: segs[c.index].id } : null).filter((c) => c && c.title);
    const vod = (segs.find((s) => s.vod_id) || {}).vod_id || null;
    await db.run(`INSERT INTO rundown_episodes (stream_id, user_id, title, logline, recap, chapters_json, vod_id, minutes, aired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stream_id) DO UPDATE SET title = excluded.title, logline = excluded.logline, recap = excluded.recap,
        chapters_json = excluded.chapters_json, vod_id = excluded.vod_id, minutes = excluded.minutes`,
    [stream.id, user.id, title, clean(out.logline, 220), recap ? recap.replace(/ ¶ /g, '\n\n') : null, JSON.stringify(chapters), vod, minutes, stream.started_at || sqlTime(Date.now())]);
    await setProgress(stream.id, stream.read_to_sec, 1);
    await announce(stream, user, title).catch(() => {});
    return { called: true, episode: true };
}

/** A fresh episode (its stream ended within ANNOUNCE_WITHIN_H hours) goes to global chat, at most ANNOUNCE_PER_HOUR an hour. */
async function announce(stream, user, title) {
    const ended = toMs(stream.ended_at);
    if (!ended || Date.now() - ended > ANNOUNCE_WITHIN_H * 3600_000) return false;
    const now = Date.now();
    _announced = _announced.filter((t) => now - t < 3600_000);
    if (_announced.length >= ANNOUNCE_PER_HOUR) return false;
    _announced.push(now);
    let base = 'https://openvibe.live';
    try { base = String(require('../config').baseUrl || base).replace(/\/$/, ''); } catch { /* */ }
    const url = `${base}/rundown/e/${stream.id}`;
    await require('../chat/chat-delivery').message({ username: 'THE RUNDOWN', user_id: null, message: `📰 ${user.display_name || user.username}: “${title}” → ${url}`.slice(0, 480), message_type: 'system', key: `rundown:episode:${stream.id}`, metadata: { rundown_episode: stream.id, url }, is_global: true });
    return true;
}

// ── Topic pages ──────────────────────────────────────────────
async function refreshTopic(topicId) {
    const topic = await db.get('SELECT id, title FROM rundown_topics WHERE id = ?', [topicId]);
    if (!topic) return { called: false };
    const takes = await db.all(`SELECT s.what, s.take, s.quotes_json, s.said_at, u.username, u.display_name FROM rundown_segments s JOIN users u ON u.id = s.user_id
        WHERE s.topic_id = ? AND s.status = 'live' ORDER BY s.said_at ASC LIMIT 30`, [topicId]);
    if (!takes.length) return { called: false };
    const out = await ai('live.rundown.topic', { topic: topic.title, takes: takes.map((t) => ({ streamer: t.display_name || t.username, when: String(t.said_at).slice(0, 10), what: t.what, take: t.take || null, quote: (parseJson(t.quotes_json, [])[0] || {}).text || null })) }, null);
    const source = takes.map((t) => `${t.what} ${t.take || ''} ${parseJson(t.quotes_json, []).map((q) => q.text).join(' ')}`).join('\n');
    if (!out || !out.summary || filters.addsAccusation(`${out.headline || ''} ${out.summary}`, source) || filters.privateDetail(`${out.headline || ''} ${out.summary}`)) {
        await db.run('UPDATE rundown_topics SET summary_takes = ?, summary_at = ov_now() WHERE id = ?', [takes.length, topicId]);
        return { called: true, failed: true };
    }
    await db.run('UPDATE rundown_topics SET headline = ?, summary = ?, summary_takes = ?, summary_at = ov_now() WHERE id = ?', [clean(out.headline, 100), clean(out.summary, 700), takes.length, topicId]);
    return { called: true };
}
/** Topics with new takes since their page was written: two or more takes, the busiest first. */
async function staleTopics(limit) {
    return await db.all(`SELECT id FROM rundown_topics WHERE status = 'live' AND takes >= 2 AND takes > summary_takes
        AND (summary_at IS NULL OR summary_at <= ?) ORDER BY streamers DESC, takes DESC, last_seen_at DESC LIMIT ?`, [sqlTime(Date.now() - 20 * 60 * 1000), limit]);
}

// ── The tick ─────────────────────────────────────────────────
async function tick() {
    if (_busy || !await enabled() || !await aiOn()) return { skipped: true };
    _busy = true;
    const done = { segments: 0, episodes: 0, topics: 0, calls: 0 };
    try {
        let calls = 0;
        for (const stream of await candidates()) {
            if (calls >= CALLS_PER_TICK || !budgetLeft()) break;
            const user = await db.get('SELECT id, username, display_name FROM users WHERE id = ?', [stream.user_id]);
            if (!user || await optedOut(user.id)) { await setProgress(stream.id, stream.read_to_sec, 1); continue; }
            const r = await readStretch(stream, user);
            if (r.called) { calls++; done.segments += r.kept || 0; continue; }
            // Read to the end and over: the episode.
            if (!Number(stream.is_live)) {
                const fresh = await db.get('SELECT read_to_sec FROM rundown_progress WHERE stream_id = ?', [stream.id]);
                const left = await db.get("SELECT COUNT(*) AS n FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec > ?", [stream.id, fresh ? fresh.read_to_sec : -1]);
                if (!Number(left && left.n)) {
                    const e = await writeEpisode({ ...stream, read_to_sec: fresh ? fresh.read_to_sec : stream.read_to_sec }, user);
                    if (e.called) { calls++; if (e.episode) done.episodes++; }
                }
            }
        }
        for (const t of await staleTopics(Math.max(0, CALLS_PER_TICK - calls))) {
            if (!budgetLeft()) break;
            const r = await refreshTopic(t.id);
            if (r.called) { calls++; if (!r.failed) done.topics++; }
        }
        done.calls = calls;
    } finally { _busy = false; }
    if (done.segments || done.episodes || done.topics) console.log(`[Rundown] ${done.segments} segment(s), ${done.episodes} episode(s), ${done.topics} topic page(s) from ${done.calls} AI call(s)`);
    return done;
}

function start() {
    if (_job) return;
    _job = require('../utils/jobs').every('rundown-desk', TICK_MS, () => tick().catch((e) => console.warn('[Rundown] desk:', e.message)), { initialDelayMs: 60_000, jitterMs: 20_000 });
    console.log(`[Rundown] desk started (every ${TICK_MS / 60000} min; at most ${CALLS_PER_TICK} AI calls a tick, ${CALLS_PER_HOUR} an hour)`);
}
function stop() { if (typeof _job === 'function') _job(); _job = null; }

module.exports = { start, stop, tick, readStretch, writeEpisode, refreshTopic, keepSegments, topicFor, nextStretch, ready, optedOut, MAX_LINES, _test: { reset() { _calls = []; _announced = []; _fails = new Map(); _repeated = { at: 0, set: new Set() }; _langs = new Map(); _people = { at: 0, entries: [] }; } } };
