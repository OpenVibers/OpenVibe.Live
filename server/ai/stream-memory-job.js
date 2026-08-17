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

async function _analyzeOne(stream) {
    let image = null;
    try { if (vision && vision.captureFrame) image = await vision.captureFrame(stream); } catch { /* */ }
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
        if (ai.transcriptionEnabled && ai.transcriptionEnabled()) {
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
            description: memDesc, tags: r.tags, thumbnail_url: stream.thumbnail_url || null,
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
                const summary = await ai.summarizeStreamMemories(memories);
                if (summary) {
                    db.updateStreamAiOverview(stream.id, summary);
                    _lastSummary.set(stream.id, { count: memories.length, at: now });
                }
            } else if (!stream.ai_overview) {
                // Nothing summarized yet — seed the card with the latest observation.
                db.updateStreamAiOverview(stream.id, r.description);
            }
        } catch { /* keep existing overview */ }
    } catch (e) { console.warn('[AI] memory store failed:', e.message); }
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
        _analyzeOne(stream).catch(() => {});
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

module.exports = { start, tick };
