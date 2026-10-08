'use strict';
/**
 * A streamer's own provider key lives in OpenVibe.AI (roadmap WS-O task 2; Contracts 0.74.0 ai.credential.manage).
 *
 * When a streamer saves a key for their AI viewers, Live forwards it once to OpenVibe.AI
 * (PUT /api/v1/credentials/:subject, with Live's service token for audience openvibe.ai) and keeps only
 * channel_ai_config.byo_in_ai = 1; the key column is emptied. Their viewers then run as workflow runs on AI with
 * credential { subject } (llm.complete → ai-service.complete), so the key is used only by AI, only for them, and
 * only within the daily budget they set. A change of model keeps the stored key; a new provider address needs the
 * key again (AI answers 400 credential.key_required).
 *
 * moveLocal(userId) moves a key still stored in Live the same way (scripts/move-byo-keys-to-ai.js runs it for every
 * channel once). The key is never logged.
 */
const db = require('../db/database');

function baseUrl() { return String(process.env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700').replace(/\/+$/, ''); }

async function subjectOf(userId) {
    const r = await db.getDb().prepare("SELECT subject_id FROM linked_accounts WHERE user_id = ? AND service = 'network' AND subject_id IS NOT NULL ORDER BY id LIMIT 1").get(userId);
    return r ? r.subject_id : null;
}

/** openai | anthropic, from the streamer's settings (settings_json.byo.provider) or the address. */
function providerOf(cfg) {
    let extra = {};
    try { extra = (JSON.parse(cfg.settings_json || '{}') || {}).byo || {}; } catch { extra = {}; }
    if (extra.provider === 'anthropic' || /anthropic\.com/i.test(String(cfg.byo_base_url || extra.base_url || ''))) return 'anthropic';
    return 'openai';
}

/** Models per role from the streamer's settings, the chosen model as the default. */
function modelsOf(cfg) {
    let extra = {};
    try { extra = (JSON.parse(cfg.settings_json || '{}') || {}).byo || {}; } catch { extra = {}; }
    const models = { chat: String(cfg.byo_model || extra.model || 'gpt-4o-mini').slice(0, 120) };
    for (const role of ['vision', 'director', 'summary']) {
        const m = extra[`model_${role}`] || (extra.models && extra.models[role]);
        if (m) models[role] = String(m).slice(0, 120);
    }
    return models;
}

/** The https address to send with the key (the provider's own when none was set). */
function addressOf(cfg, provider) {
    const raw = String(cfg.byo_base_url || '').trim().replace(/\/+$/, '');
    if (raw) return raw;
    return provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
}

async function call(method, subject, body) {
    const principal = require('../net/network-principal');
    for (let attempt = 0; attempt < 2; attempt++) {
        let headers;
        try { headers = await principal.serviceHeaders('openvibe.ai'); } catch (e) { return { ok: false, status: 503, body: { code: 'credentials.unavailable', detail: `no service token for openvibe.ai: ${e.message}` } }; }
        let res;
        try {
            res = await fetch(`${baseUrl()}/api/v1/credentials/${encodeURIComponent(subject)}`, {
                method, headers: { ...headers, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
            });
        } catch (e) { return { ok: false, status: 503, body: { code: 'credentials.unavailable', detail: 'OpenVibe.AI did not answer' } }; }
        if (res.status === 401 && attempt === 0) { principal.invalidate('openvibe.ai'); continue; }
        let data = {};
        try { data = res.status === 204 ? {} : await res.json(); } catch { data = {}; }
        return { ok: res.ok, status: res.status, body: data };
    }
    return { ok: false, status: 503, body: { code: 'credentials.unavailable' } };
}

/**
 * Store (or update) the streamer's credential in AI. apiKey may be omitted to keep the stored key (a model or
 * budget change). → { ok, status, body } (body: ai.credential@1, or a problem with `code`).
 */
async function store(userId, cfg, { apiKey = null } = {}) {
    const subject = await subjectOf(userId);
    if (!subject) return { ok: false, status: 409, body: { code: 'credentials.no_subject', detail: 'this channel has no Network account linked' } };
    const provider = providerOf(cfg);
    const put = { provider, base_url: addressOf(cfg, provider), models: modelsOf(cfg) };
    if (apiKey) put.api_key = String(apiKey);
    return await call('PUT', subject, put);
}

async function remove(userId) {
    const subject = await subjectOf(userId);
    if (!subject) return { ok: true, status: 204, body: {} };
    return await call('DELETE', subject);
}

/**
 * A saved AI-viewer config, before Live writes its own columns. byoKey: a new key (string), null to remove the stored
 * one, undefined to keep it. A new key, or a new address or model while the key is in AI, goes to AI; `fields` then
 * gets byo_key '' and byo_in_ai. → null when Live may save, else { status, error, code } to answer with.
 */
async function applyConfig(userId, before, byoKey, fields) {
    const newKey = typeof byoKey === 'string' && byoKey.trim() !== '' ? byoKey.trim() : null;
    if (byoKey === null && (before.byo_in_ai || before.byo_key)) {
        const r = await remove(userId);
        if (!r.ok && r.status !== 404) return { status: 502, error: 'Could not remove your key from OpenVibe.AI; try again', code: 'credentials.unavailable' };
        fields.byo_key = ''; fields.byo_in_ai = 0;
        return null;
    }
    if (!newKey && !(before.byo_in_ai && (fields.byo_base_url !== undefined || fields.byo_model !== undefined))) return null;
    const r = await store(userId, { ...before, ...fields }, { apiKey: newKey });
    if (!r.ok) {
        const code = (r.body && (r.body.code || r.body.error)) || null;
        if (code === 'credential.key_required') return { status: 400, error: 'Enter your key again to change the provider address', code };
        return { status: r.status >= 500 ? 502 : 400, error: (r.body && r.body.detail) || 'Could not store your key in OpenVibe.AI', code };
    }
    fields.byo_key = ''; fields.byo_in_ai = 1;
    return null;
}

/** Move a key still stored in Live to AI; on success the local key is erased. → 'moved' | 'none' | '<code>' */
async function moveLocal(userId) {
    const cfg = await db.getChannelAiConfig(userId);
    const key = String(cfg.byo_key || '').trim();
    if (!key) return 'none';
    const r = await store(userId, cfg, { apiKey: key });
    if (!r.ok) return (r.body && (r.body.code || r.body.error)) || `http_${r.status}`;
    await db.upsertChannelAiConfig(userId, { byo_key: '', byo_in_ai: 1 });
    return 'moved';
}

module.exports = { store, remove, moveLocal, applyConfig, subjectOf, providerOf, modelsOf, addressOf };
