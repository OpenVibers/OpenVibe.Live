/**
 * OpenVibe.Live — Stream memory job
 *
 * Periodically captures a frame from each live stream and asks the vision model
 * what's happening, storing a timestamped "memory". The latest memory doubles as
 * the stream's home-card "AI Overview". Gated by `ai_enabled` +
 * `ai_stream_memory_enabled` (default OFF) and the configured capture interval, so
 * it costs nothing until an admin turns it on.
 */
const db = require('../db/database');
const ai = require('./ai-analysis');

let vision = null;
try { vision = require('./stream-vision'); } catch { /* optional */ }

const _last = new Map(); // streamId -> last capture ms (avoids overlap / respects interval)
const _lastSummary = new Map(); // streamId -> { count, at } — throttles the summarizer
const SUMMARY_MIN_NEW = 3;              // re-summarize once this many new memories exist
const SUMMARY_MAX_AGE_MS = 5 * 60 * 1000; // ...or at least this long since the last rollup

// In-flight capture per stream: the periodic job and on-demand callers (AI viewers asking
// for a fresh look) share ONE ffmpeg + ONE vision call instead of racing.
const _inflight = new Map(); // streamId → Promise
/**
 * Analyze the current frame NOW through the normal pipeline (frame → vision → memory row →
 * overview rollup). Used by the AI viewers so a "look at the screen" is never a private,
 * throwaway vision call — the result is cached for every consumer.
 */
function captureMemoryNow(stream, { allowFfmpeg = true, reason = 'manual' } = {}) {
    if (!stream || !stream.id) return Promise.resolve(false);
    if (!ai.streamMemoryEnabled()) return Promise.resolve(false);
    const existing = _inflight.get(stream.id);
    if (existing) return existing;
    const p = _analyzeOne(stream, { allowFfmpeg, reason }).then(() => true).catch(() => false).finally(() => _inflight.delete(stream.id));
    _inflight.set(stream.id, p);
    _last.set(stream.id, Date.now());
    return p;
}

// ── Moment frames ────────────────────────────────────────────
// The live thumbnail a moment used to point at rotates every few seconds and is deleted
// within the hour, so every moment in the timeline ended up showing the placeholder
// pixel (a white box). Keep a small JPEG of the analysed frame per moment instead,
// under data/ai-moments/<streamId>/<offset>.jpg (served at /data/ai-moments/…, ~15 KB).
const MOMENTS_DIR = require('path').resolve(process.env.AI_MOMENTS_PATH || './data/ai-moments');
async function _persistMomentFrame(image, streamId, offset) {
    if (!image) return null;
    try {
        const fs = require('fs'), path = require('path');
        const sharp = require('sharp');
        const dir = path.join(MOMENTS_DIR, String(streamId));
        fs.mkdirSync(dir, { recursive: true });
        const file = `${Math.max(0, Math.round(offset))}.jpg`;
        const input = Buffer.isBuffer(image) ? image : fs.readFileSync(image);
        await sharp(input).resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 72 }).toFile(path.join(dir, file));
        return `/data/ai-moments/${streamId}/${file}`;
    } catch (e) {
        console.warn('[AI-See] moment frame not saved:', e.message);
        return null;
    }
}
// A live thumbnail URL (/api/thumbnails/stream-…) is never worth storing — it will be gone
// by the time anyone looks; Media-hosted VOD thumbnails are stable and fine.
function _stableThumb(url) {
    const u = String(url || '');
    if (!u || /\/api\/thumbnails\/stream-/.test(u)) return null;
    return u;
}

