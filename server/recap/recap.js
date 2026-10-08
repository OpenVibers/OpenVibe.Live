/**
 * recap.js — the after-show report. Every stream that ran long enough gets a recap page
 * (/recap/<streamId>) a few minutes after it ends: the viewer curve, chat numbers and top
 * chatters, the best Arena mic lines, clips, tips and follows gained, the VOD — and an AI
 * headline + summary written from all of it (template copy when AI is off).
 *
 *   buildRecap(streamId)     gather + (optionally) AI → { …recap } and store it
 *   getRecap(streamId)       stored recap or null
 *   ensureRecap(streamId)    stored or freshly built
 *   start()                  job: recap + chat announcement for streams that ended recently
 *
 * Stored in `stream_recaps` (one row per stream, JSON). Rebuilt on demand by the owner/admin.
 */
'use strict';

const db = require('../db/database');
const chatReads = require('../chat/chat-reads');

const MIN_DURATION_SEC = 8 * 60;          // shorter streams don't get a report
const LOOKBACK_HOURS = 12;                // job only looks at streams that ended this recently
const SETTLE_SEC = 150;                   // wait for VOD/clips/moments to land after the end
const JOB_INTERVAL_MS = 2 * 60 * 1000;

let _tableReady = false;
function ensureTable() {
    if (_tableReady) return;
    try {
        db.getDb().exec(`CREATE TABLE IF NOT EXISTS stream_recaps (
            stream_id INTEGER PRIMARY KEY,
            user_id INTEGER,
            json TEXT NOT NULL,
            ai INTEGER DEFAULT 0,
            announced_at DATETIME,
            created_at DATETIME DEFAULT ov_now()
        )`);
        db.getDb().exec('CREATE INDEX IF NOT EXISTS idx_stream_recaps_user ON stream_recaps(user_id, created_at)');
        _tableReady = true;
    } catch (e) { console.warn('[Recap] table:', e.message); }
}

const sqlTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseTs = (s) => { if (!s) return NaN; const t = Date.parse(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')); return t; };
const safe = async (fn, dflt) => { try { const v = await fn(); return v == null ? dflt : v; } catch { return dflt; } };
function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }

/** Everything we know about one finished stream. */
async function gather(streamId) {
    const stream = await db.getStreamById(streamId);
    if (!stream || stream.is_live) return null;
    const user = await db.getUserById(stream.user_id);
    if (!user) return null;
    const startMs = parseTs(stream.started_at);
    const endMs = parseTs(stream.ended_at) || (startMs + (stream.duration_seconds || 0) * 1000);
    const durationSec = Number(stream.duration_seconds) || Math.max(0, Math.round((endMs - startMs) / 1000));
    const start = sqlTs(startMs), end = sqlTs(endMs);

    // Viewer curve (sampled every ~minute by the chat server while live).
    const curve = await safe(async () => await db.all(`SELECT recorded_at AS t, viewer_count AS v, COALESCE(chat_messages_5m, 0) AS c FROM viewer_snapshots WHERE stream_id = ? ORDER BY recorded_at ASC`, [streamId]), []);
    const viewersAvg = curve.length ? Math.round(curve.reduce((n, p) => n + Number(p.v || 0), 0) / curve.length * 10) / 10 : null;
    const peakAt = curve.length ? curve.reduce((best, p) => (Number(p.v) > Number(best.v) ? p : best), curve[0]) : null;

    // Chat: totals and top chatters from OpenVibe.Chat (Live's own tables when Live runs chat).
    const chat = (await chatReads.streamStats(streamId)) || { messages: 0, chatters: 0, sounds: 0 };
    const topChatters = ((await chatReads.topChatters({ streamId, limit: 5 })) || [])
        .filter(r => r.username && (r.user_id == null || Number(r.user_id) !== Number(stream.user_id)))
        .slice(0, 5);
    const busiest = curve.length ? curve.reduce((best, p) => (Number(p.c) > Number(best.c) ? p : best), curve[0]) : null;

    // Arena mic lines said on this stream.
    const micLines = await safe(async () => await db.all(`SELECT text, quality, kind, aimed_at, sec, vod_id FROM arena_mic_moments WHERE stream_id = ? ORDER BY quality DESC, said_at ASC LIMIT 4`, [streamId]), []);

    // Money + love.
    const tips = await safe(async () => await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'donation' AND COALESCE(status, 'completed') NOT IN ('failed', 'refunded', 'pending') AND ((stream_id = ?) OR (to_user_id = ? AND created_at BETWEEN ? AND ?))`, [streamId, stream.user_id, start, end]), { n: 0, total: 0 });
    const topTipper = await safe(async () => await db.get(`SELECT u.username, u.display_name, SUM(t.amount) AS total FROM transactions t JOIN users u ON u.id = t.from_user_id
        WHERE t.type = 'donation' AND ((t.stream_id = ?) OR (t.to_user_id = ? AND t.created_at BETWEEN ? AND ?)) GROUP BY t.from_user_id ORDER BY total DESC LIMIT 1`, [streamId, stream.user_id, start, end]), null);
    const follows = await safe(async () => (await db.get(`SELECT COUNT(*) AS n FROM follows WHERE streamer_id = ? AND created_at BETWEEN ? AND ?`, [stream.user_id, start, end])).n, 0);
    const followersNow = await safe(async () => await db.getFollowerCount(stream.user_id), null);

    // What was said (for the model): a slice of the transcript, English when we have it.
    const speech = await safe(async () => await db.all(`SELECT COALESCE(text_en, text) AS t, start_sec AS s FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' ORDER BY start_sec ASC`, [streamId]), []);
    const speechSample = (() => {
        if (!speech.length) return '';
        const pick = [];
        const n = speech.length, take = Math.min(n, 36);
        for (let i = 0; i < take; i++) pick.push(speech[Math.floor(i * n / take)].t);
        return pick.join(' ').replace(/\s+/g, ' ').slice(0, 1600);
    })();

    // Media: the VOD + clips of this stream.
    let vod = null, clips = [];
    try {
        const media = require('../media-client');
        const out = await media.listVods({ stream_id: streamId, limit: 3 }).catch(() => null);
        const vods = (out?.vods || []).filter(v => v.status === 'ready' && (v.duration_seconds || v.duration));
        if (vods.length) { const v = vods.sort((a, b) => (b.duration_seconds || b.duration || 0) - (a.duration_seconds || a.duration || 0))[0]; vod = { id: v.id, thumbnail_url: v.thumbnail_url || null, duration_seconds: v.duration_seconds || v.duration || 0 }; }
        const co = await media.listClips({ stream_id: streamId, limit: 12 }).catch(() => null);
        clips = (co?.clips || (Array.isArray(co) ? co : [])).filter(c => c && (c.is_public == null || Number(c.is_public) === 1))
            .sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0)).slice(0, 6)
            .map(c => ({ id: c.id, title: c.title || 'Clip', thumbnail_url: c.thumbnail_url || null, duration_seconds: c.duration_seconds || c.duration || 0, view_count: Number(c.view_count) || 0, by: c.display_name || c.username || null }));
    } catch { /* Media down — the report still ships */ }

    return {
        stream: { id: stream.id, title: stream.title || 'Untitled stream', category: stream.ai_category || stream.category || null, protocol: stream.protocol || null, started_at: stream.started_at, ended_at: stream.ended_at || end, duration_seconds: durationSec, peak_viewers: Math.max(Number(stream.peak_viewers) || 0, peakAt ? Number(peakAt.v) || 0 : 0), ai_overview: stream.ai_overview_short || stream.ai_overview || null },
        streamer: { id: user.id, username: user.username, display_name: user.display_name || user.username, avatar_url: user.avatar_url || null, profile_color: user.profile_color || null },
        viewers: { avg: viewersAvg, peak_at: peakAt ? peakAt.t : null, curve: curve.map(p => [p.t, Number(p.v) || 0, Number(p.c) || 0]) },
        chat: { messages: Number(chat.messages) || 0, chatters: Number(chat.chatters) || 0, top: topChatters.map(r => ({ username: r.username, display_name: r.display_name || r.username, avatar_url: r.avatar_url || null, profile_color: r.profile_color || null, n: Number(r.count) })), busiest_at: busiest && Number(busiest.c) > 0 ? busiest.t : null, busiest_n: busiest ? Number(busiest.c) : 0, sounds: Number(chat.sounds) || 0 },
        mic: micLines.map(m => ({ text: m.text, quality: m.quality, kind: m.kind, aimed_at: m.aimed_at || null, sec: m.sec, vod_id: m.vod_id || null })),
        love: { tips: Number(tips.n) || 0, tips_total: Number(tips.total) || 0, top_tipper: topTipper ? { username: topTipper.username, display_name: topTipper.display_name || topTipper.username, total: Number(topTipper.total) } : null, follows, followers_now: followersNow },
        speech: { lines: speech.length, sample: speechSample },
        vod, clips,
    };
}

