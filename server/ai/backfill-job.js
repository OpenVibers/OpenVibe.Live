/**
 * backfill-job.js — slowly fills in AI output for content that predates (or missed)
 * analysis: VOD/clip overviews + transcripts. Processes a few items per minute so it
 * never spikes CPU/cost.
 *
 * Post media-split: the work queue lives in Live's vod_ai_state / clip_ai_state
 * tables (seeded by the Media vod.ready/clip.ready webhook + the cutover migration),
 * keyed by the Media vod/clip id. Content metadata (stream_id, user_id, playback)
 * is resolved from OpenVibe.Media per item. Paste analysis moved out with the paste
 * system — Media owns paste ai_summary now.
 */
'use strict';
const db = require('../db/database');
const ai = require('./ai-analysis');
const media = require('../media-client');

let _timer = null;
let _busy = false;

// Resolve Media metadata for a state row ({id} = Media id). Returns a vod/clip-shaped
// object the ai-analysis functions understand, or null (→ retry later).
async function _vodMeta(row) {
    try {
        const v = await media.getVod(row.id);
        if (!v) return null;
        if (v.status && String(v.status) === 'recording') return null; // still growing
        return { ...v, id: row.id, duration_seconds: v.duration_seconds ?? v.duration ?? 0 };
    } catch { return null; }
}
async function _clipMeta(row) {
    try {
        const c = await media.getClip(row.id);
        if (!c) return null;
        return { ...c, id: row.id, duration_seconds: c.duration_seconds ?? c.duration ?? 0 };
    } catch { return null; }
}

async function tick() {
    if (_busy) return;
    _busy = true;
    try {
        // Transcripts — FREE local whisper (no API/cost), so they run independent of
        // the AI master switch. We DON'T stop while streams are live — instead we drop
        // to low-power (fewer whisper threads) and a smaller batch so we never starve
        // the live encoders.
        let anyLive = false;
        try { anyLive = ((db.getLiveStreams && db.getLiveStreams()) || []).length > 0; } catch { /* */ }
        // When the continuous timeline is running it is already decoding live audio
        // constantly, and VOD backfill does NOT share its serialisation — so both would
        // run whisper at once, on top of the live encoder. Measured effect on this 4-core
        // box: load average 5.44. VOD transcripts have no deadline whatsoever, so simply
        // stand them down until the stream ends; they catch up at full speed afterwards.
        let timelineBusy = false;
        try { timelineBusy = anyLive && require('./timeline-job').timelineEnabled(); } catch { /* */ }
        if (timelineBusy) {
            try { require('./transcribe').setLowPower(true); } catch { /* */ }
        } else if (ai.transcriptionEnabled && ai.transcriptionEnabled()) {
            try { require('./transcribe').setLowPower(anyLive); } catch { /* */ }
            const batch = anyLive ? 1 : 2;   // throttle while live, catch up faster when idle
            try {
                for (const row of db.getVodsNeedingTranscript(batch)) {
                    const vod = await _vodMeta(row);
                    if (vod) await ai.generateVodTranscript(vod);
                }
            } catch (e) { console.warn('[AI backfill] vod transcript:', e.message); }
            try {
                for (const row of db.getClipsNeedingTranscript(batch)) {
                    const clip = await _clipMeta(row);
                    if (clip) await ai.generateClipTranscript(clip);
                }
            } catch (e) { console.warn('[AI backfill] clip transcript:', e.message); }
        }

        if (!ai.isEnabled()) return;

        // Paste summaries. Pastes moved to Media at the migration, but the analysis job
        // kept querying this service's OWN pastes table — which no longer receives rows —
        // so every paste created since had no AI at all. Media has no LLM, so it hands us
        // a work queue and we post results back.
        if (ai.pasteAnalysisEnabled && ai.pasteAnalysisEnabled()) {
            try {
                const out = await media.listPastesNeedingAi(anyLive ? 1 : 3).catch(() => null);
                for (const p of (out?.pastes || [])) {
                    if (!p || !p.slug) continue;
                    let r = null;
                    if (p.type === 'screenshot') {
                        // screenshot_url is RELATIVE ("/p/<slug>/screenshot") and the file
                        // lives on Media's disk, not ours — so it has to be fetched over
                        // HTTP from Media's public base, not opened as a path.
                        const img = p.slug ? media.pasteScreenshotUrl(p.slug) : null;
                        if (img) r = await ai.analyzeImagePaste(img, p.title).catch(() => null);
                    } else {
                        r = await ai.analyzeTextPaste(p.content || '', p.title).catch(() => null);
                    }
                    if (!r || !r.description) continue;
                    await media.setPasteAi(p.slug, {
                        ai_summary: r.description,
                        ai_tags: JSON.stringify(r.tags || []),
                    }).catch((e) => console.warn('[AI backfill] paste ai write:', e.message));
                    console.log(`[AI backfill] paste ${p.slug} summarized`);
                }
            } catch (e) { console.warn('[AI backfill] paste:', e.message); }
        }

        // VOD overviews (frames + audio pulled from the Media playback URL; self-marks).
        try {
            for (const row of db.getVodsNeedingOverview(1)) {
                const vod = await _vodMeta(row);
                if (vod) await ai.generateVodOverview(vod);
            }
        } catch (e) { console.warn('[AI backfill] vod:', e.message); }

        // Timeline coverage: guarantee start/end (+mid) memories on stream-backed VODs.
        try {
            for (const row of db.getVodsNeedingTimeline(1)) {
                const vod = await _vodMeta(row);
                if (vod && vod.stream_id) await ai.ensureVodTimeline(vod);
            }
        } catch (e) { console.warn('[AI backfill] timeline:', e.message); }

        // Clip overviews + local transcripts (frames + audio; self-marks).
        try {
            for (const row of db.getClipsNeedingOverview(1)) {
                const clip = await _clipMeta(row);
                if (clip) await ai.generateClipOverview(clip);
            }
        } catch (e) { console.warn('[AI backfill] clip:', e.message); }
    } finally {
        _busy = false;
    }
}

function start() {
    if (_timer) return;
    // One-time repair of any raw-JSON descriptions stored by earlier builds.
    try { if (db.cleanupMalformedAiText) db.cleanupMalformedAiText(); } catch (e) { console.warn('[AI] cleanup:', e.message); }
    _timer = setInterval(tick, 60_000);
    console.log('[AI] Backfill job started (VOD/clip overviews + transcripts via vod_ai_state/clip_ai_state)');
}

module.exports = { start, tick };