async function _analyzeOne(stream, { allowFfmpeg = true, reason = 'periodic' } = {}) {
    let image = null;
    if (allowFfmpeg) { try { if (vision && vision.captureFrame) image = await vision.captureFrame(stream); } catch { /* */ } }
    if (!image) {
        // Fall back to the freshest thumbnail file on disk.
        try {
            const thumbSvc = require('../media-proxy/live-thumbs');
            const st = thumbSvc.getStreamThumbnailState && thumbSvc.getStreamThumbnailState(stream.id);
            if (st && st.filePath) image = st.filePath;
        } catch { /* */ }
    }
    if (!image) return;

    const r = await ai.analyzeStreamFrame(image);
    if (!r || !r.description) return;

    const startedMs = stream.started_at ? new Date(String(stream.started_at).replace(' ', 'T') + 'Z').getTime() : Date.now();
    const offset = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    const CHUNK_SEC = 12;

    // Free local audio transcription (whisper.cpp) folded into the memory, so the
    // overview reflects what was SAID, not just what's on screen. Cleaned of the
    // usual whisper hallucinations; segment timestamps are stored (absolute stream
    // time) as contextual data for the AI system.
    let heard = '';
    let heardSegments = null;
    try {
        // When the continuous timeline is running it already transcribes ALL of the audio,
        // so grabbing another 12s chunk here would duplicate the work and — worse — open a
        // second PlainRTP consumer on the same producer, which is what made this path start
        // capturing digital silence (-91dB) once continuous capture was switched on.
        // Read the timeline instead: strictly more speech, and free.
        const _timeline = (() => { try { return require('./timeline-job').timelineEnabled(); } catch { return false; } })();
        if (_timeline) {
            try {
                const from = Math.max(0, offset - ai.captureIntervalSec());
                const rows = db.getTimeline(stream.id, { kind: 'speech', from, to: offset, limit: 200 }) || [];
                heard = rows.map(r => String(r.text || '').trim()).filter(Boolean).join(' ');
                heardSegments = rows.length
                    ? rows.map(r => ({ start: r.start_sec, end: r.end_sec, text: r.text }))
                    : null;
            } catch { /* fall through to empty */ }
            console.log(`[AI-Hear] stream ${stream.id}: from timeline transcript=${JSON.stringify((heard || '').slice(0, 100))}`);
        } else if (ai.transcriptionEnabled && ai.transcriptionEnabled()) {
            const audio = require('./stream-audio').captureAudioChunk ? await require('./stream-audio').captureAudioChunk(stream, CHUNK_SEC) : null;
            if (audio) {
                const tx = await require('./transcribe').transcribeWavDetailed(audio, { offsetSec: Math.max(0, offset - CHUNK_SEC) });
                heard = tx.text || '';
                heardSegments = (tx.segments && tx.segments.length) ? tx.segments : null;
                try { require('fs').unlinkSync(audio); } catch { /* */ }
            }
            console.log(`[AI-Hear] stream ${stream.id}: audio=${audio ? 'captured' : 'null'} transcript=${JSON.stringify((heard || '').slice(0, 100))}`);
        } else {
            console.log(`[AI-Hear] stream ${stream.id}: transcription disabled (enabled=${ai.transcriptionEnabled && ai.transcriptionEnabled()})`);
        }
    } catch (e) { console.warn(`[AI-Hear] stream ${stream.id}: transcription error`, e.message); }
    // Only fold in the "heard" part when the transcript is actual speech. Whisper emits
    // non-speech markers on silence/noise (>> continuation, [INAUDIBLE], [BLANK_AUDIO],
    // (music), etc.) — strip those and, if nothing with real words remains, drop the
    // "heard" clause entirely rather than storing `heard: ">> [INAUDIBLE]"`.
    const heardClean = String(heard || '')
        .replace(/[<>]{2,}/g, ' ')                    // >> / << continuation markers
        .replace(/[\[(][^\])]*[\])]/g, ' ')           // [INAUDIBLE] / (music) / [ silence ] …
        .replace(/\s+/g, ' ')
        .trim();
    const hasSpeech = /[a-z0-9]/i.test(heardClean);
    if (!hasSpeech) heardSegments = null;             // don't keep inaudible-only segments either
    const memDesc = hasSpeech ? `${r.description} — heard: "${heardClean.slice(0, 500)}"` : r.description;

    try {
        db.addStreamMemory({
            stream_id: stream.id, user_id: stream.user_id, offset_seconds: offset,
            description: memDesc, tags: r.tags, thumbnail_url: await _persistMomentFrame(image, stream.id, offset) || _stableThumb(stream.thumbnail_url),
            transcript_json: heardSegments,
        });
        // Roll this stream's memories into an overview — but only RE-summarize when
        // enough new memories have accumulated (SUMMARY_MIN_NEW) or enough time has
        // passed (SUMMARY_MAX_AGE_MS), NOT on every 120s frame capture. This cuts the
        // summarizer API calls ~2-3x. Between rollups the existing overview is kept
        // (better than overwriting it with a single-frame description).
        try {
            const memories = db.getStreamMemories(stream.id) || [];
            const now = Date.now();
            const last = _lastSummary.get(stream.id) || { count: 0, at: 0 };
            const grew = (memories.length - last.count) >= SUMMARY_MIN_NEW;
            const stale = (now - last.at) >= SUMMARY_MAX_AGE_MS;
            if (memories.length > 1 && (!last.at || grew || stale)) {
                const summary = await ai.summarizeStreamMemories(memories, stream.id);
                if (summary && summary.overview) {
                    db.updateStreamAiOverview(stream.id, summary.overview);
                    if (summary.category) db.setStreamAiCategory(stream.id, summary.category, summary.tags);
                    _lastSummary.set(stream.id, { count: memories.length, at: now });
                }
            } else if (!stream.ai_overview) {
                // Nothing summarized yet — seed the card with the latest observation.
                db.updateStreamAiOverview(stream.id, r.description);
            }
        } catch { /* keep existing overview */ }
    } catch (e) { console.warn('[AI] memory store failed:', e.message); }

    // Live paste: when the vision model flags THIS frame as screenshot-worthy, post it as an image
    // paste right now (no extra AI call — the caption came with the memory). Rate-limited per stream
    // and deduped through the shared moment registry so the paste job / clip job never re-use it.
    try { await _maybeLivePaste(stream, image, r, offset); } catch (e) { console.warn('[AI] live paste:', e.message); }
}

