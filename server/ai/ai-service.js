/**
 * ai-service.js — Live as a CONSUMER of OpenVibe.AI (roadmap Wave 13).
 *
 * With AI_SERVICE=remote, Live stops calling model providers itself: every shared-key AI call
 * becomes a workflow run on OpenVibe.AI (ai.openvibe.network, internal OV_AI_INTERNAL_URL),
 * authenticated with Live's Network service token for audience openvibe.ai (network-principal).
 * Unset (the default), nothing here is used and Live behaves exactly as before.
 *
 *   structured(workflow, input, opts) -> the run's output object, or null
 *        for workflows whose prompt now lives in OpenVibe.AI (live.translate, live.paste.*,
 *        live.stream.*, live.streamer.overview, live.media.overview, live.stream.recap,
 *        network.site_copy)
 *   complete(o, { toVisionJpeg }) -> the llm.complete() result shape, or null
 *        for every other llm.complete() call: the prompt Live rendered is sent as a passthrough run of
 *        the workflow that owns that feature (KIND_TO_WORKFLOW), so each run is still attributable
 *        to one workflow + model + run
 *
 * null means "no AI answer" exactly like llm.complete() returning null today (AI off, over
 * budget, provider down): quota refusals (429), failed runs, unreachable service, and SYNTHETIC
 * answers (the AI service's stub provider) all come back as null — synthetic text never reaches
 * a Live page. Streamer BYO providers are not routed here (llm.js keeps calling them directly).
 */
'use strict';
const principal = require('../net/network-principal');

const AUDIENCE = 'openvibe.ai';
const TERMINAL = new Set(['succeeded', 'cached', 'failed', 'cancelled']);

/** llm.complete() kind -> the OpenVibe.AI workflow that owns that feature (same table as the service). */
const KIND_TO_WORKFLOW = {
    ai_viewers_director: 'live.viewers.plan', ai_viewers_reply: 'live.viewers.reply', ai_viewers: 'live.viewers.line', ai_viewers_fold: 'live.viewers.fold',
    chat_global: 'live.chat.insight', chat_user: 'live.chat.insight', chat_relay: 'live.chat.insight', chat_anon: 'live.chat.insight', combined_overview: 'live.chat.insight', session_titles: 'live.chat.insight',
    moment_vod_rank: 'live.moments.rank', moment_pick: 'live.moments.pick', auto_clip_confirm: 'live.clips.confirm', hero_slogans: 'live.hero.slogans', easter_egg: 'live.easter_egg', home_star: 'live.home.star',
    arena_persona: 'live.arena.persona', arena_quotes: 'live.arena.quotes', arena_scene: 'live.arena.scene', arena_beef_judge: 'live.arena.judge', arena_mic_judge: 'live.arena.judge', arena_headline: 'live.arena.headline',
    status_check: 'live.status_check',
};
const ROLES = ['chat', 'vision', 'director', 'summary', 'legacy'];

