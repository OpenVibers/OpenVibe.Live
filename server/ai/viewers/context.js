/**
 * AI Chat Viewers — context assembly.
 *
 * Builds a compact, layered prompt for one bot line from data we already produce:
 *   - the streamer's profile (streamer_overviews)
 *   - what's happening now (live "situation": audio transcript + on-screen vision)
 *   - room mood (global chat insight)
 *   - who they're replying to (that viewer's insight/brain)
 *   - the bot's own persistent persona + brain
 *
 * The shared per-tick context (streamer/global/situation/recent chat) is computed
 * once by refreshShared() and reused by every bot in the tick; only the per-target
 * viewer insight varies per line.
 */
const db = require('../../db/database');
const chatAi = require('../chat-ai');

function clip(str, n) { return (str || '').toString().replace(/\s+/g, ' ').trim().slice(0, n); }

/** Compute the per-tick shared context for a stream (cached on the worker). */
function refreshShared(worker) {
    const s = worker.stream || {};
    const streamerId = worker.userId;
    let streamerOverview = '';
    try {
        const ov = db.getStreamerOverview(streamerId);
        streamerOverview = clip(ov && (ov.overview_short || ov.overview), 700);
    } catch { /* */ }
    let globalMood = '';
    try {
        const g = chatAi.getGlobalInsight();
        if (g) globalMood = clip(g.overview, 300);
    } catch { /* */ }
    worker.shared = {
        streamerOverview,
        globalMood,
        streamMeta: {
            title: clip(s.title, 140),
            category: clip(s.category, 60),
            streamer: clip(s.display_name || s.username, 60),
        },
        at: Date.now(),
    };
    return worker.shared;
}

// Recent chat lines the bot can "see" (worker keeps a rolling buffer).
function recentChatText(worker, max = 14) {
    const lines = (worker.recentChat || []).slice(-max);
    return lines.map(l => `${l.username}: ${clip(l.message, 160)}`).join('\n');
}

// Insight text for the viewer a bot is replying to (real or relay).
function targetInsightText(target) {
    if (!target) return '';
    try {
        let ins = null;
        if (target.kind === 'user' && target.userId) ins = chatAi.getUserInsight(target.userId);
        else if (target.kind === 'relay' && target.relayId) ins = chatAi.getRelayUserInsight(target.relayId);
        if (!ins) return '';
        const ov = ins.overview_alltime || ins.overview_24h || '';
        const mem = ins.memory || '';
        return clip([ov, mem].filter(Boolean).join(' — '), 400);
    } catch { return ''; }
}

/**
 * Build {system, user} for one bot line.
 * @param {object} worker
 * @param {object} bot   channel_ai_bots row
 * @param {{targetUser?:object, addressed?:boolean, situationLine?:string}} [opts]
 */
function buildBotContext(worker, bot, opts = {}) {
    const shared = worker.shared || refreshShared(worker);
    let persona = {}; let brain = {};
    try { persona = JSON.parse(bot.persona_json || '{}'); } catch { /* */ }
    try { brain = JSON.parse(bot.brain_json || '{}'); } catch { /* */ }

    const charBlurb = (persona.character && persona.character.blurb) || 'a chat viewer';
    const styleRules = (persona.style && persona.style.rules) || 'casual, short';
    const identity = persona.identity || brain.identity || '';
    const memory = brain.memory || '';

    const sys = [
        `You are "${bot.display_name || bot.username}", a viewer in a live stream's chat. You are ${charBlurb}.`,
        identity ? `Your identity: ${clip(identity, 500)}` : '',
        `Typing style: ${styleRules}.`,
        memory ? `Things you remember from this channel: ${clip(memory, 500)}` : '',
        shared.streamerOverview ? `About the streamer (${shared.streamMeta.streamer}): ${shared.streamerOverview}` : '',
        shared.globalMood ? `Site chat mood right now: ${shared.globalMood}` : '',
        `Rules: Reply with ONE short chat message only (usually under 15 words). Stay fully in character. Never say you are an AI, a bot, or a language model. No quotation marks, no emojis unless your style uses them, no meta commentary. Just the message text.`,
    ].filter(Boolean).join('\n');

    const situation = opts.situationLine || worker.situationLine || '';
    const recent = recentChatText(worker);
    const targetTxt = opts.targetUser ? targetInsightText(opts.targetUser) : '';

    const userParts = [
        `Stream: "${shared.streamMeta.title}"${shared.streamMeta.category ? ` [${shared.streamMeta.category}]` : ''}.`,
        situation ? `What's happening on stream right now: ${situation}` : '',
        recent ? `Recent chat:\n${recent}` : 'Chat is quiet right now.',
    ];
    if (opts.targetUser) {
        const who = opts.targetUser.username || 'someone';
        userParts.push(targetTxt
            ? `You're replying to ${who}. What you know about ${who}: ${targetTxt}`
            : `You're replying to ${who}.`);
        if (opts.targetUser.message) userParts.push(`${who} just said: "${clip(opts.targetUser.message, 200)}"`);
    } else if (opts.addressed) {
        userParts.push(`The streamer just addressed chat. React naturally.`);
    }
    userParts.push(`Write your next chat message as ${bot.username}:`);

    return { system: sys, user: userParts.filter(Boolean).join('\n\n') };
}

module.exports = { refreshShared, buildBotContext, recentChatText, targetInsightText };
