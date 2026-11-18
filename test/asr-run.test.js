'use strict';
// Live speech-to-text on the shared node (server/ai/asr-run.js, plan §AD.21b item 6): a live segment's WAV goes to
// OpenVibe.Run as an openvibe-asr job for the operator in their project, and parakeet-cli's output comes back for
// transcribe.js to parse as a local run's. Any failure answers { ok: false } (the caller decodes here) and keeps the
// next five minutes local. A fake Run and a fake token client stand in.
//   node test/asr-run.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56';
const PROJECT = 'prj_01M7A6T4Y2ZNWTMM8VR6HW5T17';
const ENV = { ASR_RUN_URL: 'http://127.0.0.1:4920', ASR_RUN_SUBJECT: SUBJECT, ASR_RUN_PROJECT: PROJECT };
const TOKEN_LINE = '  [ 0] id=    1 frame=  0 dur_idx= 1 dur_val= 1 p=0.9 plog=-1 t0= 100 t1= 150 word_start=true "▁Hello."';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-asr-run-'));
function wavOf(bytes) {
    const b = Buffer.alloc(bytes);
    b.write('RIFF', 0, 'ascii'); b.write('WAVE', 8, 'ascii');
    const f = path.join(dir, `seg-${bytes}-${Math.random().toString(36).slice(2)}.wav`);
    fs.writeFileSync(f, b);
    return f;
}

/** A fake Run: answers a submit with a job id and each read from `states` in turn. */
function fakeRun({ states = ['queued', 'running', 'succeeded'], result = { code: 0, stderr: TOKEN_LINE, ms: 1400 }, submitStatus = 201 } = {}) {
    const calls = [];
    let reads = 0;
    const fetchImpl = async (url, o = {}) => {
        calls.push({ url, method: o.method, headers: o.headers, body: o.body ? JSON.parse(o.body) : null });
        if (o.method === 'POST' && url.endsWith('/api/v1/jobs')) return { status: submitStatus, json: async () => (submitStatus === 201 ? { job: { id: 'job_1', state: 'queued' } } : { code: 'run.denied' }) };
        if (url.endsWith('/api/v1/jobs/job_1')) {
            const state = states[Math.min(reads++, states.length - 1)];
            return { status: 200, json: async () => ({ id: 'job_1', state, result: state === 'succeeded' ? result : null, error: state === 'failed' ? { code: 'run.job.exit_nonzero' } : undefined }) };
        }
        return { status: 404, json: async () => ({}) };
    };
    return { calls, fetchImpl };
}
const tokens = { getToken: async () => 'tok-run', invalidate() {} };

