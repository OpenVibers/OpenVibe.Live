/**
 * drama.js — ARENA ALERT, the Arena's drama-news desk (Arena v4, 2026-10-16; the owner: "drama alert type competitive
 * shit … based on streamer activity").
 *
 * Detectors read what streamers actually did and turn each event into a story (arena_drama, one per event by
 * dedupe_key). Every 5 min (arena-job.js) over the last 3 hours:
 *
 *   rage_quit      a stream over in under 15 min from someone who usually goes 45+
 *   viewer_crash   viewers halve within 20 min (from 3+)          viewer_spike   viewers double within 20 min (to 4+)
 *   chat_explosion chat 3x the stream's usual rate (15+ in 5 min) meltdown / tears   3+ yells, screams, shouts or sobs
 *                  heard within 2 min (the sound timeline), with what they said around it
 *   marathon       8+ hours live                                  ghost_town     an hour or more to 0-1 viewers, no chat
 *   the_return     live again after 14+ days away                 title_drama    a title that is a cry for help
 *   peak_record    a new personal viewer peak (3+)
 * and once a day: fell_off (4+ streams the month before, none for 7 days), streak (every 7 days in a row live),
 * quote_of_day (the best judged mic line). Beefs report themselves (beef.js → beefStory).
 *
 * A story is written at once from a template (grounded, already spicy) and rewritten by OpenVibe.AI's
 * live.arena.drama in the desk's voice (headline, blurb, alert 1-5) when AI is on, at most AI_PER_HOUR an hour.
 * Each story moves two scores: cow_points (the Lolcow Index: rage quits, crashes, meltdowns, L's) and clout_points
 * (the Clout Rankings: spikes, records, marathons, W's). Streamers in arena_opt_outs get no stories.
 *
 *   detect({ now })            run every detector; returns { created }
 *   beefStory(kind, beef, ctx) a beef opened / won / forfeited
 *   feed({ limit, before, user, voterKey })   stories, newest first, with reaction counts (and the viewer's)
 *   react(id, reaction, voterKey)             one reaction per viewer per story (changing it replaces it)
 *   lolcowIndex({ days }) · cloutRankings()   the two boards; rankings carry this week's moves
 *   rapSheet(userId)                           one streamer's dossier
 *   setOptOut(userId, out)                     keep a streamer out (and hide their stories) or let them back in
 *   announce(id)                               a 3+ alert story as a line in chat (the live stream's room, else global)
 */
'use strict';

const db = require('../db/database');

