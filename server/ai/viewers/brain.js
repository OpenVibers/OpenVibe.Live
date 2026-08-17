/**
 * AI Chat Viewers — persistent brains + rolling memory.
 *
 * A bot's brain_json holds a condensed identity + rolling memory + a short timeline
 * that persists across streams (stored on channel_ai_bots). Periodically we fold the
 * bot's recent activity into that memory with a cheap metered LLM pass, so a bot that
 * chatted last week remembers running jokes and who it talked to.
 */
const db = require('../../db/database');
const budget = require('./budget');

function clip(str, n) { return (str || '').toString().replace(/\s+/g, ' ').trim().slice(0, n); }

/**
 * Fold a bot's recent lines + notable events into its rolling memory.
 * @param {number} streamerId
 * @param {object} bot          channel_ai_bots row
 * @param {string[]} recentLines what the bot said / reacted to since the last fold
 * @returns {Promise<boolean>} whether the brain was updated
 */
async function foldBrain(streamerId, bot, recentLines) {
    if (!bot || !recentLines || recentLines.length < 3) return false;
    let brain = {};
    try { brain = JSON.parse(bot.brain_json || '{}'); } catch { /* */ }
    const prevMemory = brain.memory || '';

    const prompt = [
        `You maintain the memory of a chat persona named "${bot.display_name || bot.username}".`,
        prevMemory ? `Current memory:\n${clip(prevMemory, 800)}` : `No memory yet.`,
        `Recent things they said/saw in chat:\n- ${recentLines.map(l => clip(l, 160)).slice(-20).join('\n- ')}`,
        `Update their memory: a tight paragraph (max 90 words) of durable facts — running jokes, who they talk to, opinions they've formed, recurring topics. Keep the useful old stuff, drop the trivial. Return ONLY the updated memory paragraph.`,
    ].join('\n\n');

    let updated;
    try {
        updated = await budget.generate(streamerId, { system: '', user: prompt, maxTokens: 160, temperature: 0.4 });
    } catch { return false; }
    if (!updated || !updated.trim()) return false;

    brain.memory = clip(updated, 900);
    brain.timeline = (brain.timeline || []).slice(-8);
    brain.timeline.push({ n: bot.msg_count || 0, note: clip(recentLines[recentLines.length - 1], 80) });
    try {
        db.updateChannelAiBot(bot.id, { brain_json: brain });
        return true;
    } catch { return false; }
}

/** Clear a bot's rolling memory (keeps its identity/persona). */
function clearBrain(botId) {
    const bot = db.getChannelAiBot(botId);
    if (!bot) return false;
    let persona = {};
    try { persona = JSON.parse(bot.persona_json || '{}'); } catch { /* */ }
    db.updateChannelAiBot(botId, { brain_json: { memory: '', timeline: [], identity: persona.identity || '' } });
    return true;
}

module.exports = { foldBrain, clearBrain };
