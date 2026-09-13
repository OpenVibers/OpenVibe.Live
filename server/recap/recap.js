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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.getDb().exec('CREATE INDEX IF NOT EXISTS idx_stream_recaps_user ON stream_recaps(user_id, created_at)');
        _tableReady = true;
    } catch (e) { console.warn('[Recap] table:', e.message); }
}

const sqlTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseTs = (s) => { if (!s) return NaN; const t = Date.parse(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')); return t; };
const safe = (fn, dflt) => { try { const v = fn(); return v == null ? dflt : v; } catch { return dflt; } };
function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }

/** Everything we know about one finished stream. */
async function gather(streamId) {
    const stream = db.getStreamById(streamId);
    if (!stream || stream.is_live) return null;
    const user = db.getUserById(stream.user_id);
    if (!user) return null;
    const startMs = parseTs(stream.started_at);
    const endMs = parseTs(stream.ended_at) || (startMs + (stream.duration_seconds || 0) * 1000);
    const durationSec = Number(stream.duration_seconds) || Math.max(0, Math.round((endMs - startMs) / 1000));
    const start = sqlTs(startMs), end = sqlTs(endMs);

    // Viewer curve (sampled every ~minute by the chat server while live).
    const curve = safe(() => db.all(`SELECT recorded_at AS t, viewer_count AS v, COALESCE(chat_messages_5m, 0) AS c FROM viewer_snapshots WHERE stream_id = ? ORDER BY recorded_at ASC`, [streamId]), []);
    const viewersAvg = curve.length ? Math.round(curve.reduce((n, p) => n + Number(p.v || 0), 0) / curve.length * 10) / 10 : null;
    const peakAt = curve.length ? curve.reduce((best, p) => (Number(p.v) > Number(best.v) ? p : best), curve[0]) : null;

    // Chat.
    const chat = safe(() => db.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT COALESCE(user_id, anon_id, username)) AS chatters FROM chat_messages WHERE stream_id = ? AND COALESCE(is_deleted, 0) = 0`, [streamId]), { n: 0, chatters: 0 });
    const topChatters = safe(() => db.all(`SELECT c.username, u.display_name, u.avatar_url, u.profile_color, COUNT(*) AS n
        FROM chat_messages c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.stream_id = ? AND COALESCE(c.is_deleted, 0) = 0 AND c.username IS NOT NULL AND (c.user_id IS NULL OR c.user_id != ?)
        GROUP BY COALESCE(c.user_id, c.username) ORDER BY n DESC LIMIT 5`, [streamId, stream.user_id]), []);
    const busiest = curve.length ? curve.reduce((best, p) => (Number(p.c) > Number(best.c) ? p : best), curve[0]) : null;
    const sounds = safe(() => db.get(`SELECT COUNT(*) AS n FROM chat_messages WHERE stream_id = ? AND message_type = 'soundboard'`, [streamId]).n, 0);

    // Arena mic lines said on this stream.
    const micLines = safe(() => db.all(`SELECT text, quality, kind, aimed_at, sec, vod_id FROM arena_mic_moments WHERE stream_id = ? ORDER BY quality DESC, said_at ASC LIMIT 4`, [streamId]), []);

    // Money + love.
    const tips = safe(() => db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'donation' AND COALESCE(status, 'completed') NOT IN ('failed', 'refunded', 'pending') AND ((stream_id = ?) OR (to_user_id = ? AND created_at BETWEEN ? AND ?))`, [streamId, stream.user_id, start, end]), { n: 0, total: 0 });
    const topTipper = safe(() => db.get(`SELECT u.username, u.display_name, SUM(t.amount) AS total FROM transactions t JOIN users u ON u.id = t.from_user_id
        WHERE t.type = 'donation' AND ((t.stream_id = ?) OR (t.to_user_id = ? AND t.created_at BETWEEN ? AND ?)) GROUP BY t.from_user_id ORDER BY total DESC LIMIT 1`, [streamId, stream.user_id, start, end]), null);
    const follows = safe(() => db.get(`SELECT COUNT(*) AS n FROM follows WHERE streamer_id = ? AND created_at BETWEEN ? AND ?`, [stream.user_id, start, end]).n, 0);
    const followersNow = safe(() => db.getFollowerCount(stream.user_id), null);

    // What was said (for the model): a slice of the transcript, English when we have it.
    const speech = safe(() => db.all(`SELECT COALESCE(text_en, text) AS t, start_sec AS s FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' ORDER BY start_sec ASC`, [streamId]), []);
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
        chat: { messages: Number(chat.n) || 0, chatters: Number(chat.chatters) || 0, top: topChatters.map(r => ({ username: r.username, display_name: r.display_name || r.username, avatar_url: r.avatar_url || null, profile_color: r.profile_color || null, n: Number(r.n) })), busiest_at: busiest && Number(busiest.c) > 0 ? busiest.t : null, busiest_n: busiest ? Number(busiest.c) : 0, sounds },
        mic: micLines.map(m => ({ text: m.text, quality: m.quality, kind: m.kind, aimed_at: m.aimed_at || null, sec: m.sec, vod_id: m.vod_id || null })),
        love: { tips: Number(tips.n) || 0, tips_total: Number(tips.total) || 0, top_tipper: topTipper ? { username: topTipper.username, display_name: topTipper.display_name || topTipper.username, total: Number(topTipper.total) } : null, follows, followers_now: followersNow },
        speech: { lines: speech.length, sample: speechSample },
        vod, clips,
    };
}

