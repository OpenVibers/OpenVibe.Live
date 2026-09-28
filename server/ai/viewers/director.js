/**
 * AI viewers v3 — the director.
 *
 * ONE structured run per pass plans up to K lines for the whole roster: who speaks,
 * to whom (a viewer, another bot in a thread, the streamer, or nobody), with what text,
 * after what delay, and why. The rules and the stable context go in the (cached) system
 * prompt of OpenVibe.AI's template live.viewers.plan; the volatile tail is the user message.
 * Batching lines per call is the single biggest token saving over the old one-call-per-line
 * engine; the cached prefix is the second.
 */
'use strict';
const { viewerRun } = require('./ai-run');

const clip = (t, n) => String(t == null ? '' : t).slice(0, n);

/**
 * Plan a pass: live.viewers.plan (the director's rules and plan schema are AI's; the stream context is Live's).
 * Returns { plan, usage, model, cost, latencyMs } or null (quiet).
 * @param {object} args { stableText, volatileText, maxLines, provider (null = site AI, { credentialSubject } = own key), ownerUserId, temperature }
 */
async function plan({ stableText, volatileText, maxLines = 3, provider = null, ownerUserId = null, temperature = 0.9 }) {
    const r = await viewerRun('live.viewers.plan', {
        stable: clip(stableText, 40000), volatile: clip(volatileText, 60000), max_lines: Math.max(1, Math.min(12, Math.round(maxLines) || 3)), temperature,
    }, { provider, ownerUserId, kind: 'ai_viewers_director', role: 'director' });
    if (!r) return null;
    const p = r.output || {};
    const lines = Array.isArray(p.lines) ? p.lines.filter(l => l && typeof l === 'object' && typeof l.text === 'string' && l.bot) : [];
    return { plan: { skip: !!p.skip && !lines.length, notes: String(p.notes || '').slice(0, 200), lines, threads_close: Array.isArray(p.threads_close) ? p.threads_close.map(String) : [] }, usage: r.usage, model: r.model, cost: r.cost, latencyMs: r.latencyMs };
}

/**
 * Fast path: ONE line from ONE bot answering the streamer right now (no full plan): live.viewers.reply.
 */
async function quickReply({ stableText, situationText, bot, streamerLine, maxWords = 18, provider = null, ownerUserId = null }) {
    const r = await viewerRun('live.viewers.reply', {
        stable: clip(stableText, 40000), situation: clip(situationText, 20000), bot: clip(bot.username, 80), streamer_line: clip(streamerLine, 400), max_words: Math.max(1, Math.min(80, Math.round(maxWords) || 18)),
    }, { provider, ownerUserId, kind: 'ai_viewers_reply', role: 'chat' });
    return r ? { text: r.output.text, usage: r.usage, model: r.model, cost: r.cost } : null;
}

module.exports = { plan, quickReply };
