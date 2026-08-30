/**
 * Unified Context Service — everything the site already knows, assembled for an LLM.
 *
 * Nothing here runs a new analysis. It reads the stores other jobs keep warm:
 *   stream_timeline_events (live transcript + sounds)   stream_memories (frames)
 *   streams.ai_overview / ai_title                       streamer_overviews
 *   app_state ai_whole_overview_<uid> (combined blurb)    chat_ai_summaries (global/user/relay/anon)
 *   chat_messages (channel + relayed + bot lines)         follows / subscriptions / stream_first_chats
 *   channels (bio, panels) / managed_streams / streams    channel_ai_bots (personas, memories)
 *   ai_viewer_threads (open conversations)
 *
 * Two halves:
 *   STABLE prefix — byte-identical between calls until one of its inputs changes, so the
 *                   provider's prompt cache hits (Anthropic cache_control / OpenAI prefix).
 *                   Never put a timestamp, count or anything live in here.
 *   VOLATILE tail — deltas: only chat newer than `since`, the last N seconds of speech,
 *                   the latest frame description with its age, who is in the delta.
 *
 * The only side effect is optional: `wantFreshFrame` may ask stream-memory-job to capture
 * a frame NOW through its normal pipeline (result lands in stream_memories for everyone).
 */
'use strict';
const crypto = require('crypto');
const db = require('../../db/database');

function clip(str, n) { return (str == null ? '' : String(str)).replace(/\s+/g, ' ').trim().slice(0, n); }
function clipWords(str, n) { const t = clip(str, n * 8); return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t; }
function mmss(sec) { sec = Math.max(0, Math.round(Number(sec) || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function ago(ms) { if (ms == null || !Number.isFinite(ms)) return 'unknown'; const s = Math.round(ms / 1000); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; return `${Math.round(s / 3600)}h ago`; }
function parseTs(v) { if (!v) return null; const t = String(v); const d = new Date(/^\d{4}-\d{2}-\d{2} /.test(t) ? t.replace(' ', 'T') + 'Z' : t); return isNaN(d) ? null : d.getTime(); }
function hash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }

// Whisper emits markers on silence/noise; never show them to the model.
function scrubSpeech(text) {
    return String(text || '')
        .replace(/[<>]{2,}/g, ' ')
        .replace(/[\[(][^\])]*[\])]/g, ' ')
        .replace(/\b(thanks? for watching|subscribe to my channel)\b[.!]?/gi, ' ')
        .replace(/\s+/g, ' ').trim();
}
function hasWords(t) { return /[a-z0-9]{2,}/i.test(t || ''); }

