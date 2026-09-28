/**
 * OpenVibe.Live — AI analysis
 *
 * Vision + text analysis used for: paste description/tags, paste text overviews,
 * and periodic live-stream "memories". Every call is a workflow run on OpenVibe.AI
 * (ai-service.js), which holds the provider key, the models and the prompts of the analyses
 * here. Everything is gated by the `ai_enabled` master switch and an optional daily USD budget
 * cap. Token usage + cost are recorded to `ai_usage` for the admin cost breakdown.
 */
const db = require('../db/database');

function b(k) { const v = db.getSetting(k); return v === true || v === 'true' || v === 1 || v === '1'; }
function num(k, d) { const v = parseFloat(db.getSetting(k)); return Number.isFinite(v) ? v : d; }

const llm = require('./llm');
const aiService = require('./ai-service');
function isEnabled() { return llm.isEnabled(); }
function pasteAnalysisEnabled() { return isEnabled() && b('ai_paste_analysis_enabled'); }
function streamMemoryEnabled() { return isEnabled() && b('ai_stream_memory_enabled'); }
// Local whisper.cpp transcription (default on when installed). Independent of the
// LLM being enabled — it's free/local — but we only bother while capturing memories.
function transcriptionEnabled() {
    const setting = db.getSetting('ai_transcription_enabled');
    const on = (setting === undefined || setting === null || setting === '') ? true : (setting === true || setting === 'true' || setting === 1 || setting === '1');
    try { return on && require('./transcribe').available(); } catch { return false; }
}
function captureIntervalSec() { return Math.max(30, num('ai_stream_capture_interval_sec', 120)); }
function withinBudget() { return llm.withinBudget(); }

// The transport lives in ./llm (a run on OpenVibe.AI, uniform metering). Every feature's prompt is an OpenVibe.AI
// template now (roadmap WS-O task 2); this single-prompt call is left for the status probe (testStatus).

/** Core call: one prompt, text back, or null. */
async function _complete({ prompt, image = null, maxTokens = 400, kind, temperature = null, ownerUserId = null, source = null, role = 'legacy', imageMaxWidth = 1280 }) {
    const r = await llm.complete({ role, user: prompt, image, imageMaxWidth, maxTokens, temperature, kind, ownerUserId, source });
    return r && r.text ? r.text : null;
}

/** Is Live's AI usable right now (enabled + within the global budget)? viewers/budget.js asks under this name. */
function sharedKeyReady() { return isEnabled() && withinBudget(); }

// ── Public analysis functions ──

/** Describe an image paste → { description, tags }. */
async function analyzeImagePaste(image, title, kind = 'paste_image') {
    if (!sharedKeyReady()) return null;
    const img = await aiService.imageInput(image, { toVisionJpeg: llm.toVisionJpeg, maxWidth: 1280 });
    const o = img ? await aiService.structured('live.paste.describe_image', { title: String(title || '').slice(0, 500), image: img }, { meter: { kind, role: 'vision' } }) : null;
    return o && o.description ? { description: o.description, tags: o.tags || [] } : null;
}

/** Summarize a text paste → { description }. */
async function analyzeTextPaste(content, title) {
    if (!sharedKeyReady() || !String(content || '').trim()) return null;
    const o = await aiService.structured('live.paste.summarize_text', { title: String(title || '').slice(0, 500), content: String(content || '').slice(0, 200000) }, { meter: { kind: 'paste_text', role: 'legacy' } });
    return o && o.description ? { description: o.description, tags: [] } : null;
}

/** Analyze a live-stream frame → { description, tags }. */
async function analyzeStreamFrame(image) {
    // One vision run does three jobs: the memory description, the tags, and a screenshot-worthiness
    // verdict + caption (so live pastes need no extra call).
    if (!sharedKeyReady()) return null;
    const img = await aiService.imageInput(image, { toVisionJpeg: llm.toVisionJpeg, maxWidth: 768 });
    const o = img ? await aiService.structured('live.stream.describe_frame', { image: img }, { meter: { kind: 'stream_memory', role: 'vision' } }) : null;
    return o && o.description ? { description: o.description, tags: o.tags || [], worthy: o.worthy === true, title: o.worthy === true ? String(o.title || '').slice(0, 80) : '' } : null;
}

