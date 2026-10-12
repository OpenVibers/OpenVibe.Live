'use strict';
const assert = require('assert');
const http = require('http');
const db = require('../server/db/database');
const media = require('../server/media-client');
const principal = require('../server/net/network-principal');
const local = require('../server/ai/ai-analysis');
const remote = require('../server/ai/ai-media-analyze');
const backfill = require('../server/ai/backfill-job');

process.env.LIVE_MEDIA_ANALYSIS = 'ai';
let calls = [];
let refuse = false;
let stillRunning = false;
function answer(body) {
    calls.push(body);
    if (refuse) return { status: 503, body: { code: 'media.no_space', detail: 'disk is full' } };
    if (stillRunning) return { status: 202, body: { run: { id: `run_${calls.length}`, status: 'running' } } };
    return { status: 201, body: { run: {
        id: `run_${calls.length}`, status: 'succeeded', synthetic: false,
        output: {
            overview: { text: 'A creator explains the project. Then the stream ends.', source: 'local_model' },
            transcript: { available: true, language: 'en', text: 'Welcome everyone.', segments: [
                { start: 1.25, end: 2.8, text: 'Welcome' },
                { start: 2.9, end: 4.1, text: 'everyone.' },
            ] },
            streams: { video: true, audio: true },
            highlights: [{ start: 1, end: 5, score: 2, reasons: ['speech'], excerpt: 'Welcome everyone.' }],
            scenes: [], signals: {}, gaps: [], duration_seconds: 30, analyzed_seconds: 30, speech_ratio: 0.1,
        },
    } } };
}
const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
        const result = answer(raw ? JSON.parse(raw) : { poll: req.url });
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = result.status;
        res.end(JSON.stringify(result.body));
    });
});

