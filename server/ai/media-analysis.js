/**
 * media-analysis.js — extract a spread of video FRAMES + sampled AUDIO from a media
 * file (local path OR presigned B2/R2 URL, via ffmpeg range requests) and turn them
 * into stream memories + an AI overview. This is what gives pre-existing VODs and
 * clips (which never had live memories) real AI overviews, combining vision + local
 * whisper transcription.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/database');

function _tmp(ext) {
    return path.join(os.tmpdir(), `openvibe-ma-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
}

// Track spawned ffmpeg/ffprobe children so a shutdown can kill them (see killActive).
const _active = new Set();
function _track(ff) {
    if (!ff) return ff;
    _active.add(ff);
    const drop = () => _active.delete(ff);
    ff.on('close', drop); ff.on('error', drop); ff.on('exit', drop);
    return ff;
}
function killActive() {
    let n = 0;
    for (const ff of _active) { try { ff.kill('SIGKILL'); n++; } catch { /* */ } }
    _active.clear();
    return n;
}

function _runFf(bin, args, killMs) {
    return new Promise((resolve) => {
        let ff;
        try { ff = _track(spawn(bin, args, { stdio: 'ignore' })); } catch { return resolve(false); }
        const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, killMs);
        ff.on('close', (c) => { clearTimeout(t); resolve(c === 0); });
        ff.on('error', () => { clearTimeout(t); resolve(false); });
    });
}

function _ffprobeDuration(src) {
    return new Promise((resolve) => {
        let out = '';
        let ff;
        try { ff = _track(spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src], { stdio: ['ignore', 'pipe', 'ignore'] })); }
        catch { return resolve(0); }
        ff.stdout.on('data', (d) => { out += d; });
        const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } resolve(0); }, 45000);
        ff.on('close', () => { clearTimeout(t); const n = parseFloat(String(out).trim()); resolve(Number.isFinite(n) ? n : 0); });
        ff.on('error', () => { clearTimeout(t); resolve(0); });
    });
}

async function _extractFrame(src, t) {
    const out = _tmp('jpg');
    // -ss before -i = fast seek (HTTP range for remote URLs).
    const ok = await _runFf('ffmpeg', ['-y', '-ss', String(Math.max(0, t)), '-i', src, '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '5', out], 60000);
    if (ok && fs.existsSync(out) && fs.statSync(out).size > 512) return out;
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch { /* */ }
    return null;
}

// Detect the "most active" moments cheaply via AUDIO loudness (ebur128 momentary
// loudness). Audio-only decode is far lighter than full video scene-detection, and
// loud moments are a good proxy for exciting/active parts. Returns timestamps (seconds)
// sorted loudest-first. Gated by a duration cap so we never heavy-decode huge VODs.
const ACTIVE_MAX_DURATION = 3 * 3600; // 3h — beyond this we skip detection and space uniformly
function _detectActiveTimes(src) {
    return new Promise((resolve) => {
        // ametadata prints, per frame: "pts_time:<t>" then "lavfi.r128.M=<loudness>".
        const args = ['-hide_banner', '-nostats', '-vn', '-i', src,
            '-af', 'ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M',
            '-f', 'null', '-'];
        let ff;
        try { ff = _track(spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })); }
        catch { return resolve([]); }
        const points = [];
        let pending = null;
        let buf = '';
        ff.stderr.on('data', (d) => {
            buf += d.toString();
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                const pm = line.match(/pts_time:([0-9.]+)/);
                if (pm) { pending = parseFloat(pm[1]); continue; }
                const lm = line.match(/lavfi\.r128\.M=(-?[0-9.]+)/);
                if (lm && pending != null) { points.push({ t: pending, loud: parseFloat(lm[1]) }); pending = null; }
            }
            if (points.length > 20000) { try { ff.kill('SIGKILL'); } catch { /* */ } } // safety cap
        });
        const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 180000);
        const done = () => { clearTimeout(timer); resolve(points); };
        ff.on('close', done);
        ff.on('error', () => { clearTimeout(timer); resolve([]); });
    });
}

