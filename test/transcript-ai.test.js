'use strict';
// VOD and clip transcripts run on OpenVibe.AI (roadmap WS-O task 2): against a stub Network and a stub AI, a Media
// recording (a URL) is transcribed by live.media.transcribe one 5-minute window at a time. Each run has media_url,
// start_sec and seconds; low_power follows the backfill's live-stream state; timestamps are kept as AI gives them.
// A resumed pass skips finished windows; a failed window is reported, not fatal; local whisper is not touched.
// Needs ffmpeg/ffprobe (it makes a 10-minute test recording); skipped without them.
//   node test/transcript-ai.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { serviceAuth } = require('openvibe-contracts');

if (spawnSync('ffprobe', ['-version']).status !== 0 || spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('transcript via AI: skipped (no ffmpeg/ffprobe)');
    process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-tx-ai-'));
process.env.NODE_ENV = 'test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
console.warn = () => {};
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const rec = path.join(tmp, 'rec.m4a');
spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=610', '-c:a', 'aac', '-b:a', '16k', rec]);
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const runs = [];
let failAt = null;
const network = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const f = new URLSearchParams(raw); const now = Math.floor(Date.now() / 1000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: [f.get('audience')], cap: ['ai.run.create', 'ai.run.read'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey), token_type: 'Bearer', expires_in: 300 }));
    });
});
const ai = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        runs.push(body);
        res.setHeader('Content-Type', 'application/json');
        const s = body.input.start_sec;
        if (s === failAt) { res.statusCode = 201; return res.end(JSON.stringify({ run: { id: 'run_x', status: 'failed', error: { code: 'provider.error' } } })); }
        res.statusCode = 201;
        res.end(JSON.stringify({ run: { id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPA', status: 'succeeded', synthetic: false, workflow: { key: body.workflow }, output: { text: `words at ${s}`, language: 'en', segments: [{ start: s + 1.5, end: s + 4, text: `words at ${s}` }] }, usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0 } } }));
    });
});
const media = http.createServer((req, res) => {
    const buf = fs.readFileSync(rec);
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) { const a = Number(m[1]); const b = m[2] ? Number(m[2]) : buf.length - 1; res.writeHead(206, { 'Content-Type': 'audio/mp4', 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' }); return res.end(buf.subarray(a, b + 1)); }
    res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' }); res.end(buf);
});

(async () => {
    for (const s of [network, ai, media]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;
    process.env.OV_AI_INTERNAL_URL = `http://127.0.0.1:${ai.address().port}`;
    const url = `http://127.0.0.1:${media.address().port}/v/42`;
    const ma = require('../server/ai/media-analysis');
    const tx = require('../server/ai/transcribe');
    try {
        const progress = [];
        tx.setLowPower(true);
        let r = await ma.transcribeOnly(url, { onWindow: (sec, segs) => progress.push([sec, segs.length]) });
        assert.deepStrictEqual(runs.map((x) => [x.workflow, x.input.start_sec, x.input.seconds, x.input.low_power, x.input.media_url]), [
            ['live.media.transcribe', 0, 300, true, url], ['live.media.transcribe', 300, 300, true, url], ['live.media.transcribe', 600, 10, true, url],
        ]);
        assert.deepStrictEqual([r.ok, r.text, r.segments.map((g) => g.start)], [true, 'words at 0 words at 300 words at 600', [1.5, 301.5, 601.5]]);
        assert.deepStrictEqual(progress, [[300, 1], [600, 2], [610, 3]]);
        // Resume after a restart: finished windows are not run again.
        runs.length = 0; tx.setLowPower(false);
        r = await ma.transcribeOnly(url, { resumeFromSec: 600, priorSegments: [{ start: 1, end: 2, text: 'kept' }] });
        assert.deepStrictEqual(runs.map((x) => [x.input.start_sec, x.input.low_power]), [[600, false]]);
        assert.strictEqual(r.text, 'kept words at 600');
        // A failed window is reported; the others still count.
        runs.length = 0; failAt = 300;
        r = await ma.transcribeOnly(url);
        assert.deepStrictEqual([r.ok, r.segments.length], [true, 2]);
    } finally {
        for (const s of [network, ai, media]) s.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('transcript via AI: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
