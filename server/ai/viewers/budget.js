/**
 * AI Chat Viewers — budget + cost routing.
 *
 * Every bot LLM call goes through generate(), which routes to either:
 *   - the SHARED OpenVibe.Live key (default), metered + capped per streamer at
 *     channel_ai_config.daily_budget_cents (default 20¢/day). Over the cap → bots
 *     go quiet (returns null). Also respects the admin master switch + global cap.
 *   - the streamer's BYO key (uncapped; their provider bills them). Usage is still
 *     recorded (estimated) for display.
 *
 * Spend is attributed to the streamer via ai_usage.owner_user_id with
 * source='ai_viewers', which is the foundation for per-streamer budgets + billing.
 */
const db = require('../../db/database');
const ai = require('../ai-analysis');
const aiProvider = require('../ai-provider');

const SOURCE = 'ai_viewers';

// Rough token estimate from text length (~4 chars/token) — used only for the BYO
// path (whose provider doesn't report usage) so the dashboard meter has a number.
function approxTokens(str) { return Math.ceil((str || '').length / 4); }

function byoUsable(cfg) {
    if (cfg.byo_key && String(cfg.byo_key).trim()) return true;
    try { return aiProvider.isSelfHostedBaseUrl(cfg.byo_base_url); } catch { return false; }
}

/**
 * Snapshot of a streamer's AI-viewer budget state.
 * @returns {{ useShared:boolean, active:boolean, reason:string|null,
 *             spentToday:number, capUsd:number, cfg:object }}
 */
function budgetStatus(userId) {
    const cfg = db.getChannelAiConfig(userId);
    const useShared = !!cfg.use_shared_key;
    const spentToday = db.getAiCostTodayForUser(userId, SOURCE);
    const capUsd = (cfg.daily_budget_cents || 0) / 100;
    let active = false;
    let reason = null;
    if (useShared) {
        if (!ai.sharedKeyReady()) reason = 'shared_ai_disabled';
        else if (capUsd > 0 && spentToday >= capUsd) reason = 'over_daily_cap';
        else active = true;
    } else if (byoUsable(cfg)) {
        active = true;
    } else {
        reason = 'no_byo_key';
    }
    return { useShared, active, reason, spentToday, capUsd, cfg };
}

/**
 * Metered chat completion for a bot, routed by the streamer's key choice.
 * @returns {Promise<string|null>} the generated text, or null when the streamer is
 *   quiet (AI disabled / over cap / no usable key / provider error).
 */
async function generate(userId, { system = '', user = '', image = null, maxTokens = 80, temperature = 1.0 } = {}) {
    const st = budgetStatus(userId);
    if (!st.active) return null;

    if (st.useShared) {
        // Shared admin key: metered + attributed inside ai-analysis.viewerComplete.
        return ai.viewerComplete({ system, user, image, maxTokens, temperature, ownerUserId: userId });
    }

    // BYO key — same llm.js path as the shared key (real system role, caching, timeouts),
    // metered from the provider's usage report (estimated only when the server omits it).
    const r = await ai.llm.complete({
        role: 'chat', system, user, image, imageMaxWidth: 768, maxTokens, temperature,
        kind: 'ai_viewers', source: SOURCE, ownerUserId: userId,
        provider: byoProvider(st.cfg),
    });
    return r && r.text ? r.text.trim() || null : null;
}

/** llm.js provider override for a streamer's BYO settings (column fields + settings_json.byo). */
function byoProvider(cfg) {
    let extra = {};
    try { extra = (JSON.parse(cfg.settings_json || '{}') || {}).byo || {}; } catch { extra = {}; }
    const models = {};
    for (const role of ['chat', 'vision', 'director', 'summary']) {
        const m = extra[`model_${role}`] || (extra.models && extra.models[role]);
        if (m) models[role] = String(m);
    }
    return {
        baseUrl: cfg.byo_base_url || extra.base_url || aiProvider.DEFAULT_BASE_URL,
        apiKey: cfg.byo_key || '',
        model: cfg.byo_model || extra.model || 'gpt-4o-mini',
        models,
        kind: extra.provider === 'anthropic' ? 'anthropic' : undefined,
    };
}

/** Today's shared-key spend on AI viewers across ALL channels (global viewers cap). */
function globalViewerSpendToday() {
    try { return db.get("SELECT COALESCE(SUM(cost_usd),0) AS c FROM ai_usage WHERE source = ? AND COALESCE(provider,'shared') = 'shared' AND created_at >= date('now')", [SOURCE])?.c || 0; } catch { return 0; }
}

/**
 * v3 status with the degradation ladder. mode ∈ normal | economy | replies_only | streamer_only | silent.
 *   normal        < 60% of the daily cap spent
 *   economy       60–80%   (longer cadence, one fewer line per pass)
 *   replies_only  80–95%   (only replies to real viewers / the streamer)
 *   streamer_only 95–100%  (only the streamer fast path)
 *   silent        cap reached, AI disabled, kill switch, or global viewers cap reached
 */
function status(userId) {
    const st = budgetStatus(userId);
    const kill = (() => { const v = db.getSetting('ai_viewers_enabled'); return v === false || v === 'false' || v === 0 || v === '0'; })();
    let mode = 'normal';
    let reason = st.reason;
    if (kill) { mode = 'silent'; reason = 'kill_switch'; }
    else if (!st.active) mode = 'silent';
    else if (st.useShared) {
        const gcap = parseFloat(db.getSetting('ai_viewers_global_cap_usd_per_day')) || 0;
        if (gcap > 0 && globalViewerSpendToday() >= gcap) { mode = 'silent'; reason = 'global_viewers_cap'; }
        else if (st.capUsd > 0) {
            const ratio = st.spentToday / st.capUsd;
            mode = ratio >= 1 ? 'silent' : ratio >= 0.95 ? 'streamer_only' : ratio >= 0.8 ? 'replies_only' : ratio >= 0.6 ? 'economy' : 'normal';
            if (mode === 'silent') reason = 'over_daily_cap';
        }
    }
    return { ...st, mode, reason, active: st.active && mode !== 'silent' };
}

module.exports = { generate, budgetStatus, status, byoUsable, byoProvider, globalViewerSpendToday, SOURCE };
