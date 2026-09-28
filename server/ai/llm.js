/**
 * llm.js — the ONE chat-completion entry point for OpenVibe.Live.
 *
 * Every feature (AI viewers, overviews, chat insights, vision, paste analysis) calls complete().
 * Live calls no model provider itself and keeps no shared provider key (roadmap WS-O task 2):
 * complete() is a workflow run on OpenVibe.AI (ai-service.js), one of two kinds:
 *   - a streamer's own key stored in OpenVibe.AI (o.provider.credentialSubject, byo-credentials.js):
 *     a run with credential { subject }, within the budget the streamer set there;
 *   - every other call: gated on the admin master switch (ai_enabled) + the global daily budget,
 *     then a run of the workflow that owns the feature (ai-service KIND_TO_WORKFLOW).
 * Both are recorded in ai_usage (role, provider, latency, the run's cost), so per-streamer budgets
 * and the admin cost views keep working. A raw key / base URL override (the old direct "bring your
 * own" path) is refused: every stored key moved to OpenVibe.AI.
 *
 * testProvider() is the one direct provider call left (see there). toVisionJpeg() downscales any
 * image before it is sent; parseJsonLoose() repairs the JSON models commonly get slightly wrong.
 */
'use strict';
const fs = require('fs');
const db = require('../db/database');
const aiService = require('./ai-service');
const egress = require('../net/egress');

const ROLES = ['chat', 'vision', 'director', 'summary', 'legacy'];

function b(k) { const v = db.getSetting(k); return v === true || v === 'true' || v === 1 || v === '1'; }
function num(k, d) { const v = parseFloat(db.getSetting(k)); return Number.isFinite(v) ? v : d; }

// ── Gates ────────────────────────────────────────────────────
// The provider key lives in OpenVibe.AI, so the admin master switch and AI_SERVICE (not off) decide.
function isEnabled() { return b('ai_enabled') && aiService.enabled(); }
function withinBudget() {
    const cap = num('ai_max_cost_usd_per_day', 0);
    if (!cap || cap <= 0) return true;
    try { return db.getAiCostToday() < cap; } catch { return true; }
}

// ── Images ───────────────────────────────────────────────────
async function _loadImage(image) {
    if (!image) return null;
    if (Buffer.isBuffer(image)) return image;
    if (typeof image !== 'string') return null;
    if (image.startsWith('data:')) {
        const m = image.match(/^data:([^;]+);base64,(.*)$/);
        return m ? Buffer.from(m[2], 'base64') : null;
    }
    if (/^https?:\/\//i.test(image)) {
        try {
            const res = await fetch(image, { signal: AbortSignal.timeout(20000) });
            if (!res.ok) { console.warn(`[AI] image fetch ${res.status} for ${image}`); return null; }
            const buf = Buffer.from(await res.arrayBuffer());
            return buf.length ? buf : null;
        } catch (e) { console.warn('[AI] image fetch failed:', e.message); return null; }
    }
    if (/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 40)) && !fs.existsSync(image)) {
        try { return Buffer.from(image, 'base64'); } catch { return null; }
    }
    try { return fs.readFileSync(image); } catch { return null; }
}
/** Any image input → downscaled JPEG data URL (sharp). Falls back to the original bytes. */
async function toVisionJpeg(image, { maxWidth = 1280, quality = 82 } = {}) {
    const buf = await _loadImage(image);
    if (!buf) return null;
    try {
        const sharp = require('sharp');
        const out = await sharp(buf, { failOn: 'none', animated: false })
            .rotate()
            .resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality })
            .toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch {
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
}

function parseJsonLoose(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* */ }
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    let raw = m[0];
    try { return JSON.parse(raw); } catch { /* repair */ }
    try {
        let t = raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1');
        const osq = (t.match(/\[/g) || []).length, csq = (t.match(/\]/g) || []).length;
        if (osq > csq) { t = t.replace(/\}\s*$/, ''); t += ']'.repeat(osq - csq); }
        const ocb = (t.match(/\{/g) || []).length, ccb = (t.match(/\}/g) || []).length;
        if (ocb > ccb) t += '}'.repeat(ocb - ccb);
        return JSON.parse(t);
    } catch { return null; }
}

function _meter(o, role, r, provider) {
    try {
        db.recordAiUsage({
            kind: o.kind || role, model: r.model, input_tokens: r.usage.input, output_tokens: r.usage.output, cached_tokens: r.usage.cached || 0,
            cost_usd: r.cost || 0, owner_user_id: o.ownerUserId || null, source: o.source || null, role, provider, latency_ms: r.latencyMs,
        });
    } catch { /* metering is best-effort */ }
}

let _overrideWarned = false;

