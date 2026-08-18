/**
 * timeline-job.js — continuous audio → unified stream timeline.
 *
 * Replaces the old sampling model. That one grabbed a 12s chunk every 120s, which
 * measured against real stream audio caught almost nothing: this stream is only ~13%
 * speech, so sampling 10% of wall-clock captured roughly 1% of what was actually said.
 * Six of ten sampled 12s slices contained no speech at all and produced a bare "you",
 * which the noise filter then deleted — hence hours of `transcript=""` in the logs.
 *
 * Here instead:
 *   stream-audio.startContinuousCapture()  one long-lived ffmpeg per stream,
 *                                          rolling 16kHz mono loudnorm'd WAV segments
 *          │
 *          ▼
 *   transcribe (Silero VAD-gated)          decodes ONLY regions containing a voice
 *   audio-events (optional)                non-speech sound labels
 *          │
 *          ▼
 *   stream_timeline_events                 one time-indexed row per phrase / sound
 *
 * Latency is explicitly not a requirement, so segments are consumed behind live, one at
 * a time, and the whole job yields whenever the box is busy. Accuracy and completeness
 * are what matter.
 */
'use strict';
const db = require('../db/database');
const ai = require('./ai-analysis');
const audio = require('./stream-audio');

const POLL_MS = 10000;
// Process at most this many segments per tick per stream. Keeps a backlog from monopolising
// the CPU on a 4-core box that is also running live x264 encoding.
const MAX_SEGMENTS_PER_TICK = 2;

let _busy = false;
const _known = new Set();   // stream ids we have started capture for

function timelineEnabled() {
    try {
        const v = db.getSetting && db.getSetting('ai_timeline_enabled');
        if (v === undefined || v === null || v === '') return false;   // default OFF
        return String(v) === 'true' || String(v) === '1';
    } catch { return false; }
}

/** Transcribe one spooled segment and write its speech + sound rows. */
async function _processSegment(stream, seg) {
    const transcribe = require('./transcribe');
    let events = [];

    // ── Speech ────────────────────────────────────────────────────────────────
    // offsetSec shifts whisper's file-relative timestamps into absolute stream time,
    // so a row's start_sec is directly usable as a ?t= deep link.
    let tx = null;
    try {
        tx = await transcribe.transcribeWavDetailed(seg.path, {
            offsetSec: seg.offsetSec,
            timeoutMs: 180000,
            live: true,     // must keep up with the segment rate; see MODEL_LIVE
        });
    } catch (e) {
        console.warn(`[AI-Timeline] stream ${stream.id} seg ${seg.name}: transcribe error`, e.message);
    }
    if (tx && tx.ok && Array.isArray(tx.segments)) {
        for (const s of tx.segments) {
            const text = String(s.text || '').trim();
            if (!text) continue;
            events.push({
                stream_id: stream.id, user_id: stream.user_id, kind: 'speech',
                start_sec: Number(s.start) || seg.offsetSec,
                end_sec: s.end == null ? null : Number(s.end),
                text,
            });
        }
    }

    // ── Non-speech sound events ───────────────────────────────────────────────
    // Optional and best-effort: if the classifier is unavailable the speech timeline is
    // still complete, so this must never be able to fail the segment.
    try {
        const sounds = require('./audio-events');
        if (sounds.available()) {
            const cat = stream.category || null;
            const detected = await sounds.detect(seg.path, { offsetSec: seg.offsetSec, category: cat });
            for (const d of (detected || [])) {
                events.push({
                    stream_id: stream.id, user_id: stream.user_id, kind: 'sound',
                    start_sec: d.start, end_sec: d.end, label: d.label, confidence: d.confidence,
                });
            }
        }
    } catch { /* classifier optional */ }

    if (events.length) db.addTimelineEvents(events);
    audio.discardSegment(stream.id, seg.name);

    const spoken = events.filter(e => e.kind === 'speech').length;
    const heard = events.filter(e => e.kind === 'sound').length;
    if (spoken || heard) {
        const preview = events.find(e => e.kind === 'speech');
        console.log(`[AI-Timeline] stream ${stream.id} +${seg.offsetSec}s: ${spoken} speech, ${heard} sound` +
            (preview ? ` — ${JSON.stringify(String(preview.text).slice(0, 80))}` : ''));
    }
    return events.length;
}

async function tick() {
    if (_busy) return;                       // never overlap; whisper is CPU-bound
    if (!timelineEnabled()) return;
    if (!ai.transcriptionEnabled || !ai.transcriptionEnabled()) return;

    _busy = true;
    try {
        let live = [];
        try { live = db.getLiveStreams() || []; } catch { return; }
        const liveIds = new Set(live.map(s => s.id));

        // Start capture for newly live streams.
        for (const stream of live) {
            if (audio.isCapturing(stream.id)) continue;
            try { await audio.startContinuousCapture(stream); } catch { /* retry next tick */ }
            _known.add(stream.id);
        }

        // Stop + tidy streams that ended. Their remaining segments are drained first so
        // the tail of the stream is not lost, then the spool is removed.
        for (const id of [..._known]) {
            if (liveIds.has(id)) continue;
            audio.stopContinuousCapture(id);
            const leftovers = audio.pendingSegments(id);
            if (!leftovers.length) {
                audio.purgeSpool(id);
                _known.delete(id);
            }
        }

        // Drain segments, oldest first.
        for (const stream of live) {
            const pending = audio.pendingSegments(stream.id);
            if (!pending.length) continue;
            for (const seg of pending.slice(0, MAX_SEGMENTS_PER_TICK)) {
                await _processSegment(stream, seg).catch(() => {});
            }
        }
    } catch (e) {
        console.warn('[AI-Timeline] tick error:', e.message);
    } finally {
        _busy = false;
    }
}

function start() {
    setInterval(() => { tick().catch(() => {}); }, POLL_MS);
    console.log('[AI] Timeline job started (continuous audio → stream_timeline_events)');
}

/** Called on shutdown so ffmpeg children do not orphan. */
function stopAll() { return audio.stopAllCaptures(); }

module.exports = { start, tick, stopAll, timelineEnabled };