// Pick up to `count` "active" timestamps spread across the timeline, avoiding anything
// within `minGap` of an already-chosen time. Falls back to uniform spacing when audio
// activity is unavailable (silent stream, detection skipped, etc.).
async function pickActiveTimes(src, duration, count, avoid = [], minGap = 20) {
    if (count <= 0 || !(duration > 0)) return [];
    const chosen = [];
    const tooClose = (t) => avoid.concat(chosen).some((x) => Math.abs(x - t) < minGap);
    if (duration <= ACTIVE_MAX_DURATION) {
        let pts = [];
        try { pts = await _detectActiveTimes(src); } catch { pts = []; }
        // Sort loudest-first; greedily take well-separated peaks.
        pts.sort((a, b) => b.loud - a.loud);
        for (const p of pts) {
            if (chosen.length >= count) break;
            const t = Math.max(1, Math.floor(p.t));
            if (t < 1 || t > duration - 1) continue;
            if (!tooClose(t)) chosen.push(t);
        }
    }
    // Fill any remainder with uniform points (covers silent/undetected media).
    if (chosen.length < count) {
        const need = count - chosen.length;
        for (let i = 1; i <= need + 1 && chosen.length < count; i++) {
            const t = Math.floor((duration * i) / (need + 2));
            if (t >= 1 && t <= duration - 1 && !tooClose(t)) chosen.push(t);
        }
    }
    return chosen.sort((a, b) => a - b);
}

// Extract a frame at each timestamp, vision-analyze it, and (optionally) store a stream
// memory. Returns [{t, description, tags}]. This is the shared frame→memory pipeline.
async function captureFrameMemories(src, times, { streamId = null, userId = null, offsetBase = 0, store = true } = {}) {
    const ai = require('./ai-analysis');
    const out = [];
    for (const t of times) {
        const fp = await _extractFrame(src, t);
        if (!fp) continue;
        let r = null;
        try { r = await ai.analyzeStreamFrame(fp); } catch { /* */ }
        try { fs.unlinkSync(fp); } catch { /* */ }
        if (r && r.description) {
            out.push({ t, description: r.description, tags: r.tags });
            if (store && streamId) {
                try {
                    db.addStreamMemory({
                        stream_id: streamId, user_id: userId,
                        offset_seconds: Math.round(offsetBase + t),
                        description: r.description, tags: r.tags, thumbnail_url: null,
                    });
                } catch { /* */ }
            }
        }
    }
    return out;
}

// How many frames a VOD of this length is worth analyzing — scaled so short clips are
// cheap (2 calls) and long streams get proportionally more coverage (capped at 8).
function targetFrameCount(duration) {
    if (duration <= 300) return 2;    // ≤5 min: start + end
    if (duration <= 1200) return 4;   // ≤20 min
    if (duration <= 3600) return 6;   // ≤1 h
    return 8;                          // > 1 h
}

// The REQUIRED anchor timestamps: the very start, right before the end, and (for VODs
// over 5 minutes) the middle. These guarantee the timeline always brackets the VOD.
function anchorTimes(duration) {
    const start = 1;
    const end = Math.max(2, Math.floor(duration - 2));
    const anchors = [start, end];
    if (duration > 300) anchors.push(Math.floor(duration / 2));
    return [...new Set(anchors)].sort((a, b) => a - b);
}

// Build the full set of frame timestamps for a VOD: guaranteed anchors + active-moment
// fills up to the target, skipping anything already covered by `existingOffsets`.
async function pickFrameTimes(src, duration, { existingOffsets = [], maxFrames = null } = {}) {
    const target = maxFrames || targetFrameCount(duration);
    const tol = Math.min(30, Math.max(8, Math.floor(duration * 0.06)));
    const covered = (t) => existingOffsets.some((o) => Math.abs(o - t) <= tol);
    const picks = [];
    for (const a of anchorTimes(duration)) if (!covered(a)) picks.push(a);
    const remaining = target - existingOffsets.length - picks.length;
    if (remaining > 0) {
        const active = await pickActiveTimes(src, duration, remaining, existingOffsets.concat(picks), tol);
        for (const t of active) picks.push(t);
    }
    return [...new Set(picks)].sort((a, b) => a - b);
}

