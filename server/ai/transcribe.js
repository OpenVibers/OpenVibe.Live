/**
 * transcribe.js — free, LOCAL speech-to-text via whisper.cpp (no API, runs on the
 * server CPU). Used for live-stream memories and VOD/clip transcripts.
 *
 * Reliability features:
 *   - JSON output (-oj) → per-segment timestamps (ms) we keep as contextual data.
 *   - Beam search for steadier decoding.
 *   - Post-filter that drops whisper's well-known hallucinations on silence/music
 *     ("you", "Thanks for watching!", "[MUSIC]", …) and collapses looped repeats.
 *
 * Install (server): build whisper.cpp + download a ggml model. Paths/threads/beam
 * can be overridden with WHISPER_BIN / WHISPER_MODEL / WHISPER_THREADS / WHISPER_BEAM.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const CANDIDATE_BINS = [
    process.env.WHISPER_BIN,
    path.join(HOME, 'whisper.cpp/build/bin/whisper-cli'),
    path.join(HOME, 'whisper.cpp/build/bin/main'),
    path.join(HOME, 'whisper.cpp/main'),
].filter(Boolean);
const MODEL = process.env.WHISPER_MODEL || path.join(HOME, 'whisper.cpp/models/ggml-base.en.bin');
// Live transcription has a hard throughput constraint that batch work does not: segments
// arrive continuously, so if a decode takes longer than the segment it covers, the backlog
// grows without bound and audio is eventually evicted unheard. Measured on this box,
// large-v3-turbo-q5 took 72s for a 30s segment (2.4x realtime) — accurate but unusable for
// live. VOD/clip backfill has no such constraint and should use the most accurate model
// available. So allow the live path to pick a faster one; falls back to MODEL when unset.
const MODEL_LIVE = process.env.WHISPER_MODEL_LIVE || MODEL;
function _modelFor(opts) {
    const m = (opts && opts.live) ? MODEL_LIVE : MODEL;
    try { return fs.existsSync(m) ? m : MODEL; } catch { return MODEL; }
}
const THREADS = Math.max(2, Math.min(8, parseInt(process.env.WHISPER_THREADS, 10) || 4));

// ── Voice Activity Detection ──────────────────────────────────────────────
// Measured on 60s of real stream audio: VAD cut large-v3-turbo from 51.0s to 24.0s
// AND removed a trailing "Thank you." hallucination. Both effects matter, and the
// second one matters more than the speedup.
//
// This stream is only ~13% speech (VAD found 7.9s of speech in 60s). Without VAD the
// decoder is handed 87% silence and invents text over it — "you", "Thank you.",
// "[BLANK_AUDIO]", "Bye!" — which is exactly what the HALLUCINATIONS blocklist below
// exists to delete. VAD removes the cause rather than filtering the symptom, so the
// decoder only ever sees regions that actually contain a voice.
const VAD_MODEL = process.env.WHISPER_VAD_MODEL || path.join(HOME, 'whisper.cpp/models/ggml-silero-v5.1.2.bin');
function vadModel() {
    if (process.env.WHISPER_VAD === '0') return null;      // explicit opt-out
    try { return fs.existsSync(VAD_MODEL) ? VAD_MODEL : null; } catch { return null; }
}
// Default to greedy decoding (whisper.cpp default) — proven to transcribe speech
// reliably here. Beam search (WHISPER_BEAM>1) sometimes collapses real speech into a
// non-speech tag like "[Crowd noise]", so it's opt-in only.
const BEAM = Math.max(1, Math.min(8, parseInt(process.env.WHISPER_BEAM, 10) || 1));

let _binCache;
let _binMissSince = 0;
function whisperBin() {
    // Cache a FOUND binary for the process lifetime (it won't move). But if it wasn't
    // found, only cache the miss briefly (30s) and then re-probe — so installing whisper
    // while the server is running is picked up without a restart.
    if (_binCache) return _binCache;
    if (_binMissSince && (Date.now() - _binMissSince) < 30000) return null;
    const found = CANDIDATE_BINS.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
    if (found) { _binCache = found; _binMissSince = 0; }
    else { _binMissSince = Date.now(); }
    return found;
}
function available() {
    try { return !!whisperBin() && fs.existsSync(MODEL); } catch { return false; }
}

// ── Reliability plumbing ──────────────────────────────────────────────────
// Every spawned whisper/ffmpeg child is tracked so a shutdown/restart can kill it
// (otherwise it orphans + leaks its temp WAV/JSON). killActive() is called from the
// server's graceful-shutdown handler.
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
// ── Hard concurrency gate ─────────────────────────────────────────────────
// ai-analysis serialises VOD work through _txChain, but that only covers callers that
// go through it — the timeline job, clip transcripts and the on-finalize webhook all
// reach transcribeWavDetailed by other routes. Three large-v3-turbo processes were
// observed running at once (896MB + 636MB + 636MB RSS, load average 20.9 on 4 cores),
// which starved the live encoders and the clip cutter alike.
//
// Put the limit HERE, where every caller must pass, so no future path can bypass it.
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.WHISPER_MAX_CONCURRENT, 10) || 1);
// Two INDEPENDENT lanes. The live timeline decodes 10s segments with the small model and
// must keep up with real time; VOD/clip backfill decodes hour-long recordings with the
// large model. When they shared one slot, a single VOD job (minutes to hours, and killed
// + restarted from scratch on every deploy) held the slot and the live transcript simply
// stopped — segments piled up in the spool and were discarded. Live never waits on batch.
const _lanes = {
    live:  { max: 1, running: 0, waiters: [] },
    batch: { max: MAX_CONCURRENT, running: 0, waiters: [] },
};
function _acquire(lane = 'batch') {
    const L = _lanes[lane] || _lanes.batch;
    if (L.running < L.max) { L.running++; return Promise.resolve(); }
    return new Promise(resolve => L.waiters.push(resolve));
}
function _release(lane = 'batch') {
    const L = _lanes[lane] || _lanes.batch;
    const next = L.waiters.shift();
    if (next) next();              // hand the slot straight over
    else L.running = Math.max(0, L.running - 1);
}
function laneStatus() {
    return Object.fromEntries(Object.entries(_lanes).map(([k, L]) => [k, { running: L.running, queued: L.waiters.length }]));
}

// While a stream is live we lower the whisper thread count so VOD transcription can
// still make progress without starving the live encoders.
let _lowPower = false;
function setLowPower(v) { _lowPower = !!v; }
function _threads(live = false) {
    // Live segments are short and use the small model: 2 threads keeps them well ahead of
    // real time while leaving cores for the encoders and the (niced) batch lane.
    if (live) return Math.max(1, Math.min(2, THREADS));
    return _lowPower ? Math.max(1, Math.min(2, THREADS)) : THREADS;
}

// Phrases whisper commonly hallucinates over silence / music / non-speech.
// Always-drop: whisper's stock inventions over non-speech. These are never worth keeping
// even when VAD says a voice is present, because they are the model's filler, not words.
const HALLUCINATIONS = new Set([
    'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
    'thanks for watching.', 'please subscribe', 'subscribe', 'like and subscribe',
    'thank you for watching', 'thank you very much',
    'thank you so much', 'silence', 'music', 'applause',
]);
// Drop-only-without-VAD: these ARE real words a streamer says constantly. They were on the
// blocklist because, with the decoder run over 87% silence, they were overwhelmingly
// hallucinations — six of ten sampled 12s slices produced a bare "you". Once Silero gates
// the decoder to actual speech regions, deleting them throws away genuine transcript.
const FILLER_WORDS = new Set([
    'you', 'bye', 'bye.', 'bye bye', 'okay', 'ok', 'oh', 'uh', 'um', 'hmm', 'mm', 'mhm',
    'the', 'so', 'yeah', 'i\'m sorry',
]);
function _isNoise(t) {
    const s = (t || '').replace(/\s+/g, ' ').trim();
    if (!s) return true;
    // bracketed/parenthetical cues, music notes, or pure punctuation
    if (/^[\s.\-–—_*]+$/.test(s)) return true;
    if (/^[\[(♪].*[\])♪]?$/.test(s)) return true;
    if (/^♪/.test(s) || /♪$/.test(s)) return true;
    const norm = s.toLowerCase().replace(/[.!?,…]+$/g, '').trim();
    if (HALLUCINATIONS.has(norm)) return true;
    // Whisper's training data was full of subtitle boilerplate, and it emits those exact
    // phrases over noise even when VAD says a voice is present — a real live segment came
    // back as "For more information, visit www.fema.org." These are recognisable by shape:
    // a short line that is mostly a URL or a subtitle credit, which real stream speech
    // essentially never is.
    if (/\b(?:www\.|https?:\/\/)\S+/i.test(norm) && norm.split(/\s+/).length <= 12) return true;
    if (/subtitle[sd]?\s+(?:by|from)|amara\.org|subscribe to|closed caption/i.test(norm)) return true;
    if (/^(?:for more info(?:rmation)?|visit our website|see you (?:next time|in the next video))/i.test(norm)) return true;
    if (!vadModel() && FILLER_WORDS.has(norm)) return true;
    return false;
}

// Clean a raw segment list: drop noise + collapse immediate repeats.
function _cleanSegments(segsRaw) {
    const out = [];
    let last = '';
    for (const seg of segsRaw) {
        const text = (seg.text || '').replace(/\s+/g, ' ').trim();
        if (_isNoise(text)) continue;
        const norm = text.toLowerCase();
        if (norm === last) continue; // whisper loops the same line — drop the dupes
        last = norm;
        out.push({ start: Math.round(seg.start * 100) / 100, end: Math.round(seg.end * 100) / 100, text });
    }
    return out;
}
function _joinSegments(segments) {
    return segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Detailed transcription of a 16kHz mono WAV.
 * @returns {Promise<{text:string, segments:Array<{start:number,end:number,text:string}>}>}
 *          start/end in seconds (shifted by opts.offsetSec).
 */
