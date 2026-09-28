/**
 * AI Chat Viewers — budget + cost routing.
 *
 * Every bot line is a run on OpenVibe.AI (viewers/ai-run.js, templates live.viewers.*), either way:
 *   - the site's AI (default), metered + capped per streamer at
 *     channel_ai_config.daily_budget_cents (default 20¢/day). Over the cap → bots
 *     go quiet (returns null). Also respects the admin master switch + global cap.
 *   - the streamer's own key, stored in OpenVibe.AI (byo_in_ai; their provider bills
 *     them, within the budget they set there). Usage is still recorded for display.
 *     A key that never moved there is not used: Live calls no provider itself.
 *
 * Spend is attributed to the streamer via ai_usage.owner_user_id with
 * source='ai_viewers', which is the foundation for per-streamer budgets + billing.
 */
const db = require('../../db/database');
const ai = require('../ai-analysis');

const SOURCE = 'ai_viewers';

// Only a key stored in OpenVibe.AI runs; a key (or keyless self-hosted address) left in Live's
// database would need Live to call the provider itself, which it no longer does.
function byoUsable(cfg) { return !!cfg.byo_in_ai; }

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
 * The provider for a streamer's own-key settings (column fields + settings_json.byo). A key stored in OpenVibe.AI
 * (byo_in_ai, WS-O task 2) is named by the streamer's subject, for viewers/ai-run.js; the key itself never comes back
 * here. Otherwise the typed key, address and models, which only llm.testProvider uses ("test connection" before
 * the key is saved to OpenVibe.AI).
 */
function byoProvider(cfg) {
    if (cfg.byo_in_ai) {
        const subject = require('../byo-credentials').subjectOf(cfg.user_id);
        return subject ? { credentialSubject: subject } : null;
    }
    let extra = {};
    try { extra = (JSON.parse(cfg.settings_json || '{}') || {}).byo || {}; } catch { extra = {}; }
    const models = {};
    for (const role of ['chat', 'vision', 'director', 'summary']) {
        const m = extra[`model_${role}`] || (extra.models && extra.models[role]);
        if (m) models[role] = String(m);
    }
    return {
        baseUrl: cfg.byo_base_url || extra.base_url || '',
        apiKey: cfg.byo_key || '',
        model: cfg.byo_model || extra.model || 'gpt-4o-mini',
        models,
        kind: extra.provider === 'anthropic' ? 'anthropic' : undefined,
    };
}

/**
 * Today's spend of the site's AI on AI viewers across ALL channels (global viewers cap): every row but a streamer's
 * own key. Runs on OpenVibe.AI are recorded as 'openvibe-ai' (the old direct calls were 'shared'), so counting only
 * 'shared' stopped counting anything once AI_SERVICE=remote went live.
 */
function globalViewerSpendToday() {
    try { return db.get("SELECT COALESCE(SUM(cost_usd),0) AS c FROM ai_usage WHERE source = ? AND COALESCE(provider,'shared') <> 'byo' AND created_at >= date('now')", [SOURCE])?.c || 0; } catch { return 0; }
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

module.exports = { budgetStatus, status, byoUsable, byoProvider, globalViewerSpendToday, SOURCE };
