/**
 * OpenVibe.Live — AI analysis
 *
 * Vision + text analysis used for: paste description/tags, paste text overviews,
 * and periodic live-stream "memories". Provider (Anthropic Claude by default, or
 * any OpenAI-compatible endpoint) + key + model are configured in
 * openvibe.tools/admin → AI. Everything is gated by the `ai_enabled` master switch and
 * an optional daily USD budget cap. Token usage + estimated cost are recorded to
 * `ai_usage` for the admin cost breakdown.
 */
const fs = require('fs');
const db = require('../db/database');

function s(k) { return (db.getSetting(k) || '').toString().trim(); }
function b(k) { const v = db.getSetting(k); return v === true || v === 'true' || v === 1 || v === '1'; }
function num(k, d) { const v = parseFloat(db.getSetting(k)); return Number.isFinite(v) ? v : d; }

function isEnabled() { return b('ai_enabled') && !!s('ai_api_key'); }
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
function model() { return s('ai_model') || (s('ai_provider') === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-5'); }

function withinBudget() {
    const cap = num('ai_max_cost_usd_per_day', 0);
    if (!cap || cap <= 0) return true;
    try { return db.getAiCostToday() < cap; } catch { return true; }
}
function estimateCost(inTok, outTok) {
    return (inTok / 1e6) * num('ai_input_cost_per_mtok', 3) + (outTok / 1e6) * num('ai_output_cost_per_mtok', 15);
}

// Normalize an image input (data URL, raw base64, or file path) → {base64, mediaType}.
function _normImage(image) {
    if (!image) return null;
    if (typeof image === 'string' && image.startsWith('data:')) {
        const m = image.match(/^data:([^;]+);base64,(.*)$/);
        if (m) return { base64: m[2], mediaType: m[1] };
    }
    if (typeof image === 'string' && /^[A-Za-z0-9+/=]+$/.test(image.slice(0, 40))) {
        return { base64: image, mediaType: 'image/jpeg' };
    }
    // treat as a file path
    try {
        const buf = fs.readFileSync(image);
        const ext = String(image).toLowerCase();
        const mediaType = ext.endsWith('.png') ? 'image/png' : ext.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        return { base64: buf.toString('base64'), mediaType };
    } catch { return null; }
}

// ── Provider calls (return { text, input_tokens, output_tokens }) ──
async function _anthropic(prompt, img, maxTokens, temperature) {
    const content = [{ type: 'text', text: prompt }];
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    const body = { model: model(), max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (temperature != null) body.temperature = temperature;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': s('ai_api_key'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || `anthropic ${res.status}`);
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const u = j.usage || {};
    return { text, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 };
}
async function _openai(prompt, img, maxTokens, temperature) {
    const base = (s('ai_base_url') || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const m = model();
    const content = [{ type: 'text', text: prompt }];
    if (img) content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
    const body = { model: m, messages: [{ role: 'user', content }] };
    if (temperature != null && !/^(gpt-5|o\d)/i.test(m)) body.temperature = temperature;
    // GPT-5 / o-series are reasoning models: they reject `max_tokens` (need
    // `max_completion_tokens`) and spend hidden reasoning tokens, so give the
    // output headroom and keep reasoning effort low for these short tasks —
    // otherwise the whole budget is consumed by reasoning and content is empty.
    if (/^(gpt-5|o\d)/i.test(m)) {
        body.max_completion_tokens = Math.max(maxTokens, 256) + 512;
        body.reasoning_effort = /^gpt-5/i.test(m) ? 'minimal' : 'low';
    } else {
        body.max_tokens = maxTokens;
    }
    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s('ai_api_key')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || `openai ${res.status}`);
    const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    const u = j.usage || {};
    return { text, input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 };
}

/** Core call: dispatches by provider, records usage/cost. Returns text or null. */
async function _complete({ prompt, image = null, maxTokens = 400, kind, temperature = null, ownerUserId = null, source = null }) {
    if (!isEnabled() || !withinBudget()) return null;
    const img = image ? _normImage(image) : null;
    if (image && !img) return null;
    const provider = s('ai_provider') === 'openai' ? _openai : _anthropic;
    let r;
    try { r = await provider(prompt, img, maxTokens, temperature); }
    catch (e) { console.warn('[AI] analysis failed:', e.message); return null; }
    try { db.recordAiUsage({ kind, model: model(), input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: estimateCost(r.input_tokens, r.output_tokens), owner_user_id: ownerUserId, source }); } catch { /* */ }
    return r.text || null;
}

/** Generic text completion (used by media analysis to synthesize overviews). */
async function summarizeText(prompt, maxTokens = 350, kind = 'media_overview') {
    return _complete({ prompt, maxTokens, kind });
}

/**
 * Metered completion for the AI Chat Viewers engine on the SHARED (admin) key.
 * Attributes the spend to a streamer (owner_user_id) under source='ai_viewers' so
 * per-streamer daily budgets work. Returns text, or null if the admin AI is
 * disabled / over the global budget. Supports an optional image (vision) input.
 */
async function viewerComplete({ system = '', user = '', image = null, maxTokens = 80, temperature = 1.0, ownerUserId = null }) {
    const prompt = system ? `${system}\n\n${user}` : user;
    return _complete({ prompt, image, maxTokens, temperature, kind: 'ai_viewers', source: 'ai_viewers', ownerUserId });
}

/** Is the shared admin AI key usable right now (enabled + within global budget)? */
function sharedKeyReady() { return isEnabled() && withinBudget(); }

function _parseJson(text) {
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let raw = m[0];
    try { return JSON.parse(raw); } catch { /* try to repair below */ }
    // Models often emit slightly-broken JSON (a missing closing "]" before "}",
    // a trailing comma, smart quotes). Repair the common cases before giving up.
    try {
        let s = raw
            .replace(/[“”]/g, '"')   // smart double quotes → "
            .replace(/[‘’]/g, "'")   // smart single quotes → '
            .replace(/,\s*([}\]])/g, '$1');    // trailing commas
        // Balance brackets: an unclosed array right before the object close is the common
        // case (`..."fight"}` → `..."fight"]}`). Strip a trailing "}", add the missing "]",
        // then re-add the needed "}" so bracket counts line up.
        const opensq = (s.match(/\[/g) || []).length, closesq = (s.match(/\]/g) || []).length;
        if (opensq > closesq) {
            s = s.replace(/\}\s*$/, '');
            s += ']'.repeat(opensq - closesq);
        }
        const opencb = (s.match(/\{/g) || []).length, closecb = (s.match(/\}/g) || []).length;
        if (opencb > closecb) s += '}'.repeat(opencb - closecb);
        return JSON.parse(s);
    } catch { return null; }
}