// Inner implementation. Wrapped by transcribeWavDetailed, which holds the concurrency
// slot for the whole run so only MAX_CONCURRENT decoders exist at any moment.
function _transcribeWavInner(wavPath, { timeoutMs = 180000, offsetSec = 0, live = false } = {}) {
    return new Promise((resolve) => {
        const bin = whisperBin();
        // ok=false only for genuine FAILURES (missing binary, spawn/exec error, timeout,
        // non-zero exit, unparseable output). A clean run that finds no speech is ok=true
        // with empty text — the caller must NOT treat that as a failure to retry.
        if (!bin || !available() || !wavPath || !fs.existsSync(wavPath)) {
            return resolve({ text: '', segments: [], ok: false, error: 'whisper unavailable' });
        }
        const outBase = `${wavPath}.out`;
        const jsonPath = `${outBase}.json`;
        const args = ['-m', _modelFor({ live }), '-f', wavPath, '-oj', '-of', outBase, '-t', String(_threads(live)), '-l', 'en'];
        if (BEAM > 1) args.push('-bs', String(BEAM));
        // Decode only the regions Silero says contain a voice. Segment timestamps stay in
        // absolute file time, so the {start,end} contract is unchanged for every caller.
        const vm = vadModel();
        if (vm) args.push('--vad', '-vm', vm);
        let ff;
        // Run at low CPU priority. Transcription is never latency-critical, but it shares
        // 4 cores with live x264 encoding on a box with no swap — so it must always be the
        // thing that yields. `nice` is used rather than a hard cgroup cap because a cap that
        // is hit kills the process, whereas a niced process simply runs slower.
        try { ff = _track(spawn('nice', ['-n', '15', bin, ...args], { stdio: 'ignore' })); }
        catch (e) { return resolve({ text: '', segments: [], ok: false, error: e.message }); }
        let done = false;
        const finish = (result) => {
            if (done) return; done = true;
            clearTimeout(timer);
            try { fs.existsSync(jsonPath) && fs.unlinkSync(jsonPath); } catch { /* */ }
            resolve(result);
        };
        const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } finish({ text: '', segments: [], ok: false, error: 'timeout' }); }, timeoutMs);
        ff.on('close', (code) => {
            if (code !== 0) return finish({ text: '', segments: [], ok: false, error: `whisper exited ${code}` });
            let parsed;
            try { parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { return finish({ text: '', segments: [], ok: false, error: 'parse: ' + e.message }); }
            const items = Array.isArray(parsed && parsed.transcription) ? parsed.transcription : [];
            const segsRaw = items.map(it => ({
                start: offsetSec + ((it.offsets && it.offsets.from) || 0) / 1000,
                end: offsetSec + ((it.offsets && it.offsets.to) || 0) / 1000,
                text: it.text || '',
            }));
            const segments = _cleanSegments(segsRaw);
            finish({ text: _joinSegments(segments), segments, ok: true });
        });
        ff.on('error', (e) => finish({ text: '', segments: [], ok: false, error: e.message }));
    });
}

