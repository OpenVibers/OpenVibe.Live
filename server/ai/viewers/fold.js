/**
 * AI viewers v3 — memory fold. One summary-role run per channel (OpenVibe.AI's live.viewers.fold) folds every bot's recent
 * lines (and the threads they took part in) into their rolling memory, plus a channel-wide
 * "running bits" note. Replaces the per-bot fold of v2 (N calls → 1).
 */
'use strict';
const db = require('../../db/database');
const { viewerRun } = require('./ai-run');

function clip(str, n) { return (str || '').toString().replace(/\s+/g, ' ').trim().slice(0, n); }


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
    try { channelMemory = (JSON.parse((await db.getChannelAiConfig(worker.userId)).settings_json || '{}') || {}).channel_memory || ''; } catch { /* */ }

    // The fold instructions and schema are OpenVibe.AI's versioned template live.viewers.fold (WS-O task 2).
    const r = await viewerRun('live.viewers.fold', {
        channel_memory: clip(channelMemory, 2000),
        personas: entries.slice(0, 30).map(e => ({ username: clip(e.bot.username, 80), memory: clip(e.memory, 2000), lines: e.lines.map(l => clip(l, 400)).slice(-20) })),
    }, { provider, ownerUserId: worker.userId, kind: 'ai_viewers_fold', role: 'summary' });
    if (!r) return null;
    const out = r.output;
    if (!out || !Array.isArray(out.memories)) return null;
    let updated = 0;
    for (const m of out.memories) {
        const e = entries.find(x => x.bot.username.toLowerCase() === String(m.bot || '').toLowerCase());
        if (!e || !m.memory || !String(m.memory).trim()) continue;
        let brain = {}; try { brain = JSON.parse(e.bot.brain_json || '{}'); } catch { /* */ }
        brain.memory = clip(m.memory, 900);
        brain.timeline = (brain.timeline || []).slice(-8);
        brain.timeline.push({ n: e.bot.msg_count || 0, note: clip(e.lines[e.lines.length - 1], 80) });
        try { await db.updateChannelAiBot(e.bot.id, { brain_json: brain }); worker.botLines.set(e.bot.id, []); updated++; } catch { /* */ }
    }
    if (out.channel_memory && String(out.channel_memory).trim()) {
        try {
            const cfg = await db.getChannelAiConfig(worker.userId);
            let sj = {}; try { sj = JSON.parse(cfg.settings_json || '{}') || {}; } catch { /* */ }
            sj.channel_memory = clip(out.channel_memory, 600);
            await db.upsertChannelAiConfig(worker.userId, { settings_json: JSON.stringify(sj) });
        } catch { /* */ }
    }
    return { updated, cost: r.cost || 0, usage: r.usage, model: r.model };
}

/** Clear a bot's rolling memory (keeps its identity/persona). */
async function clearBrain(botId) {
    const bot = await db.getChannelAiBot(botId);
    if (!bot) return false;
    let persona = {}; try { persona = JSON.parse(bot.persona_json || '{}'); } catch { /* */ }
    await db.updateChannelAiBot(botId, { brain_json: { memory: '', timeline: [], identity: persona.identity || '' } });
    return true;
}

module.exports = { foldAll, clearBrain };