function enabled() { return String(process.env.AI_SERVICE || '').trim().toLowerCase() === 'remote'; }
function baseUrl() { return String(process.env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700').replace(/\/+$/, ''); }
function workflowFor(kind) { return KIND_TO_WORKFLOW[kind] || 'live.complete'; }

let _lastWarn = 0;
function warn(msg) {
    if (Date.now() - _lastWarn < 60_000) return;
    _lastWarn = Date.now();
    console.warn(`[AI service] ${msg}`);
}

async function _fetchJson(method, path, body, timeoutMs, retried = false) {
    let headers;
    try { headers = await principal.serviceHeaders(AUDIENCE); } catch (e) { warn(`no service token for ${AUDIENCE}: ${e.message}`); return null; }
    let res;
    try {
        res = await fetch(`${baseUrl()}${path}`, {
            method,
            headers: { ...headers, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) { warn(`${method} ${path} failed: ${e.message}`); return null; }
    const json = await res.json().catch(() => null);
    if (res.status === 401 && !retried) {                     // stale/rotated token: fetch a new one once
        principal.invalidate(AUDIENCE);
        return _fetchJson(method, path, body, timeoutMs, true);
    }
    if (res.status === 429) { warn(`quota: ${(json && json.detail) || 'refused'} (retry after ${res.headers.get('retry-after') || '?'}s)`); return null; }
    if (!res.ok && res.status !== 202) { warn(`${method} ${path} -> ${res.status} ${(json && (json.code || json.detail)) || ''}`); return null; }
    return json;
}

/**
 * Run a workflow and wait for it. Returns the run object (any terminal status) or null.
 * opts: { target, attribution, idempotencyKey, waitMs (default 60s), timeoutMs }
 */
async function run(workflow, input, { target, attribution, idempotencyKey, waitMs = 60000 } = {}) {
    if (!enabled()) return null;
    const wait = Math.max(0, Math.min(60000, waitMs));
    const created = await _fetchJson('POST', `/api/v1/runs?wait=${wait}`, {
        workflow, input, target: target || undefined, attribution: attribution || undefined, idempotency_key: idempotencyKey || undefined,
    }, wait + 15000);
    let r = created && created.run;
    if (!r) return null;
    // Still queued/running after the wait: poll briefly (the service caps a wait at 60 s).
    const deadline = Date.now() + wait;
    while (!TERMINAL.has(r.status) && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 1000));
        const again = await _fetchJson('GET', `/api/v1/runs/${encodeURIComponent(r.id)}`, null, 15000);
        if (!again || !again.run) return null;
        r = again.run;
    }
    return r;
}

/** A usable (real, finished) output or null. */
function usable(r) {
    if (!r || !['succeeded', 'cached'].includes(r.status)) return null;
    if (r.synthetic) { warn(`${r.workflow && r.workflow.key} answered from the stub provider; treating it as no answer`); return null; }
    return r.output || null;
}

// Live's ai_usage table keeps metering remote runs too (per-streamer budgets, admin cost views);
// llm.js installs the recorder so this module stays free of the database.
let _recorder = null;
function setRecorder(fn) { _recorder = typeof fn === 'function' ? fn : null; }
function meter(r, m) {
    if (!_recorder || !m || !r || r.status !== 'succeeded' || r.synthetic) return;
    try { _recorder(r, m); } catch { /* metering is best-effort */ }
}

/** opts: run() options plus meter: { kind, role, ownerUserId, source } for Live's ai_usage row. */
async function structured(workflow, input, opts = {}) {
    const r = await run(workflow, input, { ...opts, attribution: opts.attribution || ownerRef(opts.meter && opts.meter.ownerUserId) });
    meter(r, opts.meter);
    return usable(r);
}

/** EntityRef for the Live user a spend is attributed to (Live's per-streamer budgets). */
function ownerRef(ownerUserId) {
    const id = parseInt(ownerUserId, 10);
    return id > 0 ? { service: 'live', type: 'user', id: String(id) } : undefined;
}

/**
 * An image for a workflow input. OpenVibe.Media URLs stay URLs (the service fetches only
 * allow-listed OpenVibe hosts); files, buffers and any other URL are downscaled here, as before,
 * and sent inline.
 */
async function imageInput(image, { toVisionJpeg, maxWidth = 1024 } = {}) {
    if (!image) return null;
    if (typeof image === 'string' && /^https:\/\/openvibe\.media\//i.test(image)) return { url: image, max_width: maxWidth };
    const dataUrl = toVisionJpeg ? await toVisionJpeg(image, { maxWidth, quality: 78 }) : (typeof image === 'string' && image.startsWith('data:') ? image : null);
    return dataUrl ? { data_url: dataUrl, max_width: maxWidth } : null;
}

/**
 * llm.complete() over the service. Same argument object; same result shape
 * ({ text, json, usage, model, provider, shared, latencyMs, cost }) or null.
 */
async function complete(o = {}, { toVisionJpeg } = {}) {
    const role = ROLES.includes(o.role) ? o.role : 'legacy';
    let image = null;
    if (o.image) {
        image = await imageInput(o.image, { toVisionJpeg, maxWidth: o.imageMaxWidth || 1024 });
        if (!image) return null;
    }
    const system = typeof o.system === 'string' ? o.system
        : Array.isArray(o.system) ? o.system.filter(x => x && String(x.text || '').trim()).map(x => ({ text: String(x.text), cache: Boolean(x.cache) })) : undefined;
    const input = {
        role, kind: o.kind ? String(o.kind).slice(0, 64) : undefined, source: o.source ? String(o.source).slice(0, 64) : undefined,
        system: system && system.length ? system : undefined,
        messages: Array.isArray(o.messages) && o.messages.length ? o.messages.filter(m => m && m.role).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) : undefined,
        user: o.user != null ? String(o.user) : undefined,
        image: image || undefined,
        json: o.json ? { name: o.json.name, schema: o.json.schema, strict: o.json.strict, description: o.json.description } : undefined,
        max_tokens: Math.max(1, Math.round(o.maxTokens || 400)),
        temperature: o.temperature == null ? undefined : o.temperature,
        timeout_ms: o.timeoutMs ? Math.max(1000, Math.min(120000, o.timeoutMs)) : undefined,
        cache_key: o.cacheKey ? String(o.cacheKey).slice(0, 128) : undefined,
    };
    if (!input.user && !input.messages) input.user = '';
    const started = Date.now();
    const r = await run(workflowFor(o.kind), input, { attribution: ownerRef(o.ownerUserId), waitMs: Math.max(30000, (o.timeoutMs || 30000) * 2) });
    const out = usable(r);
    if (!out) return null;
    const usage = { input: (r.usage && r.usage.tokens_in) || 0, output: (r.usage && r.usage.tokens_out) || 0, cached: 0 };
    return {
        text: typeof out.text === 'string' ? out.text : '',
        json: out.json || null,
        usage,
        model: (r.provenance && r.provenance.model) || null,
        provider: 'openvibe-ai',
        shared: true,
        latencyMs: Date.now() - started,
        cost: (r.usage && r.usage.cost_usd) || 0,
        runId: r.id,
        workflow: r.workflow && r.workflow.key,
    };
}

module.exports = { enabled, run, structured, complete, usable, imageInput, ownerRef, workflowFor, setRecorder, KIND_TO_WORKFLOW, AUDIENCE };
