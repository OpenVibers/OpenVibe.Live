'use strict';
// A clip trimmed in place (Media POST /clips/:id/trim, the clip editor's Save) keeps its id with a narrower window. Its
// clip.ready names the new window: Live's overview and transcript of the old window are cleared and media.analyze runs
// under a new idempotency key (a new AI run, not a replay of the first one); a clip.ready with the same window keeps
// them. An analysis still running for the old window when the trim's clip.ready lands stores nothing. A clip older than
// the recorded window (clip_ai_state.ai_window, migration 0012) gets it from its next clip.ready, or from the clip
// editor before a trim (seedOnly).
//
//   node test/clip-trim-ai-state.test.js
const assert = require('assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.LIVE_MEDIA_ANALYSIS = 'ai';
process.env.LIVE_MEDIA_ANALYSIS_WAIT_MS = '0';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const eventId = () => { const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let s = ''; for (let i = 0; i < 26; i++) s += A[crypto.randomInt(32)]; return `evt_${s}`; };

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const media = require('../server/media-client');
    media.signedMediaUrl = async (kind, id) => ({ url: `https://openvibe.media/${kind}/${id}?signature=test` });
    media.getClip = async (id) => ({ id, status: 'ready', user_id: 7 });
    const aiService = require('../server/ai/ai-service');
    const keys = [];
    let gate = null;
    aiService.run = async (workflow, input, opts) => {
        keys.push(opts.idempotencyKey);
        const n = keys.length;
        if (gate) await gate.promise;
        return { status: 'succeeded', output: {
            overview: { text: `Overview ${n}.` },
            transcript: { available: true, text: `Line ${n}.`, segments: [{ start: 0, end: 1, text: `Line ${n}.` }] },
            streams: { video: true, audio: true }, gaps: [],
        } };
    };
    const hold = () => { let release; const promise = new Promise((r) => { release = r; }); gate = { promise, release }; return gate; };
    const remote = require('../server/ai/ai-media-analyze');
    const realAnalyze = remote.analyze;
    let analyses = [];
    remote.analyze = (...a) => { const p = realAnalyze(...a); analyses.push(p); return p; };
    const settle = async () => { const all = analyses; analyses = []; await Promise.all(all); };
    const until = async (fn, what) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn(), what); };
    const outcomes = require('../server/media-proxy/outcomes');
    const ready = async (data) => { await outcomes.handle({ event: 'clip.ready', data: { user_id: 7, ...data }, eventId: eventId() }); };
    const state = async (id) => await db.getClipAiState(id);

    // ── A new clip: its window is recorded and it is analysed ──
    await ready({ id: 501, start_time: 5, end_time: 20 });
    await settle();
    let s = await state(501);
    assert.deepStrictEqual([s.ai_window, s.ai_overview, Number(s.transcript_attempts) || 0], ['5.0-20.0', 'Overview 1.', 0]);
    assert.ok(s.ai_transcript_json && JSON.parse(s.ai_transcript_json)[0].text === 'Line 1.');
    assert.strictEqual(keys[0], 'live.media.analyze:clip:501:0');

    // ── clip.ready again with the same window (a re-cut of the same footage): nothing is cleared ──
    await ready({ id: 501, start_time: 5, end_time: 20.04 });
    await settle();
    s = await state(501);
    assert.deepStrictEqual([s.ai_window, s.ai_overview], ['5.0-20.0', 'Overview 1.'], 'the same window keeps the overview');

    // ── Trimmed to 8-14 s: the old window's overview and transcript go, and the analysis is a new run ──
    const g = hold();
    await ready({ id: 501, start_time: 8, end_time: 14 });
    s = await state(501);
    assert.deepStrictEqual([s.ai_window, s.ai_overview, s.ai_overview_short, s.ai_transcript_json], ['8.0-14.0', null, null, null], 'cleared');
    assert.strictEqual(Number(s.transcript_attempts), 1, 'the attempt moved on');
    g.release(); gate = null;
    await settle();
    s = await state(501);
    assert.strictEqual(keys[keys.length - 1], 'live.media.analyze:clip:501:1', 'a key the first run never had');
    assert.strictEqual(s.ai_overview, `Overview ${keys.length}.`, 'the trimmed clip\'s own overview');
    assert.strictEqual(JSON.parse(s.ai_transcript_json)[0].text, `Line ${keys.length}.`);

    // ── An analysis of the old window still running when the trim lands stores nothing ──
    const g2 = hold();
    await ready({ id: 502, start_time: 0, end_time: 10 });
    const stale = analyses.slice();
    await until(() => keys[keys.length - 1] === 'live.media.analyze:clip:502:0', 'the first analysis is running');
    await ready({ id: 502, start_time: 2, end_time: 6 });   // its own analysis waits (one per clip at a time)
    g2.release(); gate = null;
    await Promise.all(stale); await settle();
    s = await state(502);
    assert.deepStrictEqual([s.ai_window, s.ai_overview, s.ai_transcript_json, s.transcript_status], ['2.0-6.0', null, null, 'pending'],
        'the old window\'s result is dropped and the clip waits for its own analysis');
    await remote.analyze('clip', { id: 502, user_id: 7 });   // the backfill's next tick
    s = await state(502);
    assert.strictEqual(keys[keys.length - 1], 'live.media.analyze:clip:502:1');
    assert.strictEqual(s.ai_overview, `Overview ${keys.length}.`);

    // ── A clip from before the window was recorded: its next clip.ready records it and keeps what it has ──
    await db.run("INSERT INTO clip_ai_state (clip_id, ai_overview, ai_overview_short, transcript_status) VALUES (503, 'Older', 'Older', 'done')");
    await ready({ id: 503, start_time: 0, end_time: 9 });
    await settle();
    s = await state(503);
    assert.deepStrictEqual([s.ai_window, s.ai_overview], ['0.0-9.0', 'Older'], 'recorded, nothing cleared');
    // …and the clip editor records it before a trim (seedOnly never clears, never overwrites a recorded window).
    await db.run("INSERT INTO clip_ai_state (clip_id, ai_overview, ai_overview_short) VALUES (504, 'Older', 'Older')");
    assert.strictEqual(await db.setClipAiWindow(504, db.clipAiWindow({ start_time: 0, end_time: 9 }), { seedOnly: true }), false);
    assert.strictEqual(await db.setClipAiWindow(504, '1.0-2.0', { seedOnly: true }), false);
    s = await state(504);
    assert.deepStrictEqual([s.ai_window, s.ai_overview], ['0.0-9.0', 'Older'], 'seeded once, overview kept');
    const g3 = hold();
    await ready({ id: 504, start_time: 3, end_time: 9 });
    s = await state(504);
    assert.deepStrictEqual([s.ai_window, s.ai_overview], ['3.0-9.0', null], 'the trim\'s clip.ready clears it');
    g3.release(); gate = null;
    await settle();

    // ── A clip.ready without a window (nothing to compare) changes nothing ──
    await ready({ id: 501 });
    await settle();
    assert.strictEqual((await state(501)).ai_window, '8.0-14.0');
    assert.strictEqual(db.clipAiWindow({ start_time: 4, end_time: 4 }), null, 'an empty window is no window');

    quiet('clip trim AI state: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