// Robustly pull a plain-text description out of a model reply that was SUPPOSED to be
// JSON but may be malformed — so we never store a raw `{"description":...}` blob as text.
function _extractDescription(text, maxLen) {
    if (!text) return '';
    const j = _parseJson(text);
    if (j && j.description) return String(j.description).slice(0, maxLen);
    // Broken JSON: lift just the description string field.
    const dm = text.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (dm) { try { return JSON.parse(`"${dm[1]}"`).slice(0, maxLen); } catch { return dm[1].slice(0, maxLen); } }
    // Not JSON at all → use as-is; if it merely looks like a JSON blob we couldn't parse, drop it.
    const t = text.trim();
    return /^[{[]/.test(t) ? '' : t.slice(0, maxLen);
}
function _extractTags(text, maxTags) {
    const j = _parseJson(text);
    if (j && Array.isArray(j.tags)) return j.tags.slice(0, maxTags).map(String);
    const tm = text && text.match(/"tags"\s*:\s*\[([^\]]*)/i);
    if (tm) return tm[1].split(',').map(s => s.replace(/["'\s]/g, '')).filter(Boolean).slice(0, maxTags);
    return [];
}

// ── Public analysis functions ──

/** Re-encode any image (path/data) to a vision-friendly JPEG data URL. Handles
 *  avif/gif/webp/huge images that the vision API otherwise rejects. */
async function _toVisionJpeg(image) {
    try {
        const sharp = require('sharp');
        const buf = await sharp(image, { failOn: 'none', animated: false })
            .rotate()
            .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 82 })
            .toBuffer();
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch { return image; }
}

/** Describe an image paste → { description, tags }. */
async function analyzeImagePaste(image, title) {
    const prompt = `You are describing an uploaded image/screenshot for a paste titled "${(title || '').slice(0, 120)}".
Reply ONLY with compact JSON: {"description":"1-2 sentence description of what the image shows","tags":["3-6","short","lowercase","tags"]}.`;
    const img = await _toVisionJpeg(image);
    const text = await _complete({ prompt, image: img, maxTokens: 300, kind: 'paste_image' });
    if (!text) return null;
    const description = _extractDescription(text, 600);
    return description ? { description, tags: _extractTags(text, 8) } : null;
}

/** Summarize a text paste → { description }. */
async function analyzeTextPaste(content, title) {
    const snippet = String(content || '').slice(0, 6000);
    const prompt = `Summarize what this pasted text is about in one short sentence (max 200 chars), plainly. Title: "${(title || '').slice(0, 120)}".\n\n---\n${snippet}`;
    const text = await _complete({ prompt, maxTokens: 120, kind: 'paste_text' });
    return text ? { description: text.slice(0, 300), tags: [] } : null;
}

/** Analyze a live-stream frame → { description, tags }. */
async function analyzeStreamFrame(image) {
    const prompt = `This is a frame from a live stream. Reply ONLY with compact JSON: {"description":"one concise sentence describing what is happening on screen right now","tags":["2-5","short","tags"]}.`;
    const text = await _complete({ prompt, image, maxTokens: 200, kind: 'stream_memory' });
    if (!text) return null;
    const description = _extractDescription(text, 400);
    return description ? { description, tags: _extractTags(text, 6) } : null;
}

/** Condense a stream's memories into a one-line "AI Overview" for the home card. */
async function summarizeStreamMemories(memories) {
    // Use observations from across the whole session (capped for token budget) so the
    // overview reflects the entire stream since it started, not just the latest frame.
    const lines = (memories || []).slice(-80).map(m => `- ${m.description}`).join('\n');
    if (!lines) return null;
    const prompt = `These are timestamped observations from a live stream, in order since it started. Give a thorough overview (2-6 sentences) of what this stream has been about overall — the main activities, topics, and vibe across the whole session (not just the latest moment):\n${lines}`;
    const text = await _complete({ prompt, maxTokens: 500, kind: 'stream_memory' });
    return text ? text.slice(0, 2000) : null;
}

/**
 * Build (and store) an AI overview of a streamer, aggregating signals across all
 * their streams (memories), VODs, and pastes. Returns the overview text or null.
 */
async function generateStreamerOverview(userId) {
    if (!isEnabled() || !withinBudget()) return null;
    const user = db.getUserById(userId);
    if (!user) return null;
    const channel = (typeof db.getChannelByUserId === 'function') ? db.getChannelByUserId(userId) : null;

    const memories = (db.getStreamMemoriesByUser ? db.getStreamMemoriesByUser(userId, 60) : []) || [];
    const memLines = memories.slice(0, 40).map(m => `- ${m.description}`).filter(l => l.length > 2);

    const vods = (db.getVodsByUser ? db.getVodsByUser(userId, false, 20, 0) : []) || [];
    const vodLines = vods.map(v => `- ${v.title || 'Untitled VOD'}${v.category ? ` [${v.category}]` : ''}`);

    const pastes = (db.getUserPastesForAi ? db.getUserPastesForAi(userId, 25) : []) || [];
    const pasteLines = pastes.filter(p => p.ai_summary).map(p => `- "${p.title || 'paste'}": ${p.ai_summary}`);

    if (!memLines.length && !vodLines.length && !pasteLines.length) return null;

    const ctx = [
        `Streamer: ${user.display_name || user.username} (@${user.username})`,
        (channel?.bio || user.bio) ? `Bio: ${(channel?.bio || user.bio).slice(0, 400)}` : '',
        channel?.category ? `Usual category: ${channel.category}` : '',
        memLines.length ? `\nLive-stream observations (across sessions):\n${memLines.join('\n')}` : '',
        vodLines.length ? `\nRecent VODs:\n${vodLines.join('\n')}` : '',
        pasteLines.length ? `\nPaste summaries:\n${pasteLines.join('\n')}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `You are building an internal profile of a livestreamer for site staff, using aggregated signals across their streams, VODs, and pastes. Write a concise overview (4-8 sentences) covering: what they stream / their content niche, recurring themes or activities, tone/vibe, and anything notable for moderation. Be factual and neutral; do NOT invent specifics that aren't supported by the signals below.\n\n${ctx}`;

    const text = await _complete({ prompt, maxTokens: 550, kind: 'streamer_overview' });
    if (!text) return null;
    const overview = text.slice(0, 4000);
    try {
        db.upsertStreamerOverview(userId, {
            overview,
            model: model(),
            sources: JSON.stringify({ memories: memories.length, vods: vods.length, pastes: pasteLines.length }),
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
        const overview = await summarizeStreamMemories(existing);
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
        try { r = await require('./media-analysis').transcribeOnly(src); } catch (e) { r = { text: '', segments: [], ok: false, error: e.message }; }
        if (r.text) {                                            // got speech → store it (+segments)
            try { db.setVodTranscript(vod.id, r.text, r.segments || []); } catch { /* */ }
            db.setVodTranscriptStatus(vod.id, 'done');
        } else if (r.ok) {                                       // ran clean, genuinely no speech → terminal
            try { db.setVodTranscript(vod.id, ' ', []); } catch { /* */ }
            db.setVodTranscriptStatus(vod.id, 'empty');
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
            db.setClipTranscriptStatus(clip.id, 'empty');
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

/** Report AI config + optionally live-probe the provider. */
async function testStatus({ probe = true } = {}) {
    const cfg = {
        enabled: isEnabled(),
        provider: s('ai_provider') || 'anthropic',
        model: model(),
        has_key: !!s('ai_api_key'),
        base_url: s('ai_base_url') || null,
        paste_analysis: pasteAnalysisEnabled(),
        stream_memory: streamMemoryEnabled(),
        budget_cap_usd_per_day: num('ai_max_cost_usd_per_day', 0),
        within_budget: withinBudget(),
    };
    try { cfg.cost_today = db.getAiCostToday(); } catch { cfg.cost_today = null; }
    if (!cfg.enabled) return { ...cfg, ok: false, error: cfg.has_key ? 'AI is disabled (ai_enabled=false)' : 'No API key set' };
    if (!probe) return { ...cfg, ok: true, probed: false };
    const started = Date.now();
    const reply = await _complete({ prompt: 'Reply with exactly: OK', maxTokens: 8, kind: 'status_check' });
    return { ...cfg, ok: !!reply, probed: true, reply: reply || null, latency_ms: Date.now() - started, error: reply ? null : 'Provider returned no response (check key/model/base URL)' };
}

module.exports = {
    isEnabled, withinBudget, pasteAnalysisEnabled, streamMemoryEnabled, transcriptionEnabled, captureIntervalSec,
    analyzeImagePaste, analyzeTextPaste, analyzeStreamFrame, summarizeStreamMemories,
    generateStreamerOverview, generateVodOverview, generateClipOverview, ensureVodTimeline,
    generateVodTranscript, generateClipTranscript, summarizeText, testStatus,
    viewerComplete, sharedKeyReady, estimateCost,
};