// ── Stable prefix blocks ──────────────────────────────────────
function streamerBlock(userId) {
    const parts = [];
    try { const ov = db.getStreamerOverview(userId); if (ov && (ov.overview_short || ov.overview)) parts.push(clip(ov.overview_short || ov.overview, 700)); } catch { /* */ }
    try {
        let w = db.getState(`ai_whole_overview_${userId}`);
        if (typeof w === 'string' && /^\s*\{/.test(w)) { try { w = JSON.parse(w); } catch { /* keep string */ } }
        const t = w && typeof w === 'object' ? w.text : w;
        if (t && typeof t === 'string') parts.push(clip(t, 400));
    } catch { /* */ }
    try {
        const ch = db.getChannelByUserId(userId);
        if (ch) {
            if (ch.description) parts.push(`Channel bio: ${clip(ch.description, 240)}`);
            let panels = []; try { panels = JSON.parse(ch.panels || '[]'); } catch { /* */ }
            const titles = (panels || []).map(p => p && (p.title || p.name)).filter(Boolean).slice(0, 4);
            if (titles.length) parts.push(`Channel panels: ${titles.map(t => clip(t, 40)).join(' · ')}`);
        }
    } catch { /* */ }
    return parts.join('\n');
}
function sessionBlock(stream) {
    if (!stream) return '';
    const parts = [];
    const title = stream.ai_title || stream.title;
    const cat = stream.ai_category || stream.category;
    if (title) parts.push(`Stream title: "${clip(title, 140)}"${cat ? ` (category: ${clip(cat, 40)}${stream.ai_category ? ', judged from the stream itself' : ', self-selected'})` : ''}`);
    if (stream.ai_overview) parts.push(`What this session has been about so far: ${clip(stream.ai_overview, 500)}`);
    return parts.join('\n');
}
function rosterBlock(bots, settings) {
    const muted = new Set(((settings.runtime || {}).muted || []).map(x => String(x).toLowerCase()));
    return bots.map(b => {
        let persona = {}, brain = {};
        try { persona = JSON.parse(b.persona_json || '{}'); } catch { /* */ }
        try { brain = JSON.parse(b.brain_json || '{}'); } catch { /* */ }
        const blurb = (persona.character && persona.character.blurb) || 'a regular viewer';
        const style = (persona.style && persona.style.rules) || 'casual, short';
        const identity = persona.identity || brain.identity || '';
        const memory = brain.memory || '';
        const flags = [];
        if (muted.has(String(b.username).toLowerCase())) flags.push('MUTED — never speaks');
        if (persona.tts === false) flags.push('no tts');
        return `- ${b.username}: ${clip(blurb, 160)}. Style: ${clip(style, 100)}.${identity ? ` About them: ${clip(identity, 240)}.` : ''}${memory ? ` Remembers: ${clip(memory, 300)}` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
    }).join('\n');
}
function rulesBlock(settings) {
    const parts = [];
    if (settings.channel_personality) parts.push(`Channel personality (from the streamer): ${clip(settings.channel_personality, 1200)}`);
    if (settings.tone) parts.push(`Tone: ${clip(settings.tone, 200)}`);
    if (settings.language && settings.language !== 'auto') parts.push(`Language: ${settings.language}`);
    parts.push(`Emote/emoji usage: ${settings.emote_usage || 'some'}.`);
    if (settings.topics) parts.push(`Topics the viewers enjoy: ${clip(settings.topics, 300)}`);
    if (settings.blocklist) parts.push(`Never mention or engage with: ${clip(settings.blocklist, 500)}`);
    if (settings.channel_memory) parts.push(`Shared running bits in this chat: ${clip(settings.channel_memory, 600)}`);
    parts.push(`Lines are at most ${settings.max_words || 18} words.`);
    return parts.join('\n');
}
function runningBitsBlock(userId) {
    try {
        const closed = db.getRecentClosedAiViewerThreads(userId, 3);
        if (!closed.length) return '';
        return 'Running bits from earlier streams: ' + closed.map(t => clip(t.topic, 80)).join(' · ');
    } catch { return ''; }
}

/**
 * Build (or reuse) the stable prefix. Returns { text, hash, at }.
 * Cached on `cacheHolder.stable` until its inputs' hash changes or maxAgeMs elapses.
 */
function stablePrefix({ userId, stream, bots, settings, cacheHolder = null, maxAgeMs = 10 * 60 * 1000 }) {
    const text = [
        streamerBlock(userId),
        sessionBlock(stream),
        `The AI viewers in this chat (${bots.length}):\n${rosterBlock(bots, settings)}`,
        rulesBlock(settings),
        runningBitsBlock(userId),
    ].filter(Boolean).join('\n\n');
    const h = hash(text);
    if (cacheHolder && cacheHolder.stable && cacheHolder.stable.hash === h && Date.now() - cacheHolder.stable.at < maxAgeMs) return cacheHolder.stable;
    const out = { text, hash: h, at: Date.now() };
    if (cacheHolder) cacheHolder.stable = out;
    return out;
}

// ── Volatile blocks ──────────────────────────────────────────
function streamOffsetSec(stream) {
    const started = parseTs(stream && stream.started_at);
    return started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
}

function heardBlock(stream, settings) {
    if (!settings.hear_enabled || !stream) return { text: '', ageMs: null, count: 0, sounds: [] };
    const off = streamOffsetSec(stream);
    const from = Math.max(0, off - (settings.hear_window_sec || 90));
    let rows = [];
    try { rows = db.getTimeline(stream.id, { from, to: off + 5, limit: 80 }) || []; } catch { rows = []; }
    const speech = []; const sounds = [];
    let lastEnd = null;
    for (const r of rows) {
        if (r.kind === 'speech') { const t = scrubSpeech(r.text); if (hasWords(t)) { speech.push(`[${mmss(r.start_sec)}] ${t}`); lastEnd = r.end_sec || r.start_sec; } }
        else if (r.kind === 'sound' && r.label) sounds.push({ label: r.label, at: r.start_sec, confidence: r.confidence });
    }
    let text = speech.join('\n');
    if (text.length > 900) text = text.slice(-900).replace(/^[^\[]*/, '');
    const uniqSounds = [...new Set(sounds.map(s => s.label))].slice(0, 6);
    const ageMs = lastEnd != null ? Math.max(0, (off - lastEnd) * 1000) : null;
    return { text, ageMs, count: speech.length, sounds: uniqSounds, latestSound: sounds.length ? sounds[sounds.length - 1] : null };
}

function seenBlock(stream) {
    if (!stream) return { text: '', ageMs: null, memoryId: null, tags: [] };
    let m = null;
    try { m = db.getLatestStreamMemory(stream.id); } catch { m = null; }
    if (!m) return { text: '', ageMs: null, memoryId: null, tags: [] };
    const desc = String(m.description || '').replace(/\s+—\s+heard:.*$/s, '').trim();
    let tags = []; try { tags = JSON.parse(m.tags || '[]'); } catch { tags = []; }
    const off = streamOffsetSec(stream);
    const ageMs = Math.max(0, (off - (m.offset_seconds || 0)) * 1000);
    return { text: clip(desc, 300), ageMs, memoryId: m.id, tags: Array.isArray(tags) ? tags.slice(0, 6) : [] };
}

function chatDelta(channelUserId, sinceId, { limit = 40, botNames = new Set() } = {}) {
    let rows = [];
    try { rows = db.getChannelChatSince(channelUserId, sinceId || 0, limit) || []; } catch { rows = []; }
    const lines = rows.map(r => {
        const isBot = r.source_platform === 'ai' || botNames.has(String(r.username || '').toLowerCase());
        const tag = isBot ? ' (AI viewer)' : (r.source_platform && r.source_platform !== 'ai' ? '' : '');
        return { id: r.id, username: r.username, message: clip(r.message, 160), isBot, userId: r.user_id, anonId: r.anon_id, platform: r.source_platform || null, replyTo: r.reply_to_id || null, tag };
    });
    const text = lines.map(l => `${l.username}${l.isBot ? ' (AI viewer)' : ''}: ${l.message}`).join('\n');
    return { lines, text: text.length > 2500 ? text.slice(-2500) : text, maxId: rows.length ? rows[rows.length - 1].id : sinceId || 0 };
}

function moodBlock() {
    try { const g = require('../chat-ai').getGlobalInsight(); return g && g.overview ? clip(g.overview, 250) : ''; } catch { return ''; }
}

function personBlock(line, channelUserId, settings) {
    if (!settings.remember_viewers || line.isBot) return '';
    const chatAi = require('../chat-ai');
    let ins = null;
    try {
        if (line.userId) ins = chatAi.getUserInsight(line.userId);
        else if (line.anonId) ins = chatAi.getAnonInsight(line.anonId);
        else if (line.platform && !line.userId) {
            const m = String(line.username || '').match(/^\[[^\]]+\]\s*(.+)$/);
            const ru = db.getRelayUser(line.platform, m ? m[1] : line.username);
            if (ru) ins = chatAi.getRelayUserInsight(ru.id);
        }
    } catch { ins = null; }
    const flags = [];
    try {
        if (line.userId) {
            if (line.userId === channelUserId) flags.push('THE STREAMER');
            else {
                if (db.isActiveSubscriber(line.userId, channelUserId)) flags.push('subscriber');
                else if (db.isFollowing(line.userId, channelUserId)) flags.push('follower');
            }
        }
        const key = line.userId ? `user:${line.username}` : (line.anonId ? `anon:${line.anonId}` : `ext:${line.username}`);
        if (line.userId !== channelUserId && settings.greet_first_timers && db.isFirstChatInChannel && db.isFirstChatInChannel(key, channelUserId)) flags.push('first time chatting here');
    } catch { /* */ }
    const insight = ins ? clip([ins.overview_24h || ins.overview_alltime, ins.memory].filter(Boolean).join(' — '), 220) : '';
    if (!insight && !flags.length) return '';
    return `- ${line.username}${flags.length ? ` [${flags.join(', ')}]` : ''}${insight ? `: ${insight}` : ''}`;
}

function threadsBlock(channelUserId, limit) {
    let rows = [];
    try { rows = db.getOpenAiViewerThreads(channelUserId, limit || 5) || []; } catch { rows = []; }
    return {
        rows,
        text: rows.map(t => {
            let who = []; try { who = JSON.parse(t.participants_json || '[]'); } catch { /* */ }
            return `- thread #${t.id} (${t.kind.replace('_', '↔')}, ${who.join(' & ')}${t.topic ? `, about: ${clip(t.topic, 60)}` : ''}, ${t.turns} turns)${t.last_line ? ` last: ${t.last_line_by}: "${clip(t.last_line, 120)}"` : ''}${t.awaiting ? ` — waiting on ${t.awaiting}` : ''}`;
        }).join('\n'),
    };
}