// Transcribe the audio: full for short media, else 3 spread 60s windows. Returns
// { text, segments:[{start,end,text}] } with segment times relative to the recording.
// Does the source carry an audio stream at all? Video-only recordings (screen shares with
// no mic, some RS robots) used to fail ffmpeg's wav extraction, burn 8 retries and end up
// 'failed' — they are simply silent and should be terminal 'empty' on the first pass.
function _ffprobeHasAudio(src) {
    return new Promise((resolve) => {
        let out = '';
        let p;
        try {
            p = _track(spawn('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', src], { stdio: ['ignore', 'pipe', 'ignore'] }));
        } catch { return resolve(null); }
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(null); }, 30000);
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', (c) => { clearTimeout(t); resolve(c === 0 ? /audio/.test(out) : null); });
        p.on('error', () => { clearTimeout(t); resolve(null); });
    });
}

async function _transcribeSpan(src, duration, { resumeFromSec = 0, priorSegments = null, onWindow = null } = {}) {
    const transcribe = require('./transcribe');
    if (!transcribe.available()) return { text: '', segments: [], ok: false, error: 'whisper unavailable' };
    if (duration > 0 && duration <= 200) {
        return await transcribe.transcribeMediaDetailed(src, { seconds: 0, timeoutMs: 300000 });
    }
    // FULL coverage, not a sample. This used to take three 60-second windows at 10%/45%/80%
    // of the recording, so a 4-hour VOD produced 3 minutes of transcript and the rest was
    // simply never heard. Walk the whole thing in windows instead.
    //
    // Affordable because the decoder is VAD-gated: measured on this stream only ~13% of
    // audio contains a voice, and VAD cut a 60s decode from 51.0s to 24.0s while also
    // removing a trailing hallucination. Windows are processed one at a time and the whole
    // pass runs from the backfill queue, which already drops to low power while live.
    const WINDOW_SEC = 300;
    const parts = [];
    // Resume support: a deploy/restart used to throw away every finished window of an
    // hour-long VOD. Callers persist progress after each window (onWindow) and hand the
    // finished segments back (priorSegments/resumeFromSec) so we continue, not restart.
    const segments = Array.isArray(priorSegments) ? [...priorSegments] : [];
    let anyOk = segments.length > 0, lastErr = null;
    const total = Math.max(0, Math.floor(duration || 0));
    const windows = [];
    const firstStart = Math.max(0, Math.floor((resumeFromSec || 0) / WINDOW_SEC) * WINDOW_SEC);
    for (let start = firstStart; start < total; start += WINDOW_SEC) windows.push(start);
    if (firstStart > 0) console.log(`[AI] transcript resuming at ${Math.round(firstStart / 60)}min of ${Math.round(total / 60)}min (${segments.length} segments kept)`);
    // Safety valve for absurdly long recordings so one VOD cannot occupy the queue forever.
    const MAX_WINDOWS = Math.max(1, parseInt(process.env.AI_VOD_MAX_WINDOWS, 10) || 96); // 8h
    if (windows.length > MAX_WINDOWS) {
        console.warn(`[AI] VOD is ${Math.round(total / 60)}min — transcribing the first ${MAX_WINDOWS * WINDOW_SEC / 60}min only`);
        windows.length = MAX_WINDOWS;
    }
    for (const start of windows) {
        const wav = _tmp('wav');
        const len = Math.min(WINDOW_SEC, total - start);
        const ffOk = await _runFf('ffmpeg', ['-y', '-ss', String(start), '-i', src, '-t', String(len), '-vn', '-ac', '1', '-ar', '16000', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-f', 'wav', wav], 180000);
        if (ffOk) {
            const r = await transcribe.transcribeWavDetailed(wav, { timeoutMs: 600000, offsetSec: start });
            if (r.ok) anyOk = true; else lastErr = r.error || lastErr;
            if (r.segments && r.segments.length) segments.push(...r.segments);
            if (r.ok && typeof onWindow === 'function') {
                try { await onWindow(Math.min(total, start + len), segments); } catch { /* progress is best-effort */ }
            }
        } else { lastErr = 'ffmpeg window extract failed'; }
        try { fs.existsSync(wav) && fs.unlinkSync(wav); } catch { /* */ }
    }
    segments.sort((a, b) => (a.start || 0) - (b.start || 0));
    parts.length = 0;
    for (const s of segments) if (s.text) parts.push(s.text);
    // ok=true only if at least one window ran the full ffmpeg+whisper pipeline cleanly.
    // If every window failed (unreadable source, etc.) we return ok=false so the caller
    // retries instead of marking the VOD permanently silent.
    // Windows are contiguous now, so the transcript reads as continuous prose rather than
    // three disconnected excerpts joined by an ellipsis.
    return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), segments, ok: anyOk, error: anyOk ? null : lastErr };
}

