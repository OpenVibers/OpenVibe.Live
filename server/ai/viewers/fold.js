/**
 * AI viewers v3 — memory fold. One summary-role call per channel folds every bot's recent
 * lines (and the threads they took part in) into their rolling memory, plus a channel-wide
 * "running bits" note. Replaces the per-bot fold of v2 (N calls → 1).
 */
'use strict';
const db = require('../../db/database');
const llm = require('../llm');

function clip(str, n) { return (str || '').toString().replace(/\s+/g, ' ').trim().slice(0, n); }

const FOLD_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
        memories: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { bot: { type: 'string' }, memory: { type: 'string' } }, required: ['bot', 'memory'] } },
        channel_memory: { type: 'string', description: 'running jokes / recurring topics for the whole channel, <= 90 words' },
    },
    required: ['memories', 'channel_memory'],
};

/**
 * @param {object} worker { userId, bots, botLines: Map<botId, string[]>, settings }
 * @returns {Promise<{updated:number, cost:number}|null>}
 */
async function foldAll(worker, { provider = null } = {}) {
    const entries = [];
    for (const bot of worker.bots) {
        const lines = worker.botLines.get(bot.id) || [];
        if (lines.length < 3) continue;
        let brain = {}; try { brain = JSON.parse(bot.brain_json || '{}'); } catch { /* */ }
        entries.push({ bot, lines: lines.slice(-20), memory: brain.memory || '' });
    }
    if (!entries.length) return null;
    let channelMemory = '';
    try { channelMemory = (JSON.parse(db.getChannelAiConfig(worker.userId).settings_json || '{}') || {}).channel_memory || ''; } catch { /* */ }

    const prompt = [
        'You maintain the memories of AI chat personas for one streaming channel.',
        channelMemory ? `Current channel memory (running bits): ${clip(channelMemory, 600)}` : '',
        ...entries.map(e => `### ${e.bot.username}\nCurrent memory: ${e.memory ? clip(e.memory, 700) : '(none)'}\nRecent lines:\n- ${e.lines.map(l => clip(l, 160)).join('\n- ')}`),
        'For each persona, write an updated memory: a tight paragraph (max 90 words) of durable facts — running jokes, who they talk to, opinions they formed, recurring topics. Keep the useful old stuff, drop the trivial. Also update the channel memory (running bits everyone shares).',
    ].filter(Boolean).join('\n\n');

    const r = await llm.complete({
        role: 'summary', user: prompt, json: { name: 'fold', schema: FOLD_SCHEMA, strict: true },
        maxTokens: 160 * entries.length + 160, temperature: 0.4,
        kind: 'ai_viewers_fold', source: 'ai_viewers', ownerUserId: worker.userId, provider,
    });
    if (!r) return null;
    const out = r.json || llm.parseJsonLoose(r.text);
    if (!out || !Array.isArray(out.memories)) return null;
    let updated = 0;
    for (const m of out.memories) {
        const e = entries.find(x => x.bot.username.toLowerCase() === String(m.bot || '').toLowerCase());
        if (!e || !m.memory || !String(m.memory).trim()) continue;
        let brain = {}; try { brain = JSON.parse(e.bot.brain_json || '{}'); } catch { /* */ }
        brain.memory = clip(m.memory, 900);
        brain.timeline = (brain.timeline || []).slice(-8);
        brain.timeline.push({ n: e.bot.msg_count || 0, note: clip(e.lines[e.lines.length - 1], 80) });
        try { db.updateChannelAiBot(e.bot.id, { brain_json: brain }); worker.botLines.set(e.bot.id, []); updated++; } catch { /* */ }
    }
    if (out.channel_memory && String(out.channel_memory).trim()) {
        try {
            const cfg = db.getChannelAiConfig(worker.userId);
            let sj = {}; try { sj = JSON.parse(cfg.settings_json || '{}') || {}; } catch { /* */ }
            sj.channel_memory = clip(out.channel_memory, 600);
            db.upsertChannelAiConfig(worker.userId, { settings_json: JSON.stringify(sj) });
        } catch { /* */ }
    }
    return { updated, cost: r.cost || 0, usage: r.usage, model: r.model };
}

/** Clear a bot's rolling memory (keeps its identity/persona). */
function clearBrain(botId) {
    const bot = db.getChannelAiBot(botId);
    if (!bot) return false;
    let persona = {}; try { persona = JSON.parse(bot.persona_json || '{}'); } catch { /* */ }
    db.updateChannelAiBot(botId, { brain_json: { memory: '', timeline: [], identity: persona.identity || '' } });
    return true;
}

module.exports = { foldAll, clearBrain };