/** Fixed category taxonomy the AI picks from (matches the go-live selector). */
const CATEGORIES = ['outdoors', 'travel', 'building', 'music', 'gaming', 'robot', 'desktop', 'irl', 'other'];
function normalizeCategory(c) { const t = String(c || '').toLowerCase().trim(); if (!t) return null; if (CATEGORIES.includes(t)) return t; const map = { 'just chatting': 'irl', chatting: 'irl', talk: 'irl', coding: 'desktop', programming: 'desktop', software: 'desktop', tech: 'desktop', art: 'building', craft: 'building', diy: 'building', cooking: 'irl', hiking: 'outdoors', driving: 'travel', 'road trip': 'travel', robotics: 'robot', game: 'gaming', games: 'gaming', dj: 'music' }; return map[t] || null; }

/** Condense a stream's memories into a one-line "AI Overview" for the home card. */
async function summarizeStreamMemories(memories, streamId = null) {
    // Use observations from across the whole session (capped for token budget) so the
    // overview reflects the entire stream since it started, not just the latest frame.
    const observations = (memories || []).slice(-80).map(m => String(m.description || '').slice(0, 1000)).filter(Boolean);
    if (!observations.length || !sharedKeyReady()) return null;
    // The audio timeline, when one exists, goes along with its timestamps: what was SAID and what
    // was HEARD, both anchored in time.
    const input = { observations };
    if (streamId) {
        try {
            input.speech = (db.getTimeline(streamId, { kind: 'speech', limit: 400 }) || []).slice(-200).map(r => ({ start_sec: Number(r.start_sec) || 0, text: String(r.text || '').slice(0, 2000) }));
            input.sounds = (db.getTimeline(streamId, { kind: 'sound', limit: 120 }) || []).slice(-60).map(r => ({ start_sec: Number(r.start_sec) || 0, label: String(r.label || '').slice(0, 120), confidence: Number(r.confidence || 0) }));
        } catch { /* timeline optional */ }
    }
    // The same run also classifies the stream: the category is inferred from what is actually on
    // screen / said, never from the streamer's go-live selector.
    const o = await aiService.structured('live.stream.summarize', input, { target: streamId ? { service: 'live', type: 'stream', id: String(streamId) } : undefined, meter: { kind: 'stream_memory', role: 'legacy' } });
    return o && o.overview ? { overview: o.overview, category: normalizeCategory(o.category), tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 6) : [] } : null;
}

/**
 * Build (and store) an AI overview of a streamer, aggregating signals across all
 * their streams (memories), VODs, and pastes. Returns the overview text or null.
 */
async function generateStreamerOverview(userId) {
    if (!sharedKeyReady()) return null;
    const user = db.getUserById(userId);
    if (!user) return null;
    const channel = (typeof db.getChannelByUserId === 'function') ? db.getChannelByUserId(userId) : null;

    const memories = (db.getStreamMemoriesByUser ? db.getStreamMemoriesByUser(userId, 60) : []) || [];
    const memLines = memories.slice(0, 40).map(m => String(m.description || '').slice(0, 1000)).filter(Boolean);

    // VODs from OpenVibe.Media (public ones) and pastes from OpenVibe.Community (any visibility:
    // this overview is for site staff), both through media-proxy/lookups.js.
    const lookups = require('../media-proxy/lookups');
    const [vods, pastes] = await Promise.all([lookups.userVods(userId, { limit: 20 }), lookups.userPastesForAi(user, 25)]);
    const summarized = pastes.filter(p => p.ai_summary);

    if (!memLines.length && !vods.length && !summarized.length) return null;

    const o = await aiService.structured('live.streamer.overview', {
        streamer: { username: String(user.username), display_name: String(user.display_name || user.username), bio: String(channel?.bio || user.bio || '').slice(0, 2000), category: (channel?.ai_category || channel?.category) ? String(channel.ai_category || channel.category) : undefined, category_inferred: Boolean(channel?.ai_category) },
        memories: memLines,
        vods: vods.map(v => ({ title: String(v.title || 'Untitled VOD').slice(0, 300), category: (v.ai_category || v.category) ? String(v.ai_category || v.category) : undefined })),
        pastes: summarized.map(p => ({ title: String(p.title || 'paste').slice(0, 300), summary: String(p.ai_summary).slice(0, 600) })),
    }, { target: { service: 'live', type: 'user', id: String(userId) }, meter: { kind: 'streamer_overview', role: 'legacy' } });
    const text = o && o.overview;
    if (!text) return null;
    const overview = String(text).slice(0, 4000);
    try {
        db.upsertStreamerOverview(userId, {
            overview,
            model: 'openvibe-ai',
            sources: JSON.stringify({ memories: memories.length, vods: vods.length, pastes: summarized.length }),
        });
    } catch (e) { console.warn('[AI] overview store failed:', e.message); }
    return overview;
}