/**
 * The call.
 * @param {object} o
 *  role, system (string | [{text, cache}]), messages ([{role, content}]), user (shortcut: appended user msg),
 *  image (data URL | http url | path | Buffer), imageMaxWidth (default 1024), json ({name, schema, strict?}),
 *  maxTokens, temperature, timeoutMs, cacheKey, kind (ai_usage.kind), source, ownerUserId,
 *  provider ({ credentialSubject }: a streamer's own key stored in OpenVibe.AI)
 * @returns {Promise<null|{text:string, json:object|null, usage:{input,output,cached}, model:string, provider:string, latencyMs:number}>}
 */
async function complete(o = {}) {
    const role = ROLES.includes(o.role) ? o.role : 'legacy';
    if (o.provider) {
        // A streamer's own key stored in OpenVibe.AI (byo-credentials.js): a run with credential { subject };
        // AI calls their provider with it, within their daily budget. Metered here as 'byo'.
        if (o.provider.credentialSubject) {
            if (!aiService.enabled()) return null;
            const r = await aiService.complete({ ...o, role, credentialSubject: o.provider.credentialSubject }, { toVisionJpeg });
            if (!r) return null;
            if (o.json && !r.json) r.json = parseJsonLoose(r.text);
            _meter(o, role, r, 'byo');
            return r;
        }
        // A raw key or base URL: Live no longer calls a provider with one, and never falls back to the shared AI.
        if (!_overrideWarned) {
            _overrideWarned = true;
            console.warn(`[AI] ${role}/${o.kind || role}: a raw provider key/base URL is no longer called from Live (keys live in OpenVibe.AI); no answer`);
        }
        return null;
    }
    if (!isEnabled() || !withinBudget()) return null;
    const r = await aiService.complete({ ...o, role }, { toVisionJpeg });
    if (!r) { console.warn(`[AI] ${role}/${o.kind || role} via OpenVibe.AI returned no answer`); return null; }
    if (o.json && !r.json) r.json = parseJsonLoose(r.text);
    _meter(o, role, r, 'openvibe-ai');
    return r;
}

/**
 * "Test connection" for a key a streamer has just typed for their AI viewers (POST /api/ai-viewers/byo/test),
 * before it is saved: a one-word request to their provider. This is the ONE direct provider call left in Live,
 * because the key is not in OpenVibe.AI yet (it goes there only when the streamer saves it), so there is nothing
 * AI could run it with. The address is the streamer's choice, so the request goes out through the egress guard
 * (server/net/egress.js): never to Live's own port or any private address, redirects not followed. Nothing is
 * metered and only ok / an HTTP status comes back, never the provider's answer.
 * override = { kind?: 'openai'|'anthropic', baseUrl?, apiKey?, model?, models?: { chat } }
 */
async function testProvider(override = null) {
    if (!override || override.credentialSubject) return { ok: false, error: 'No key to test' };
    const typed = String(override.baseUrl || '').trim().replace(/\/+$/, '');
    const kind = override.kind === 'anthropic' || /anthropic\.com/i.test(typed) ? 'anthropic' : 'openai';
    const baseUrl = typed || (kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
    const model = String((override.models && override.models.chat) || override.model || 'gpt-4o-mini');
    const apiKey = String(override.apiKey || '');
    if (!apiKey && /api\.openai\.com|anthropic\.com/i.test(baseUrl)) return { ok: false, error: 'Enter your API key to test it' };
    const prompt = [{ role: 'user', content: 'Reply with the single word: ok' }];
    let url, headers, body;
    if (kind === 'anthropic') {
        url = `${baseUrl}/messages`;
        headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
        body = { model, max_tokens: 5, temperature: 0, messages: prompt };
    } else {
        url = `${baseUrl}/chat/completions`;
        headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        body = { model, messages: prompt };
        // Reasoning models (gpt-5, o-series) take max_completion_tokens and think before they answer.
        if (/^(gpt-5|o\d)/i.test(model)) { body.max_completion_tokens = 768; body.reasoning_effort = /^gpt-5/i.test(model) ? 'minimal' : 'low'; }
        else { body.max_tokens = 5; body.temperature = 0; }
    }
    const started = Date.now();
    try {
        const r = await egress.postJson(url, body, { headers, timeoutMs: 15000, maxBytes: 256 * 1024 });
        if (r.status >= 200 && r.status < 300) return { ok: true, model, latencyMs: Date.now() - started };
        return { ok: false, error: `The provider answered HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
}

// Remote structured workflows (translate, paste/frame analysis, overviews, recap) meter here too.
aiService.setRecorder((r, m) => db.recordAiUsage({
    kind: m.kind || (r.workflow && r.workflow.key) || 'remote', model: (r.provenance && r.provenance.model) || null,
    input_tokens: (r.usage && r.usage.tokens_in) || 0, output_tokens: (r.usage && r.usage.tokens_out) || 0, cached_tokens: 0,
    cost_usd: (r.usage && r.usage.cost_usd) || 0, owner_user_id: m.ownerUserId || null, source: m.source || null, role: m.role || null, provider: 'openvibe-ai', latency_ms: null,
}));

module.exports = { complete, testProvider, toVisionJpeg, parseJsonLoose, isEnabled, withinBudget, ROLES };