const LIVE_PASTE_MIN_GAP_MS = 90 * 60 * 1000;
async function _maybeLivePaste(stream, image, r, offset) {
    if (!r || !r.worthy || !r.title || !image) return;
    try { if (String(db.getSetting('ai_live_pastes_enabled') ?? 'true') === 'false') return; } catch { /* default on */ }
    const registry = require('./moment-registry');
    const last = registry.lastOfKind('paste', { stream_id: stream.id });
    if (last && Date.now() - (last.ts || 0) < LIVE_PASTE_MIN_GAP_MS) return;
    const why = registry.usedReason({ stream_id: stream.id, offset, desc: r.description, title: r.title });
    if (why) return;
    const moments = require('./ai-moments-job');
    if (typeof image === 'string' && !image.startsWith('data:') && moments.frameTooDark && await moments.frameTooDark(image)) return;
    let buffer = null;
    try { buffer = Buffer.isBuffer(image) ? image : (typeof image === 'string' && image.startsWith('data:') ? Buffer.from(image.split(',')[1] || '', 'base64') : require('fs').readFileSync(image)); } catch { return; }
    if (!buffer || buffer.length < 2000) return;
    const username = stream.username || (db.getUserById(stream.user_id) || {}).username || 'someone';
    let base = 'https://openvibe.live'; try { const c = require('../config'); base = String(c.baseUrl || c.publicUrl || base).replace(/\/$/, ''); } catch { /* */ }
    const media = require('../media-client');
    const paste = await media.createPaste({
        slug: moments.makeSlug ? moments.makeSlug() : undefined, user_id: stream.user_id,
        title: r.title.slice(0, 80), content: `${r.description}\n\n🔴 Caught live on @${username}'s stream — ${base}/${username}`, language: 'text', visibility: 'public',
        stream_id: stream.id, metadata: JSON.stringify({ ai_moment: true, live: true, stream_id: stream.id, offset, username, vod_link: null }),
        ai_summary: r.description, ai_tags: JSON.stringify(Array.isArray(r.tags) ? r.tags.slice(0, 8) : []),
        screenshot: { buffer, filename: `live-${stream.id}-${offset}.jpg`, contentType: 'image/jpeg' },
    });
    if (paste) {
        registry.record({ kind: 'paste', stream_id: stream.id, offset, desc: r.description, title: r.title });
        console.log(`[AI-Moments] live paste for stream ${stream.id} at ${offset}s: "${r.title}"`);
    }
}

async function tick() {
    if (!ai.streamMemoryEnabled()) return;
    let streams = [];
    try { streams = db.getLiveStreams() || []; } catch { return; }
    const intervalMs = ai.captureIntervalSec() * 1000;
    const now = Date.now();
    for (const stream of streams) {
        if (now - (_last.get(stream.id) || 0) < intervalMs) continue;
        _last.set(stream.id, now); // set before the async work so we don't double-capture
        if (_inflight.has(stream.id)) continue;
        captureMemoryNow(stream, { allowFfmpeg: true, reason: 'periodic' }).catch(() => {});
    }
    // GC entries for streams no longer live.
    if (_last.size > 300 || _lastSummary.size > 300) {
        const liveIds = new Set(streams.map(s => s.id));
        for (const id of _last.keys()) if (!liveIds.has(id)) _last.delete(id);
        for (const id of _lastSummary.keys()) if (!liveIds.has(id)) _lastSummary.delete(id);
    }
}

function start() {
    setInterval(() => { tick().catch(() => {}); }, 30000);
    console.log('[AI] Stream memory job started (30s poll; captures at the configured interval when enabled)');
}

module.exports = { start, tick, captureMemoryNow };
