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
const THREADS = Math.max(2, Math.min(8, parseInt(process.env.WHISPER_THREADS, 10) || 4));
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
// While a stream is live we lower the whisper thread count so VOD transcription can
// still make progress without starving the live encoders.
let _lowPower = false;
function setLowPower(v) { _lowPower = !!v; }
function _threads() { return _lowPower ? Math.max(1, Math.min(2, THREADS)) : THREADS; }

// Phrases whisper commonly hallucinates over silence / music / non-speech.
const HALLUCINATIONS = new Set([
    'you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
    'thanks for watching.', 'please subscribe', 'subscribe', 'like and subscribe',
    'bye', 'bye.', 'bye bye', 'okay', 'ok', 'oh', 'uh', 'um', 'hmm', 'mm', 'mhm',
    'the', 'so', 'yeah', '.', '...', 'thank you for watching', 'thank you very much',
    'thank you so much', 'i\'m sorry', 'silence', 'music', 'applause',
]);
function _isNoise(t) {
    const s = (t || '').replace(/\s+/g, ' ').trim();
    if (!s) return true;
    // bracketed/parenthetical cues, music notes, or pure punctuation
    if (/^[\s.\-–—_*]+$/.test(s)) return true;
    if (/^[\[(♪].*[\])♪]?$/.test(s)) return true;
    if (/^♪/.test(s) || /♪$/.test(s)) return true;
    const norm = s.toLowerCase().replace(/[.!?,…]+$/g, '').trim();
    return HALLUCINATIONS.has(norm);
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
function transcribeWavDetailed(wavPath, { timeoutMs = 180000, offsetSec = 0 } = {}) {
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
        const args = ['-m', MODEL, '-f', wavPath, '-oj', '-of', outBase, '-t', String(_threads()), '-l', 'en'];
        if (BEAM > 1) args.push('-bs', String(BEAM));
        let ff;
        try { ff = _track(spawn(bin, args, { stdio: 'ignore' })); }
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

module.exports = { available, transcribeWav, transcribeWavDetailed, transcribeMedia, transcribeMediaDetailed, killActive, setLowPower };
