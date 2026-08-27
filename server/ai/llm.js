/**
 * llm.js — the ONE chat-completion entry point for OpenVibe.Live.
 *
 * Every feature (AI viewers, overviews, chat insights, vision, paste analysis) calls
 * complete(); it is the single place that:
 *   - gates on the admin master switch + global daily budget (shared key), or routes
 *     to a streamer's BYO provider (uniformly metered either way);
 *   - picks the model per ROLE (chat / vision / director / summary) with per-role admin
 *     overrides and BYO equivalents, falling back to the default model;
 *   - talks to Anthropic or any OpenAI-compatible endpoint with real system/user roles
 *     (the old code flattened everything into one user message, which made prompt
 *     caching impossible);
 *   - uses prompt caching: Anthropic cache_control on the stable system blocks, OpenAI
 *     automatic prefix caching + prompt_cache_key;
 *   - supports structured JSON output (OpenAI json_schema, Anthropic forced tool), with a
 *     prose-JSON repair fallback for gateways that lack it;
 *   - always downscales images before sending them;
 *   - applies a timeout and ONE retry on transient failures;
 *   - records usage (incl. cached tokens, role, provider, latency) with per-model pricing.
 */
'use strict';
const fs = require('fs');
const db = require('../db/database');

const ROLES = ['chat', 'vision', 'director', 'summary', 'legacy'];
const DEFAULT_TIMEOUT_MS = { chat: 20000, vision: 30000, director: 25000, summary: 30000, legacy: 30000 };

function s(k) { return (db.getSetting(k) || '').toString().trim(); }
function b(k) { const v = db.getSetting(k); return v === true || v === 'true' || v === 1 || v === '1'; }
function num(k, d) { const v = parseFloat(db.getSetting(k)); return Number.isFinite(v) ? v : d; }

