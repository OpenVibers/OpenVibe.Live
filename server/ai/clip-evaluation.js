'use strict';
/**
 * clip-evaluation.js — the AI's clip picks against people's, blind, on OpenVibe.Bench (item 151, C20).
 *
 * Once a day, for up to MAX_PER_RUN recent recordings that have both a public clip the AI cut and a public clip a
 * person made, Live submits one live.clip round to Bench (#105): the AI's pick (policy auto-clip@AUTO_CLIP_POLICY, or
 * the one the auto-clip log names for it: policyOf) and the person's (policy people@1), each with a 6-hour signed playback link from Media. Signed-in people vote at
 * https://bench.openvibe.services/battle?kind=live.clip (Bench #106: two players, blind, no titles), and
 * results() reads each side's accept rate back from Bench (both_bad counts against both).
 *
 *   Off unless LIVE_CLIP_EVAL=on, and never in drill mode (auto-clip-job.js starts it).
 *   Recording-separated: one round per recording, ever (state clip_eval_log keeps the last 2000).
 *   Protected content stays out: only public clips of public recordings, nothing the explicit check flags, never a
 *   mature recording, and never clip 483 or VOD 5709.
 *
 *   run({ now, max }) → { submitted: [{ vod_id, round_id }], skipped, why }
 *   results() → { policies } from Bench, or null
 *   start() / stop()
 */
const db = require('../db/database');
const media = require('../media-client');
const principal = require('../net/network-principal');
const { isExplicit } = require('./explicit');
const { parseTs } = require('./clip-policy');

const BENCH_URL = String(process.env.LIVE_BENCH_URL || 'https://bench.openvibe.services').replace(/\/+$/, '');
// The picker as it stands: the date of its last change (score bar, calibration, freshness, sweep). Change it with the
// picker, so Bench's accept rate is per version.
const AUTO_CLIP_POLICY = process.env.LIVE_AUTO_CLIP_POLICY || '2026-11-02';
const LOG = 'clip_eval_log';
const KEEP = 2000;
const MAX_PER_RUN = 3;
const WINDOW_DAYS = 14;
const PLAYBACK_TTL_S = 6 * 3600;
const DAY_MS = 24 * 3600 * 1000;
const NEVER_CLIPS = new Set(['483']);
const NEVER_VODS = new Set(['5709']);

const enabled = () => String(process.env.LIVE_CLIP_EVAL || '').toLowerCase() === 'on';

/** What was sent (or claimed). A failed read throws: an empty answer would look like "nothing sent yet". */
async function _log() {
    const raw = await db.getState(LOG);
    try { const d = JSON.parse(raw || '[]'); return Array.isArray(d) ? d : []; } catch { return []; }
}

/** A clip that may be judged: public, ready, not flagged, 5 to 180 seconds, with its window known. */
function eligible(clip) {
    if (!clip || clip.visibility !== 'public' || (clip.status && clip.status !== 'ready')) return false;
    if (NEVER_CLIPS.has(String(clip.id)) || NEVER_VODS.has(String(clip.vod_id))) return false;
    if (clip.mature || clip.is_mature || isExplicit(clip.title || '', clip.description || '')) return false;
    const start = Number(clip.start_time);
    const len = Number(clip.duration_seconds ?? clip.duration ?? (Number(clip.end_time) - start));
    return Number.isFinite(start) && start >= 0 && Number.isFinite(len) && len >= 5 && len <= 180;
}

async function bench(method, path, body) {
    const res = await fetch(`${BENCH_URL}${path}`, {
        method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await principal.serviceHeaders('openvibe.bench')) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) { const e = new Error(`Bench ${method} ${path}: HTTP ${res.status}`); e.status = res.status; throw e; }
    return json;
}

/**
 * Which picker cut an AI clip, for Bench's per-policy accept rate: the auto-clip log names it on clips cut since C08
 * (2026-11-03: VOD moments are `vod-moment@2026-11-03`); older clips and the live cutter are `auto-clip@AUTO_CLIP_POLICY`.
 */
function policyOf(clip, clipLog = []) {
    const e = (Array.isArray(clipLog) ? clipLog : []).find((x) => x && x.clip_id != null && String(x.clip_id) === String(clip.id));
    const p = e && e.policy;
    if (p && typeof p.selector === 'string' && typeof p.version === 'string') return { selector: p.selector.slice(0, 80), version: p.version.slice(0, 80), models: [] };
    return { selector: 'auto-clip', version: AUTO_CLIP_POLICY, models: [] };
}

function entryOf(clip, policy, signed) {
    const start = Math.round(Number(clip.start_time) * 1000);
    const len = Math.round(Number(clip.duration_seconds ?? clip.duration ?? (Number(clip.end_time) - Number(clip.start_time))) * 1000);
    return {
        source: { recording_id: `vod_${clip.vod_id}`, start_ms: start, end_ms: start + len },
        playback: { url: signed.url, expires_at: signed.expires_at },
        policy,
        ...(clip.title ? { title: String(clip.title).slice(0, 200) } : {}),
    };
}

