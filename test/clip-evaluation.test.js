/**
 * The AI's clip picks against people's, blind, on Bench (server/ai/clip-evaluation.js; item 151, C20): a recent
 * recording with a public AI clip and a public clip a person made becomes one live.clip round with both entries and
 * signed playback links; one round per recording, ever; protected content (private, mature, explicit, clip 483,
 * VOD 5709) stays out; off unless LIVE_CLIP_EVAL=on; Bench down stops the run for the day.
 *
 *   node test/run.js clip-evaluation
 */
'use strict';
const assert = require('assert');

process.env.LIVE_CLIP_EVAL = 'on';
const media = require('../server/media-client');
const db = require('../server/db/database');
const principal = require('../server/net/network-principal');
const state = new Map();
db.getState = async (k) => state.get(k) || null;
db.setState = async (k, v) => { state.set(k, v); };
principal.configured = () => true;
principal.serviceHeaders = async () => ({ Authorization: 'Bearer svc-live' });

const NOW = Date.parse('2026-11-03T02:00:00Z');
const clip = (id, vod, ai, extra = {}) => ({ id, vod_id: vod, auto_generated: ai, visibility: 'public', status: 'ready', start_time: 120, duration_seconds: 30, title: `clip ${id}`, ...extra });
let clips;
let vods;
let bench;
let benchDown;
const reset = () => {
    clips = [
        clip(10, 100, true), clip(11, 100, false),                          // AI and a person on 100: judged
        clip(20, 200, true),                                                // nobody else on 200: skipped
        clip(30, 300, true), clip(31, 300, false, { visibility: 'unlisted' }), // the person's clip is not public
        clip(40, 400, true, { title: 'explicit sex act' }), clip(41, 400, false),
        clip(483, 500, true), clip(51, 500, false),                         // clip 483 never
        clip(60, 5709, true), clip(61, 5709, false),                        // VOD 5709 never
        clip(70, 700, true), clip(71, 700, false),                          // a mature recording
        clip(80, 800, true), clip(81, 800, false),                          // a second good one
    ];
    vods = { 100: { id: 100, visibility: 'public' }, 300: { id: 300, visibility: 'public' }, 400: { id: 400, visibility: 'public' }, 500: { id: 500, visibility: 'public' }, 5709: { id: 5709, visibility: 'public' }, 700: { id: 700, visibility: 'public', mature: true }, 800: { id: 800, visibility: 'public' } };
    bench = [];
    benchDown = false;
    state.clear();
};
media.listClips = async (q) => {
    let rows = clips.filter((c) => c.status === 'ready');
    if (q.auto_generated === 1) rows = rows.filter((c) => c.auto_generated);
    if (q.auto_generated === 0) rows = rows.filter((c) => !c.auto_generated);
    if (q.vod_id != null) rows = rows.filter((c) => String(c.vod_id) === String(q.vod_id));
    return { clips: rows.slice(0, q.limit), total: rows.length };
};
media.getVod = async (id) => vods[id] || null;
media.signedMediaUrl = async (kind, id, ttl) => ({ url: `https://openvibe.media/c/${id}?exp=1&sig=x`, expires_at: new Date(NOW + ttl * 1000).toISOString() });
global.fetch = async (url, opts) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    bench.push({ method: opts.method, path: u.pathname, body, auth: opts.headers.Authorization });
    if (benchDown) return new Response('down', { status: 503 });
    if (u.pathname === '/api/v1/kinds/live.clip/tasks') return Response.json({ task: { id: `bnt_${bench.length}` } }, { status: 201 });
    if (/\/rounds$/.test(u.pathname)) return Response.json({ round: { id: `brn_${bench.length}` } }, { status: 201 });
    if (/\/entries$/.test(u.pathname)) return Response.json({ entry: { id: `bte_${bench.length}` } }, { status: 201 });
    if (u.pathname === '/api/v1/kinds/live.clip/policies') return Response.json({ kind_id: 'live.clip', policies: [{ policy: 'auto-clip@x', accept_rate: 0.5 }] });
    return new Response('?', { status: 404 });
};

const evaluation = require('../server/ai/clip-evaluation');