function viewerCountOf(stream) {
    try { const cs = require('../../chat/chat-server'); if (cs && typeof cs.getStreamViewerCount === 'function') return cs.getStreamViewerCount(stream.id); } catch { /* */ }
    return stream && stream.viewer_count != null ? stream.viewer_count : null;
}

/**
 * Assemble the volatile tail.
 * @returns {{ text, hash, changed, chatMaxId, delta, sources }}
 */
function volatileTail({ userId, stream, settings, sinceChatId = 0, botNames = new Set(), intents = [], mode = 'normal', linesAllowed = 3, botShare = null }) {
    const heard = heardBlock(stream, settings);
    const seen = seenBlock(stream);
    const chat = chatDelta(userId, sinceChatId, { botNames });
    const mood = moodBlock();
    const threads = threadsBlock(userId, settings.max_open_threads || 3);
    const people = [];
    const seenNames = new Set();
    for (const l of chat.lines) {
        if (l.isBot || seenNames.has(l.username)) continue;
        seenNames.add(l.username);
        if (people.length >= 6) break;
        const p = personBlock(l, userId, settings);
        if (p) people.push(p);
    }
    const vc = viewerCountOf(stream);
    const parts = [];
    parts.push(`Now: ${mmss(streamOffsetSec(stream))} into the stream${vc != null ? `, ${vc} viewers` : ''}${stream && stream.title ? `, title "${clip(stream.title, 100)}"` : ''}.`);
    if (heard.text) parts.push(`Heard on stream (last ${settings.hear_window_sec || 90}s, latest speech ${ago(heard.ageMs)}):\n${heard.text}`);
    else if (settings.hear_enabled) parts.push('Heard on stream: (no speech in the last window)');
    if (heard.sounds.length) parts.push(`Sounds detected: ${heard.sounds.join(', ')}`);
    if (seen.text) parts.push(`On screen (${ago(seen.ageMs)}): ${seen.text}${seen.tags.length ? ` [${seen.tags.join(', ')}]` : ''}`);
    if (mood) parts.push(`Site-wide chat mood: ${mood}`);
    parts.push(chat.text ? `New chat since last look:\n${chat.text}` : 'New chat since last look: (nothing new)');
    if (people.length) parts.push(`About the people in that chat:\n${people.join('\n')}`);
    if (threads.text) parts.push(`Open conversations:\n${threads.text}`);
    if (intents.length) parts.push(`Must handle now:\n${intents.map(i => `- ${i.text}`).join('\n')}`);
    parts.push(`Plan budget: mode ${mode}; up to ${linesAllowed} line(s) this pass${botShare != null ? `; bot-to-bot share so far ${Math.round(botShare * 100)}% (target ≤ ${Math.round((settings.bot_to_bot_ratio || 0) * 100)}%)` : ''}.`);
    const text = parts.join('\n\n');
    const changeKey = hash([heard.text, seen.memoryId, chat.maxId, intents.map(i => i.text).join('|')].join(''));
    return {
        text, hash: changeKey, chatMaxId: chat.maxId,
        delta: { newChat: chat.lines.filter(l => !l.isBot).length, newChatAll: chat.lines.length, speechLines: heard.count, memoryId: seen.memoryId, latestSound: heard.latestSound },
        sources: { heardAgeMs: heard.ageMs, seenAgeMs: seen.ageMs, seenMemoryId: seen.memoryId, chatLines: chat.lines.length, people: people.length, threads: threads.rows.length, mood: !!mood },
        chatLines: chat.lines, threads: threads.rows,
    };
}

/**
 * Ask the stream-memory pipeline for a fresh frame analysis if the latest one is older
 * than maxAgeSec. The result is stored in stream_memories for everyone (never a private
 * throwaway vision call). Returns true if a capture was started.
 */
async function wantFreshFrame(stream, { maxAgeSec = 180, allowFfmpeg = true } = {}) {
    if (!stream) return false;
    const seen = seenBlock(stream);
    if (seen.ageMs != null && seen.ageMs < maxAgeSec * 1000) return false;
    try {
        const job = require('../stream-memory-job');
        if (typeof job.captureMemoryNow !== 'function') return false;
        await job.captureMemoryNow(stream, { allowFfmpeg, reason: 'ai-viewers' });
        return true;
    } catch { return false; }
}

module.exports = { stablePrefix, volatileTail, wantFreshFrame, heardBlock, seenBlock, chatDelta, scrubSpeech, clip, clipWords, ago, mmss, hash, streamOffsetSec };
