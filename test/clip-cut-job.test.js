/**
 * Following a clip cut on the server (Media's clip.cut job, roadmap WS-G task 3).
 *
 *   - GET /api/clips/:id/job?job= answers the job of that clip's cut to whoever made the clip (or may
 *     manage it): status, attempts, the error once it failed. Anyone else, a job of another clip, or
 *     a job that is not a clip.cut gets 404; a malformed job id 400.
 *   - public/js/ov-clip-jobs.js (run here with a stand-in fetch, localStorage and timers) follows a job
 *     to ready or failed, says so once per retry, keeps the pending cut across a "reload" and resumes it,
 *     and forgets a job the server no longer knows.
 *
 *   node test/clip-cut-job.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const tmp = path.join(os.tmpdir(), `ov-clip-cut-job-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};
const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();
const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };
const addUser = (id, username) => raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, 'x', 'user', '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`);
addUser(3, 'maker');
addUser(4, 'stranger');

// ── OpenVibe.Media stand-in ──
const media = require('../server/media-client');
const CLIPS = { 10: { id: 10, user_id: 3, channel_user_id: 9, status: 'processing', title: 'Mine', duration_seconds: 0 }, 11: { id: 11, user_id: 3, channel_user_id: 9, status: 'ready', title: 'Other', duration_seconds: 7 } };
const JOBS = {
    mjob_01M3AAAAAAAAAAAAAAAAAAAAAA: { id: 'mjob_01M3AAAAAAAAAAAAAAAAAAAAAA', type: 'clip.cut', status: 'running', attempts: 0, max_attempts: 4, params: { clip_id: 10 }, error: null },
    mjob_01M3BBBBBBBBBBBBBBBBBBBBBB: { id: 'mjob_01M3BBBBBBBBBBBBBBBBBBBBBB', type: 'object.sprite', status: 'succeeded', attempts: 1, max_attempts: 3, params: {}, error: null },
};
media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw new media.MediaApiError('not found', 404, null); return c; };
media.getJob = async (id) => { const j = JOBS[id]; if (!j) throw new media.MediaApiError('No such job', 404, null); return { job: j }; };

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/clips', require('../server/media-proxy/clips'));
const server = http.createServer(app).listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
const get = async (p, user) => { const r = await fetch(base() + p, { headers: user ? { 'x-test-user': String(user) } : {} }); return { status: r.status, body: await r.json().catch(() => null) }; };

(async () => {
    await new Promise((r) => server.once('listening', r));
    const A = 'mjob_01M3AAAAAAAAAAAAAAAAAAAAAA', B = 'mjob_01M3BBBBBBBBBBBBBBBBBBBBBB';

    // ── The route ──
    let r = await get(`/api/clips/10/job?job=${A}`, 3);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.job, { id: A, status: 'running', attempts: 0, max_attempts: 4, error: null, run_after: null });
    assert.deepStrictEqual(r.body.clip, { id: 10, status: 'processing', title: 'Mine', duration_seconds: 0 });
    assert.strictEqual((await get(`/api/clips/10/job?job=${A}`, 4)).status, 404, 'someone else: as if missing');
    assert.strictEqual((await get(`/api/clips/10/job?job=${A}`)).status, 401);
    assert.strictEqual((await get(`/api/clips/11/job?job=${A}`, 3)).status, 404, 'the job of another clip');
    assert.strictEqual((await get(`/api/clips/10/job?job=${B}`, 3)).status, 404, 'not a clip.cut');
    assert.strictEqual((await get('/api/clips/10/job?job=mjob_01M3CCCCCCCCCCCCCCCCCCCCCC', 3)).status, 404, 'unknown job');
    assert.strictEqual((await get('/api/clips/10/job?job=../x', 3)).status, 400);
    JOBS[A] = { ...JOBS[A], status: 'failed', attempts: 1, error: 'No decodable footage in that window' };
    r = await get(`/api/clips/10/job?job=${A}`, 3);
    assert.strictEqual(r.body.job.error, 'No decodable footage in that window', 'a failed cut says why');

    // ── The client helper, against a scripted server ──
    const src = fs.readFileSync(path.join(__dirname, '../public/js/ov-clip-jobs.js'), 'utf8');
    const store = new Map();
    const script = {};            // jobId -> list of answers, one per poll
    const polls = [];
    const timers = [];
    const makeWindow = () => {
        const w = {
            localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
            fetch: async (url) => {
                const m = /\/api\/clips\/(\d+)\/job\?job=([\w]+)/.exec(url);
                polls.push(m[2]);
                const next = (script[m[2]] || []).shift() || { status: 200, body: { job: { status: 'running', attempts: 0 } } };
                return { status: next.status, ok: next.status < 300, json: async () => next.body };
            },
            setTimeout: (fn) => { timers.push(fn); return timers.length; },
            Date,
        };
        w.window = w;
        return w;
    };
    const drain = async () => { for (let i = 0; i < 50 && timers.length; i++) { const fn = timers.shift(); fn(); await new Promise((r2) => setImmediate(r2)); await new Promise((r2) => setImmediate(r2)); } };
    const plain = (v) => JSON.parse(JSON.stringify(v));   // values from the page's realm
    const settle = () => new Promise((r2) => setImmediate(() => setImmediate(r2)));

    // A cut that retries once, then is ready.
    let w = makeWindow();
    vm.runInNewContext(src, w);
    const seen = [];
    script.mjob_1 = [
        { status: 200, body: { job: { status: 'running', attempts: 0 } } },
        { status: 200, body: { job: { status: 'queued', attempts: 1, max_attempts: 4 } } },
        { status: 200, body: { job: { status: 'queued', attempts: 1, max_attempts: 4 } } },
        { status: 200, body: { job: { status: 'succeeded', attempts: 2 }, clip: { id: 10, status: 'ready' } } },
    ];
    w.OVClipJobs.follow(10, 'mjob_1', { onReady: (c) => seen.push(['ready', c.id]), onFailed: (m) => seen.push(['failed', m]), onRetry: (j) => seen.push(['retry', j.attempts]) });
    assert.deepStrictEqual(plain(w.OVClipJobs.pending().map((e) => e.jobId)), ['mjob_1'], 'kept while pending');
    await settle(); await drain();
    assert.deepStrictEqual(seen, [['retry', 1], ['ready', 10]], 'one retry notice, then ready');
    assert.deepStrictEqual(plain(w.OVClipJobs.pending()), [], 'forgotten once done');

    // A reload: the new page resumes what the old one left pending, and a failure is reported.
    w = makeWindow();
    vm.runInNewContext(src, w);
    script.mjob_2 = [{ status: 200, body: { job: { status: 'running', attempts: 0 } } }];
    w.OVClipJobs.follow(12, 'mjob_2', {});
    await settle();
    timers.length = 0;                                   // the page goes away mid-cut
    assert.deepStrictEqual(JSON.parse(store.get('ov_clip_jobs')).map((e) => e.jobId), ['mjob_2']);
    const w2 = makeWindow();
    vm.runInNewContext(src, w2);
    script.mjob_2 = [{ status: 200, body: { job: { status: 'failed', attempts: 4, error: 'gave up' } } }];
    const seen2 = [];
    w2.OVClipJobs.resume({ onFailed: (m) => seen2.push(m) });
    await settle(); await drain();
    assert.deepStrictEqual(seen2, ['gave up'], 'the resumed cut reports its failure');
    assert.deepStrictEqual(plain(w2.OVClipJobs.pending()), []);

    // A job the server no longer knows (or no longer shows this person) is dropped silently.
    const w3 = makeWindow();
    vm.runInNewContext(src, w3);
    script.mjob_3 = [{ status: 404, body: { error: 'Job not found' } }];
    const seen3 = [];
    w3.OVClipJobs.follow(13, 'mjob_3', { onReady: () => seen3.push('ready'), onFailed: () => seen3.push('failed') });
    await settle(); await drain();
    assert.deepStrictEqual([seen3, plain(w3.OVClipJobs.pending())], [[], []]);

    // Following the same job twice polls it once.
    const w4 = makeWindow();
    vm.runInNewContext(src, w4);
    polls.length = 0;
    script.mjob_4 = [{ status: 200, body: { job: { status: 'succeeded' }, clip: { id: 14 } } }];
    w4.OVClipJobs.follow(14, 'mjob_4', {});
    w4.OVClipJobs.follow(14, 'mjob_4', {});
    await settle(); await drain();
    assert.deepStrictEqual(polls, ['mjob_4']);

    server.close();
    try { fs.unlinkSync(tmp); } catch { /* */ }
    quiet('clip cut job: all checks passed');
})().catch((err) => { quiet(err); process.exit(1); });
