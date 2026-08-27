/**
 * AI Chat Viewers 2.0 — dashboard API.  Mounted at /api/ai-viewers.
 *
 *   GET    /config                 my channel_ai_config + budget + usage
 *   PUT    /config                 save settings (byo_key preserved when blank)
 *   GET    /roster                 my persistent bot roster
 *   PATCH  /bots/:id               edit a bot (name / identity / active)
 *   POST   /bots/:id/clear-memory  wipe a bot's rolling memory
 *   DELETE /bots/:id               delete a bot
 *   POST   /clone                  clone a real chatter into a bot
 *   POST   /preview                generate one sample line (no posting)
 */
'use strict';
const express = require('express');
const db = require('../../db/database');
const { requireAuth } = require('../../auth/auth');
const chatAi = require('../chat-ai');
const budget = require('./budget');
const roster = require('./roster');
const brain = require('./brain');
const engine = require('./engine');

const router = express.Router();
const KEY_SENTINEL = '••••••••••••••••';

function sanitizeConfig(cfg) {
    const key = String(cfg.byo_key || '');
    return {
        enabled: !!cfg.enabled,
        num_ambient_bots: cfg.num_ambient_bots ?? 3,
        pacing_seconds: cfg.pacing_seconds ?? 45,
        persona: cfg.persona || '',
        transcribe_enabled: !!cfg.transcribe_enabled,
        vision_enabled: !!cfg.vision_enabled,
        use_shared_key: cfg.use_shared_key === undefined ? true : !!cfg.use_shared_key,
        daily_budget_cents: cfg.daily_budget_cents ?? 20,
        byo_base_url: cfg.byo_base_url || '',
        byo_model: cfg.byo_model || 'gpt-4o-mini',
        has_byo_key: !!key,
        byo_key_masked: key ? KEY_SENTINEL : '',
    };
}

function budgetSummary(userId) {
    const st = budget.budgetStatus(userId);
    return {
        active: st.active,
        reason: st.reason,
        use_shared_key: st.useShared,
        spent_today_usd: Math.round(st.spentToday * 10000) / 10000,
        cap_usd: st.capUsd,
    };
}

function botSummary(b) {
    let persona = {}; let brainObj = {};
    try { persona = JSON.parse(b.persona_json || '{}'); } catch { /* */ }
    try { brainObj = JSON.parse(b.brain_json || '{}'); } catch { /* */ }
    return {
        id: b.id,
        username: b.username,
        display_name: b.display_name || b.username,
        color: persona.color || b.avatar_color || '#8a8aff',
        source: b.source || 'ambient',
        character: (persona.character && persona.character.label) || '',
        blurb: (persona.character && persona.character.blurb) || '',
        identity: persona.identity || brainObj.identity || '',
        memory: brainObj.memory || '',
        is_active: !!b.is_active,
        msg_count: b.msg_count || 0,
        last_active_at: b.last_active_at || null,
        cloned_from: b.cloned_from_ref || null,
    };
}

// ── Config ────────────────────────────────────────────────────
function statusSafe(userId) { try { return engine.status(userId); } catch (e) { return { error: e.message }; } }