async function run({ now = Date.now(), max = MAX_PER_RUN } = {}) {
    if (!enabled()) return { submitted: [], skipped: 0, why: 'off (LIVE_CLIP_EVAL is not on)' };
    if (!principal.configured()) return { submitted: [], skipped: 0, why: 'no OAuth client secret' };
    const since = new Date(now - WINDOW_DAYS * DAY_MS).toISOString();
    const ai = await media.listClips({ auto_generated: 1, since, status: 'ready', order: 'newest', limit: 100 }, { timeoutMs: 15_000 });
    if (!ai || !Array.isArray(ai.clips)) return { submitted: [], skipped: 0, why: 'Media did not answer' };
    let done;
    try { done = new Set((await _log()).map((x) => String(x.vod_id))); } catch (e) { return { submitted: [], skipped: 0, why: `state unreadable: ${e.message}` }; }
    let clipLog = [];
    try { clipLog = JSON.parse(await db.getState('auto_clip_log') || '[]'); } catch { clipLog = []; }
    const byVod = new Map();
    for (const c of ai.clips) if (c.auto_generated === true && eligible(c) && !done.has(String(c.vod_id)) && !byVod.has(String(c.vod_id))) byVod.set(String(c.vod_id), c);
    const submitted = [];
    let skipped = 0;
    for (const [vodId, aiClip] of byVod) {
        if (submitted.length >= max) break;
        try {
            const vod = await media.getVod(vodId, { timeoutMs: 10_000 });
            if (!vod || vod.visibility !== 'public' || vod.mature || vod.is_mature) { skipped++; continue; }
            const people = await media.listClips({ vod_id: vodId, auto_generated: 0, status: 'ready', limit: 20 }, { timeoutMs: 10_000 });
            const person = (people && Array.isArray(people.clips) ? people.clips : []).find((c) => c.auto_generated !== true && eligible(c));
            if (!person) { skipped++; continue; }
            const [sa, sp] = await Promise.all([media.signedMediaUrl('clip', aiClip.id, PLAYBACK_TTL_S), media.signedMediaUrl('clip', person.id, PLAYBACK_TTL_S)]);
            if (!sa || !sa.url || !sp || !sp.url) { skipped++; continue; }
            // Claimed before Bench is asked: a recording is never sent twice, even when a later step fails (11-03: a
            // round reached Bench, then the log write failed, and the next run would have sent it again).
            const claim = { vod_id: vodId, ai_clip: aiClip.id, person_clip: person.id, round_id: null, at: new Date(now).toISOString() };
            await db.setState(LOG, JSON.stringify([claim, ...(await _log())].slice(0, KEEP)));
            const task = await bench('POST', '/api/v1/kinds/live.clip/tasks', { prompt: 'Two clips of one stream', public: false });
            const round = await bench('POST', `/api/v1/tasks/${task.task.id}/rounds`, {});
            const roundId = round.round.id;
            await bench('POST', `/api/v1/rounds/${roundId}/entries`, { payload: entryOf(aiClip, policyOf(aiClip, clipLog), sa) });
            await bench('POST', `/api/v1/rounds/${roundId}/entries`, { payload: entryOf(person, { selector: 'people', version: '1', models: [] }, sp) });
            const log = await _log();
            const mine = log.find((x) => String(x.vod_id) === vodId && x.round_id == null);
            if (mine) mine.round_id = roundId;
            await db.setState(LOG, JSON.stringify(log.slice(0, KEEP))).catch(() => {});
            submitted.push({ vod_id: vodId, round_id: roundId });
        } catch (e) {
            if (e && (e.status === 404 || e.status === 410)) { skipped++; continue; }
            console.warn('[clip-eval] stopped for today:', e && e.message);
            break;   // Bench or Media down: the rest wait for tomorrow
        }
    }
    if (submitted.length) console.log(`[clip-eval] ${submitted.length} recording(s) sent to Bench for a blind vote`);
    return { submitted, skipped, why: submitted.length ? null : 'no recording with both an AI clip and a person\'s clip' };
}

/** Each side's results, as Bench counts them (shadow metrics): the AI's picker against people's. */
async function results() {
    if (!principal.configured()) return null;
    try { return await bench('GET', '/api/v1/kinds/live.clip/policies'); } catch { return null; }
}

let _stop = null;
function start() {
    if (_stop || !enabled()) return;
    _stop = require('../utils/jobs').every('clip-evaluation', DAY_MS, () => run(), { initialDelayMs: 40 * 60 * 1000, jitterMs: 20 * 60 * 1000 });
}
function stop() { if (_stop) { _stop(); _stop = null; } }

module.exports = { run, results, start, stop, eligible, entryOf, policyOf, AUTO_CLIP_POLICY, LOG, MAX_PER_RUN };