(async () => {
    reset();
    let out = await evaluation.run({ now: NOW, max: 5 });
    assert.deepStrictEqual(out.submitted.map((x) => x.vod_id).sort(), ['100', '800'], JSON.stringify(out));
    const entries = bench.filter((b) => /\/entries$/.test(b.path));
    assert.strictEqual(entries.length, 4, 'two entries a round');
    const ai = entries.find((e) => e.body.payload.policy.selector === 'auto-clip' && e.body.payload.source.recording_id === 'vod_100');
    const person = entries.find((e) => e.body.payload.policy.selector === 'people' && e.body.payload.source.recording_id === 'vod_100');
    assert.ok(ai && person, 'the AI\'s pick and the person\'s');
    assert.deepStrictEqual(ai.body.payload.source, { recording_id: 'vod_100', start_ms: 120000, end_ms: 150000 });
    assert.match(ai.body.payload.playback.url, /^https:\/\/openvibe\.media\/c\/10\?/);
    assert.strictEqual(ai.body.payload.policy.version, evaluation.AUTO_CLIP_POLICY);
    assert.ok(Date.parse(ai.body.payload.playback.expires_at) > NOW, 'a link that lasts');
    assert.ok(bench.every((b) => b.auth === 'Bearer svc-live'), 'Live\'s own service token');
    const task = bench.find((b) => b.path === '/api/v1/kinds/live.clip/tasks');
    assert.deepStrictEqual(task.body, { prompt: 'Two clips of one stream', public: false }, 'a private task that names no recording');
    const touched = new Set(entries.map((e) => e.body.payload.source.recording_id));
    for (const never of ['vod_200', 'vod_300', 'vod_400', 'vod_500', 'vod_5709', 'vod_700']) assert.ok(!touched.has(never), `${never} stays out`);

    // One round per recording, ever.
    const before = bench.length;
    out = await evaluation.run({ now: NOW + 86400_000, max: 5 });
    assert.strictEqual(out.submitted.length, 0, 'nothing new');
    assert.strictEqual(bench.length, before, 'no second round for 100 or 800');
    assert.strictEqual(JSON.parse(state.get(evaluation.LOG)).length, 2);

    // At most `max` a run; Bench down stops the run (the rest wait for tomorrow).
    reset();
    out = await evaluation.run({ now: NOW, max: 1 });
    assert.strictEqual(out.submitted.length, 1);
    reset();
    benchDown = true;
    out = await evaluation.run({ now: NOW, max: 5 });
    assert.strictEqual(out.submitted.length, 0);
    assert.strictEqual(bench.length, 1, 'stopped at the first refusal');

    // The recording is claimed before Bench is asked: a state that cannot be written sends nothing, and a state that
    // cannot be read stops the run (11-03).
    reset();
    const realSet = db.setState;
    db.setState = async () => { throw new Error('db down'); };
    out = await evaluation.run({ now: NOW, max: 5 });
    assert.strictEqual(bench.length, 0, 'nothing reaches Bench without the claim');
    db.setState = realSet;
    const realGet = db.getState;
    db.getState = async () => { throw new Error('db down'); };
    out = await evaluation.run({ now: NOW, max: 5 });
    assert.match(out.why, /state unreadable/);
    assert.strictEqual(bench.length, 0);
    db.getState = realGet;
    // Bench failing after the claim: that recording stays claimed (never a second round for it).
    reset();
    benchDown = true;
    await evaluation.run({ now: NOW, max: 5 });
    benchDown = false;
    const claimed = JSON.parse(state.get(evaluation.LOG));
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].round_id, null);
    const firstVod = claimed[0].vod_id;
    out = await evaluation.run({ now: NOW, max: 5 });
    assert.ok(!out.submitted.some((x) => x.vod_id === firstVod), 'a claimed recording is not sent again');

    // Off unless switched on.
    reset();
    process.env.LIVE_CLIP_EVAL = '';
    out = await evaluation.run({ now: NOW });
    assert.match(out.why, /off/);
    assert.strictEqual(bench.length, 0);
    process.env.LIVE_CLIP_EVAL = 'on';

    // The shadow metrics come back from Bench.
    const r = await evaluation.results();
    assert.strictEqual(r.policies[0].accept_rate, 0.5);
    console.log('clip evaluation: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