// ── The write-up ─────────────────────────────────────────────
const SCHEMA = { name: 'stream_recap', schema: { type: 'object', additionalProperties: false, required: ['headline', 'summary', 'moment', 'tags', 'grade'], properties: {
    headline: { type: 'string', description: '≤ 70 chars, like a sports-page headline about this stream, no quotes, no emojis' },
    summary: { type: 'string', description: '2–3 sentences, ≤ 420 chars, what happened and how it went, concrete, warm, second person is fine' },
    moment: { type: 'string', description: '≤ 160 chars, the single moment of the night (from the mic lines, chat spike, a clip title or the transcript) — or empty string' },
    tags: { type: 'array', items: { type: 'string' }, description: '3 short vibe tags, 1–2 words each, lowercase' },
    grade: { type: 'string', enum: ['S', 'A', 'B', 'C'], description: 'S = legendary night, A = great, B = solid, C = quiet' },
} } };

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
    const system = `You write the "after-show report" for a live stream on OpenVibe.Live (a scrappy, open-source, community-run streaming site). Voice: sports-page energy, warm, specific, a little funny, never mocking the streamer or the viewers. Use the REAL numbers and names given. Small streams are fine — a 4-viewer night can still be an A if it was fun. Output only JSON.`;
    let r = null;
    try { r = await llm.complete({ role: 'summary', kind: 'stream_recap', source: 'recap', ownerUserId: g.streamer.id, system, user: JSON.stringify(facts), json: SCHEMA, maxTokens: 500, temperature: 0.8, timeoutMs: 40000 }); } catch (e) { console.warn('[Recap] model call failed:', e.message); return null; }
    const out = r && (r.json || (r.text ? llm.parseJsonLoose(r.text) : null));
    if (!out || !out.headline || !out.summary) return null;
    return { headline: String(out.headline).trim().slice(0, 90), summary: String(out.summary).trim().slice(0, 500), moment: String(out.moment || '').trim().slice(0, 200), tags: (Array.isArray(out.tags) ? out.tags : []).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 4), grade: ['S', 'A', 'B', 'C'].includes(out.grade) ? out.grade : 'B' };
}

async function buildRecap(streamId, { ai = true } = {}) {
    ensureTable();
    const g = await gather(streamId);
    if (!g) return null;
    let write = ai ? await aiWriteup(g) : null;
    const usedAi = !!write;
    if (!write) write = templateWriteup(g);
    const recap = { ...g, write, ai: usedAi, generated_at: new Date().toISOString() };
    db.run(`INSERT INTO stream_recaps (stream_id, user_id, json, ai, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(stream_id) DO UPDATE SET json = excluded.json, ai = excluded.ai, created_at = CURRENT_TIMESTAMP`, [streamId, g.streamer.id, JSON.stringify(recap), usedAi ? 1 : 0]);
    return recap;
}

function getRecap(streamId) {
    ensureTable();
    const row = db.get('SELECT json FROM stream_recaps WHERE stream_id = ?', [streamId]);
    if (!row) return null;
    try { return JSON.parse(row.json); } catch { return null; }
}

async function ensureRecap(streamId) { return getRecap(streamId) || buildRecap(streamId); }

/** Latest recaps for a channel (for the channel page / "more nights like this"). */
function listRecaps(userId, limit = 6) {
    ensureTable();
    return (db.all('SELECT stream_id, json, ai, created_at FROM stream_recaps WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]) || []).map(r => {
        try { const j = JSON.parse(r.json); return { stream_id: r.stream_id, title: j.stream.title, headline: j.write.headline, grade: j.write.grade, duration_seconds: j.stream.duration_seconds, peak_viewers: j.stream.peak_viewers, ended_at: j.stream.ended_at, thumbnail_url: j.vod ? j.vod.thumbnail_url : null }; } catch { return null; }
    }).filter(Boolean);
}

/** Streams that ended recently, ran long enough, and have no recap yet. */
function pending() {
    ensureTable();
    return db.all(`SELECT s.id FROM streams s
        WHERE s.is_live = 0 AND s.ended_at IS NOT NULL
          AND s.ended_at >= datetime('now', ?) AND s.ended_at <= datetime('now', ?)
          AND COALESCE(s.duration_seconds, (julianday(s.ended_at) - julianday(s.started_at)) * 86400) >= ?
          AND NOT EXISTS (SELECT 1 FROM stream_recaps r WHERE r.stream_id = s.id)
        ORDER BY s.ended_at ASC LIMIT 6`, [`-${LOOKBACK_HOURS} hours`, `-${SETTLE_SEC} seconds`, MIN_DURATION_SEC]) || [];
}

function announce(recap) {
    try {
        const chat = require('../chat/chat-server');
        const server = chat.chatServer || chat.default || chat;
        if (!server || typeof server.broadcastToChannelRoom !== 'function') return false;
        const g = recap.write.grade;
        server.broadcastToChannelRoom(recap.streamer.id, recap.stream.id, { type: 'system', message: `📋 After-show report for "${recap.stream.title}" is in — grade ${g}: ${recap.write.headline}. Read it: /recap/${recap.stream.id}` });
        db.run('UPDATE stream_recaps SET announced_at = CURRENT_TIMESTAMP WHERE stream_id = ?', [recap.stream.id]);
        return true;
    } catch (e) { console.warn('[Recap] announce:', e.message); return false; }
}

let _timer = null, _busy = false;
async function tick() {
    if (_busy) return;
    _busy = true;
    try {
        for (const row of pending()) {
            try {
                const recap = await buildRecap(row.id);
                if (recap) { announce(recap); console.log(`[Recap] stream ${row.id} (${recap.streamer.username}): grade ${recap.write.grade}${recap.ai ? '' : ' (template)'} — ${recap.write.headline}`); }
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

module.exports = { buildRecap, getRecap, ensureRecap, listRecaps, pending, announce, start, tick, gather, templateWriteup, MIN_DURATION_SEC, ensureTable };
