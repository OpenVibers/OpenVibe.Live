'use strict';
/**
 * A streamer's daily AI-viewer budget is an AI quota (roadmap WS-O task 2; Contracts 0.75.0
 * ai.quota.attribution.manage). When the streamer uses the shared key with a daily budget
 * (channel_ai_config.use_shared_key and daily_budget_cents), Live sets the cap on OpenVibe.AI for their attribution
 * live:user:<id>, workflows live.viewers.*: PUT /api/v1/attribution-quotas/live:user:<id> { window: 'day',
 * max_cost_usd, workflow_prefix: 'live.viewers.' }. AI then refuses a viewer run over the cap before any provider is
 * called, whatever Live's own pre-check says. No budget, or their own key (which has its own budget in AI), removes
 * the cap. Live's budget.js keeps reading today's spend for the degradation ladder.
 *
 * sync(userId) → 'set' | 'removed' | 'none' | '<code>'. scripts/sync-viewer-quotas.js runs it for every channel.
 */
const db = require('../db/database');

const PREFIX = 'live.viewers.';

function baseUrl() { return String(process.env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700').replace(/\/+$/, ''); }

async function call(method, userId, body) {
    const principal = require('../net/network-principal');
    const url = `${baseUrl()}/api/v1/attribution-quotas/${encodeURIComponent(`live:user:${userId}`)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
        let headers;
        try { headers = await principal.serviceHeaders('openvibe.ai'); } catch { return { ok: false, status: 503, body: { code: 'quota.unavailable' } }; }
        let res;
        try {
            res = await fetch(url, { method, headers: { ...headers, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
        } catch { return { ok: false, status: 503, body: { code: 'quota.unavailable' } }; }
        if (res.status === 401 && attempt === 0) { principal.invalidate('openvibe.ai'); continue; }
        let data = {};
        try { data = res.status === 204 ? {} : await res.json(); } catch { data = {}; }
        return { ok: res.ok, status: res.status, body: data };
    }
    return { ok: false, status: 503, body: { code: 'quota.unavailable' } };
}

/** Make AI's cap match the streamer's settings. */
async function sync(userId) {
    const id = parseInt(userId, 10);
    if (!(id > 0)) return 'none';
    const cfg = db.getChannelAiConfig(id);
    const cents = Number(cfg.daily_budget_cents) || 0;
    if (cfg.use_shared_key && cents > 0) {
        const r = await call('PUT', id, { window: 'day', max_cost_usd: Math.round(cents) / 100, workflow_prefix: PREFIX });
        return r.ok ? 'set' : ((r.body && (r.body.code || r.body.error)) || `http_${r.status}`);
    }
    const r = await call('DELETE', id);
    if (r.status === 404) return 'none';
    return r.ok ? 'removed' : ((r.body && (r.body.code || r.body.error)) || `http_${r.status}`);
}

module.exports = { sync, PREFIX };
