/**
 * chat-ai.js — rolling AI insight for chat.
 *
 * Two products, one engine:
 *   • GLOBAL — an overview + timeline of ALL chat across the whole site (global
 *     room, every stream slot, every channel). Shown in the /chat header + panel.
 *   • PER-USER — a "today (24h) vs all-time" read on an individual chatter.
 *
 * Design for low cost + graceful scaling:
 *   • Pure DB poller (no hooks in the 8 saveChatMessage call sites). The high-water
 *     mark lives in `chat_ai_summaries.last_message_id`, so it survives restarts.
 *   • INCREMENTAL: each refresh folds only the recent window into a condensed running
 *     "memory" carried forward — one small LLM call per subject, cost is flat with volume.
 *   • ADAPTIVE window: the global overview covers however long it takes to gather ~300
 *     messages, clamped to [30 min, 14 days] — busy chat → short window, quiet → wide.
 *   • THROTTLED + CAPPED: min-interval between refreshes, a few subjects per tick, and
 *     everything gated by the shared `ai_enabled` switch + daily USD budget (summarizeText
 *     returns null when disabled/over-budget, so we just skip).
 */
'use strict';

const db = require('../db/database');

// ── Tunables ─────────────────────────────────────────────────────────────────
const TICK_MS = 45 * 1000;

const GLOBAL_MSG_THRESHOLD = 100;               // refresh once this many new msgs pile up
const GLOBAL_MIN_INTERVAL_MS = 5 * 60 * 1000;   // never more often than this (flood guard)
const GLOBAL_MAX_AGE_MS = 30 * 60 * 1000;       // ...but refresh at least this often if any new

const USER_MSG_THRESHOLD = 15;                  // per-user refresh trigger
const USER_MAX_PER_TICK = 2;                    // cap LLM calls per tick
const USER_PASS_EVERY_MS = 3 * 60 * 1000;       // throttle the (heavier) user discovery scan
const USER_STALE_MS = 24 * 60 * 60 * 1000;      // refresh a lagging user at least daily
const USER_DISCOVERY_LOOKBACK_DAYS = 14;        // bound the discovery GROUP BY

const WINDOW_TARGET_MESSAGES = 300;             // adaptive-window sizing target
const MAX_BATCH_MESSAGES = 300;                 // token cap per call
const WINDOW_MIN_MS = 30 * 60 * 1000;           // overview window is never shorter than 30 min
const WINDOW_MAX_MS = 14 * 24 * 60 * 60 * 1000; // ...nor longer than 14 days
const MEMORY_MAX_CHARS = 1600;
const USER_MEMORY_MAX_CHARS = 1200;
const TIMELINE_MAX = 40;
const MSG_MAX_CHARS = 220;
const PROMPT_MSGS_MAX_CHARS = 9000;

let _running = false;
let _timer = null;
let _tickInFlight = false;
let _lastUserPass = 0;

// ── Small utils ──────────────────────────────────────────────────────────────
function _ai() { return require('./ai-analysis'); }

// DB timestamps are UTC 'YYYY-MM-DD HH:MM:SS' (CURRENT_TIMESTAMP). Match that format.
function _sqlTime(d) { return new Date(d).toISOString().slice(0, 19).replace('T', ' '); }
function _parseSqlTime(s) { return s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : 0; }

