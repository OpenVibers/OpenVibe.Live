'use strict';

// Finished Media recordings are analysed as one OpenVibe.AI workflow run. This
// module never decodes media on Live; the signed URL also works for private items.
const db = require('../db/database');
const media = require('../media-client');
const aiService = require('./ai-service');

const inFlight = new Set();
let failures = 0;
let failureCounter = null;

function enabled() { return String(process.env.LIVE_MEDIA_ANALYSIS || 'local').toLowerCase() === 'ai'; }
function registerMetrics(registry) {
    if (registry && typeof registry.counter === 'function') {
        failureCounter = registry.counter({ name: 'live_media_analysis_retry_total', help: 'Finished media analyses deferred after an OpenVibe.AI failure', labelNames: ['kind'] });
    }
}
function retryMinutes(attempt) { return Math.min(360, 2 ** Math.min(8, Math.max(0, attempt - 1))); }

async function source(kind, item) {
    const signed = await media.signedMediaUrl(kind, item.id, 6 * 3600).catch(() => null);
    if (signed && signed.url) return signed.url;
    const meta = kind === 'vod' ? await media.getVod(item.id).catch(() => null) : await media.getClip(item.id).catch(() => null);
    if (meta && meta.playback_url) return media.publicUrl(meta.playback_url);
    return kind === 'vod' ? media.vodPlaybackUrl(item.id) : media.clipUrl(item.id);
}

async function analyze(kind, item) {
    if (!item || !item.id || !['vod', 'clip'].includes(kind)) return null;
    const key = `${kind}:${item.id}`;
    if (inFlight.has(key)) return null;
    inFlight.add(key);
    const bump = kind === 'vod' ? db.bumpVodTranscriptAttempt : db.bumpClipTranscriptAttempt;
    const status = kind === 'vod' ? db.setVodTranscriptStatus : db.setClipTranscriptStatus;
    // A clip trimmed while this ran: its clip.ready cleared the state and moved the attempt on (db.setClipAiWindow), and
    // it gets an analysis of its own. This one describes the old window, so it stores nothing, not even a retry.
    let attemptNo = null;
    const superseded = async () => kind === 'clip' && attemptNo != null
        && (Number((await db.getClipAiState(item.id) || {}).transcript_attempts) || 0) !== attemptNo;
    try {
        const state = kind === 'vod' ? await db.getVodAiState(item.id) : await db.getClipAiState(item.id);
        // One AI run per attempt: a retry after a failure starts a new run, while a run still going when the poll
        // budget ends is re-joined later by the same key (never a second analysis of the same recording at once).
        attemptNo = Number(state && state.transcript_attempts) || 0;
        const mediaUrl = await source(kind, item);
        if (!mediaUrl) throw new Error('Media did not provide a readable URL');
        const run = await aiService.run('media.analyze', { media_url: mediaUrl, language: 'en', allow_paid: false }, {
            target: { service: 'live', type: kind, id: String(item.id) },
            attribution: aiService.ownerRef(item.user_id),
            idempotencyKey: `live.media.analyze:${kind}:${item.id}:${attemptNo}`,
            // Up to a minute (a clip is usually done by then), never a poll loop: a longer analysis is re-joined
            // in 15 minutes by its key, so the backfill loop is never held for the length of a recording.
            waitMs: Math.max(0, Number(process.env.LIVE_MEDIA_ANALYSIS_WAIT_MS ?? 60000) || 0), pollMs: 0,
        });
        if (run && (run.status === 'queued' || run.status === 'running')) {
            if (!await superseded()) await status(item.id, 'retry', 'OpenVibe.AI is still analysing it', 15);
            return null;
        }
        const out = aiService.usable(run);
        if (!out || !out.overview || typeof out.overview.text !== 'string' || !out.overview.text.trim() || !out.transcript || !Array.isArray(out.transcript.segments)) {
            throw new Error((run && run.error && (run.error.code || run.error.detail)) || (run && run.status) || 'no usable media.analyze result');
        }
        if (await superseded()) return null;
        // The state setters derive ai_overview_short and store segments in the
        // existing [{start,end,text}] JSON format. AI signals/highlights have no
        // corresponding state columns; keep all other Live state untouched.
        const overview = out.overview.text.trim();
        const segments = out.transcript.segments.map(g => ({ start: g.start, end: g.end, text: g.text }));
        // An overview Live already has (a model's, or a person's edit) is kept: AI's fills only a missing one.
        if (!state || !String(state.ai_overview || '').trim()) {
            if (kind === 'vod') await db.setVodAiOverview(item.id, overview);
            else await db.setClipAiOverview(item.id, { overview });
        }
        const partialSpeech = Array.isArray(out.gaps) && out.gaps.some(g => /^Speech-to-text failed/i.test(String(g)));
        if (out.transcript.available && !partialSpeech) {
            const hasSpeech = !!(segments.length || String(out.transcript.text || '').trim());
            if (hasSpeech || !state || !state.ai_transcript_json) {
                if (kind === 'vod') await db.setVodTranscript(item.id, out.transcript.text || ' ', segments);
                else await db.setClipTranscript(item.id, out.transcript.text || ' ', segments);
            }
            await status(item.id, hasSpeech || (state && state.ai_transcript_json) ? 'done' : 'empty');
        } else if (out.streams && out.streams.audio === false) {
            if (!state || !state.ai_transcript_json) {
                if (kind === 'vod') await db.setVodTranscript(item.id, ' ', []);
                else await db.setClipTranscript(item.id, ' ', []);
            }
            await status(item.id, state && state.ai_transcript_json ? 'done' : 'empty', 'no audio stream');
        } else if (!state || !state.ai_transcript_json) {
            const attempt = await bump(item.id);
            await status(item.id, 'retry', partialSpeech ? 'AI speech-to-text incomplete' : 'AI speech-to-text unavailable', retryMinutes(attempt));
        }
        return out;
    } catch (e) {
        if (await superseded().catch(() => false)) return null;
        const attempt = await bump(item.id);
        await status(item.id, 'retry', e.message, retryMinutes(attempt));
        failures++;
        if (failureCounter) failureCounter.inc({ kind });
        console.warn(`[AI media] ${kind} ${item.id}: ${e.message}; retry in ${retryMinutes(attempt)} min`);
        return null;
    } finally {
        inFlight.delete(key);
    }
}

module.exports = { enabled, analyze, registerMetrics, stats: () => ({ failures }) };
