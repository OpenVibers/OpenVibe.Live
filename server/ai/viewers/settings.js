/**
 * AI Chat Viewers — per-channel settings schema.
 *
 * Every knob the streamer can turn lives in channel_ai_config.settings_json (merged over
 * admin defaults from site_settings.ai_viewers_default_settings_json, merged over the
 * built-in defaults below). Ranges are enforced here, server-side, on every save.
 * Legacy columns (num_ambient_bots, pacing_seconds, persona, transcribe_enabled,
 * vision_enabled) are read as fallbacks so existing rows keep working.
 */
'use strict';
const db = require('../../db/database');

// key → { def, type, min, max, values, max_len, help }
const SCHEMA = {
    engine:                { def: '',        type: 'enum',   values: ['', 'v2', 'v3'], help: 'Engine override (blank = site default)' },
    // Roster
    roster_size:           { def: 3,         type: 'int',    min: 0, max: 12, help: 'How many ambient AI viewers hang out in chat' },
    // Activity
    activity:              { def: 'normal',  type: 'enum',   values: ['quiet', 'normal', 'lively', 'chaos', 'custom'], help: 'Preset for how chatty the bots are' },
    lines_per_min:         { def: 3,         type: 'num',    min: 0.5, max: 12, help: 'Max bot lines per minute (admin ceiling applies)' },
    min_gap_sec:           { def: 4,         type: 'int',    min: 2, max: 60, help: 'Minimum seconds between any two bot lines' },
    director_interval_sec: { def: 20,        type: 'int',    min: 8, max: 120, help: 'How often the director looks at the stream and plans lines (active)' },
    idle_interval_sec:     { def: 60,        type: 'int',    min: 20, max: 300, help: 'Director cadence when nothing is happening' },
    lines_per_tick:        { def: 3,         type: 'int',    min: 1, max: 6, help: 'Max lines planned per director pass' },
    // Social
    bot_to_bot_ratio:      { def: 0.3,       type: 'num',    min: 0, max: 0.8, help: 'Share of bot lines that are bots talking to each other' },
    reply_probability:     { def: 0.6,       type: 'num',    min: 0, max: 1, help: 'Chance a real viewer message gets a bot reply' },
    mention_fast_path_sec: { def: 6,         type: 'int',    min: 0, max: 30, help: 'Reply to the streamer within this many seconds even between director passes' },
    react_to_sounds:       { def: true,      type: 'bool',   help: 'React to detected sounds (laughs, music, alarms…)' },
    react_to_scene_changes:{ def: true,      type: 'bool',   help: 'React when what is on screen changes' },
    greet_first_timers:    { def: true,      type: 'bool',   help: 'Welcome first-time chatters in this channel' },
    reply_to_relay_chat:   { def: true,      type: 'bool',   help: 'Also reply to relayed Twitch/Kick/YouTube/RS chatters' },
    max_open_threads:      { def: 3,         type: 'int',    min: 0, max: 6, help: 'Concurrent conversations the bots keep going' },
    max_thread_turns:      { def: 6,         type: 'int',    min: 2, max: 20, help: 'Turns before a bot conversation naturally ends' },
    thread_idle_close_sec: { def: 240,       type: 'int',    min: 60, max: 1800, help: 'Close a conversation nobody continued after this long' },
    // Senses
    hear_enabled:          { def: true,      type: 'bool',   help: 'Use the live audio transcript (free, local)' },
    hear_window_sec:       { def: 90,        type: 'int',    min: 30, max: 300, help: 'How many seconds of speech the bots "hear"' },
    vision_policy:         { def: 'when_addressed', type: 'enum', values: ['off', 'thumbnail', 'when_addressed', 'periodic'], help: 'When to look at the screen: never / cached thumbnail only / fresh frame when the streamer addresses chat / periodically' },
    vision_max_age_sec:    { def: 180,       type: 'int',    min: 60, max: 900, help: 'Consider the last screen analysis stale after this long' },
    vision_periodic_sec:   { def: 300,       type: 'int',    min: 120, max: 1800, help: 'Periodic screen analysis cadence (periodic policy)' },
    // Style
    language:              { def: 'en',      type: 'str',    max_len: 12, help: 'Language the bots chat in (ISO code or "auto")' },
    tone:                  { def: '',        type: 'str',    max_len: 300, help: 'Overall vibe of the bots (e.g. cozy, hype, sarcastic)' },
    emote_usage:           { def: 'some',    type: 'enum',   values: ['none', 'some', 'lots'], help: 'How often bots use emotes/emoji' },
    max_words:             { def: 18,        type: 'int',    min: 4, max: 60, help: 'Longest bot line, in words' },
    topics:                { def: '',        type: 'str',    max_len: 300, help: 'Things the bots like to bring up' },
    blocklist:             { def: '',        type: 'str',    max_len: 500, help: 'Topics/words the bots must avoid' },
    channel_personality:   { def: '',        type: 'str',    max_len: 4000, help: 'Free-form description of your channel for the bots' },
    // Behaviour
    quiet_from:            { def: '',        type: 'str',    max_len: 5, help: 'Quiet hours start (HH:MM, streamer local time)' },
    quiet_to:              { def: '',        type: 'str',    max_len: 5, help: 'Quiet hours end (HH:MM)' },
    quiet_tz:              { def: 'UTC',     type: 'str',    max_len: 48, help: 'IANA time zone for quiet hours' },
    quiet_allow_replies:   { def: true,      type: 'bool',   help: 'Still answer the streamer during quiet hours' },
    tts_enabled:           { def: true,      type: 'bool',   help: 'Read bot lines aloud with TTS (per-bot override in roster)' },
    powerchat_forward:     { def: true,      type: 'bool',   help: 'Show bot lines on your PowerChat overlay' },
    memory_fold_min:       { def: 10,        type: 'int',    min: 3, max: 60, help: 'How often bots consolidate what they remember' },
    remember_viewers:      { def: true,      type: 'bool',   help: 'Let bots use what the site already knows about regulars' },
    channel_memory:        { def: '',        type: 'str',    max_len: 600, help: 'Running bits the bots share (maintained automatically; editable)' },
    // Object-valued (validated separately)
    slots:                 { def: {},        type: 'obj',    help: 'Per-slot enable: { "<managed_stream_id>": true|false }' },
    byo:                   { def: {},        type: 'obj',    help: '{ provider, base_url, model, model_chat, model_vision, model_director, model_summary }' },
    runtime:               { def: {},        type: 'obj',    help: 'Live mod state: { paused, muted:[bot usernames] }' },
};