// Resolve an ffmpeg-consumable source for a vod/clip row: a still-present legacy
// local file, else the OpenVibe.Media playback URL (ffmpeg range-reads it over HTTP).
async function _mediaSource(row, kind = 'vod') {
    if (row && row.file_path) { try { if (require('fs').existsSync(row.file_path)) return row.file_path; } catch { /* */ } }
    try {
        const media = require('../media-client');
        const id = row && row.id;
        if (!id) return null;
        const meta = kind === 'clip' ? await media.getClip(id) : await media.getVod(id);
        if (meta && meta.playback_url) return media.publicUrl(meta.playback_url);
        return kind === 'clip' ? media.clipUrl(id) : media.vodPlaybackUrl(id);
    } catch { /* */ }
    return null;
}

/**
 * Generate + store a VOD's AI overview. Prefers existing stream memories; otherwise
 * extracts a spread of frames + sampled audio from the VOD file itself (creating
 * memories) so pre-existing VODs get real overviews.
 */
const _overviewInFlight = new Set();
async function generateVodOverview(vod) {
    if (!vod) return null;
    if (!isEnabled() || !withinBudget()) return null;
    // Guard against the on-finalize trigger and the backfill poller processing the same
    // VOD at once (that would double-extract frames + duplicate timeline memories).
    if (_overviewInFlight.has(vod.id)) return null;
    _overviewInFlight.add(vod.id);
    try {
        return await _generateVodOverviewInner(vod);
    } finally {
        _overviewInFlight.delete(vod.id);
    }
}
async function _generateVodOverviewInner(vod) {
    const ma = require('./media-analysis');

    // Ensure the timeline BRACKETS the VOD: a memory at the very start, right before the
    // end, and (for >5min) the middle — extracting only the anchors not already covered
    // by live-captured memories. This runs even when the VOD already has live memories,
    // so start/end coverage is guaranteed without re-analyzing the whole thing.
    if (vod.stream_id) {
        try { await ensureVodTimeline(vod); } catch { /* */ }
    }

    const existing = vod.stream_id ? (db.getStreamMemories(vod.stream_id) || []) : [];
    if (existing.length >= 2) {
        // `stream` never existed in this scope — the parameter is `vod` — so this threw
        // ReferenceError for every stream-backed VOD with >=2 memories, i.e. the common
        // case. generateVodOverview() rejected, the VOD was never marked done, and the
        // backfill logged "[AI backfill] vod: stream is not defined" once a minute
        // forever. That is why ai_overview was null on every recent VOD.
        const overview = await summarizeStreamMemories(existing, vod.stream_id || null);
        if (overview) { try { db.setVodAiOverview(vod.id, overview); } catch { /* */ } }
        return overview;
    }
    // No stream_id (or still sparse) — analyze the media directly (smart frame selection).
    const src = await _mediaSource(vod);
    if (!src) { try { db.setVodAiOverview(vod.id, ' '); } catch { /* */ } return null; } // unprocessable — mark done
    const r = await ma.analyzeMedia(src, {
        streamId: vod.stream_id || null, userId: vod.user_id || null,
        storeMemories: !!vod.stream_id, offsetBase: 0,
    });
    const overview = r && r.overview ? r.overview : ' '; // ' ' = tried, nothing to say
    try { db.setVodAiOverview(vod.id, overview); } catch { /* */ }
    // Persist the whisper transcript (+ timestamped segments) for the VOD page, and mark
    // the transcript job done so the transcript poller doesn't re-run whisper on this VOD.
    try {
        const t = r ? r.transcript : '';
        if (t && t.trim()) { db.setVodTranscript(vod.id, t, r ? r.segments : null); db.setVodTranscriptStatus(vod.id, 'done'); }
    } catch { /* */ }
    return r ? r.overview : null;
}

/**
 * Guarantee timeline coverage for a stream-backed VOD: analyze frames at the required
 * anchors (start / end / mid>5min) that aren't already covered, plus a few active-moment
 * frames if the VOD is sparse — cost-scaled by length. Stores the results as memories.
 */
async function ensureVodTimeline(vod) {
    if (!vod || !vod.stream_id) return;
    if (!isEnabled() || !withinBudget()) return;
    const ma = require('./media-analysis');
    const src = await _mediaSource(vod);
    if (!src) return;
    const duration = await ma.probeDuration(src);
    if (!duration || duration < 2) return;
    const existingOffsets = (db.getStreamMemories(vod.stream_id) || []).map((m) => m.offset_seconds);
    const times = await ma.pickFrameTimes(src, duration, { existingOffsets });
    if (!times.length) return;
    await ma.captureFrameMemories(src, times, { streamId: vod.stream_id, userId: vod.user_id, offsetBase: 0, store: true });
}