(async () => {
    await db.initDb();
    const originalFetch = global.fetch;
    let listening = false;
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        listening = true;
    } catch (e) {
        if (e.code !== 'EPERM') throw e;
        // Some sandboxes forbid listening sockets. Exercise the same fake AI
        // response through fetch while preserving the normal HTTP server path.
        global.fetch = async (url, opts) => {
            const result = answer(JSON.parse(opts.body));
            return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
        };
    }
    process.env.OV_AI_INTERNAL_URL = listening ? `http://127.0.0.1:${server.address().port}` : 'http://127.0.0.1:4700';
    principal.serviceHeaders = async () => ({ Authorization: 'Bearer test-service-token' });
    media.signedMediaUrl = async (kind, id) => ({ url: `https://openvibe.media/${kind}/${id}?signature=test` });
    media.getVod = async id => ({ id, status: 'ready', user_id: 7, duration_seconds: 30 });
    media.getClip = async id => ({ id, status: 'ready', user_id: 7, duration_seconds: 30 });
    let localCalls = 0;
    local.transcriptionEnabled = async () => { localCalls++; return true; };
    local.generateVodTranscript = async () => { localCalls++; throw new Error('local VOD transcription started'); };
    local.generateClipTranscript = async () => { localCalls++; throw new Error('local clip transcription started'); };
    local.generateVodOverview = async () => { localCalls++; throw new Error('local VOD overview started'); };
    local.generateClipOverview = async () => { localCalls++; throw new Error('local clip overview started'); };
    local.isEnabled = async () => true;
    local.pasteAnalysisEnabled = async () => false;
    try {
        await db.run('INSERT INTO vod_ai_state (vod_id) VALUES (801)');
        await db.run('INSERT INTO clip_ai_state (clip_id, clip_notified) VALUES (901, 1)');
        await backfill.tick();
        assert.deepStrictEqual(calls.map(c => c.workflow), ['media.analyze', 'media.analyze']);
        assert.deepStrictEqual(calls.map(c => c.input.media_url), [
            'https://openvibe.media/vod/801?signature=test', 'https://openvibe.media/clip/901?signature=test',
        ]);
        assert.ok(calls.every(c => c.input.allow_paid === false && c.input.language === 'en'));
        const vod = await db.getVodAiState(801);
        const clip = await db.getClipAiState(901);
        assert.strictEqual(clip.clip_notified, 1, 'unmapped clip state survives analysis');
        for (const state of [vod, clip]) {
            assert.strictEqual(state.ai_overview, 'A creator explains the project. Then the stream ends.');
            assert.ok(state.ai_overview_short);
            assert.deepStrictEqual(JSON.parse(state.ai_transcript_json), [
                { start: 1.25, end: 2.8, text: 'Welcome' }, { start: 2.9, end: 4.1, text: 'everyone.' },
            ]);
            assert.strictEqual(state.transcript_status, 'done');
        }
        assert.strictEqual(localCalls, 0);

        await db.run("INSERT INTO vod_ai_state (vod_id, ai_overview, ai_overview_short) VALUES (802, 'Existing', 'Existing')");
        refuse = true;
        const before = remote.stats().failures;
        await backfill.tick();
        const failed = await db.getVodAiState(802);
        assert.strictEqual(failed.ai_overview, 'Existing');
        assert.strictEqual(failed.ai_overview_short, 'Existing');
        assert.strictEqual(failed.ai_transcript_json, null);
        assert.strictEqual(failed.transcript_status, 'retry');
        assert.ok(failed.transcript_next_at);
        assert.strictEqual(remote.stats().failures, before + 1);
        const attempted = calls.length;
        await backfill.tick();
        assert.strictEqual(calls.length, attempted, 'backoff prevents an immediate retry');
        assert.strictEqual(localCalls, 0, 'AI failure never starts the local path');

        // An overview Live already has is kept: AI's fills only a missing one (the transcript still lands).
        refuse = false;
        await db.run("INSERT INTO vod_ai_state (vod_id, ai_overview, ai_overview_short) VALUES (803, 'A model overview', 'A model overview')");
        await backfill.tick();
        const kept = await db.getVodAiState(803);
        assert.strictEqual(kept.ai_overview, 'A model overview', 'never replaced by AI\'s');
        assert.ok(kept.ai_transcript_json && JSON.parse(kept.ai_transcript_json).length === 2, 'the transcript landed');
        assert.strictEqual(calls[calls.length - 1].idempotency_key, 'live.media.analyze:vod:803:0', 'one AI run per attempt');

        // A run still going when the poll budget ends is re-joined later by the same key, not counted as a failure.
        stillRunning = true;
        process.env.LIVE_MEDIA_ANALYSIS_WAIT_MS = '0';
        await db.run('INSERT INTO vod_ai_state (vod_id) VALUES (804)');
        const failuresBefore = remote.stats().failures;
        const vod804 = { id: 804, status: 'ready', user_id: 7, duration_seconds: 30 };
        await remote.analyze('vod', vod804);
        const pending = await db.getVodAiState(804);
        assert.strictEqual(pending.transcript_status, 'retry');
        assert.strictEqual(Number(pending.transcript_attempts) || 0, 0, 'no attempt counted while AI is still working');
        assert.strictEqual(remote.stats().failures, failuresBefore, 'not a failure');
        stillRunning = false;
        await remote.analyze('vod', vod804);
        assert.strictEqual(calls[calls.length - 1].idempotency_key, calls[calls.length - 2].idempotency_key, 'the same key re-joins the run');
        assert.strictEqual((await db.getVodAiState(804)).transcript_status, 'done');
        delete process.env.LIVE_MEDIA_ANALYSIS_WAIT_MS;

        await db.run("INSERT INTO clip_ai_state (clip_id, ai_overview, ai_overview_short) VALUES (902, 'Kept clip', 'Kept clip')");
        global.fetch = async () => { throw new Error('AI connection refused'); };
        await backfill.tick();
        const down = await db.getClipAiState(902);
        assert.strictEqual(down.ai_overview, 'Kept clip');
        assert.strictEqual(down.ai_overview_short, 'Kept clip');
        assert.strictEqual(down.transcript_status, 'retry');
        assert.ok(down.transcript_next_at);
        assert.strictEqual(remote.stats().failures, before + 2);
        assert.strictEqual(localCalls, 0);

        delete process.env.LIVE_MEDIA_ANALYSIS;
        assert.strictEqual(remote.enabled(), false, 'default remains local');
        console.log('AI media analyze: VOD, clip, retry, and default mode passed');
    } finally {
        global.fetch = originalFetch;
        if (listening) server.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