const ACTIVITY_PRESETS = { quiet: 1, normal: 3, lively: 5, chaos: 8 };

function _parseJson(v) {
    if (!v) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v) || {}; } catch { return {}; }
}

function adminDefaults() {
    try {
        const raw = db.getSetting('ai_viewers_default_settings_json');
        return _parseJson(raw);
    } catch { return {}; }
}
function adminLimits() {
    const n = (k, d) => { const v = parseFloat(db.getSetting(k)); return Number.isFinite(v) ? v : d; };
    return {
        maxRoster: Math.max(0, Math.min(12, n('ai_viewers_max_roster', 12))),
        maxLinesPerMin: Math.max(0.5, Math.min(12, n('ai_viewers_max_lines_per_min', 12))),
    };
}

/** Coerce one value against the schema; returns undefined when unusable. */
function coerce(key, v, limits) {
    const sp = SCHEMA[key];
    if (!sp) return undefined;
    switch (sp.type) {
        case 'bool': return v === true || v === 'true' || v === 1 || v === '1';
        case 'int': { const n = parseInt(v, 10); if (!Number.isFinite(n)) return undefined; return Math.max(sp.min, Math.min(sp.max, n)); }
        case 'num': { const n = parseFloat(v); if (!Number.isFinite(n)) return undefined; return Math.max(sp.min, Math.min(sp.max, n)); }
        case 'enum': return sp.values.includes(String(v)) ? String(v) : undefined;
        case 'str': return String(v == null ? '' : v).slice(0, sp.max_len || 500);
        case 'obj': return (v && typeof v === 'object' && !Array.isArray(v)) ? v : undefined;
        default: return undefined;
    }
}