// Transcription retries: a transient failure (killed by a restart, ffmpeg/whisper
// error, unreadable source) is retried up to this many times before giving up. Only a
// clean run that finds no speech (r.ok && !r.text) marks a VOD terminally silent.
// Retries are now time-spaced (see _txBackoffMin) so the ladder covers hours, not minutes,
// and boot resets any 'failed' rows so nothing is stuck permanently.
const MAX_TX_ATTEMPTS = 8;
// Exponential-ish backoff (minutes) before the Nth retry attempt. Clamped to the last
// value for higher N. Spaces retries so a transient issue has time to clear and a
// persistently-bad source doesn't exhaust its attempts in one poll storm.
const TX_BACKOFF_MIN = [1, 3, 10, 30, 90, 240, 360];
function _txBackoffMin(attempt) { return TX_BACKOFF_MIN[Math.min(attempt, TX_BACKOFF_MIN.length) - 1] || 360; }
// Serialize ALL transcription so the finalize-trigger and the backfill poller can never
// run two whisper passes at once (they'd starve each other + the live encoders).
let _txChain = Promise.resolve();
function _txRun(fn) {
    const p = _txChain.then(fn, fn);
    _txChain = p.catch(() => {});
    return p;
}
// Drop whisper to low-power (fewer threads) whenever any stream is live, so VOD
// transcription keeps progressing without starving the live encoders — applied on
// EVERY transcription path (backfill poller + the on-finalize trigger).
function _applyTxLowPower() {
    try {
        const anyLive = ((db.getLiveStreams && db.getLiveStreams()) || []).length > 0;
        require('./transcribe').setLowPower(anyLive);
    } catch { /* */ }
}

/**
 * Transcript-only pass for a VOD — FREE local whisper (no vision, no API/budget).
 * Uses transcript_status for real job-state: on failure it retries (bounded), and only
 * a clean silent run is marked terminal — so an interrupted run is never lost.
 */
async function generateVodTranscript(vod) {
    if (!vod || !transcriptionEnabled()) return null;
    return _txRun(async () => {
        _applyTxLowPower();
        const src = await _mediaSource(vod);
        if (!src) {
            const n = db.bumpVodTranscriptAttempt(vod.id);
            db.setVodTranscriptStatus(vod.id, n >= MAX_TX_ATTEMPTS ? 'failed' : 'retry', 'no media source', _txBackoffMin(n));
            return null;
        }
        db.setVodTranscriptStatus(vod.id, 'processing');
        let r = { text: '', segments: [], ok: false, error: 'unknown' };
        try {
            // Continue from the last finished 5-minute window (persisted per window), so
            // the frequent deploy restarts no longer discard an hour of decoding.
            const prog = db.getVodTranscriptProgress ? db.getVodTranscriptProgress(vod.id) : { progressSec: 0, segments: [] };
            r = await require('./media-analysis').transcribeOnly(src, {
                resumeFromSec: prog.progressSec,
                priorSegments: prog.segments,
                onWindow: (sec, segs) => db.saveVodTranscriptProgress(vod.id, sec, segs),
            });
        } catch (e) { r = { text: '', segments: [], ok: false, error: e.message }; }
        if (r.text) {                                            // got speech → store it (+segments)
            try { db.setVodTranscript(vod.id, r.text, r.segments || []); } catch { /* */ }
            db.setVodTranscriptStatus(vod.id, 'done');
        } else if (r.ok) {                                       // ran clean, genuinely no speech → terminal
            try { db.setVodTranscript(vod.id, ' ', []); } catch { /* */ }
            db.setVodTranscriptStatus(vod.id, 'empty', r.noAudio ? 'no audio stream' : null);
        } else {                                                 // failure → retry (bounded + backoff), never poison
            const n = db.bumpVodTranscriptAttempt(vod.id);
            db.setVodTranscriptStatus(vod.id, n >= MAX_TX_ATTEMPTS ? 'failed' : 'retry', r.error || 'transcription failed', _txBackoffMin(n));
        }
        return r.text;
    });
}

