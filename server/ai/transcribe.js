/**
 * transcribe.js — free, LOCAL speech-to-text (no API, runs on the server CPU). Used for
 * live-stream memories, the live timeline (which The Rundown reads) and VOD/clip transcripts.
 *
 * Two engines, both from the whisper.cpp tree (ggml):
 *   - NVIDIA Parakeet TDT 0.6B v3 (`parakeet-cli`), for English and 24 other European languages.
 *     Measured 2026-10-16 on 2 min of real stream talk on this 4-core box: 394 words in 31 s,
 *     punctuated, where whisper base.en (the old live model) caught 327 words in 15 s and dropped
 *     whole sentences ("they put in" → "the Putin"), and large-v3-turbo needed 121 s (1x real time,
 *     too slow for live). A 10 s live segment decodes in 2.5 s on 2 threads, like base.en did. Audio longer than 45 s
 *     (VOD windows) is decoded in 30 s pieces: one 300 s piece needed 3.1 GB.
 *   - whisper.cpp, for every other language (Japanese, Korean, Chinese…) and as the fallback when
 *     Parakeet is not installed. ASR_ENGINE=whisper forces it everywhere.
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
// Multilingual ggml for non-English streamers. The default *.en models can only ever emit
// English — which is how a Japanese streamer's audio became hours of nonsense in the
// timeline. Install e.g. ggml-base.bin / ggml-small.bin (no ".en") and point
// WHISPER_MODEL_MULTI at it; until then non-English channels fall back to the English model.
const MODEL_MULTI = process.env.WHISPER_MODEL_MULTI || path.join(HOME, 'whisper.cpp/models/ggml-base.bin');
function multilingualModel() { try { return fs.existsSync(MODEL_MULTI) ? MODEL_MULTI : null; } catch { return null; } }
let _warnedNoMulti = false;
function _modelFor(opts) {
    if (opts && opts.language && opts.language !== 'en') {
        const mm = multilingualModel();
        if (mm) return mm;
        if (!_warnedNoMulti) { _warnedNoMulti = true; console.warn(`[Transcribe] language "${opts.language}" requested but no multilingual model at ${MODEL_MULTI} — using the English model (set WHISPER_MODEL_MULTI)`); }
    }
    const m = (opts && opts.live) ? MODEL_LIVE : MODEL;
    try { return fs.existsSync(m) ? m : MODEL; } catch { return MODEL; }
}
const THREADS = Math.max(2, Math.min(8, parseInt(process.env.WHISPER_THREADS, 10) || 4));

// ── Parakeet (NVIDIA Parakeet TDT, ggml, from the same whisper.cpp build) ──
const PARAKEET_BIN = process.env.PARAKEET_BIN || path.join(HOME, 'whisper.cpp/build/bin/parakeet-cli');
const PARAKEET_MODEL = process.env.PARAKEET_MODEL || path.join(HOME, 'whisper.cpp/models/ggml-parakeet-tdt-0.6b-v3-q8_0.bin');
// Parakeet TDT 0.6B v3's languages (NVIDIA's model card): every other language goes to whisper.
const PARAKEET_LANGS = new Set(['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk']);
function parakeetAvailable() {
    if (process.env.ASR_ENGINE === 'whisper') return false;
    try { return fs.existsSync(PARAKEET_BIN) && fs.existsSync(PARAKEET_MODEL); } catch { return false; }
}
/** The engine a decode in `language` uses: 'parakeet' or 'whisper'. */
function engineFor(language = 'en') {
    return parakeetAvailable() && PARAKEET_LANGS.has(String(language || 'en').slice(0, 2).toLowerCase()) ? 'parakeet' : 'whisper';
}

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
    if (parakeetAvailable()) return true;
    try { return !!whisperBin() && fs.existsSync(MODEL); } catch { return false; }
}
function whisperAvailable() {
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
// ── Parakeet output → timed sentences ──────────────────────────────────────
// `parakeet-cli -ps` prints every token on stderr with its start and end in centiseconds and whether it starts a
// word ("▁For"). A sentence ends at . ? or !, at a pause of 1.5 s, or after 20 s, so each timeline row stays a
// line someone said, deep-linkable by its start.
const TOKEN_LINE = /t0=\s*(-?\d+)\s+t1=\s*(-?\d+)\s+word_start=(true|false)\s+"(.*)"\s*$/;
// Fillers Parakeet writes out ("uh", "um") carry nothing for a reader or The Rundown's quotes.
const FILLER_RE = /(^|[\s,])(?:uh+|um+|uhm|erm|mm+)(?=[\s,.!?]|$)[,]?/gi;
function parseParakeet(stderr, offsetSec = 0) {
    const out = [];
    let cur = null;
    const close = () => {
        if (!cur) return;
        const text = cur.text.replace(FILLER_RE, '$1').replace(/\s+([,.!?])/g, '$1').replace(/\s+/g, ' ').replace(/^[,\s]+/, '').trim();
        if (text) out.push({ start: offsetSec + cur.t0 / 100, end: offsetSec + cur.t1 / 100, text });
        cur = null;
    };
    for (const line of String(stderr || '').split('\n')) {
        const m = TOKEN_LINE.exec(line);
        if (!m) continue;
        const t0 = Number(m[1]), t1 = Number(m[2]);
        const wordStart = m[3] === 'true';
        const raw = m[4];
        if (/^<.*>$/.test(raw)) continue;                      // <unk>, <|…|> control tokens
        const piece = raw.replace(/\u2581/g, ' ');
        if (cur && wordStart && (t0 - cur.t1 > 150 || t0 - cur.t0 > 2000)) close();
        if (!cur) cur = { t0, t1, text: '' };
        cur.text += wordStart && !piece.startsWith(' ') ? ` ${piece}` : piece;
        cur.t1 = Math.max(cur.t1, t1);
        if (/[.!?]["')\]]?$/.test(piece.trim())) close();
    }
    close();
    return out;
}

// Parakeet's memory and time grow faster than the audio: measured on this box, 10 s took 0.74 GB, 60 s 1.1 GB and a
// 300 s VOD window 3.1 GB in 154 s. Anything longer than CHUNK_MAX_SEC is cut into CHUNK_SEC pieces (PCM, cut exactly,
// so each piece's times only shift by its start) and decoded one after another.
const CHUNK_SEC = 30;
const CHUNK_MAX_SEC = 45;
function wavSeconds(wavPath) {
    try { return Math.max(0, (fs.statSync(wavPath).size - 44) / 32000); } catch { return 0; }   // 16 kHz mono s16le
}
function _splitWav(wavPath, dir) {
    return new Promise((resolve) => {
        let ff;
        try { ff = _track(spawn('nice', ['-n', '15', 'ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-i', wavPath, '-f', 'segment', '-segment_time', String(CHUNK_SEC), '-c', 'copy', path.join(dir, 'p%04d.wav')], { stdio: 'ignore' })); }
        catch { return resolve(null); }
        ff.on('close', (code) => {
            if (code !== 0) return resolve(null);
            try { resolve(fs.readdirSync(dir).filter((n) => /^p\d{4}\.wav$/.test(n)).sort().map((n) => path.join(dir, n))); } catch { resolve(null); }
        });
        ff.on('error', () => resolve(null));
    });
}
async function _parakeetInner(wavPath, opts = {}) {
    if (!wavPath || wavSeconds(wavPath) <= CHUNK_MAX_SEC) return await _parakeetOnce(wavPath, opts);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-pk-'));
    try {
        const pieces = await _splitWav(wavPath, dir);
        if (!pieces || !pieces.length) return { text: '', segments: [], ok: false, error: 'could not split the audio' };
        const segments = [];
        const deadline = Date.now() + (opts.timeoutMs || 180000);
        for (let i = 0; i < pieces.length; i++) {
            const left = deadline - Date.now();
            if (left <= 0) return { text: '', segments: [], ok: false, error: 'timeout' };
            const r = await _parakeetOnce(pieces[i], { ...opts, timeoutMs: left, offsetSec: (opts.offsetSec || 0) + i * CHUNK_SEC });
            if (!r.ok) return r;
            segments.push(...r.segments);
        }
        return { text: _joinSegments(segments), segments, ok: true, engine: 'parakeet' };
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
}

function _parakeetOnce(wavPath, { timeoutMs = 180000, offsetSec = 0, live = false } = {}) {
    return new Promise((resolve) => {
        if (!parakeetAvailable() || !wavPath || !fs.existsSync(wavPath)) return resolve({ text: '', segments: [], ok: false, error: 'parakeet unavailable' });
        const args = ['-t', String(_threads(live)), '-ps', '-np', '-m', PARAKEET_MODEL, '-f', wavPath];
        let ff;
        try { ff = _track(spawn('nice', ['-n', '15', PARAKEET_BIN, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })); }
        catch (e) { return resolve({ text: '', segments: [], ok: false, error: e.message }); }
        const chunks = [];
        let size = 0;
        ff.stderr.on('data', (d) => { if (size < 64 * 1024 * 1024) { chunks.push(d); size += d.length; } });
        let done = false;
        const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } finish({ text: '', segments: [], ok: false, error: 'timeout' }); }, timeoutMs);
        ff.on('close', (code) => {
            if (code !== 0) return finish({ text: '', segments: [], ok: false, error: `parakeet exited ${code}` });
            const segments = _cleanSegments(parseParakeet(Buffer.concat(chunks).toString('utf8'), offsetSec));
            finish({ text: _joinSegments(segments), segments, ok: true, engine: 'parakeet' });
        });
        ff.on('error', (e) => finish({ text: '', segments: [], ok: false, error: e.message }));
    });
}

// Inner implementation. Wrapped by transcribeWavDetailed, which holds the concurrency
// slot for the whole run so only MAX_CONCURRENT decoders exist at any moment.
function _transcribeWavInner(wavPath, { timeoutMs = 180000, offsetSec = 0, live = false, language = 'en' } = {}) {
    return new Promise((resolve) => {
        const bin = whisperBin();
        // ok=false only for genuine FAILURES (missing binary, spawn/exec error, timeout,
        // non-zero exit, unparseable output). A clean run that finds no speech is ok=true
        // with empty text — the caller must NOT treat that as a failure to retry.
        if (!bin || !whisperAvailable() || !wavPath || !fs.existsSync(wavPath)) {
            return resolve({ text: '', segments: [], ok: false, error: 'whisper unavailable' });
        }
        const outBase = `${wavPath}.out`;
        const jsonPath = `${outBase}.json`;
        // Decode in the channel's language when a multilingual model is installed; else English.
        const lang = (language && language !== 'en' && multilingualModel()) ? String(language) : 'en';
        const args = ['-m', _modelFor({ live, language: lang }), '-f', wavPath, '-oj', '-of', outBase, '-t', String(_threads(live)), '-l', lang];
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
    try {
        if (engineFor(opts && opts.language) === 'parakeet') {
            const r = await _parakeetInner(wavPath, opts);
            // A Parakeet failure (a crash, a bad model file) must not leave a hole: whisper takes the same audio.
            if (r.ok || !whisperAvailable()) return r;
            console.warn(`[Transcribe] parakeet failed (${r.error}); whisper takes this audio`);
        }
        return await _transcribeWavInner(wavPath, opts);
    } finally { _release(lane); }
}

/** Human-readable availability report (logged at boot so a broken install is visible). */
function describe() {
    const bin = whisperBin();
    return {
        available: available(),
        bin: bin || null,
        model: MODEL, modelExists: fs.existsSync(MODEL),
        modelLive: MODEL_LIVE, modelLiveExists: fs.existsSync(MODEL_LIVE),        modelMulti: MODEL_MULTI, modelMultiExists: !!multilingualModel(),
        vadModel: vadModel() || null,
        parakeet: parakeetAvailable() ? PARAKEET_MODEL : null, engineEn: engineFor('en'),
        threads: THREADS, beam: BEAM, maxConcurrent: MAX_CONCURRENT,
    };
}

function isLowPower() { return _lowPower; }

module.exports = { available, describe, engineFor, parseParakeet, laneStatus, multilingualModel, transcribeWav, transcribeWavDetailed, transcribeMedia, transcribeMediaDetailed, killActive, setLowPower, isLowPower };
