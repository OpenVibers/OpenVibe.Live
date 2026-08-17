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

    // BYO key (OpenAI-compatible) — unmetered by the provider; record an estimate.
    const cfg = st.cfg;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    const userContent = image
        ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: image } }]
        : user;
    messages.push({ role: 'user', content: userContent });
    let text;
    try {
        text = await aiProvider.chatCompletion({
            baseUrl: cfg.byo_base_url || aiProvider.DEFAULT_BASE_URL,
            apiKey: cfg.byo_key,
            model: cfg.byo_model || 'gpt-4o-mini',
            messages, temperature, maxTokens,
        });
    } catch (e) {
        console.warn('[AI-Viewers] BYO completion failed:', e.message);
        return null;
    }
    try {
        const inTok = approxTokens(system) + approxTokens(user) + (image ? 800 : 0);
        const outTok = approxTokens(text);
        db.recordAiUsage({
            kind: 'ai_viewers', model: cfg.byo_model || 'byo',
            input_tokens: inTok, output_tokens: outTok,
            cost_usd: ai.estimateCost(inTok, outTok),
            owner_user_id: userId, source: SOURCE,
        });
    } catch { /* metering is best-effort */ }
    return (text || '').trim() || null;
}

module.exports = { generate, budgetStatus, byoUsable, SOURCE };