// ── The write-up ─────────────────────────────────────────────
function templateWriteup(g) {
    const s = g.stream, name = g.streamer.display_name;
    const bits = [];
    bits.push(`${name} streamed "${s.title}" for ${fmtDur(s.duration_seconds)}${s.peak_viewers ? `, peaking at ${s.peak_viewers} viewer${s.peak_viewers === 1 ? '' : 's'}` : ''}.`);
    if (g.chat.messages) bits.push(`Chat put up ${g.chat.messages} line${g.chat.messages === 1 ? '' : 's'} from ${g.chat.chatters} ${g.chat.chatters === 1 ? 'person' : 'people'}${g.chat.top[0] ? `, led by ${g.chat.top[0].display_name}` : ''}.`);
    if (g.love.follows || g.love.tips) bits.push([g.love.follows ? `${g.love.follows} new follow${g.love.follows === 1 ? '' : 's'}` : '', g.love.tips ? `${g.love.tips} tip${g.love.tips === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') + ' came in.');
    const grade = s.peak_viewers >= 25 || g.chat.messages >= 400 ? 'S' : s.peak_viewers >= 10 || g.chat.messages >= 120 ? 'A' : s.peak_viewers >= 3 || g.chat.messages >= 25 ? 'B' : 'C';
    return {
        headline: `${name} went ${fmtDur(s.duration_seconds)} on "${String(s.title).slice(0, 40)}"`,
        summary: bits.join(' ').slice(0, 420),
        moment: g.clips[0] ? `Clip: ${g.clips[0].title}` : (g.chat.busiest_n >= 10 ? `Chat hit ${g.chat.busiest_n} lines in five minutes.` : ''),
        tags: [s.category || 'stream', g.chat.messages >= 100 ? 'chatty' : 'chill', g.mic.length ? 'mic on fire' : 'good vibes'],
        grade,
    };
}

async function aiWriteup(g) {
    let llm = null; try { llm = require('../ai/llm'); } catch { return null; }
    if (!llm || !llm.isEnabled() || !llm.withinBudget()) return null;
    const facts = {
        streamer: g.streamer.display_name, title: g.stream.title, category: g.stream.category, duration: fmtDur(g.stream.duration_seconds),
        viewers: { peak: g.stream.peak_viewers, avg: g.viewers.avg }, chat: { messages: g.chat.messages, chatters: g.chat.chatters, top: g.chat.top.map(t => `${t.display_name} (${t.n})`), sound_commands: g.chat.sounds },
        mic_lines: g.mic.map(m => m.text), clips: g.clips.map(c => c.title), tips: g.love.tips_total ? `${g.love.tips} tips, ${g.love.tips_total} total` : 'none', new_follows: g.love.follows,
        what_was_said: g.speech.sample || '(no transcript)',
    };
    // The prompt lives in OpenVibe.AI (workflow live.stream.recap).
    const out = await require('../ai/ai-service').structured('live.stream.recap', { facts }, { target: { service: 'live', type: 'stream', id: String(g.stream.id) }, meter: { kind: 'stream_recap', role: 'summary', source: 'recap', ownerUserId: g.streamer.id } });
    if (!out || !out.headline || !out.summary) return null;
    return { headline: String(out.headline).trim().slice(0, 90), summary: String(out.summary).trim().slice(0, 500), moment: String(out.moment || '').trim().slice(0, 200), tags: (Array.isArray(out.tags) ? out.tags : []).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 4), grade: ['S', 'A', 'B', 'C'].includes(out.grade) ? out.grade : 'B' };
}

async function buildRecap(streamId, { ai = true } = {}) {
    ensureTable();
    const g = await gather(streamId);
    if (!g) return null;
    // A channel that turned AI Moments off gets the stats report only (no model, not an AI Moment).
    let derivationOn = true;
    try { derivationOn = await db.isAiDerivationEnabled(g.streamer.id); } catch { /* default on */ }
    let write = ai && derivationOn ? await aiWriteup(g) : null;
    const usedAi = !!write;
    if (!write) write = templateWriteup(g);
    const recap = { ...g, write, ai: usedAi, generated_at: new Date().toISOString() };
    await db.run(`INSERT INTO stream_recaps (stream_id, user_id, json, ai, created_at) VALUES (?, ?, ?, ?, ov_now())
            ON CONFLICT(stream_id) DO UPDATE SET json = excluded.json, ai = excluded.ai, created_at = ov_now()`, [streamId, g.streamer.id, JSON.stringify(recap), usedAi ? 1 : 0]);
    return recap;
}

async function getRecap(streamId) {
    ensureTable();
    const row = await db.get('SELECT json FROM stream_recaps WHERE stream_id = ?', [streamId]);
    if (!row) return null;
    try { return JSON.parse(row.json); } catch { return null; }
}

async function ensureRecap(streamId) { return await getRecap(streamId) || await buildRecap(streamId); }

/** Latest recaps for a channel (for the channel page / "more nights like this"). */
async function listRecaps(userId, limit = 6) {
    ensureTable();
    return (await db.all('SELECT stream_id, json, ai, created_at FROM stream_recaps WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]) || []).map(r => {
        try { const j = JSON.parse(r.json); return { stream_id: r.stream_id, title: j.stream.title, headline: j.write.headline, grade: j.write.grade, duration_seconds: j.stream.duration_seconds, peak_viewers: j.stream.peak_viewers, ended_at: j.stream.ended_at, thumbnail_url: j.vod ? j.vod.thumbnail_url : null }; } catch { return null; }
    }).filter(Boolean);
}

/** Latest recaps site-wide (for discovery surfaces). */
async function listRecentRecaps(limit = 6, excludeUserId = null) {
    ensureTable();
    const rows = await db.all(`SELECT r.stream_id, r.json, r.created_at, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM stream_recaps r JOIN users u ON u.id = r.user_id WHERE (? IS NULL OR r.user_id != ?) AND COALESCE(u.is_banned, 0) = 0
        ORDER BY r.created_at DESC LIMIT ?`, [excludeUserId, excludeUserId, limit]) || [];
    return rows.map(r => { try { const j = JSON.parse(r.json); return { stream_id: r.stream_id, username: r.username, display_name: r.display_name || r.username, avatar_url: r.avatar_url, profile_color: r.profile_color, title: j.stream.title, headline: j.write.headline, grade: j.write.grade, duration_seconds: j.stream.duration_seconds, peak_viewers: j.stream.peak_viewers, chat_messages: j.chat.messages, ended_at: j.stream.ended_at, thumbnail_url: j.vod ? j.vod.thumbnail_url : null }; } catch { return null; } }).filter(Boolean);
}

/** Streams that ended recently, ran long enough, and have no recap yet. */
async function pending() {
    ensureTable();
    return await db.all(`SELECT s.id FROM streams s
        WHERE s.is_live = 0 AND s.ended_at IS NOT NULL
          AND s.ended_at >= datetime('now', ?) AND s.ended_at <= datetime('now', ?)
          AND COALESCE(s.duration_seconds, (julianday(s.ended_at) - julianday(s.started_at)) * 86400) >= ?
          AND NOT EXISTS (SELECT 1 FROM stream_recaps r WHERE r.stream_id = s.id)
        ORDER BY s.ended_at ASC LIMIT 6`, [`-${LOOKBACK_HOURS} hours`, `-${SETTLE_SEC} seconds`, MIN_DURATION_SEC]) || [];
}

async function announce(recap) {
    try {
        const delivery = require('../chat/chat-delivery');
        const g = recap.write.grade;
        const frame = { type: 'system', message: `📋 After-show report for "${recap.stream.title}" is in — grade ${g}: ${recap.write.headline}. Read it: /recap/${recap.stream.id}` };
        if (delivery.ingress()) await delivery.event({ kind: 'channel', id: recap.streamer.id }, frame, { key: `recap:${recap.stream.id}` });
        else await delivery.broadcastToChannelRoom(recap.streamer.id, recap.stream.id, frame);
        await db.run('UPDATE stream_recaps SET announced_at = ov_now() WHERE stream_id = ?', [recap.stream.id]);
        return true;
    } catch (e) { console.warn('[Recap] announce:', e.message); return false; }
}

let _timer = null, _busy = false;
async function tick() {
    if (_busy) return;
    _busy = true;
    try {
        for (const row of await pending()) {
            try {
                const recap = await buildRecap(row.id);
                if (recap) { await announce(recap); console.log(`[Recap] stream ${row.id} (${recap.streamer.username}): grade ${recap.write.grade}${recap.ai ? '' : ' (template)'} — ${recap.write.headline}`); }
            } catch (e) { console.warn(`[Recap] stream ${row.id}:`, e.message); }
        }
    } finally { _busy = false; }
}
function start() {
    if (_timer) return;
    ensureTable();
    setTimeout(() => tick().catch(() => {}), 45 * 1000);
    _timer = setInterval(() => tick().catch(e => console.warn('[Recap] job:', e.message)), JOB_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    console.log('[Recap] after-show reports started (every 2 min, streams ≥ 8 min)');
}

module.exports = { buildRecap, getRecap, ensureRecap, listRecaps, listRecentRecaps, pending, announce, start, tick, gather, templateWriteup, MIN_DURATION_SEC, ensureTable };