/** Validate + clamp a partial settings object (unknown keys dropped). */
function sanitize(input, limits = adminLimits()) {
    const out = {};
    for (const [k, v] of Object.entries(input || {})) {
        const c = coerce(k, v, limits);
        if (c !== undefined) out[k] = c;
    }
    if (out.roster_size != null) out.roster_size = Math.min(out.roster_size, limits.maxRoster);
    if (out.lines_per_min != null) out.lines_per_min = Math.min(out.lines_per_min, limits.maxLinesPerMin);
    if (out.slots) { const s = {}; for (const [id, en] of Object.entries(out.slots)) if (/^\d+$/.test(id)) s[id] = !!en; out.slots = s; }
    if (out.byo) {
        const b = out.byo; const clean = {};
        for (const k of ['provider', 'base_url', 'model', 'model_chat', 'model_vision', 'model_director', 'model_summary']) if (b[k] != null) clean[k] = String(b[k]).trim().slice(0, 300);
        if (clean.provider && !['openai', 'anthropic'].includes(clean.provider)) delete clean.provider;
        out.byo = clean;
    }
    if (out.runtime) { out.runtime = { paused: !!out.runtime.paused, muted: Array.isArray(out.runtime.muted) ? out.runtime.muted.map(String).slice(0, 24) : [] }; }
    for (const k of ['quiet_from', 'quiet_to']) if (out[k] && !/^\d{2}:\d{2}$/.test(out[k])) out[k] = '';
    return out;
}

/** Fully-resolved settings for a channel: built-in ← admin defaults ← row (+ legacy columns). */
function getSettings(userId, cfgRow = null) {
    const cfg = cfgRow || db.getChannelAiConfig(userId) || {};
    const limits = adminLimits();
    const base = {};
    for (const [k, sp] of Object.entries(SCHEMA)) base[k] = typeof sp.def === 'object' ? { ...sp.def } : sp.def;
    const admin = sanitize(adminDefaults(), limits);
    const row = sanitize(_parseJson(cfg.settings_json), limits);
    const s = { ...base, ...admin, ...row };
    // Legacy column fallbacks (rows that predate settings_json).
    if (row.roster_size == null && cfg.num_ambient_bots != null) s.roster_size = Math.min(limits.maxRoster, Math.max(0, cfg.num_ambient_bots));
    if (row.channel_personality == null && cfg.persona) s.channel_personality = String(cfg.persona).slice(0, 4000);
    if (row.hear_enabled == null && cfg.transcribe_enabled != null) s.hear_enabled = !!cfg.transcribe_enabled;
    if (row.vision_policy == null && cfg.vision_enabled != null) s.vision_policy = cfg.vision_enabled ? 'when_addressed' : 'off';
    if (s.activity !== 'custom' && ACTIVITY_PRESETS[s.activity]) s.lines_per_min = Math.min(limits.maxLinesPerMin, ACTIVITY_PRESETS[s.activity]);
    s.lines_per_min = Math.min(s.lines_per_min, limits.maxLinesPerMin);
    s.roster_size = Math.min(s.roster_size, limits.maxRoster);
    return s;
}

/** Persist a partial update (merged into the stored JSON). Returns the resolved settings. */
function updateSettings(userId, partial) {
    const cfg = db.getChannelAiConfig(userId) || {};
    const current = _parseJson(cfg.settings_json);
    const clean = sanitize(partial);
    const merged = { ...current, ...clean };
    if (partial && partial.byo && current.byo) merged.byo = { ...current.byo, ...clean.byo };
    if (partial && partial.slots && current.slots) merged.slots = { ...current.slots, ...clean.slots };
    db.upsertChannelAiConfig(userId, { settings_json: JSON.stringify(merged) });
    return getSettings(userId);
}

/** Schema description for the UI (defaults resolved with admin overrides). */
function describe() {
    const admin = sanitize(adminDefaults());
    const limits = adminLimits();
    return Object.entries(SCHEMA).map(([key, sp]) => ({
        key, type: sp.type, help: sp.help,
        def: admin[key] !== undefined ? admin[key] : sp.def,
        min: key === 'roster_size' ? 0 : sp.min, max: key === 'roster_size' ? limits.maxRoster : (key === 'lines_per_min' ? limits.maxLinesPerMin : sp.max),
        values: sp.values || null,
    }));
}

function isQuietNow(s, at = new Date()) {
    if (!s.quiet_from || !s.quiet_to) return false;
    let hm;
    try { hm = new Intl.DateTimeFormat('en-GB', { timeZone: s.quiet_tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(at); } catch { hm = at.toISOString().slice(11, 16); }
    const cur = hm.replace(':', ''); const from = s.quiet_from.replace(':', ''); const to = s.quiet_to.replace(':', '');
    return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

module.exports = { SCHEMA, ACTIVITY_PRESETS, getSettings, updateSettings, sanitize, describe, adminLimits, isQuietNow };