(async () => {
    const { createAsrRun, settingsOf, MAX_WAV } = require('../server/ai/asr-run');
    let clock = Date.parse('2026-11-18T02:00:00Z');
    const now = () => clock;
    const sleep = async (ms) => { clock += ms; };
    const quiet = { warn() {} };

    // Not configured: nothing is sent.
    assert.strictEqual(settingsOf({}), null);
    assert.strictEqual(settingsOf({ ...ENV, ASR_RUN_SUBJECT: 'someone' }), null, 'a malformed subject is not configured');
    const off = createAsrRun({ env: {}, fetchImpl: async () => { throw new Error('must not be called'); }, tokens, now, sleep, log: quiet });
    assert.strictEqual(off.configured(), false);
    assert.deepStrictEqual(await off.decode(wavOf(1000)), { ok: false, error: 'not configured' });

    // A decode on the node: the job's shape, the operator's headers, parakeet's own output back.
    const run = fakeRun();
    const a = createAsrRun({ env: ENV, fetchImpl: run.fetchImpl, tokens, now, sleep, log: quiet });
    assert.strictEqual(a.configured(), true);
    const seg = wavOf(320 * 1024 + 44);
    const r = await a.decode(seg);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.stderr, TOKEN_LINE);
    assert.strictEqual(r.job, 'job_1');
    const submit = run.calls[0];
    assert.deepStrictEqual([submit.method, submit.body.class, submit.body.artifact, submit.body.egress], ['POST', 'linux', { name: 'openvibe-asr', version: '1.0.0' }, 'none']);
    assert.strictEqual(Buffer.from(submit.body.args.audio_b64, 'base64').length, 320 * 1024 + 44, 'the whole segment is sent');
    assert.deepStrictEqual(submit.body.requirements.trust, ['first-party', 'user-owned'], 'the operator\'s own node is eligible');
    assert.ok(submit.body.ttl_ms <= 30000, 'an unplaced segment expires soon');
    assert.match(submit.body.idempotency_key, /^live-asr:[0-9a-f]{32}$/);
    assert.deepStrictEqual([submit.headers.Authorization, submit.headers['X-OV-Subject'], submit.headers['X-OV-Project']], ['Bearer tok-run', SUBJECT, PROJECT]);
    assert.ok(Buffer.byteLength(JSON.stringify(submit.body)) < 512 * 1024, 'within Run\'s 512 KB args');

    // Too large for the node's function: not sent, and no cool-down (it is the segment, not the node).
    const big = await a.decode(wavOf(MAX_WAV + 1));
    assert.strictEqual(big.ok, false);
    assert.strictEqual((await a.decode(seg)).ok, true, 'still on the node after a segment that was too large');

    // A failed job: { ok: false }, then five minutes local without asking Run, then the node again.
    const bad = fakeRun({ states: ['running', 'failed'] });
    const b = createAsrRun({ env: ENV, fetchImpl: bad.fetchImpl, tokens, now, sleep, log: quiet });
    const f = await b.decode(seg);
    assert.strictEqual(f.ok, false);
    assert.match(f.error, /ended failed \(run\.job\.exit_nonzero\)/);
    const before = bad.calls.length;
    assert.deepStrictEqual(await b.decode(seg), { ok: false, error: 'cooling down after a failure' });
    assert.strictEqual(bad.calls.length, before, 'Run is not asked while cooling down');
    clock += 5 * 60 * 1000 + 1;
    await b.decode(seg);
    assert.ok(bad.calls.length > before, 'asked again after five minutes');

    // LIVE_ASR_LOCAL_FALLBACK=off (11-18: nothing heavy decodes on production): a failed segment is { ok: false } and
    // the next one asks the node again at once, no cooldown.
    const offRun = fakeRun({ states: ['running', 'failed'] });
    const noLocal = createAsrRun({ env: { ...ENV, LIVE_ASR_LOCAL_FALLBACK: 'off' }, fetchImpl: offRun.fetchImpl, tokens, now, sleep, log: quiet });
    assert.strictEqual(noLocal.localFallback(), false);
    assert.strictEqual((await noLocal.decode(seg)).ok, false);
    const offBefore = offRun.calls.length;
    await noLocal.decode(seg);
    assert.ok(offRun.calls.length > offBefore, 'fallback off: the next segment asks the node again, no cooldown');
    assert.strictEqual(createAsrRun({ env: ENV }).localFallback(), true, 'on by default');

    // Run refuses the submit; a job that never ends in time.
    assert.match((await createAsrRun({ env: ENV, fetchImpl: fakeRun({ submitStatus: 403 }).fetchImpl, tokens, now, sleep, log: quiet }).decode(seg)).error, /Run answered 403 run\.denied/);
    assert.match((await createAsrRun({ env: ENV, fetchImpl: fakeRun({ states: ['queued'] }).fetchImpl, tokens, now, sleep, log: quiet }).decode(seg, { timeoutMs: 2000 })).error, /no answer within 2 s/);
    // A non-zero exit on the node is a failure, never an empty transcript.
    assert.match((await createAsrRun({ env: ENV, fetchImpl: fakeRun({ result: { code: 2, stderr: 'parakeet did not start' } }).fetchImpl, tokens, now, sleep, log: quiet }).decode(seg)).error, /exit 2/);

    // Through transcribe.js: a live segment's text comes from the node's answer, parsed as a local run's.
    const bin = path.join(dir, 'parakeet-cli');
    fs.writeFileSync(bin, '#!/bin/sh\necho \'  [ 0] id=    1 frame=  0 dur_idx= 1 dur_val= 1 p=0.9 plog=-1 t0= 100 t1= 150 word_start=true "▁Local."\' 1>&2\n');
    fs.chmodSync(bin, 0o755);
    const model = path.join(dir, 'model.bin');
    fs.writeFileSync(model, 'x');
    process.env.PARAKEET_BIN = bin;
    process.env.PARAKEET_MODEL = model;
    Object.assign(process.env, ENV);
    const shared = require('../server/ai/asr-run');
    const node = fakeRun();
    const inst = createAsrRun({ env: process.env, fetchImpl: node.fetchImpl, tokens, log: quiet, sleep: async () => {} });
    shared.asrRun = () => inst;
    const t = require('../server/ai/transcribe');
    const live = await t.transcribeWavDetailed(seg, { live: true, offsetSec: 20 });
    assert.ok(live.ok, live.error);
    assert.deepStrictEqual(live.segments.map((x) => [x.start, x.text]), [[21, 'Hello.']], 'the node\'s words, shifted like a local run\'s');
    assert.strictEqual(live.on, 'node');
    // Batch work stays local.
    const batch = await t.transcribeWavDetailed(seg, { offsetSec: 0 });
    assert.deepStrictEqual(batch.segments.map((x) => x.text), ['Local.']);
    console.log('asr on the shared node: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