// ── Gates ────────────────────────────────────────────────────
function isEnabled() { return b('ai_enabled') && !!s('ai_api_key'); }
function withinBudget() {
    const cap = num('ai_max_cost_usd_per_day', 0);
    if (!cap || cap <= 0) return true;
    try { return db.getAiCostToday() < cap; } catch { return true; }
}
function defaultModel() { return s('ai_model') || (s('ai_provider') === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o-mini'); }

/** Model for a role: admin per-role override → default model. */
function modelForRole(role) {
    const r = ROLES.includes(role) ? role : 'legacy';
    if (r !== 'legacy') { const m = s(`ai_model_${r}`); if (m) return m; }
    return defaultModel();
}

/**
 * Resolve the provider for a call.
 * override = { kind?: 'openai'|'anthropic', baseUrl?, apiKey?, model?, models?: {chat,vision,...} }
 */
function resolveProvider(role, override = null) {
    if (override && (override.apiKey || override.baseUrl)) {
        const baseUrl = String(override.baseUrl || '').trim().replace(/\/+$/, '');
        const kind = override.kind || (/anthropic\.com/i.test(baseUrl) ? 'anthropic' : 'openai');
        const model = (override.models && override.models[role]) || override.model || 'gpt-4o-mini';
        return { kind, baseUrl: baseUrl || (kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'), apiKey: override.apiKey || '', model, shared: false };
    }
    const baseUrl = (s('ai_base_url') || '').replace(/\/+$/, '');
    // Anthropic only when explicitly chosen (and not pointed at an OpenAI-compatible
    // gateway); everything else — openai, openrouter, groq, ollama, blank — is OpenAI-shaped.
    const kind = s('ai_provider') === 'anthropic' && (!baseUrl || /anthropic\.com/i.test(baseUrl)) ? 'anthropic' : 'openai';
    return {
        kind,
        baseUrl: baseUrl || (kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
        apiKey: s('ai_api_key'),
        model: modelForRole(role),
        shared: true,
    };
}

// ── Pricing ──────────────────────────────────────────────────
// site_settings.ai_pricing_json = { "gpt-5-nano": {"in":0.05,"out":0.4,"cached":0.005}, "default": {...} }
// (USD per million tokens). Longest key-prefix match on the model id; falls back to the
// flat ai_input/output_cost_per_mtok settings, cached input = 10% of input.
let _pricingCache = { at: 0, table: null };
function pricingTable() {
    if (Date.now() - _pricingCache.at < 30000 && _pricingCache.table) return _pricingCache.table;
    let table = {};
    try {
        const raw = db.getSetting('ai_pricing_json');   // type 'json' → already parsed
        table = (raw && typeof raw === 'object') ? raw : (raw ? JSON.parse(String(raw)) : {}) || {};
    } catch { table = {}; }
    _pricingCache = { at: Date.now(), table };
    return table;
}
function priceFor(model) {
    const table = pricingTable();
    const m = String(model || '').toLowerCase();
    let best = null, bestLen = -1;
    for (const [k, v] of Object.entries(table)) {
        const key = String(k).toLowerCase();
        if (key === 'default') continue;
        if (m.startsWith(key) && key.length > bestLen && v && typeof v === 'object') { best = v; bestLen = key.length; }
    }
    if (!best && table.default && typeof table.default === 'object') best = table.default;
    const inRate = best && Number.isFinite(Number(best.in)) ? Number(best.in) : num('ai_input_cost_per_mtok', 3);
    const outRate = best && Number.isFinite(Number(best.out)) ? Number(best.out) : num('ai_output_cost_per_mtok', 15);
    const cachedRate = best && Number.isFinite(Number(best.cached)) ? Number(best.cached) : inRate * 0.1;
    return { in: inRate, out: outRate, cached: cachedRate };
}
/** usage = { input (total prompt tokens incl. cached), output, cached } */
function estimateCost(model, usage) {
    const p = priceFor(model);
    const input = Math.max(0, (usage.input || 0) - (usage.cached || 0));
    return (input / 1e6) * p.in + ((usage.cached || 0) / 1e6) * p.cached + ((usage.output || 0) / 1e6) * p.out;
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
function _splitDataUrl(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/);
    return m ? { mediaType: m[1], base64: m[2] } : null;
}

// ── Message shaping ──────────────────────────────────────────
function _systemBlocks(system) {
    if (!system) return [];
    if (typeof system === 'string') return system.trim() ? [{ text: system, cache: false }] : [];
    return system.filter(x => x && String(x.text || '').trim()).map(x => ({ text: String(x.text), cache: !!x.cache }));
}
function _normMessages(messages, user) {
    const out = [];
    for (const m of (messages || [])) {
        if (!m || !m.role) continue;
        out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
    if (user) out.push({ role: 'user', content: user });
    if (!out.length) out.push({ role: 'user', content: '' });
    return out;
}

function _isReasoningModel(m) { return /^(gpt-5|o\d)/i.test(m || ''); }

function _openaiBody({ p, system, messages, img, json, maxTokens, temperature, cacheKey, jsonMode }) {
    const msgs = [];
    const sysText = system.map(x => x.text).join('\n\n');
    if (sysText) msgs.push({ role: 'system', content: sysText });
    messages.forEach((m, i) => {
        const last = i === messages.length - 1;
        if (last && img && m.role === 'user') {
            const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
            msgs.push({ role: 'user', content: [...parts, { type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } }] });
        } else msgs.push({ role: m.role, content: Array.isArray(m.content) ? m.content : String(m.content || '') });
    });
    const body = { model: p.model, messages: msgs };
    if (_isReasoningModel(p.model)) {
        body.max_completion_tokens = Math.max(maxTokens, 256) + 512;
        body.reasoning_effort = /^gpt-5/i.test(p.model) ? 'minimal' : 'low';
    } else {
        body.max_tokens = maxTokens;
        if (temperature != null) body.temperature = temperature;
    }
    if (json && jsonMode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: json.name || 'result', schema: json.schema, strict: json.strict !== false } };
    else if (json && jsonMode === 'object') body.response_format = { type: 'json_object' };
    if (cacheKey && /api\.openai\.com/i.test(p.baseUrl)) body.prompt_cache_key = String(cacheKey).slice(0, 64);
    return body;
}
function _anthropicBody({ p, system, messages, img, json, maxTokens, temperature }) {
    const body = { model: p.model, max_tokens: Math.max(1, maxTokens) };
    if (system.length) {
        body.system = system.map(x => x.cache ? { type: 'text', text: x.text, cache_control: { type: 'ephemeral' } } : { type: 'text', text: x.text });
    }
    body.messages = messages.map((m, i) => {
        const last = i === messages.length - 1;
        const content = Array.isArray(m.content)
            ? m.content.map(c => (c.type === 'text' ? { type: 'text', text: c.text } : c))
            : [{ type: 'text', text: String(m.content || '') }];
        if (last && img && m.role === 'user') content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
        return { role: m.role, content };
    });
    if (temperature != null) body.temperature = temperature;
    if (json) {
        body.tools = [{ name: json.name || 'result', description: json.description || 'Return the result.', input_schema: json.schema }];
        body.tool_choice = { type: 'tool', name: json.name || 'result' };
    }
    return body;
}

// ── HTTP ─────────────────────────────────────────────────────
class LlmHttpError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body; } }

async function _post(url, headers, body, timeoutMs) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
    if (!res.ok) throw new LlmHttpError(res.status, (j.error && (j.error.message || j.error)) || `HTTP ${res.status}: ${text.slice(0, 200)}`, j);
    return j;
}

async function _callOpenAI(p, args, timeoutMs) {
    const headers = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
    let jsonMode = args.json ? 'schema' : null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const body = _openaiBody({ ...args, p, jsonMode });
        try {
            const j = await _post(`${p.baseUrl}/chat/completions`, headers, body, timeoutMs);
            const msg = j.choices && j.choices[0] && j.choices[0].message;
            const text = (msg && typeof msg.content === 'string' ? msg.content : '').trim();
            const u = j.usage || {};
            return { text, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 } };
        } catch (e) {
            // Gateways without structured-output support: step down schema → json_object → prose.
            if (e instanceof LlmHttpError && e.status === 400 && jsonMode && /response_format|json_schema|schema|strict/i.test(e.message)) {
                jsonMode = jsonMode === 'schema' ? 'object' : null;
                continue;
            }
            throw e;
        }
    }
    throw new Error('structured output unsupported');
}
async function _callAnthropic(p, args, timeoutMs) {
    const body = _anthropicBody({ ...args, p });
    const j = await _post(`${p.baseUrl}/messages`, { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }, body, timeoutMs);
    const content = j.content || [];
    let text = content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    let jsonOut = null;
    const tool = content.find(c => c.type === 'tool_use');
    if (tool && tool.input) { jsonOut = tool.input; if (!text) text = JSON.stringify(tool.input); }
    const u = j.usage || {};
    const cached = u.cache_read_input_tokens || 0;
    return { text, json: jsonOut, usage: { input: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached } };
}