function _parseJson(text) {
    if (!text) return null;
    // Prefer a fenced/object slice; tolerate leading prose from chatty models.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { /* */ }
    // Retry after stripping trailing commas.
    try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

function _clip(str, n) { str = (str == null ? '' : String(str)).trim(); return str.length > n ? str.slice(0, n) : str; }

function _fmtMessages(rows, { includeChannel = false, now = 0 } = {}) {
    const lines = [];
    for (const r of rows) {
        const who = r.username || (r.user_id ? `user#${r.user_id}` : 'anon');
        let ctx = '';
        if (includeChannel) {
            if (r.is_global) ctx = '[global] ';
            else if (r.channel_username) ctx = `[#${r.channel_username}] `;
            else if (r.stream_id) ctx = `[stream] `;
        }
        const kind = (r.message_type && r.message_type !== 'chat') ? `(${r.message_type}) ` : '';
        // "[Xm ago]" marker so the model can time-stamp notable moments accurately.
        let when = '';
        if (now) { const t = _parseSqlTime(r.timestamp || r.created_at); if (t) when = `[${Math.max(0, Math.round((now - t) / 60000))}m ago] `; }
        lines.push(`${when}${ctx}${who}: ${kind}${_clip(r.message, MSG_MAX_CHARS)}`);
    }
    let out = lines.join('\n');
    if (out.length > PROMPT_MSGS_MAX_CHARS) out = out.slice(out.length - PROMPT_MSGS_MAX_CHARS); // keep the freshest
    return out;
}

function _windowLabel(ms) {
    const min = Math.round(ms / 60000);
    if (min < 90) return min <= 60 ? 'past hour' : `past ${min} min`;
    const hrs = Math.round(ms / 3600000);
    if (hrs < 36) return `past ${hrs} hours`;
    const days = Math.max(1, Math.round(ms / 86400000));
    return `past ${days} day${days === 1 ? '' : 's'}`;
}

// Stamp raw model additions into {ts,label,detail}, skipping placeholders, timestamping each
// with the AI's mins_ago (when it happened) or the fallback.
function _stampAdditions(additions, fallbackTs, nowMs) {
    const now = nowMs || Date.now();
    const out = [];
    for (const a of (Array.isArray(additions) ? additions : [])) {
        const label = _clip(a && (a.label || a.title), 80);
        if (!label || _isPlaceholder(label)) continue;
        let ts = fallbackTs;
        const mins = Number(a && a.mins_ago);
        if (Number.isFinite(mins) && mins >= 0 && mins <= 43200) ts = _sqlTime(now - mins * 60000);
        out.push({ ts, label, detail: _clip(a.detail || a.description || '', 240) });
    }
    return out;
}
function _mergeTimeline(priorJson, additions, fallbackTs, nowMs) {
    let prior = [];
    try { prior = JSON.parse(priorJson || '[]'); if (!Array.isArray(prior)) prior = []; } catch { prior = []; }
    prior.push(..._stampAdditions(additions, fallbackTs, nowMs));
    // Keep chronological (mins_ago stamps mean append order isn't time order) then cap to newest.
    prior.sort((x, y) => _parseSqlTime(x.ts) - _parseSqlTime(y.ts));
    if (prior.length > TIMELINE_MAX) prior = prior.slice(prior.length - TIMELINE_MAX);
    return JSON.stringify(prior);
}
// The model sometimes echoes the schema's example text as a real entry — reject those.
function _isPlaceholder(s) { return /^(short title|one sentence|label|title|detail|\.\.\.)$/i.test(String(s || '').trim()); }
function _cleanTimeline(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(t => t && t.label && !_isPlaceholder(t.label))
        .sort((a, b) => _parseSqlTime(a.ts) - _parseSqlTime(b.ts)); // chronological; UI reverses for newest-first
}

// ── GLOBAL ───────────────────────────────────────────────────────────────────
async function _refreshGlobal() {
    const ai = _ai();
    const prior = db.getChatAiSummary('global', 0, 'global');
    const hw = prior ? (prior.last_message_id || 0) : 0;
    const maxId = db.getMaxChatMessageId();
    const newCount = maxId > hw ? db.countChatMessagesSince(hw) : 0;
    if (newCount === 0) return false;

    const ageMs = prior && prior.updated_at ? (Date.now() - _parseSqlTime(prior.updated_at)) : Infinity;
    if (ageMs < GLOBAL_MIN_INTERVAL_MS) return false;
    if (newCount < GLOBAL_MSG_THRESHOLD && ageMs < GLOBAL_MAX_AGE_MS) return false;

    // Adaptive window: back to the ~300th-most-recent message, clamped to [30min, 14d].
    const now = Date.now();
    const nthTs = db.getNthRecentChatTs(WINDOW_TARGET_MESSAGES);
    let startMs = nthTs ? _parseSqlTime(nthTs) : (now - WINDOW_MAX_MS);
    startMs = Math.min(startMs, now - WINDOW_MIN_MS);
    startMs = Math.max(startMs, now - WINDOW_MAX_MS);
    const windowStart = _sqlTime(startMs);
    const windowLabel = _windowLabel(now - startMs);

    const rows = db.getChatMessagesForAi({ sinceTs: windowStart, order: 'desc', limit: MAX_BATCH_MESSAGES });
    if (!rows.length) return false;
    const priorMemory = prior ? (prior.memory_json || '') : '';
    let priorTl = [];
    try { priorTl = JSON.parse(prior ? (prior.timeline_json || '[]') : '[]'); } catch { priorTl = []; }
    const recentLabels = priorTl.slice(-8).map(t => `- ${t.label}`).join('\n') || '(none yet)';

    const prompt =
`You are the community analyst for a live-streaming site's chat. Analyze the RECENT chat below (covers roughly the ${windowLabel}, across the global room and individual streamer channels) and update a rolling picture of the community.

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "recent_overview": "2-4 sentences on what the chat is about right now: main topics, mood/energy, who's active, any notable events. Concrete, no fluff.",
  "memory": "Condensed running notes about this community carried forward: recurring topics, regulars, running jokes, ongoing events/dramas. Update the PRIOR notes with anything new; keep it under ~1400 chars.",
  "timeline": [ {"label":"short title","detail":"one sentence","mins_ago": <integer: minutes before now this happened, read from the [Xm ago] markers on the messages>} ]  // 0-3 genuinely NOTABLE moments from THIS window (raids, milestones, big drama, memorable bits). Use [] if nothing stands out — do not invent.
}

PRIOR running notes (may be empty):
"""${_clip(priorMemory, MEMORY_MAX_CHARS)}"""

Recent timeline entries already recorded (avoid duplicating these):
${recentLabels}

RECENT CHAT (${rows.length} messages, oldest first):
${_fmtMessages(rows, { includeChannel: true, now })}`;

    const text = await ai.summarizeText(prompt, 700, 'chat_global');
    if (!text) return false; // disabled / over budget / call failed
    const parsed = _parseJson(text);
    if (!parsed) { console.warn('[ChatAI] global: unparseable model output'); return false; }

    const nowIso = _sqlTime(now);
    // Persist the new moments to the growing timeline log (for the browsable/searchable view).
    try { db.addChatTimelineEvents('global', 0, _stampAdditions(parsed.timeline, nowIso, now)); } catch { /* */ }
    db.upsertChatAiSummary({
        scope: 'global', subject_id: 0, window: 'global',
        overview: _clip(parsed.recent_overview || '', 2000),
        memory_json: _clip(parsed.memory || priorMemory, MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, nowIso, now),
        message_count: (prior ? (prior.message_count || 0) : 0) + newCount,
        window_message_count: rows.length,
        last_message_id: maxId,
        window_label: windowLabel,
        window_start: windowStart,
        window_end: nowIso,
    });
    console.log(`[ChatAI] global refreshed (${newCount} new, window=${windowLabel}, ${rows.length} msgs)`);
    return true;
}

// ── PER-USER ─────────────────────────────────────────────────────────────────
async function _refreshUser(uid, maxId) {
    const ai = _ai();
    const prior = db.getChatAiSummary('user', uid, 'rolling');
    const now = Date.now();

    // Last-24h messages for the "today" read; fall back to most-recent if quiet in 24h.
    const dayStart = _sqlTime(now - 24 * 60 * 60 * 1000);
    let dayRows = db.getChatMessagesForAi({ sinceTs: dayStart, userId: uid, order: 'asc', limit: MAX_BATCH_MESSAGES });
    let has24h = dayRows.length > 0;
    if (!dayRows.length) dayRows = db.getChatMessagesForAi({ userId: uid, order: 'desc', limit: 80 });
    if (!dayRows.length) return false;

    const uname = dayRows[dayRows.length - 1].username || `user#${uid}`;
    const priorMemory = prior ? (prior.memory_json || '') : '';
    const totalSeen = (prior ? (prior.message_count || 0) : 0);

    const prompt =
`You profile an individual chatter ("${uname}") on a live-streaming site, contrasting who they are TODAY vs OVERALL. Base everything only on the evidence below — do not invent.

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "overview_24h": "${has24h ? '2-3 sentences on what this user has been chatting about and their mood/energy in the LAST 24 HOURS.' : 'They have not chatted in the last 24h; write 1 sentence noting they have been quiet recently.'}",
  "overview_alltime": "2-3 sentences on who this user is as a chatter OVERALL: their style, recurring interests, tone, how they interact.",
  "memory": "Condensed running notes about this user carried forward (interests, catchphrases, who they talk to, patterns). Update the PRIOR notes; keep under ~1000 chars.",
  "timeline": [ {"label":"short title","detail":"one sentence","mins_ago": <integer: minutes before now this happened, read from the [Xm ago] markers on the messages>} ]  // 0-2 NEW notable moments for this user, or [].
}

PRIOR running notes (all-time gist so far${totalSeen ? `; ~${totalSeen} messages seen previously` : ''}):
"""${_clip(priorMemory, USER_MEMORY_MAX_CHARS)}"""

${has24h ? 'MESSAGES FROM THIS USER IN THE LAST 24H' : 'THIS USER\'S MOST RECENT MESSAGES'} (oldest first):
${_fmtMessages(dayRows, { now })}`;

    const text = await ai.summarizeText(prompt, 600, 'chat_user');
    if (!text) return false;
    const parsed = _parseJson(text);
    if (!parsed) { console.warn(`[ChatAI] user ${uid}: unparseable model output`); return false; }

    const newCount = db.countChatMessagesSince(prior ? (prior.last_message_id || 0) : 0, uid);
    const nowIso = _sqlTime(now);
    // Stamp new timeline moments with the user's ACTUAL last activity time in the analyzed
    // batch — NOT "now". Otherwise old moments show as "2m ago" whenever the insight is refreshed
    // (e.g. when someone opens it), even if the user hasn't chatted in days.
    const _lastRow = dayRows[dayRows.length - 1] || {};
    const activityTs = _lastRow.timestamp || _lastRow.created_at || nowIso;
    // Canonical rolling row: memory + timeline + high-water + both overviews (as JSON).
    db.upsertChatAiSummary({
        scope: 'user', subject_id: uid, window: 'rolling',
        overview: JSON.stringify({
            today: _clip(parsed.overview_24h || '', 1200),
            alltime: _clip(parsed.overview_alltime || '', 1200),
            has_24h: has24h,
        }),
        memory_json: _clip(parsed.memory || priorMemory, USER_MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, activityTs, now),
        message_count: totalSeen + newCount,
        window_message_count: dayRows.length,
        last_message_id: maxId || db.getMaxChatMessageId(),
        window_label: has24h ? 'past 24h' : 'recent',
        window_start: has24h ? dayStart : null,
        window_end: nowIso,
    });
    console.log(`[ChatAI] user ${uid} (${uname}) refreshed (${newCount} new, 24h=${has24h})`);
    return true;
}

async function _userPass() {
    const staleCutoff = _sqlTime(Date.now() - USER_STALE_MS);
    const sinceTs = _sqlTime(Date.now() - USER_DISCOVERY_LOOKBACK_DAYS * 86400000);
    let candidates = [];
    try {
        candidates = db.getUsersNeedingChatAi({
            threshold: USER_MSG_THRESHOLD, staleCutoffIso: staleCutoff, sinceTs, limit: USER_MAX_PER_TICK,
        });
    } catch (e) { console.warn('[ChatAI] user discovery failed:', e.message); return; }
    for (const c of candidates) {
        if (!c.uid) continue;
        try { await _refreshUser(c.uid, c.max_id); }
        catch (e) { console.warn(`[ChatAI] user ${c.uid} refresh failed:`, e.message); }
    }
}

// ── PER RELAY-USER (external platform chatters bridged in) ────────────────────
// Same "today vs all-time" insight as a native user, keyed by the relay_users rowid.
async function _refreshRelayUser(ru) {
    const ai = _ai();
    const prior = db.getChatAiSummary('relay', ru.id, 'rolling');
    const now = Date.now();
    const dayStart = _sqlTime(now - 24 * 60 * 60 * 1000);

    let dayRows = db.getRelayChatMessagesForAi({ platform: ru.platform, rawUsername: ru.username, sinceTs: dayStart, order: 'asc', limit: MAX_BATCH_MESSAGES });
    let has24h = dayRows.length > 0;
    if (!dayRows.length) dayRows = db.getRelayChatMessagesForAi({ platform: ru.platform, rawUsername: ru.username, order: 'desc', limit: 80 });
    if (!dayRows.length) return false;

    const uname = ru.display_name || ru.username;
    const priorMemory = prior ? (prior.memory_json || '') : '';

    const prompt =
`You profile an external chatter ("${uname}", bridged in from ${ru.platform}) on a live-streaming site, contrasting who they are TODAY vs OVERALL. Base everything only on the evidence below — do not invent.

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "overview_24h": "${has24h ? '2-3 sentences on what this user chatted about and their mood/energy in the LAST 24 HOURS.' : 'They have not chatted in the last 24h; 1 sentence noting they have been quiet recently.'}",
  "overview_alltime": "2-3 sentences on who this user is as a chatter OVERALL: style, recurring interests, tone.",
  "memory": "Condensed running notes carried forward (interests, catchphrases, patterns). Update the PRIOR notes; keep under ~1000 chars.",
  "timeline": [ {"label":"short title","detail":"one sentence","mins_ago": <integer: minutes before now this happened, read from the [Xm ago] markers on the messages>} ]  // 0-2 NEW notable moments, or [].
}

PRIOR running notes:
"""${_clip(priorMemory, USER_MEMORY_MAX_CHARS)}"""

${has24h ? 'MESSAGES FROM THIS USER IN THE LAST 24H' : "THIS USER'S MOST RECENT MESSAGES"} (oldest first):
${_fmtMessages(dayRows, { now })}`;

    const text = await ai.summarizeText(prompt, 600, 'chat_relay');
    if (!text) return false;
    const parsed = _parseJson(text);
    if (!parsed) { console.warn(`[ChatAI] relay ${ru.id}: unparseable model output`); return false; }

    const nowIso = _sqlTime(now);
    db.upsertChatAiSummary({
        scope: 'relay', subject_id: ru.id, window: 'rolling',
        overview: JSON.stringify({
            today: _clip(parsed.overview_24h || '', 1200),
            alltime: _clip(parsed.overview_alltime || '', 1200),
            has_24h: has24h,
        }),
        memory_json: _clip(parsed.memory || priorMemory, USER_MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, nowIso, now),
        message_count: ru.message_count || 0,
        window_message_count: dayRows.length,
        last_message_id: db.getMaxChatMessageId(),
        window_label: has24h ? 'past 24h' : 'recent',
        window_start: has24h ? dayStart : null,
        window_end: nowIso,
    });
    console.log(`[ChatAI] relay ${ru.platform}:${ru.username} refreshed (24h=${has24h}, ${dayRows.length} msgs)`);
    return true;
}

async function _relayPass() {
    const lookbackIso = _sqlTime(Date.now() - USER_DISCOVERY_LOOKBACK_DAYS * 86400000);
    let candidates = [];
    try { candidates = db.getRelayUsersNeedingChatAi({ lookbackIso, threshold: 8, limit: USER_MAX_PER_TICK }); }
    catch (e) { console.warn('[ChatAI] relay discovery failed:', e.message); return; }
    for (const ru of candidates) {
        if (!ru.id) continue;
        try { await _refreshRelayUser(ru); }
        catch (e) { console.warn(`[ChatAI] relay ${ru.id} refresh failed:`, e.message); }
    }
}

// ── PER ANON (not-logged-in chatters, keyed by their stable anon_id) ──────────
// Same "today vs all-time" insight as a native user, keyed by the numeric anon id.
async function _refreshAnon(anonId) {
    const ai = _ai();
    const subjectId = db.anonSubjectId(anonId);
    if (!subjectId) return false;
    const prior = db.getChatAiSummary('anon', subjectId, 'rolling');
    const now = Date.now();
    const dayStart = _sqlTime(now - 24 * 60 * 60 * 1000);

    let dayRows = db.getAnonChatMessagesForAi({ anonId, sinceTs: dayStart, order: 'asc', limit: MAX_BATCH_MESSAGES });
    let has24h = dayRows.length > 0;
    if (!dayRows.length) dayRows = db.getAnonChatMessagesForAi({ anonId, order: 'desc', limit: 80 });
    if (!dayRows.length) return false;

    const priorMemory = prior ? (prior.memory_json || '') : '';
    const prompt =
`You profile an ANONYMOUS chatter ("${anonId}", not logged in) on a live-streaming site, contrasting who they are TODAY vs OVERALL. Base everything only on the evidence below — do not invent.

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "overview_24h": "${has24h ? '2-3 sentences on what this anon chatted about and their mood/energy in the LAST 24 HOURS.' : 'They have not chatted in the last 24h; 1 sentence noting they have been quiet recently.'}",
  "overview_alltime": "2-3 sentences on who this anon is as a chatter OVERALL: style, recurring interests, tone.",
  "memory": "Condensed running notes carried forward (interests, catchphrases, patterns). Update the PRIOR notes; keep under ~1000 chars.",
  "timeline": [ {"label":"short title","detail":"one sentence","mins_ago": <integer: minutes before now this happened, read from the [Xm ago] markers on the messages>} ]  // 0-2 NEW notable moments, or [].
}

PRIOR running notes:
"""${_clip(priorMemory, USER_MEMORY_MAX_CHARS)}"""

${has24h ? 'MESSAGES FROM THIS ANON IN THE LAST 24H' : "THIS ANON'S MOST RECENT MESSAGES"} (oldest first):
${_fmtMessages(dayRows, { now })}`;

    const text = await ai.summarizeText(prompt, 600, 'chat_anon');
    if (!text) return false;
    const parsed = _parseJson(text);
    if (!parsed) { console.warn(`[ChatAI] anon ${anonId}: unparseable model output`); return false; }

    const nowIso = _sqlTime(now);
    db.upsertChatAiSummary({
        scope: 'anon', subject_id: subjectId, window: 'rolling',
        overview: JSON.stringify({
            today: _clip(parsed.overview_24h || '', 1200),
            alltime: _clip(parsed.overview_alltime || '', 1200),
            has_24h: has24h,
        }),
        memory_json: _clip(parsed.memory || priorMemory, USER_MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, nowIso, now),
        message_count: dayRows.length,
        window_message_count: dayRows.length,
        last_message_id: db.getMaxChatMessageId(),
        window_label: has24h ? 'past 24h' : 'recent',
        window_start: has24h ? dayStart : null,
        window_end: nowIso,
    });
    console.log(`[ChatAI] anon ${anonId} refreshed (24h=${has24h}, ${dayRows.length} msgs)`);
    return true;
}

async function _anonPass() {
    const staleCutoff = _sqlTime(Date.now() - USER_STALE_MS);
    const sinceTs = _sqlTime(Date.now() - USER_DISCOVERY_LOOKBACK_DAYS * 86400000);
    let candidates = [];
    try {
        candidates = db.getAnonsNeedingChatAi({ threshold: USER_MSG_THRESHOLD, staleCutoffIso: staleCutoff, sinceTs, limit: USER_MAX_PER_TICK });
    } catch (e) { console.warn('[ChatAI] anon discovery failed:', e.message); return; }
    for (const c of candidates) {
        if (!c.anon_id) continue;
        try { await _refreshAnon(c.anon_id); }
        catch (e) { console.warn(`[ChatAI] anon ${c.anon_id} refresh failed:`, e.message); }
    }
}

// ── Poller ───────────────────────────────────────────────────────────────────
async function _tick() {
    if (_tickInFlight) return;
    _tickInFlight = true;
    try {
        const ai = _ai();
        if (!ai.isEnabled() || !ai.withinBudget()) return; // no key / disabled / over daily cap
        try { await _refreshGlobal(); }
        catch (e) { console.warn('[ChatAI] global refresh failed:', e.message); }

        if (Date.now() - _lastUserPass >= USER_PASS_EVERY_MS) {
            _lastUserPass = Date.now();
            if (ai.withinBudget()) await _userPass();
            if (ai.withinBudget()) await _relayPass();
            if (ai.withinBudget()) await _anonPass();
        }
    } catch (e) {
        console.warn('[ChatAI] tick error:', e.message);
    } finally {
        _tickInFlight = false;
    }
}

// One-time: backfill the growing timeline log from the existing summary JSON so the browsable
// view has history immediately (before new moments accumulate).
function _seedTimelineEvents() {
    try {
        if ((db.getChatTimelineEvents({ scope: 'global', limit: 1 }) || []).length) return;
        const row = db.getChatAiSummary('global', 0, 'global');
        if (!row) return;
        let tl = []; try { tl = JSON.parse(row.timeline_json || '[]'); } catch { tl = []; }
        const cleaned = _cleanTimeline(tl);
        if (cleaned.length) { db.addChatTimelineEvents('global', 0, cleaned); console.log(`[ChatAI] Seeded ${cleaned.length} timeline event(s)`); }
    } catch { /* */ }
}

function start() {
    if (_running) return;
    _running = true;
    try { _seedTimelineEvents(); } catch { /* */ }
    _timer = setInterval(() => { _tick().catch(() => {}); }, TICK_MS);
    if (_timer.unref) _timer.unref();
    console.log('[AI] Chat-AI job started (global overview/timeline + per-user insights)');
}

function stop() {
    _running = false;
    if (_timer) { clearInterval(_timer); _timer = null; }
}

// Public read helpers (used by the routes) — parse stored JSON into a clean shape.
function getGlobalInsight() {
    const row = db.getChatAiSummary('global', 0, 'global');
    if (!row) return null;
    let timeline = [];
    try { timeline = _cleanTimeline(JSON.parse(row.timeline_json || '[]')); } catch { /* */ }
    return {
        overview: row.overview || '',
        memory: row.memory_json || '',
        timeline,
        window_label: row.window_label || '',
        message_count: row.message_count || 0,
        window_message_count: row.window_message_count || 0,
        updated_at: row.updated_at || null,
    };
}

function getUserInsight(userId) {
    const row = db.getChatAiSummary('user', userId, 'rolling');
    if (!row) return null;
    let overviews = { today: '', alltime: '', has_24h: false };
    try { overviews = { ...overviews, ...JSON.parse(row.overview || '{}') }; } catch { /* */ }
    let timeline = [];
    try { timeline = _cleanTimeline(JSON.parse(row.timeline_json || '[]')); } catch { /* */ }
    return {
        overview_24h: overviews.today || '',
        overview_alltime: overviews.alltime || '',
        has_24h: !!overviews.has_24h,
        memory: row.memory_json || '',
        timeline,
        message_count: row.message_count || 0,
        updated_at: row.updated_at || null,
    };
}

function getRelayUserInsight(relayId) {
    const row = db.getChatAiSummary('relay', relayId, 'rolling');
    if (!row) return null;
    let overviews = { today: '', alltime: '', has_24h: false };
    try { overviews = { ...overviews, ...JSON.parse(row.overview || '{}') }; } catch { /* */ }
    let timeline = [];
    try { timeline = _cleanTimeline(JSON.parse(row.timeline_json || '[]')); } catch { /* */ }
    return {
        overview_24h: overviews.today || '',
        overview_alltime: overviews.alltime || '',
        has_24h: !!overviews.has_24h,
        memory: row.memory_json || '',
        timeline,
        message_count: row.message_count || 0,
        updated_at: row.updated_at || null,
    };
}

function getAnonInsight(anonId) {
    const row = db.getChatAiSummary('anon', db.anonSubjectId(anonId), 'rolling');
    if (!row) return null;
    let overviews = { today: '', alltime: '', has_24h: false };
    try { overviews = { ...overviews, ...JSON.parse(row.overview || '{}') }; } catch { /* */ }
    let timeline = [];
    try { timeline = _cleanTimeline(JSON.parse(row.timeline_json || '[]')); } catch { /* */ }
    return {
        overview_24h: overviews.today || '',
        overview_alltime: overviews.alltime || '',
        has_24h: !!overviews.has_24h,
        memory: row.memory_json || '',
        timeline,
        message_count: row.message_count || 0,
        updated_at: row.updated_at || null,
    };
}

module.exports = { start, stop, getGlobalInsight, getUserInsight, getRelayUserInsight, getAnonInsight, _tick };
