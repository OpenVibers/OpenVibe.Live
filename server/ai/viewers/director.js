/**
 * AI viewers v3 — the director.
 *
 * ONE structured LLM call per pass plans up to K lines for the whole roster: who speaks,
 * to whom (a viewer, another bot in a thread, the streamer, or nobody), with what text,
 * after what delay, and why. The stable prefix goes in the (cached) system role; the
 * volatile tail is the user message. Batching lines per call is the single biggest
 * token saving over the old one-call-per-line engine; the cached prefix is the second.
 */
'use strict';
const llm = require('../llm');

const PLAN_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        skip: { type: 'boolean', description: 'true when nothing worth saying right now' },
        notes: { type: 'string', description: 'one short line of director reasoning (logged only)' },
        lines: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    bot: { type: 'string', description: 'username of the AI viewer that speaks' },
                    target: { type: 'string', enum: ['viewer', 'bot', 'streamer', 'ambient'] },
                    reply_to: { type: ['string', 'null'], description: 'username being replied to (viewer or bot), else null' },
                    thread: { type: ['string', 'null'], description: 'existing thread id as a string, "new" to start one, or null' },
                    topic: { type: ['string', 'null'], description: 'topic label when thread is "new"' },
                    delay_ms: { type: 'integer', minimum: 0, maximum: 45000 },
                    text: { type: 'string', description: 'the chat line, in character' },
                    reason: { type: 'string', description: 'why this bot says this now (<= 80 chars)' },
                },
                required: ['bot', 'target', 'reply_to', 'thread', 'topic', 'delay_ms', 'text', 'reason'],
            },
        },
        threads_close: { type: 'array', items: { type: 'string' }, description: 'thread ids that reached a natural end' },
    },
    required: ['skip', 'notes', 'lines', 'threads_close'],
};

const DIRECTOR_RULES = `You are the DIRECTOR of a cast of AI viewers in a live stream's chat. Each pass you decide which of them speak next, to whom, and what they say — like an improv coach cueing actors. You never speak yourself.

Hard rules:
- Every line must sound like a real, casual chat message from that specific viewer, fully in character and in their typing style. Short. No quotation marks, no stage directions, no meta commentary, never mention being an AI, bot, model, or "director".
- If the streamer addressed chat or named an AI viewer, that MUST be answered first (target "streamer"), naturally and specifically about what they said/are doing.
- Reply to real viewers when it makes sense (target "viewer", reply_to = their username). Prefer people flagged first-time / follower / subscriber. Never reply to yourself.
- Bots may talk to each other (target "bot", reply_to = the other bot) to continue an open thread or start one when chat is quiet — keep the bot-to-bot share at or under the target given, and keep each thread moving (a question, a joke callback, a disagreement), then let it end.
- "ambient" lines react to what is happening on stream (heard / seen) — not filler like "nice stream".
- Use the transcript and screen description as the source of truth for what is happening; the timestamps tell you what is recent.
- Vary who speaks; the same viewer never posts two lines in a row; spread delay_ms so lines arrive over the pass, streamer replies first (small delay).
- Respect the channel rules, tone, language, blocklist and the word limit. Plain text only; emoji only per the emote policy.
- Do not repeat anything already said in chat, by anyone. If there is genuinely nothing to add, return skip=true with an empty lines array.`;

function buildSystem(stableText) {
    // Order: rules (constant) → stable context (per stream, changes rarely). Both cached.
    return [
        { text: DIRECTOR_RULES, cache: true },
        { text: stableText, cache: true },
    ];
}

/**
 * Plan a pass. Returns { plan, usage, model, cost, latencyMs } or null (quiet).
 * @param {object} args { stableText, volatileText, maxLines, provider (BYO override or null), ownerUserId, cacheKey, temperature }
 */
async function plan({ stableText, volatileText, maxLines = 3, provider = null, ownerUserId = null, cacheKey = null, temperature = 0.9 }) {
    const r = await llm.complete({
        role: 'director',
        system: buildSystem(stableText),
        user: `${volatileText}\n\nPlan the next pass now (at most ${maxLines} lines). Return JSON only.`,
        json: { name: 'plan', schema: PLAN_SCHEMA, strict: true },
        maxTokens: 70 * maxLines + 120,
        temperature,
        cacheKey,
        kind: 'ai_viewers_director', source: 'ai_viewers', ownerUserId,
        provider,
    });
    if (!r) return null;
    let p = r.json;
    if (!p || typeof p !== 'object') p = llm.parseJsonLoose(r.text) || { skip: true, lines: [] };
    const lines = Array.isArray(p.lines) ? p.lines.filter(l => l && typeof l === 'object' && typeof l.text === 'string' && l.bot) : [];
    return { plan: { skip: !!p.skip && !lines.length, notes: String(p.notes || '').slice(0, 200), lines, threads_close: Array.isArray(p.threads_close) ? p.threads_close.map(String) : [] }, usage: r.usage, model: r.model, cost: r.cost, latencyMs: r.latencyMs };
}

/**
 * Fast path: ONE line from ONE bot answering the streamer right now (no full plan).
 */
async function quickReply({ stableText, situationText, bot, streamerLine, maxWords = 18, provider = null, ownerUserId = null, cacheKey = null }) {
    const r = await llm.complete({
        role: 'chat',
        system: buildSystem(stableText),
        user: `${situationText}\n\nThe streamer just said: "${streamerLine}"\n\nWrite ONE chat line as ${bot.username} answering the streamer directly and specifically (max ${maxWords} words, plain text, in character). Return only the line.`,
        maxTokens: 70,
        temperature: 0.9,
        cacheKey,
        kind: 'ai_viewers_reply', source: 'ai_viewers', ownerUserId,
        provider,
    });
    return r ? { text: r.text, usage: r.usage, model: r.model, cost: r.cost } : null;
}

module.exports = { plan, quickReply, PLAN_SCHEMA, DIRECTOR_RULES, buildSystem };