router.get('/config', requireAuth, (req, res) => {
    try {
        const cfg = db.getChannelAiConfig(req.user.id);
        res.json({
            config: sanitizeConfig(cfg),
            settings: settingsMod.getSettings(req.user.id, cfg),
            schema: settingsMod.describe(),
            budget: budgetSummary(req.user.id),
            status: statusSafe(req.user.id),
            engine: engine.version,
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load AI viewer config' });
    }
});

// ── v3 control surface ────────────────────────────────────────
router.get('/status', requireAuth, (req, res) => {
    try {
        const st = statusSafe(req.user.id);
        let stats = null; try { stats = db.getAiViewerLogStats(req.user.id, 60); } catch { /* */ }
        res.json({ status: st, last_hour: stats, budget: budgetSummary(req.user.id) });
    } catch (e) { res.status(500).json({ error: 'Failed to load status' }); }
});
router.get('/log', requireAuth, (req, res) => {
    try {
        const rows = db.getAiViewerLog(req.user.id, { afterId: parseInt(req.query.after, 10) || 0, limit: parseInt(req.query.limit, 10) || 50, streamId: parseInt(req.query.stream_id, 10) || null });
        res.json({ rows });
    } catch (e) { res.status(500).json({ error: 'Failed to load log' }); }
});
router.get('/threads', requireAuth, (req, res) => {
    try { res.json({ open: db.getOpenAiViewerThreads(req.user.id, 10), recent: db.getRecentClosedAiViewerThreads(req.user.id, 10) }); }
    catch (e) { res.status(500).json({ error: 'Failed to load threads' }); }
});
for (const cmd of ['pause', 'resume', 'nudge']) {
    router.post(`/${cmd}`, requireAuth, (req, res) => {
        try { res.json({ ok: true, message: engine.onModCommand(req.user.id, null, [cmd], { by: req.user.username }), status: statusSafe(req.user.id) }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
}
router.post('/bots/:id/mute', requireAuth, (req, res) => { const bot = ownBotOr404(req, res); if (!bot) return; res.json({ ok: true, message: engine.onModCommand(req.user.id, null, ['mute', bot.username], { by: req.user.username }) }); });
router.post('/bots/:id/unmute', requireAuth, (req, res) => { const bot = ownBotOr404(req, res); if (!bot) return; res.json({ ok: true, message: engine.onModCommand(req.user.id, null, ['unmute', bot.username], { by: req.user.username }) }); });
router.post('/byo/test', requireAuth, async (req, res) => {
    try {
        const cfg = db.getChannelAiConfig(req.user.id);
        const body = req.body || {};
        const override = budget.byoProvider({ ...cfg, byo_key: (body.byo_key && body.byo_key !== KEY_SENTINEL) ? body.byo_key : cfg.byo_key, byo_base_url: body.byo_base_url ?? cfg.byo_base_url, byo_model: body.byo_model ?? cfg.byo_model });
        const r = await ai.llm.testProvider(override);
        res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/config', requireAuth, (req, res) => {
    try {
        const body = req.body || {};
        const fields = {};
        const passBool = ['enabled', 'transcribe_enabled', 'vision_enabled', 'use_shared_key'];
        for (const k of passBool) if (body[k] !== undefined) fields[k] = body[k] ? 1 : 0;
        if (body.num_ambient_bots !== undefined) fields.num_ambient_bots = body.num_ambient_bots;
        if (body.pacing_seconds !== undefined) fields.pacing_seconds = body.pacing_seconds;
        if (body.persona !== undefined) fields.persona = body.persona;
        if (body.daily_budget_cents !== undefined) fields.daily_budget_cents = body.daily_budget_cents;
        if (body.byo_base_url !== undefined) fields.byo_base_url = body.byo_base_url;
        if (body.byo_model !== undefined) fields.byo_model = body.byo_model;
        // Preserve the stored key unless a real new one is supplied (not blank / not the mask).
        if (body.byo_key !== undefined && body.byo_key !== '' && body.byo_key !== KEY_SENTINEL) {
            fields.byo_key = body.byo_key;
        }
        db.upsertChannelAiConfig(req.user.id, fields);
        // v3 settings blob (partial merge, validated + clamped in settings.js).
        if (body.settings && typeof body.settings === 'object') settingsMod.updateSettings(req.user.id, body.settings);
        try { engine.applyConfigForUser(req.user.id); } catch { /* */ }
        const cfg = db.getChannelAiConfig(req.user.id);
        res.json({
            config: sanitizeConfig(cfg),
            settings: settingsMod.getSettings(req.user.id, cfg),
            budget: budgetSummary(req.user.id),
            status: statusSafe(req.user.id),
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save AI viewer config' });
    }
});

// ── Roster ────────────────────────────────────────────────────
router.get('/roster', requireAuth, (req, res) => {
    try {
        const bots = db.getChannelAiBots(req.user.id).map(botSummary);
        res.json({ bots });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load roster' });
    }
});

function ownBotOr404(req, res) {
    const bot = db.getChannelAiBot(parseInt(req.params.id, 10));
    if (!bot || bot.channel_user_id !== req.user.id) {
        res.status(404).json({ error: 'Bot not found' });
        return null;
    }
    return bot;
}

router.patch('/bots/:id', requireAuth, (req, res) => {
    try {
        const bot = ownBotOr404(req, res);
        if (!bot) return;
        const body = req.body || {};
        const fields = {};
        if (body.display_name !== undefined) fields.display_name = String(body.display_name || '').slice(0, 40) || bot.username;
        if (body.is_active !== undefined) fields.is_active = body.is_active ? 1 : 0;
        let persona = {}; try { persona = JSON.parse(bot.persona_json || '{}') || {}; } catch { /* */ }
        let touched = false;
        if (body.identity !== undefined) { persona.identity = String(body.identity || '').slice(0, 1200); touched = true; }
        if (body.blurb !== undefined) { persona.character = { ...(persona.character || {}), blurb: String(body.blurb || '').slice(0, 300) }; touched = true; }
        if (body.style !== undefined) { persona.style = { ...(persona.style || {}), rules: String(body.style || '').slice(0, 300) }; touched = true; }
        if (body.tts !== undefined) { persona.tts = !!body.tts; touched = true; }
        if (body.color !== undefined && /^#[0-9a-f]{3,8}$/i.test(String(body.color))) { persona.color = String(body.color); fields.avatar_color = persona.color; touched = true; }
        if (touched) fields.persona_json = persona;
        if (Object.keys(fields).length) db.updateChannelAiBot(bot.id, fields);
        try { engine.applyConfigForUser(req.user.id); } catch { /* */ }
        res.json({ bot: botSummary(db.getChannelAiBot(bot.id)) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update bot' });
    }
});

router.post('/bots/:id/clear-memory', requireAuth, (req, res) => {
    try {
        const bot = ownBotOr404(req, res);
        if (!bot) return;
        brain.clearBrain(bot.id);
        res.json({ ok: true, bot: botSummary(db.getChannelAiBot(bot.id)) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to clear memory' });
    }
});

router.delete('/bots/:id', requireAuth, (req, res) => {
    try {
        const bot = ownBotOr404(req, res);
        if (!bot) return;
        db.deleteChannelAiBot(bot.id);
        try { engine.applyConfigForUser(req.user.id); } catch { /* */ }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete bot' });
    }
});

// ── Clone a real chatter ──────────────────────────────────────
router.post('/clone', requireAuth, async (req, res) => {
    try {
        const { kind, ref } = req.body || {};
        let src;
        if (kind === 'user') {
            const userId = parseInt(ref, 10);
            const u = userId ? db.getUserById(userId) : null;
            if (!u) return res.status(404).json({ error: 'User not found' });
            src = {
                kind: 'user', ref: String(userId),
                displayName: u.display_name || u.username,
                insight: chatAi.getUserInsight(userId),
                samples: (db.getUserChatHistory(userId, 30).messages || []),
            };
        } else if (kind === 'relay') {
            // ref = "platform:username"
            const idx = String(ref || '').indexOf(':');
            const platform = idx > 0 ? ref.slice(0, idx) : '';
            const username = idx > 0 ? ref.slice(idx + 1) : '';
            if (!platform || !username) return res.status(400).json({ error: 'Bad relay ref' });
            const relay = db.getRelayUser(platform, username);
            src = {
                kind: 'relay', ref: `${platform}:${username}`,
                displayName: username,
                insight: relay ? chatAi.getRelayUserInsight(relay.id) : null,
                samples: (db.getRelayUserChatHistory(platform, username, { limit: 30 }).messages || []),
            };
        } else {
            return res.status(400).json({ error: 'kind must be user or relay' });
        }
        const bot = await roster.createCloneBot(req.user.id, src);
        try { engine.applyConfigForUser(req.user.id); } catch { /* */ }
        res.status(201).json({ bot: botSummary(bot) });
    } catch (e) {
        console.warn('[AI-Viewers] clone failed:', e.message);
        res.status(500).json({ error: 'Failed to clone chatter' });
    }
});

// ── Preview one line (no posting) ─────────────────────────────
router.post('/preview', requireAuth, async (req, res) => {
    try {
        if (engine.engineForUser(req.user.id).version === 'v3') {
            const out = await engine.preview(req.user.id);
            if (out && out.error) return res.status(400).json({ error: out.error });
            return res.json(out);
        }
        const st = budget.budgetStatus(req.user.id);
        if (!st.active) {
            const why = st.reason === 'shared_ai_disabled' ? 'Shared AI is currently disabled by the admin.'
                : st.reason === 'over_daily_cap' ? "You've hit today's budget cap."
                : st.reason === 'no_byo_key' ? 'Add your API key (or a public self-hosted URL) first.'
                : 'AI viewers are not active.';
            return res.status(400).json({ error: why });
        }
        const cfg = db.getChannelAiConfig(req.user.id);
        const persona = roster.makeAmbientPersona((req.user.id * 7 + 3) & 0x7fffffff);
        const system = [
            `You are a viewer in a live stream's chat. You are ${persona.character.blurb}.`,
            cfg.persona ? `Channel vibe: ${cfg.persona}` : '',
            `Typing style: ${persona.style.rules}.`,
            `Reply with ONE short chat message only. Never say you are an AI or a bot. Just the message.`,
        ].filter(Boolean).join('\n');
        const text = await budget.generate(req.user.id, {
            system, user: 'Chat is a bit quiet. Say something to get things going.',
            maxTokens: 50, temperature: 1.05,
        });
        if (!text) return res.status(502).json({ error: 'No response from the AI provider.' });
        res.json({ line: text });
    } catch (e) {
        res.status(500).json({ error: 'Preview failed' });
    }
});

module.exports = router;
