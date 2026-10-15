'use strict';
// A VOD transcript that stopped at a window OpenVibe.AI could not do yet (its whisper down) is retried later from that
// window, never stored with a hole in it; only the last attempt keeps what came before the gap. Stubs only (no
// database, no AI): the transcript pass's db calls and media-analysis.transcribeOnly are replaced on their modules.
//   node test/transcript-partial.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
console.warn = () => {};
const db = require('../server/db/database');
const ma = require('../server/ai/media-analysis');
const tx = require('../server/ai/transcribe');
const aiAnalysis = require('../server/ai/ai-analysis');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-txp-'));
const file = path.join(tmp, 'rec.mp4');
fs.writeFileSync(file, 'x');

const calls = [];
let attempts = 0;
Object.assign(db, {
    getSetting: async () => undefined,
    getLiveStreams: async () => [],
    getVodTranscriptProgress: async () => ({ progressSec: 0, segments: [] }),
    saveVodTranscriptProgress: async () => {},
    bumpVodTranscriptAttempt: async () => ++attempts,
    setVodTranscriptStatus: async (id, status, error, delay) => { calls.push(['status', status, error || null, delay || 0]); },
    setVodTranscript: async (id, text) => { calls.push(['transcript', text]); },
});
tx.available = () => true;
const partial = { text: 'words at 0', segments: [{ start: 1, end: 2, text: 'words at 0' }], ok: false, partial: true, stoppedAtSec: 300, error: 'provider.unavailable' };
ma.transcribeOnly = async () => partial;

(async () => {
    try {
        const vod = { id: 42, file_path: file };
        await aiAnalysis.generateVodTranscript(vod);
        assert.deepStrictEqual(calls.filter((c) => c[0] !== 'status' || c[1] !== 'processing'), [['status', 'retry', 'provider.unavailable', 1]],
            'stopped at a window: retried later, nothing stored');

        calls.length = 0;
        attempts = 7;                                     // the next one is the last (MAX_TX_ATTEMPTS = 8)
        await aiAnalysis.generateVodTranscript(vod);
        assert.deepStrictEqual(calls.filter((c) => c[1] !== 'processing'), [['transcript', 'words at 0'], ['status', 'done', 'transcribed up to 5 min: provider.unavailable', 0]],
            'the last attempt keeps what came before the gap and says where it stops');

        calls.length = 0;
        attempts = 7;
        ma.transcribeOnly = async () => ({ ...partial, text: '', segments: [] });
        await aiAnalysis.generateVodTranscript(vod);
        assert.deepStrictEqual(calls.filter((c) => c[1] !== 'processing'), [['status', 'failed', 'provider.unavailable', 360]], 'nothing at all after the last attempt: failed');

        calls.length = 0;
        attempts = 0;
        ma.transcribeOnly = async () => ({ text: 'all of it', segments: [{ start: 1, end: 2, text: 'all of it' }], ok: true, error: null });
        await aiAnalysis.generateVodTranscript(vod);
        assert.deepStrictEqual(calls.filter((c) => c[1] !== 'processing'), [['transcript', 'all of it'], ['status', 'done', null, 0]], 'a whole transcript is stored as before');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('transcript partial: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
