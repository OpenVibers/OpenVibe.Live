'use strict';
/**
 * Live speech-to-text on the shared node (plan §AD.21b item 6). Each 10 s live segment used to be decoded by
 * Parakeet on production's four cores, about half a core per live stream. With ASR_RUN_URL, ASR_RUN_SUBJECT and
 * ASR_RUN_PROJECT set, the live lane sends the segment's WAV to OpenVibe.Run instead, as a job of the node's
 * `openvibe-asr` function (the same parakeet-cli and model; 1.5 s for 11 s of speech on four of the node's eight
 * cores). The job runs for the operator (X-OV-Subject) in their project (X-OV-Project), with Live's Network
 * service token (run.job.submit, run.job.read). Its answer is parakeet-cli's own per-token output, which
 * transcribe.js parses exactly as it does a local run.
 *
 * Any failure (not configured, a restore drill, the token, Run, an unplaced or failed job, a timeout) answers
 * { ok: false } and the caller decodes locally as before; after a failure the next five minutes stay local, so a
 * Run outage costs one segment's wait, not every segment's.
 *
 *   createAsrRun({ env, fetchImpl, tokens, now, sleep }) → { configured(), decode(wavPath, { timeoutMs }) }
 *   decode → { ok: true, stderr, ms, job } | { ok: false, error }
 */
const fs = require('fs');
const crypto = require('crypto');

const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_WAV = 360 * 1024;             // the node's function takes at most this; a 10 s 16 kHz mono segment is 320 KB
const POLL_MS = 250;
const COOL_MS = 5 * 60 * 1000;
const DONE = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

function drill() { try { return require('../drill').enabled; } catch { return false; } }

/** May a live segment the node missed decode on this host? LIVE_ASR_LOCAL_FALLBACK=off (the owner, 11-18: heavy work
 *  runs on the shared node via Link, not on production) says no: that segment is lost, and the next one asks the node
 *  again at once, with no cooldown. */
function localFallback(env) { return !/^(off|0|false|no)$/i.test(String((env || {}).LIVE_ASR_LOCAL_FALLBACK || '').trim()); }

function settingsOf(env) {
    const url = String(env.ASR_RUN_URL || '').replace(/\/+$/, '');
    const subject = String(env.ASR_RUN_SUBJECT || '');
    const project = String(env.ASR_RUN_PROJECT || '');
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !USER_RE.test(subject) || !PROJECT_RE.test(project)) return null;
    return { url, subject, project };
}

function defaultTokens(env) {
    const clientSecret = env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) return null;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const networkInternalUrl = String(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    return createServiceTokenClient({
        tokenUrl: `${networkInternalUrl}/oauth/token`, clientId: env.OV_OAUTH_CLIENT_ID || 'live', clientSecret,
        audience: 'openvibe.run', scope: 'run.job.submit run.job.read',
    });
}

function createAsrRun({ env = process.env, fetchImpl = globalThis.fetch, tokens = undefined, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
    let client = tokens;
    let coolUntil = 0;
    let lastNote = '';

    const configured = () => !!settingsOf(env) && !drill();
    const tokenClient = () => {
        if (client === undefined) client = defaultTokens(env);
        return client;
    };
    const fail = (error) => {
        // With the local fallback off there is nothing to cool down for: each next segment asks the node again.
        const here = localFallback(env);
        if (here) coolUntil = now() + COOL_MS;
        if (error !== lastNote) { lastNote = error; if (log && log.warn) log.warn(`[ASR] the shared node did not decode (${error}); ${here ? 'decoding here for 5 minutes' : 'this segment is skipped (LIVE_ASR_LOCAL_FALLBACK=off)'}`); }
        return { ok: false, error };
    };

    async function decode(wavPath, { timeoutMs = 15000 } = {}) {
        const s = settingsOf(env);
        if (!s || drill()) return { ok: false, error: 'not configured' };
        if (now() < coolUntil) return { ok: false, error: 'cooling down after a failure' };
        const tc = tokenClient();
        if (!tc) return fail('OV_OAUTH_CLIENT_SECRET is not set');
        let wav;
        try { wav = fs.readFileSync(wavPath); } catch (e) { return { ok: false, error: `cannot read the segment: ${e.code || e.message}` }; }
        if (!wav.length || wav.length > MAX_WAV) return { ok: false, error: `the segment is ${wav.length} bytes, over ${MAX_WAV}` };
        const deadline = now() + timeoutMs;
        const call = async (method, path, body) => {
            const headers = { Accept: 'application/json', Authorization: `Bearer ${await tc.getToken()}`, 'X-OV-Subject': s.subject, 'X-OV-Project': s.project };
            if (body) headers['Content-Type'] = 'application/json';
            const res = await fetchImpl(`${s.url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(Math.max(1000, Math.min(10000, deadline - now()))) });
            if (res.status === 401 && tc.invalidate) tc.invalidate();
            const doc = await res.json().catch(() => null);
            return { status: res.status, doc };
        };
        const t0 = now();
        try {
            const body = {
                class: 'linux', artifact: { name: 'openvibe-asr', version: '1.0.0' },
                args: { audio_b64: wav.toString('base64'), threads: 4 }, egress: 'none',
                requirements: { kind: 'live.asr', mobility: 'job', latency_class: 'interactive', objective: 'balanced', trust: ['first-party', 'user-owned'] },
                limits: { wall_ms: 60000, cpu_ms: 240000, mem_bytes: 2 * 1024 * 1024 * 1024 },
                ttl_ms: 30000,
                idempotency_key: `live-asr:${crypto.createHash('sha256').update(wav).digest('hex').slice(0, 32)}`,
            };
            const sub = await call('POST', '/api/v1/jobs', body);
            const id = sub.doc && (sub.doc.id || (sub.doc.job && sub.doc.job.id));
            if (!(sub.status === 200 || sub.status === 201) || !id) return fail(`Run answered ${sub.status}${sub.doc && sub.doc.code ? ` ${sub.doc.code}` : ''}`);
            for (;;) {
                if (now() >= deadline) return fail(`no answer within ${Math.round(timeoutMs / 1000)} s`);
                await sleep(POLL_MS);
                const r = await call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`);
                const j = r.doc && (r.doc.state ? r.doc : r.doc.job);
                if (!j || !DONE.has(j.state)) continue;
                const result = j.result && typeof j.result === 'object' ? j.result : null;
                if (j.state !== 'succeeded' || !result || result.code !== 0 || typeof result.stderr !== 'string') {
                    return fail(`the job ended ${j.state}${j.error && j.error.code ? ` (${j.error.code})` : ''}${result && result.code ? `, exit ${result.code}` : ''}`);
                }
                lastNote = '';
                return { ok: true, stderr: result.stderr, ms: now() - t0, job: id };
            }
        } catch (e) {
            return fail(e && e.name === 'TimeoutError' ? 'Run did not answer in time' : `Run unreachable: ${(e && e.message) || e}`);
        }
    }

    return { configured, decode, localFallback: () => localFallback(env) };
}

let shared = null;
/** The process's own instance, made on first use (nothing at module load). */
function asrRun() {
    if (!shared) shared = createAsrRun();
    return shared;
}

module.exports = { createAsrRun, asrRun, settingsOf, localFallback, MAX_WAV, COOL_MS };