function _retryable(e) {
    if (!e) return false;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
    if (e instanceof LlmHttpError) return e.status === 429 || e.status >= 500;
    return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(e.message || '');
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

/**
 * The call.
 * @param {object} o
 *  role, system (string | [{text, cache}]), messages ([{role, content}]), user (shortcut: appended user msg),
 *  image (data URL | http url | path | Buffer), imageMaxWidth (default 1024), json ({name, schema, strict?}),
 *  maxTokens, temperature, timeoutMs, retries (default 1), cacheKey,
 *  kind (ai_usage.kind), source, ownerUserId, provider (BYO override), skipGate (internal)
 * @returns {Promise<null|{text:string, json:object|null, usage:{input,output,cached}, model:string, provider:string, latencyMs:number}>}
 */
async function complete(o = {}) {
    const role = ROLES.includes(o.role) ? o.role : 'legacy';
    const p = resolveProvider(role, o.provider || null);
    if (p.shared) { if (!isEnabled() || !withinBudget()) return null; }
    else if (!p.apiKey && !/localhost|127\.0\.0\.1|:\d+$/.test(p.baseUrl) && /api\.openai\.com|anthropic\.com/i.test(p.baseUrl)) return null;

    let img = null;
    if (o.image) {
        const dataUrl = await toVisionJpeg(o.image, { maxWidth: o.imageMaxWidth || 1024, quality: o.imageQuality || 78 });
        img = dataUrl ? _splitDataUrl(dataUrl) : null;
        if (!img) return null;
    }
    const args = {
        system: _systemBlocks(o.system),
        messages: _normMessages(o.messages, o.user),
        img,
        json: o.json || null,
        maxTokens: Math.max(1, Math.round(o.maxTokens || 400)),
        temperature: o.temperature == null ? null : o.temperature,
        cacheKey: o.cacheKey || null,
    };
    const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS[role] || 25000;
    const retries = o.retries == null ? 1 : Math.max(0, o.retries);
    const started = Date.now();
    let r = null, lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            r = p.kind === 'anthropic' ? await _callAnthropic(p, args, timeoutMs) : await _callOpenAI(p, args, timeoutMs);
            break;
        } catch (e) {
            lastErr = e;
            if (attempt < retries && _retryable(e)) { await new Promise(res => setTimeout(res, 800 + Math.random() * 700)); continue; }
            break;
        }
    }
    if (!r) { console.warn(`[AI] ${role}/${p.model} failed:`, lastErr && lastErr.message); return null; }
    const latencyMs = Date.now() - started;
    const usage = r.usage || { input: 0, output: 0, cached: 0 };
    if (!usage.input && !usage.output) {
        // Self-hosted servers often omit usage — estimate so budgets still mean something.
        const approx = (t) => Math.ceil(String(t || '').length / 4);
        usage.input = approx(args.system.map(x => x.text).join('')) + args.messages.reduce((n, m) => n + approx(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0) + (img ? 800 : 0);
        usage.output = approx(r.text);
        usage.estimated = true;
    }
    const cost = estimateCost(p.model, usage);
    try {
        db.recordAiUsage({
            kind: o.kind || role, model: p.model, input_tokens: usage.input, output_tokens: usage.output, cached_tokens: usage.cached || 0,
            cost_usd: cost, owner_user_id: o.ownerUserId || null, source: o.source || null, role, provider: p.shared ? 'shared' : 'byo', latency_ms: latencyMs,
        });
    } catch { /* metering is best-effort */ }
    let json = r.json || null;
    if (o.json && !json) json = parseJsonLoose(r.text);
    return { text: r.text || '', json, usage, model: p.model, provider: p.kind, shared: p.shared, latencyMs, cost };
}

/** 1-token connectivity probe for a provider override (BYO test) or the shared key. */
async function testProvider(override = null) {
    try {
        const r = await complete({ role: 'chat', user: 'Reply with the single word: ok', maxTokens: 5, temperature: 0, timeoutMs: 15000, retries: 0, kind: 'status_check', provider: override, skipGate: true });
        return r ? { ok: true, model: r.model, latencyMs: r.latencyMs } : { ok: false, error: 'AI disabled, over budget, or the provider rejected the request' };
    } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { complete, testProvider, resolveProvider, modelForRole, priceFor, estimateCost, toVisionJpeg, parseJsonLoose, isEnabled, withinBudget, defaultModel, ROLES };