const AI_PER_HOUR = 20;
const WINDOW_MS = 3 * 3600 * 1000;
const REACTIONS = ['fire', 'skull', 'clown', 'w', 'l'];
const RAGE_SOUNDS = new Set(['Yell', 'Screaming', 'Shout', 'Bellow', 'Battle cry', 'Groan', 'Wail, moan']);
const TEAR_SOUNDS = new Set(['Crying, sobbing', 'Whimper']);
const TITLE_DRAMA = /\b(quit(?:ting)?|i'?m done|done with|last stream|retir(?:e|ing|ed)|drama|exposed|expos(?:e|ing)|banned|apolog(?:y|ize|ise)|beef|rigged|scam(?:med)?|cancel+ed|rant|meltdown|crash(?:ing)? out|rage|tilted|hate (?:this|my)|worst (?:day|stream))\b/i;

const toMs = (s) => { if (!s) return NaN; const t = String(s); return Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`); };
const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const arena = () => require('./arena-service');

const _names = new Map();
async function nameOf(userId) {
    if (_names.has(userId)) return _names.get(userId);
    const u = await db.get('SELECT username, display_name FROM users WHERE id = ?', [userId]);
    const n = u ? (u.display_name || u.username) : `user ${userId}`;
    if (_names.size > 2000) _names.clear();
    _names.set(userId, n);
    return n;
}
async function optedOut(userId) { return !!await db.get('SELECT 1 FROM arena_opt_outs WHERE user_id = ?', [userId]); }

// ── Templates: the story before (or without) AI. Facts only, numbers stated. ──
const T = {
    rage_quit: (n, f) => [`🚨 ${n} RAGE QUIT? Stream over after ${f.minutes_live} minutes`, `${n} usually goes ${f.usual_minutes} minutes. Today it lasted ${f.minutes_live}.${f.title ? ` The title was "${f.title}".` : ''}`, 3, 14, 0],
    viewer_crash: (n, f) => [`📉 ${n}'S VIEWERS ABANDON SHIP: ${f.from} → ${f.to} in ${f.minutes} minutes`, `${f.from} people were watching ${n}. ${f.minutes} minutes later, ${f.to}.`, f.from >= 6 ? 3 : 2, 9, 0],
    viewer_spike: (n, f) => [`📈 ${n} IS BLOWING UP: ${f.from} → ${f.to} viewers`, `${n} went from ${f.from} to ${f.to} viewers in ${f.minutes} minutes. Something is happening.`, 2, 0, 9],
    chat_explosion: (n, f) => [`💬 ${n}'S CHAT GOES FERAL: ${f.messages_5m} messages in 5 minutes`, `${n}'s chat usually runs at ${f.usual_5m} messages every 5 minutes. It just hit ${f.messages_5m}.`, 2, 0, 7],
    meltdown: (n, f) => [`😤 ${n} LOSES IT ON STREAM`, `${f.count} yells, screams and shouts in ${f.seconds} seconds on ${n}'s stream.`, 3, 12, 2],
    tears: (n, f) => [`😭 ${n} IN TEARS ON STREAM?`, `Crying was heard ${f.count} times in ${f.seconds} seconds on ${n}'s stream.`, 3, 14, 0],
    marathon: (n, f) => [`⏰ ${n} HAS BEEN LIVE FOR ${f.hours} HOURS. TOUCH GRASS?`, `${n} started at ${f.started} UTC and has not stopped.`, 2, 3, 6],
    ghost_town: (n, f) => [`👻 ${n} STREAMED ${f.minutes} MINUTES TO AN EMPTY ROOM`, `Peak: ${f.peak} viewer${f.peak === 1 ? '' : 's'}. Chat messages: ${f.messages}.`, 1, 7, 0],
    the_return: (n, f) => [`👀 ${n} IS BACK after ${f.days_away} days`, `${n}'s last stream was ${f.days_away} days ago. They are live again${f.title ? `: "${f.title}"` : ''}.`, 2, 0, 6],
    title_drama: (n, f) => [`🍿 ${n}'S TITLE SAYS IT ALL: "${f.title}"`, `That is what ${n} called today's stream.`, 2, 5, 2],
    peak_record: (n, f) => [`🏆 ${n} HITS A NEW PEAK: ${f.peak} viewers`, `${n}'s best before this was ${f.previous_best}.`, 2, 0, 10],
    fell_off: (n, f) => [`📉 DID ${n} FALL OFF? No stream in ${f.days_quiet} days`, `${n} streamed ${f.streams_before} times the month before. Since then: nothing.`, 2, 9, 0],
    streak: (n, f) => [`🔥 ${n}: ${f.days} DAYS STRAIGHT, NO DAYS OFF`, `${n} has been live every day for ${f.days} days.`, 2, 0, 8],
    quote_of_day: (n, f) => [`🎤 QUOTE OF THE DAY: ${n}`, f.about ? `On ${f.about}. The judge gave it ${f.quality}/10.` : `The judge gave it ${f.quality}/10.`, 2, 0, 5],
    beef_open: (n, f) => [`🥩 BEEF: ${n} vs ${f.other}`, f.about ? `${n} came for ${f.other} on mic: ${f.about}. ${f.other} is on the clock.` : `${n} came for ${f.other} on mic. ${f.other} is on the clock.`, 3, 0, 5],
    beef_win: (n, f) => [`🏆 ${n} COOKS ${f.other}${f.upset ? ' IN AN UPSET' : ''}`, `${n} won the beef with ${f.other}, ${f.score_winner}–${f.score_loser}.`, f.upset ? 4 : 3, 0, 12],
    beef_forfeit: (n, f) => [`🐔 ${n} DUCKS ${f.other}`, `${f.other} called ${n} out on mic. ${n} never answered and ran out the clock.`, 3, 15, 0],
};

let _aiCalls = [];
function aiBudgetLeft() {
    const now = Date.now();
    _aiCalls = _aiCalls.filter((t) => now - t < 3600_000);
    return _aiCalls.length < AI_PER_HOUR;
}

/** Store a story (once per dedupe key) and have AI rewrite it. Returns the new id, or null when it existed or is opted out. */
async function createStory({ kind, userId, otherUserId = null, streamId = null, vodId = null, sec = null, dedupeKey, facts = {}, quote = null, happenedAt }) {
    if (!T[kind] || !userId || await optedOut(userId)) return null;
    if (await db.get('SELECT 1 FROM arena_drama WHERE dedupe_key = ?', [dedupeKey])) return null;
    const name = await nameOf(userId);
    const fx = { ...facts, ...(otherUserId ? { other: facts.other || await nameOf(otherUserId) } : {}) };
    const [headline, blurb, alert, cow, clout] = T[kind](name, fx);
    const cleanQuote = quote && !arena()._isBannedText(quote) ? String(quote).replace(/\s+/g, ' ').trim().slice(0, 400) : null;
    const r = await db.run(`INSERT INTO arena_drama (kind, user_id, other_user_id, stream_id, vod_id, sec, dedupe_key, facts_json, quote, headline, blurb, alert, cow_points, clout_points, happened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [kind, userId, otherUserId, streamId, vodId, sec == null ? null : Math.max(0, Math.floor(sec)), dedupeKey, JSON.stringify(fx), cleanQuote, headline.slice(0, 160), blurb.slice(0, 480), alert, cow, clout, fmt(happenedAt || Date.now())]);
    const id = r && (r.lastInsertRowid || (r.rows && r.rows[0] && r.rows[0].id));
    if (!id) return null;
    if (alert >= 3) {
        try { require('./notify').arenaNotify(userId, { type: 'drama', title: `You made the Arena: ${headline.slice(0, 100)}`, message: blurb.slice(0, 200), icon: '🚨', url: `/arena/drama/${id}`, key: `drama:${id}` }); } catch { /* */ }
    }
    // The AI headline first (when it comes), then the chat hears about it.
    rewrite(id, { kind, streamer: name, other: fx.other || null, facts: fx, quote: cleanQuote }, userId).catch(() => {}).then(() => announce(id)).catch(() => {});
    return id;
}

// A story at alert 3+ is announced in chat: in the subject's stream room (mirrored to global chat) while they are live,
// else in global chat. At most ANNOUNCE_PER_HOUR an hour, one line per story (Chat dedupes by key).
const ANNOUNCE_PER_HOUR = 6;
let _announced = [];
async function announce(id) {
    const row = await db.get("SELECT id, user_id, headline, alert, status FROM arena_drama WHERE id = ?", [id]);
    if (!row || row.status !== 'live' || Number(row.alert) < 3) return false;
    const now = Date.now();
    _announced = _announced.filter((t) => now - t < 3600_000);
    if (_announced.length >= ANNOUNCE_PER_HOUR) return false;
    _announced.push(now);
    let base = 'https://openvibe.live';
    try { base = String(require('../config').baseUrl || base).replace(/\/$/, ''); } catch { /* */ }
    const live = await db.get('SELECT id FROM streams WHERE user_id = ? AND is_live = 1 ORDER BY started_at DESC LIMIT 1', [row.user_id]);
    const headline = String(row.headline).startsWith('🚨') ? row.headline : `🚨 ${row.headline}`;
    const line = { username: 'ARENA ALERT', user_id: null, message: `${headline} → ${base}/arena/drama/${row.id}`.slice(0, 480), message_type: 'system', key: `arena:${row.id}`,
        metadata: { arena_drama_id: row.id, url: `${base}/arena/drama/${row.id}` }, ...(live ? { stream_id: live.id, mirror: true } : { is_global: true }) };
    await require('../chat/chat-delivery').message(line);
    return true;
}

async function rewrite(id, payload, userId) {
    if (!aiBudgetLeft() || !await arena().aiOn()) return;
    _aiCalls.push(Date.now());
    const out = await require('../ai/ai-service').structured('live.arena.drama', payload, { meter: { kind: 'arena_drama', role: 'chat', ownerUserId: userId, source: 'arena' } });
    if (!out || !out.headline || !out.blurb) return;
    if (arena()._isBannedText(out.headline) || arena()._isBannedText(out.blurb)) return;
    await db.run('UPDATE arena_drama SET headline = ?, blurb = ?, alert = ?, ai = 1 WHERE id = ?', [String(out.headline).slice(0, 160), String(out.blurb).slice(0, 480), Math.min(5, Math.max(1, Number(out.alert) || 1)), id]);
}

// ── Detectors ──
async function streamsSince(sinceTxt) {
    return await db.all(`SELECT id, user_id, title, category, started_at, ended_at, duration_seconds, peak_viewers, is_live FROM streams
        WHERE (is_live = 1 OR ended_at >= ? OR started_at >= ?) AND user_id IS NOT NULL ORDER BY id`, [sinceTxt, sinceTxt]);
}

async function detectStreams(streams, now, since) {
    const out = [];
    for (const s of streams) {
        const started = toMs(s.started_at), ended = toMs(s.ended_at);
        const live = Number(s.is_live) === 1;
        const minutes = Math.round((Number(s.duration_seconds) || ((live ? now : ended) - started) / 1000 || 0) / 60);
        // rage quit: a short stream from someone who usually goes long.
        if (!live && ended >= since && minutes >= 1 && minutes < 15) {
            const prior = await db.all('SELECT duration_seconds FROM streams WHERE user_id = ? AND id < ? AND duration_seconds >= 60 ORDER BY id DESC LIMIT 10', [s.user_id, s.id]);
            const usual = Math.round(median(prior.map((p) => Number(p.duration_seconds))) / 60);
            if (prior.length >= 3 && usual >= 45) out.push({ kind: 'rage_quit', userId: s.user_id, streamId: s.id, dedupeKey: `rage_quit:${s.id}`, facts: { minutes_live: minutes, usual_minutes: usual, title: s.title || null }, happenedAt: ended });
        }
        // marathon
        if (minutes >= 480) out.push({ kind: 'marathon', userId: s.user_id, streamId: s.id, dedupeKey: `marathon:${s.id}`, facts: { hours: Math.floor(minutes / 60), started: fmt(started).slice(0, 16) }, happenedAt: live ? now : ended });
        // ghost town: an hour or more, nobody there, nobody typing.
        if (!live && ended >= since && minutes >= 60 && (Number(s.peak_viewers) || 0) <= 1) {
            const a = await db.get('SELECT total_messages FROM stream_analytics WHERE stream_id = ?', [s.id]);
            const chat = await db.get('SELECT COALESCE(MAX(chat_messages_5m), 0) AS m FROM viewer_snapshots WHERE stream_id = ?', [s.id]);
            const messages = Number(a && a.total_messages) || 0;
            if (!messages && !Number(chat && chat.m)) out.push({ kind: 'ghost_town', userId: s.user_id, streamId: s.id, dedupeKey: `ghost_town:${s.id}`, facts: { minutes, peak: Number(s.peak_viewers) || 0, messages: 0 }, happenedAt: ended });
        }
        // the return
        if (started >= since) {
            const prev = await db.get('SELECT ended_at FROM streams WHERE user_id = ? AND id < ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1', [s.user_id, s.id]);
            const away = prev ? Math.floor((started - toMs(prev.ended_at)) / 86400000) : 0;
            if (away >= 14) out.push({ kind: 'the_return', userId: s.user_id, streamId: s.id, dedupeKey: `the_return:${s.id}`, facts: { days_away: away, title: s.title || null }, happenedAt: started });
        }
        // title drama
        if (s.title && TITLE_DRAMA.test(s.title) && (live || ended >= since)) {
            out.push({ kind: 'title_drama', userId: s.user_id, streamId: s.id, dedupeKey: `title_drama:${s.id}:${String(s.title).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60)}`, facts: { title: String(s.title).slice(0, 120) }, happenedAt: live ? now : ended });
        }
        // a new personal peak
        if (!live && ended >= since && (Number(s.peak_viewers) || 0) >= 3) {
            const best = await db.get('SELECT MAX(peak_viewers) AS p, COUNT(*) AS n FROM streams WHERE user_id = ? AND id < ?', [s.user_id, s.id]);
            if (best && Number(best.n) >= 3 && Number(s.peak_viewers) > (Number(best.p) || 0)) out.push({ kind: 'peak_record', userId: s.user_id, streamId: s.id, dedupeKey: `peak_record:${s.id}`, facts: { peak: Number(s.peak_viewers), previous_best: Number(best.p) || 0 }, happenedAt: ended });
        }
    }
    return out;
}

/** Viewer crashes and spikes, chat explosions: the minute-by-minute snapshots of each stream in the window. */
async function detectSnapshots(streams, since) {
    const out = [];
    for (const s of streams) {
        const rows = await db.all('SELECT viewer_count, chat_messages_5m, recorded_at FROM viewer_snapshots WHERE stream_id = ? ORDER BY recorded_at', [s.id]);
        if (rows.length < 5) continue;
        const pts = rows.map((r) => ({ t: toMs(r.recorded_at), v: Number(r.viewer_count) || 0, c: Number(r.chat_messages_5m) || 0 }));
        const usualChat = median(pts.map((p) => p.c));
        let crash = null, spike = null, chat = null;
        for (let i = 1; i < pts.length; i++) {
            const p = pts[i];
            if (p.t < since) continue;
            const prev = pts.slice(0, i).filter((q) => p.t - q.t <= 20 * 60000);
            if (!prev.length) continue;
            const hi = prev.reduce((m, q) => (q.v > m.v ? q : m), prev[0]);
            const lo = prev.reduce((m, q) => (q.v < m.v ? q : m), prev[0]);
            if (hi.v >= 3 && p.v <= hi.v / 2 && (!crash || hi.v - p.v > crash.from - crash.to)) crash = { from: hi.v, to: p.v, minutes: Math.max(1, Math.round((p.t - hi.t) / 60000)), t: p.t };
            if (p.v >= 4 && p.v >= 2 * Math.max(1, lo.v) && (!spike || p.v - lo.v > spike.to - spike.from)) spike = { from: lo.v, to: p.v, minutes: Math.max(1, Math.round((p.t - lo.t) / 60000)), t: p.t };
            if (p.c >= 15 && p.c >= 3 * Math.max(1, usualChat) && (!chat || p.c > chat.messages_5m)) chat = { messages_5m: p.c, usual_5m: usualChat, t: p.t };
        }
        const hour = (t) => new Date(t).toISOString().slice(0, 13);
        if (crash) out.push({ kind: 'viewer_crash', userId: s.user_id, streamId: s.id, dedupeKey: `viewer_crash:${s.id}:${hour(crash.t)}`, facts: { from: crash.from, to: crash.to, minutes: crash.minutes }, happenedAt: crash.t });
        if (spike) out.push({ kind: 'viewer_spike', userId: s.user_id, streamId: s.id, dedupeKey: `viewer_spike:${s.id}:${hour(spike.t)}`, facts: { from: spike.from, to: spike.to, minutes: spike.minutes }, happenedAt: spike.t });
        if (chat) out.push({ kind: 'chat_explosion', userId: s.user_id, streamId: s.id, dedupeKey: `chat_explosion:${s.id}:${hour(chat.t)}`, facts: { messages_5m: chat.messages_5m, usual_5m: chat.usual_5m }, happenedAt: chat.t });
    }
    return out;
}

/** Meltdowns and tears: 3+ rage (or crying) sounds within 2 minutes, with the longest line said around them. */
async function detectSounds(streams, sinceTxt) {
    const out = [];
    for (const s of streams) {
        const sounds = await db.all(`SELECT label, start_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'sound' AND created_at >= ? ORDER BY start_sec`, [s.id, sinceTxt]);
        for (const [kind, set] of [['meltdown', RAGE_SOUNDS], ['tears', TEAR_SOUNDS]]) {
            const hits = sounds.filter((x) => set.has(x.label));
            let best = null;
            for (let i = 0; i < hits.length; i++) {
                let j = i;
                while (j + 1 < hits.length && hits[j + 1].start_sec - hits[i].start_sec <= 120) j++;
                const n = j - i + 1;
                if (n >= 3 && (!best || n > best.n)) best = { n, from: hits[i], to: hits[j] };
            }
            if (!best) continue;
            const lines = await db.all(`SELECT text FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND start_sec BETWEEN ? AND ? ORDER BY start_sec`, [s.id, best.from.start_sec - 20, best.to.start_sec + 20]);
            const quote = lines.map((l) => String(l.text || '')).filter((t) => t && !arena()._isBannedText(t)).sort((a, b) => b.length - a.length)[0] || null;
            const counts = {};
            for (const h of hits.slice(hits.indexOf(best.from), hits.indexOf(best.to) + 1)) counts[h.label] = (counts[h.label] || 0) + 1;
            out.push({ kind, userId: s.user_id, streamId: s.id, vodId: best.from.vod_id || null, sec: best.from.start_sec, dedupeKey: `${kind}:${s.id}:${Math.floor(best.from.start_sec / 600)}`,
                facts: { count: best.n, seconds: Math.max(1, Math.round(best.to.start_sec - best.from.start_sec)), sounds: counts }, quote, happenedAt: Date.now() });
        }
    }
    return out;
}

/** Once a day: who fell off, who has not missed a day, and the quote of the day. */
async function detectDaily(now) {
    const out = [];
    const today = day(now);
    const users = await db.all(`SELECT user_id, COUNT(*) AS n FROM streams WHERE started_at >= ? AND started_at < ? AND user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) >= 4`, [fmt(now - 38 * 86400000), fmt(now - 8 * 86400000)]);
    for (const u of users) {
        const recent = await db.get('SELECT MAX(COALESCE(ended_at, started_at)) AS last FROM streams WHERE user_id = ?', [u.user_id]);
        const quiet = Math.floor((now - toMs(recent && recent.last)) / 86400000);
        if (quiet >= 7) out.push({ kind: 'fell_off', userId: u.user_id, dedupeKey: `fell_off:${u.user_id}:${day(toMs(recent.last))}`, facts: { days_quiet: quiet, streams_before: Number(u.n) }, happenedAt: now });
    }
    const days = await db.all(`SELECT user_id, substr(started_at, 1, 10) AS d FROM streams WHERE started_at >= ? AND user_id IS NOT NULL GROUP BY user_id, substr(started_at, 1, 10)`, [fmt(now - 60 * 86400000)]);
    const byUser = new Map();
    for (const r of days) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Set()); byUser.get(r.user_id).add(r.d); }
    for (const [userId, set] of byUser) {
        // Consecutive days live, ending today (or yesterday, when today's stream has not started yet).
        const from = set.has(today) ? 0 : 1;
        let n = 0;
        while (set.has(day(now - (from + n) * 86400000))) n++;
        if (n >= 7 && n % 7 === 0) out.push({ kind: 'streak', userId, dedupeKey: `streak:${userId}:${n}:${today}`, facts: { days: n }, happenedAt: now });
    }
    const yesterday = day(now - 86400000);
    const q = await db.get(`SELECT user_id, text, about, quality, vod_id, sec, stream_id FROM arena_mic_moments WHERE substr(COALESCE(said_at, created_at), 1, 10) = ? AND quality >= 7 ORDER BY quality DESC, id LIMIT 1`, [yesterday]);
    if (q) out.push({ kind: 'quote_of_day', userId: q.user_id, streamId: q.stream_id, vodId: q.vod_id, sec: q.sec, dedupeKey: `quote_of_day:${yesterday}`, facts: { quality: Number(q.quality), about: q.about || null }, quote: q.text, happenedAt: now });
    return out;
}

let _busy = false;
async function detect({ now = Date.now() } = {}) {
    if (_busy) return { created: 0, busy: true };
    _busy = true;
    try {
        const since = now - WINDOW_MS;
        const sinceTxt = fmt(since);
        const streams = await streamsSince(sinceTxt);
        const found = [
            ...await detectStreams(streams, now, since),
            ...await detectSnapshots(streams, since),
            ...await detectSounds(streams, sinceTxt),
            ...await detectDaily(now),
        ];
        let created = 0;
        for (const f of found) { try { if (await createStory(f)) created++; } catch (e) { console.warn('[Arena] drama story:', f.kind, e.message); } }
        return { created, found: found.length };
    } finally { _busy = false; }
}

/** beef.js reports: 'open' (a called out b), 'win' (winner, loser), 'forfeit' (the one who ducked, the caller). */
async function beefStory(kind, beef, ctx = {}) {
    if (kind === 'open') return await createStory({ kind: 'beef_open', userId: beef.a_user_id, otherUserId: beef.b_user_id, dedupeKey: `beef_open:${beef.id}`, facts: { about: ctx.about || null }, quote: ctx.opening_line || null, happenedAt: Date.now() });
    if (kind === 'win' && ctx.winnerId && ctx.loserId) return await createStory({ kind: 'beef_win', userId: ctx.winnerId, otherUserId: ctx.loserId, dedupeKey: `beef_win:${beef.id}`, facts: { score_winner: ctx.scoreWinner, score_loser: ctx.scoreLoser, upset: !!ctx.upset }, happenedAt: Date.now() });
    if (kind === 'forfeit' && ctx.loserId && ctx.winnerId) return await createStory({ kind: 'beef_forfeit', userId: ctx.loserId, otherUserId: ctx.winnerId, dedupeKey: `beef_forfeit:${beef.id}`, facts: {}, happenedAt: Date.now() });
    return null;
}

// ── Reading ──
async function userCard(userId) {
    if (!userId) return null;
    const u = await db.get('SELECT id, username, display_name, avatar_url FROM users WHERE id = ?', [userId]);
    return u ? { id: u.id, username: u.username, display_name: u.display_name || u.username, avatar_url: u.avatar_url || null } : null;
}
async function storyView(row, voterKey = null) {
    const counts = Object.fromEntries(REACTIONS.map((r) => [r, 0]));
    for (const c of await db.all('SELECT reaction, COUNT(*) AS n FROM arena_drama_reactions WHERE drama_id = ? GROUP BY reaction', [row.id])) counts[c.reaction] = Number(c.n);
    const mine = voterKey ? await db.get('SELECT reaction FROM arena_drama_reactions WHERE drama_id = ? AND voter_key = ?', [row.id, voterKey]) : null;
    let facts = {};
    try { facts = JSON.parse(row.facts_json || '{}'); } catch { /* */ }
    return {
        id: row.id, kind: row.kind, headline: row.headline, blurb: row.blurb, quote: row.quote, alert: Number(row.alert), ai: !!row.ai,
        user: await userCard(row.user_id), other: await userCard(row.other_user_id), facts,
        stream_id: row.stream_id, vod_id: row.vod_id, sec: row.sec, happened_at: row.happened_at,
        reactions: counts, my_reaction: mine ? mine.reaction : null,
    };
}
async function feed({ limit = 30, before = null, userId = null, voterKey = null } = {}) {
    const args = [];
    let where = "d.status = 'live'";
    if (before) { where += ' AND d.id < ?'; args.push(Number(before)); }
    if (userId) { where += ' AND (d.user_id = ? OR d.other_user_id = ?)'; args.push(userId, userId); }
    const rows = await db.all(`SELECT d.* FROM arena_drama d WHERE ${where} ORDER BY d.happened_at DESC, d.id DESC LIMIT ?`, [...args, Math.min(100, Math.max(1, limit))]);
    return await Promise.all(rows.map((r) => storyView(r, voterKey)));
}
async function story(id, voterKey = null) {
    const row = await db.get("SELECT * FROM arena_drama WHERE id = ? AND status = 'live'", [Number(id)]);
    return row ? await storyView(row, voterKey) : null;
}
async function react(id, reaction, voterKey) {
    if (!REACTIONS.includes(reaction)) throw new Error(`reaction must be one of ${REACTIONS.join(', ')}`);
    if (!await db.get("SELECT 1 FROM arena_drama WHERE id = ? AND status = 'live'", [Number(id)])) throw new Error('No such story');
    await db.run(`INSERT INTO arena_drama_reactions (drama_id, voter_key, reaction) VALUES (?, ?, ?)
        ON CONFLICT (drama_id, voter_key) DO UPDATE SET reaction = excluded.reaction, created_at = ov_now()`, [Number(id), voterKey, reaction]);
    return (await story(id, voterKey)).reactions;
}

// ── The boards ──
const weekStart = (ms) => { const d = new Date(ms); const dow = (d.getUTCDay() + 6) % 7; return day(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86400000); };

/** Lolcow Index: cow points over the last `days` (newer counts more), L's included; 0-100 against the top. */
async function lolcowIndex({ days = 7, now = Date.now() } = {}) {
    const rows = await db.all(`SELECT user_id, kind, cow_points, happened_at FROM arena_drama WHERE status = 'live' AND cow_points > 0 AND happened_at >= ?`, [fmt(now - days * 86400000)]);
    const by = new Map();
    for (const r of rows) {
        const age = (now - toMs(r.happened_at)) / (days * 86400000);
        const pts = Number(r.cow_points) * (1 - 0.5 * Math.min(1, Math.max(0, age)));
        const e = by.get(r.user_id) || { score: 0, kinds: {} };
        e.score += pts;
        e.kinds[r.kind] = (e.kinds[r.kind] || 0) + 1;
        by.set(r.user_id, e);
    }
    const top = Math.max(1, ...[...by.values()].map((e) => e.score));
    const list = await Promise.all([...by.entries()].filter(([uid]) => uid).map(async ([uid, e]) => ({ user: await userCard(uid), score: Math.round(e.score), meter: Math.round((e.score / top) * 100), kinds: e.kinds })));
    return list.filter((x) => x.user).sort((a, b) => b.score - a.score).slice(0, 25);
}

/** Clout: what each streamer did in the last 7 days (hours live, viewers, chat, followers) plus their stories' clout. */
async function cloutScores(now = Date.now()) {
    const since = fmt(now - 7 * 86400000);
    const rows = await db.all(`SELECT s.user_id, SUM(COALESCE(s.duration_seconds, 0)) AS secs, MAX(s.peak_viewers) AS peak, COUNT(*) AS streams,
            SUM(COALESCE(a.avg_viewers, 0) * COALESCE(s.duration_seconds, 0)) AS viewer_secs, SUM(COALESCE(a.total_messages, 0)) AS messages, SUM(COALESCE(a.new_followers, 0)) AS followers
        FROM streams s LEFT JOIN stream_analytics a ON a.stream_id = s.id WHERE s.started_at >= ? AND s.user_id IS NOT NULL GROUP BY s.user_id`, [since]);
    const drama = await db.all(`SELECT user_id, SUM(clout_points) AS clout, SUM(cow_points) AS cow FROM arena_drama WHERE status = 'live' AND happened_at >= ? GROUP BY user_id`, [since]);
    const wins = await db.all(`SELECT winner_user_id AS user_id, COUNT(*) AS n FROM arena_beefs WHERE status = 'resolved' AND winner_user_id IS NOT NULL AND resolved_at >= ? GROUP BY winner_user_id`, [since]);
    const by = new Map();
    const get = (uid) => { if (!by.has(uid)) by.set(uid, { hours: 0, peak: 0, avg_viewers: 0, messages: 0, followers: 0, streams: 0, story_clout: 0, cow: 0, beef_wins: 0 }); return by.get(uid); };
    for (const r of rows) {
        const e = get(r.user_id);
        const secs = Number(r.secs) || 0;
        Object.assign(e, { hours: Math.round(secs / 360) / 10, peak: Number(r.peak) || 0, avg_viewers: secs ? Math.round((Number(r.viewer_secs) || 0) / secs * 10) / 10 : 0, messages: Number(r.messages) || 0, followers: Number(r.followers) || 0, streams: Number(r.streams) || 0 });
    }
    for (const r of drama) { const e = get(r.user_id); e.story_clout = Number(r.clout) || 0; e.cow = Number(r.cow) || 0; }
    for (const r of wins) get(r.user_id).beef_wins = Number(r.n) || 0;
    for (const e of by.values()) e.clout = Math.round(e.hours * 2 + e.avg_viewers * 10 + e.peak * 3 + e.messages / 50 + e.followers * 5 + e.story_clout + e.beef_wins * 10 - e.cow * 0.5);
    return by;
}

async function cloutRankings({ now = Date.now() } = {}) {
    const by = await cloutScores(now);
    const ranked = [...by.entries()].filter(([uid]) => uid).sort((a, b) => b[1].clout - a[1].clout);
    // This week's moves: against the snapshot taken at the start of the week (taken here, once a week).
    const week = weekStart(now);
    const prevWeek = weekStart(now - 7 * 86400000);
    if (!await db.get('SELECT 1 FROM arena_clout_weeks WHERE week = ? LIMIT 1', [week])) {
        let i = 0;
        for (const [uid, e] of ranked) await db.run('INSERT INTO arena_clout_weeks (week, user_id, clout_rank, clout, cow, facts_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [week, uid, ++i, e.clout, e.cow, JSON.stringify(e)]);
    }
    const before = new Map((await db.all('SELECT user_id, clout_rank FROM arena_clout_weeks WHERE week = ?', [prevWeek])).map((r) => [r.user_id, Number(r.clout_rank)]));
    const cows = new Map((await lolcowIndex({ now })).map((c) => [c.user.id, c.meter]));
    const out = [];
    let rank = 0;
    for (const [uid, e] of ranked.slice(0, 50)) {
        rank++;
        const was = before.get(uid) || null;
        const move = was ? was - rank : null;
        const cow = cows.get(uid) || 0;
        const tags = [];
        if (cow >= 70) tags.push('COOKED');
        if (move != null && move >= 2) tags.push('ON THE RISE');
        if (move != null && move <= -2) tags.push('FALLING');
        if (e.beef_wins >= 2) tags.push('UNDEFEATED');
        const user = await userCard(uid);
        if (user) out.push({ rank, user, clout: e.clout, move, was, tags, cow, facts: e });
    }
    return out;
}

async function rapSheet(userId) {
    const user = await userCard(userId);
    if (!user) return null;
    const stories = await feed({ userId, limit: 40 });
    const cow = (await lolcowIndex()).find((c) => c.user.id === userId) || null;
    const clout = (await cloutRankings()).find((c) => c.user.id === userId) || null;
    const record = await db.get(`SELECT SUM(CASE WHEN winner_user_id = ? THEN 1 ELSE 0 END) AS w, SUM(CASE WHEN winner_user_id IS NOT NULL AND winner_user_id <> ? THEN 1 ELSE 0 END) AS l
        FROM arena_beefs WHERE status = 'resolved' AND (a_user_id = ? OR b_user_id = ?)`, [userId, userId, userId, userId]);
    const counts = {};
    for (const s of stories) counts[s.kind] = (counts[s.kind] || 0) + 1;
    return { user, stories, cow, clout, record: { w: Number(record && record.w) || 0, l: Number(record && record.l) || 0 }, counts, opted_out: await optedOut(userId) };
}

async function setOptOut(userId, out) {
    if (out) {
        await db.run('INSERT INTO arena_opt_outs (user_id) VALUES (?) ON CONFLICT DO NOTHING', [userId]);
        await db.run("UPDATE arena_drama SET status = 'hidden' WHERE user_id = ? OR other_user_id = ?", [userId, userId]);
    } else {
        await db.run('DELETE FROM arena_opt_outs WHERE user_id = ?', [userId]);
    }
    return { opted_out: !!out };
}

async function hide(id) { await db.run("UPDATE arena_drama SET status = 'hidden' WHERE id = ?", [Number(id)]); }

module.exports = { detect, beefStory, createStory, announce, feed, story, react, lolcowIndex, cloutRankings, rapSheet, setOptOut, optedOut, hide, REACTIONS, TEMPLATES: T, _test: { detectStreams, detectSnapshots, detectSounds, detectDaily, weekStart, toMs, fmt } };