/** Backward-compatible plain-text transcription of a WAV. */
async function transcribeWav(wavPath, opts = {}) {
    const r = await transcribeWavDetailed(wavPath, opts);
    return r.text;
}

/**
 * Extract audio from ANY media (local file OR http(s) URL) → temp wav → detailed
 * transcription. @returns {Promise<{text, segments}>}
 */
function transcribeMediaDetailed(mediaPath, { seconds = 0, offsetSec = 0, timeoutMs = 300000 } = {}) {
    return new Promise((resolve) => {
        const isUrl = /^https?:/i.test(mediaPath || '');
        if (!available() || !mediaPath || (!isUrl && !fs.existsSync(mediaPath))) return resolve({ text: '', segments: [], ok: false, error: 'source unavailable' });
        const wav = path.join(os.tmpdir(), `openvibe-tx-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
        const args = ['-y', '-i', mediaPath];
        if (seconds > 0) args.push('-t', String(seconds));
        args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav);
        let ff;
        try { ff = _track(spawn('ffmpeg', args, { stdio: 'ignore' })); }
        catch (e) { return resolve({ text: '', segments: [], ok: false, error: e.message }); }
        const cleanup = () => { try { fs.existsSync(wav) && fs.unlinkSync(wav); } catch { /* */ } };
        const ffTimer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
        ff.on('close', async (code) => {
            clearTimeout(ffTimer);
            if (code !== 0) { cleanup(); return resolve({ text: '', segments: [], ok: false, error: `ffmpeg exited ${code}` }); }
            let r = { text: '', segments: [], ok: false, error: 'unknown' };
            try { r = await transcribeWavDetailed(wav, { timeoutMs, offsetSec }); } catch (e) { r = { text: '', segments: [], ok: false, error: e.message }; }
            cleanup();
            resolve(r);
        });
        ff.on('error', (e) => { clearTimeout(ffTimer); cleanup(); resolve({ text: '', segments: [], ok: false, error: e.message }); });
    });
}

/** Backward-compatible plain-text transcription of a media file/URL. */
async function transcribeMedia(mediaPath, opts = {}) {
    const r = await transcribeMediaDetailed(mediaPath, opts);
    return r.text;
}

/**
 * Detailed transcription of a 16kHz mono WAV, serialised against every other caller.
 * The slot is held for the whole decode and always released, including on throw.
 */
async function transcribeWavDetailed(wavPath, opts = {}) {
    const lane = opts && opts.live ? 'live' : 'batch';
    await _acquire(lane);
    try { return await _transcribeWavInner(wavPath, opts); }
    finally { _release(lane); }
}

/** Human-readable availability report (logged at boot so a broken install is visible). */
function describe() {
    const bin = whisperBin();
    return {
        available: available(),
        bin: bin || null,
        model: MODEL, modelExists: fs.existsSync(MODEL),
        modelLive: MODEL_LIVE, modelLiveExists: fs.existsSync(MODEL_LIVE),
        vadModel: vadModel() || null,
        threads: THREADS, beam: BEAM, maxConcurrent: MAX_CONCURRENT,
    };
}

module.exports = { available, describe, laneStatus, transcribeWav, transcribeWavDetailed, transcribeMedia, transcribeMediaDetailed, killActive, setLowPower };