/** Transcript-only pass for a clip — FREE local whisper (see generateVodTranscript). */
async function generateClipTranscript(clip) {
    if (!clip || !transcriptionEnabled()) return null;
    return _txRun(async () => {
        _applyTxLowPower();
        const src = await _mediaSource(clip, 'clip');
        if (!src) {
            const n = db.bumpClipTranscriptAttempt(clip.id);
            db.setClipTranscriptStatus(clip.id, n >= MAX_TX_ATTEMPTS ? 'failed' : 'retry', 'no media source', _txBackoffMin(n));
            return null;
        }
        db.setClipTranscriptStatus(clip.id, 'processing');
        let r = { text: '', segments: [], ok: false, error: 'unknown' };
        try { r = await require('./media-analysis').transcribeOnly(src); } catch (e) { r = { text: '', segments: [], ok: false, error: e.message }; }
        if (r.text) {
            try { db.setClipTranscript(clip.id, r.text, r.segments || []); } catch { /* */ }
            db.setClipTranscriptStatus(clip.id, 'done');
        } else if (r.ok) {
            try { db.setClipTranscript(clip.id, ' ', []); } catch { /* */ }
            db.setClipTranscriptStatus(clip.id, 'empty', r.noAudio ? 'no audio stream' : null);
        } else {
            const n = db.bumpClipTranscriptAttempt(clip.id);
            db.setClipTranscriptStatus(clip.id, n >= MAX_TX_ATTEMPTS ? 'failed' : 'retry', r.error || 'transcription failed', _txBackoffMin(n));
        }
        return r.text;
    });
}

/**
 * Generate + store a clip's AI overview from a spread of frames + a whisper
 * transcript of the clip's audio (combined). Stores memories at the clip's position
 * in the source stream.
 */
async function generateClipOverview(clip) {
    if (!clip) return null;
    if (!isEnabled() || !withinBudget()) return null;
    const src = await _mediaSource(clip, 'clip');
    if (!src) { try { db.setClipAiOverview(clip.id, { overview: ' ', transcript: null }); } catch { /* */ } return null; }
    const r = await require('./media-analysis').analyzeMedia(src, {
        streamId: clip.stream_id || null, userId: clip.user_id || null,
        numFrames: 3, storeMemories: !!clip.stream_id, offsetBase: clip.start_time || 0,
    });
    const overview = (r && r.overview) ? r.overview : ' ';
    const transcript = r ? r.transcript : '';
    try { db.setClipAiOverview(clip.id, { overview, transcript: transcript || null, segments: r ? r.segments : null }); } catch { /* */ }
    // The overview pass already ran whisper — record it as done so the transcript poller
    // doesn't re-transcribe the same clip. (Only when we actually got speech; a blank
    // result is left for the dedicated, retrying transcript path to handle properly.)
    try { if (transcript && transcript.trim()) db.setClipTranscriptStatus(clip.id, 'done'); } catch { /* */ }
    return { overview: r ? r.overview : null, transcript };
}

/** Report AI config + optionally probe OpenVibe.AI with a one-word run. */
async function testStatus({ probe = true } = {}) {
    const cfg = {
        enabled: isEnabled(),
        service: aiService.enabled() ? 'openvibe-ai' : 'off',
        paste_analysis: pasteAnalysisEnabled(),
        stream_memory: streamMemoryEnabled(),
        budget_cap_usd_per_day: num('ai_max_cost_usd_per_day', 0),
        within_budget: withinBudget(),
    };
    try { cfg.cost_today = db.getAiCostToday(); } catch { cfg.cost_today = null; }
    if (!cfg.enabled) return { ...cfg, ok: false, error: aiService.enabled() ? 'AI is disabled (ai_enabled=false)' : 'AI is off (AI_SERVICE=off)' };
    if (!probe) return { ...cfg, ok: true, probed: false };
    const started = Date.now();
    const reply = await _complete({ prompt: 'Reply with exactly: OK', maxTokens: 8, kind: 'status_check' });
    return { ...cfg, ok: !!reply, probed: true, reply: reply || null, latency_ms: Date.now() - started, error: reply ? null : 'OpenVibe.AI returned no answer (over budget, or the service or its provider is down)' };
}

module.exports = {
    CATEGORIES, normalizeCategory,
    isEnabled, withinBudget, pasteAnalysisEnabled, streamMemoryEnabled, transcriptionEnabled, captureIntervalSec,
    analyzeImagePaste, analyzeTextPaste, analyzeStreamFrame, summarizeStreamMemories,
    generateStreamerOverview, generateVodOverview, generateClipOverview, ensureVodTimeline,
    generateVodTranscript, generateClipTranscript, testStatus,
    sharedKeyReady,
    complete: llm.complete, llm,
};
