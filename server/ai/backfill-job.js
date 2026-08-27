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
let _loadWarnedAt = 0;

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
        // The live timeline has its OWN whisper lane now (transcribe.js), so VOD/clip work
        // no longer has to stand down for the whole stream — it runs niced, low-power, and
        // only when the box has headroom. (The old stand-down meant nothing was ever
        // transcribed while the owner streamed, which on this site is most of the day.)
        const cores = require('os').cpus().length || 4;
        const load1 = (require('os').loadavg()[0]) || 0;
        const headroom = load1 < cores * 1.25;
        if (!headroom) {
            if (!_loadWarnedAt || Date.now() - _loadWarnedAt > 600000) { _loadWarnedAt = Date.now(); console.log(`[AI backfill] load ${load1.toFixed(1)} on ${cores} cores — deferring batch transcription`); }
        } else if (ai.transcriptionEnabled && ai.transcriptionEnabled()) {
            try { require('./transcribe').setLowPower(anyLive); } catch { /* */ }
            const batch = anyLive ? 1 : 2;   // throttle while live, catch up faster when idle
            // Take several candidates and process the first `batch` that resolve: a row whose
            // Media metadata won't resolve (still recording, Media down) used to occupy the
            // whole LIMIT every minute and block every row behind it.
            try {
                let done = 0;
                for (const row of db.getVodsNeedingTranscript(batch + 6)) {
                    if (done >= batch) break;
                    const vod = await _vodMeta(row);
                    if (!vod) continue;
                    await ai.generateVodTranscript(vod);
                    done++;
                }
            } catch (e) { console.warn('[AI backfill] vod transcript:', e.message); }
            try {
                let done = 0;
                for (const row of db.getClipsNeedingTranscript(batch + 6)) {
                    if (done >= batch) break;
                    const clip = await _clipMeta(row);
                    if (!clip) continue;
                    await ai.generateClipTranscript(clip);
                    done++;
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
            // Take a few candidates and process the first usable one: the newest row is
            // often a VOD still recording (skipped), and with LIMIT 1 it blocked the queue.
            for (const row of db.getVodsNeedingOverview(6)) {
                const vod = await _vodMeta(row);
                if (!vod) continue;
                await ai.generateVodOverview(vod);
                break;
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
            for (const row of db.getClipsNeedingOverview(6)) {
                const clip = await _clipMeta(row);
                if (!clip) continue;
                await ai.generateClipOverview(clip);
                break;
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
