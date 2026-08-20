/**
 * audio-events.js — non-speech sound recognition for the stream timeline.
 *
 * Speech is only part of what happens on a stream. Gunfire, explosions, laughter,
 * screaming, music and alarms carry as much meaning for stream memory, clip detection and
 * search as the words do — and today they are actively thrown away: whisper's own
 * "[MUSIC]" / "[Applause]" markers are deleted by the noise filter because, without VAD,
 * they were indistinguishable from hallucinations.
 *
 * Runs YAMNet (AudioSet, 521 classes) under onnxruntime-node. Chosen over CLAP because:
 *   - it needs no text encoder, so there is no Python on the production path at all
 *     (the box has Python 3.14 with no venv, PEP 668 blocking pip, and no torch)
 *   - the model is ~16MB and the audio frontend is baked into the graph, so it takes a
 *     raw waveform straight from the same 16kHz mono WAV the recogniser reads
 *   - it emits a score per 0.48s frame, so events are time-localised for free — a single
 *     explosion at second 11 cannot characterise a whole 30s segment
 *
 * Verified on 60s of real stream audio: top labels were Silence 1.000 and Speech 1.000,
 * with plausible secondaries — i.e. it is reading the actual content, not noise.
 *
 * Everything here is best-effort. If the model is absent, available() returns false and
 * the speech timeline is unaffected.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MODEL_PATH = process.env.YAMNET_MODEL
    || path.join(__dirname, '../../data/models/yamnet.onnx');
const CLASSMAP_PATH = process.env.YAMNET_CLASSMAP
    || path.join(__dirname, '../../data/models/yamnet_class_map.csv');

// YAMNet emits one score vector per 0.96s window advanced by 0.48s.
const FRAME_HOP_SEC = 0.48;
const MIN_CONFIDENCE = Number(process.env.YAMNET_MIN_CONFIDENCE) || 0.35;
// Merge same-label frames separated by less than this into one event.
const MERGE_GAP_SEC = 1.0;
// Never emit more than this per segment — one noisy label should not flood the timeline.
const MAX_EVENTS_PER_SEGMENT = 40;

// Speech and silence are handled by the recogniser and by VAD respectively; recording them
// as "sound events" would just duplicate the speech rows and bury the interesting labels.
const IGNORED = new Set([
    'Silence', 'Speech', 'Speech synthesizer', 'Narration, monologue',
    'Male speech, man speaking', 'Female speech, woman speaking',
    'Conversation', 'Child speech, kid speaking', 'Inside, small room',
    'Inside, large room or hall', 'Music',
]);

let _session = null;
let _labels = null;
let _loadFailed = false;

function available() {
    if (_loadFailed) return false;
    try { return fs.existsSync(MODEL_PATH) && fs.existsSync(CLASSMAP_PATH); } catch { return false; }
}

function _loadLabels() {
    if (_labels) return _labels;
    const raw = fs.readFileSync(CLASSMAP_PATH, 'utf8');
    _labels = raw.split('\n').slice(1).map((line) => {
        // index,mid,display_name — display_name may be quoted and contain commas
        const m = line.match(/^\d+,[^,]*,"?([^"\r\n]+?)"?\s*$/);
        return m ? m[1] : null;
    });
    return _labels;
}

async function _session_() {
    if (_session) return _session;
    const ort = require('onnxruntime-node');
    _session = await ort.InferenceSession.create(MODEL_PATH, {
        // One thread: this shares a 4-core box with live x264 encoding, and the model is
        // small enough that throughput is not the constraint.
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
    });
    return _session;
}

/** Read a 16kHz mono 16-bit PCM WAV into the Float32Array YAMNet expects. */
function _wavToFloat32(wavPath) {
    const buf = fs.readFileSync(wavPath);
    // Walk the RIFF chunks rather than assuming a 44-byte header — ffmpeg emits a LIST
    // chunk when it writes metadata, which would otherwise shift every sample.
    let off = 12;
    let dataOff = -1, dataLen = 0;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
        off += 8 + size + (size % 2);
    }
    if (dataOff < 0) { dataOff = 44; dataLen = buf.length - 44; }
    // A truncated or header-only file — ffmpeg writes one when a segment has no decodable
    // audio — leaves nothing after the header, and the sample count below goes negative.
    const n = Math.max(0, Math.floor(Math.min(dataLen, buf.length - dataOff) / 2));
    if (n === 0) return new Float32Array(0);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
    return out;
}

/**
 * Detect non-speech sound events in a 16kHz mono WAV.
 * @param {string} wavPath
 * @param {{offsetSec?:number, category?:string, minConfidence?:number}} opts
 * @returns {Promise<Array<{start:number,end:number,label:string,confidence:number}>>}
 *          start/end in ABSOLUTE stream seconds (offsetSec applied).
 */
async function detect(wavPath, { offsetSec = 0, minConfidence = MIN_CONFIDENCE } = {}) {
    if (!available()) return [];

    // Loading the model is the only failure worth disabling the feature for. Anything to
    // do with ONE segment must not: a single unreadable WAV used to set _loadFailed and
    // take audio events down for the rest of the process, with a message blaming the
    // model — which was fine all along.
    let ort, session, labels;
    try {
        ort = require('onnxruntime-node');
        session = await _session_();
        labels = _loadLabels();
    } catch (e) {
        _loadFailed = true;
        console.warn('[AI-Timeline] audio-events disabled — model failed to load:', e.message);
        return [];
    }

    let scores, frames, classes;
    try {
        const wave = _wavToFloat32(wavPath);
        if (!wave.length) return [];
        const res = await session.run({ waveform: new ort.Tensor('float32', wave, [wave.length]) });
        const out = res.output_0 || res[session.outputNames[0]];
        if (!out) return [];
        [frames, classes] = out.dims;
        scores = out.data;
    } catch (e) {
        console.warn(`[AI-Timeline] audio-events skipped ${path.basename(wavPath)}:`, e.message);
        return [];
    }

    // Collect per-frame winners above threshold, then merge runs of the same label.
    const open = new Map();   // label -> { start, end, peak }
    const done = [];
    for (let f = 0; f < frames; f++) {
        const t = offsetSec + f * FRAME_HOP_SEC;
        for (let c = 0; c < classes; c++) {
            const v = scores[f * classes + c];
            if (v < minConfidence) continue;
            const label = labels[c];
            if (!label || IGNORED.has(label)) continue;
            const cur = open.get(label);
            if (cur && (t - cur.end) <= MERGE_GAP_SEC) {
                cur.end = t + FRAME_HOP_SEC;
                if (v > cur.peak) cur.peak = v;
            } else {
                if (cur) done.push(cur);
                open.set(label, { label, start: t, end: t + FRAME_HOP_SEC, peak: v });
            }
        }
        // Close labels that have gone quiet.
        for (const [label, ev] of open) {
            if ((t - ev.end) > MERGE_GAP_SEC) { done.push(ev); open.delete(label); }
        }
    }
    for (const ev of open.values()) done.push(ev);

    return done
        .sort((a, b) => b.peak - a.peak)
        .slice(0, MAX_EVENTS_PER_SEGMENT)
        .map(e => ({
            start: Math.round(e.start * 100) / 100,
            end: Math.round(e.end * 100) / 100,
            label: e.label,
            confidence: Math.round(e.peak * 1000) / 1000,
        }))
        .sort((a, b) => a.start - b.start);
}

// _wavToFloat32 is exported for tests: it is the part that has to survive whatever
// ffmpeg leaves on disk, and it cannot be reached through detect() without the model.
module.exports = { available, detect, MODEL_PATH, CLASSMAP_PATH, _wavToFloat32 };