/**
 * Analyze a media source (ffmpeg-consumable path or URL): spread frames → vision
 * descriptions (optionally stored as memories) + sampled transcript → overview.
 * @returns {{ overview, transcript, frames, duration }}
 */
async function analyzeMedia(src, { streamId = null, userId = null, numFrames = null, storeMemories = false, offsetBase = 0 } = {}) {
    if (!src) return { overview: null, transcript: '', frames: [], duration: 0 };
    // Lazy require (avoids a load-time circular dep with ai-analysis, which pulls us in).
    const ai = require('./ai-analysis');
    const duration = await _ffprobeDuration(src);
    let frames = [];
    if (duration <= 2) {
        // Tiny media — one frame.
        const one = await captureFrameMemories(src, [1], { streamId, userId, offsetBase, store: storeMemories });
        frames = one;
    } else {
        // Guaranteed start/end (+mid for >5min) plus active-moment fills, cost-scaled.
        const times = await pickFrameTimes(src, duration, { maxFrames: numFrames });
        frames = await captureFrameMemories(src, times, { streamId, userId, offsetBase, store: storeMemories });
    }

    const { text: transcript, segments } = await _transcribeSpan(src, duration);

    let overview = null;
    if (frames.length || transcript) {
        const parts = [];
        if (frames.length) parts.push('Visual observations across the video (in order):\n' + frames.map(f => `- ${f.description}`).join('\n'));
        if (transcript) parts.push('Audio transcript (sampled from the recording):\n"' + transcript.slice(0, 4000) + '"');
        const prompt = `You are writing an AI overview of a recorded video. Using ONLY the signals below (be concrete, don't invent), summarize what the video is about in 2-5 sentences — the main activities, topics, and vibe.\n\n${parts.join('\n\n')}`;
        overview = await ai.summarizeText(prompt, 400, 'media_overview');
        if (overview) overview = overview.slice(0, 2000);
    }
    return { overview: overview || null, transcript: transcript || '', segments: segments || [], frames, duration };
}

/**
 * Transcript-only: probe duration then whisper-transcribe (FREE local, no vision).
 * @returns {Promise<{text:string, segments:Array}>}
 */
async function transcribeOnly(src, opts = {}) {
    if (!src) return { text: '', segments: [], ok: false, error: 'no source' };
    const hasAudio = await _ffprobeHasAudio(src);
    if (hasAudio === false) return { text: '', segments: [], ok: true, noAudio: true, error: null };
    const duration = await _ffprobeDuration(src);
    try { return await _transcribeSpan(src, duration, opts); } catch (e) { return { text: '', segments: [], ok: false, error: e.message }; }
}

module.exports = {
    analyzeMedia, transcribeOnly, killActive,
    probeDuration: _ffprobeDuration,
    pickFrameTimes, pickActiveTimes, captureFrameMemories, anchorTimes, targetFrameCount,
};
