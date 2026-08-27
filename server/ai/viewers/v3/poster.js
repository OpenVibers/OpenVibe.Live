/**
 * AI viewers v3 — posting a bot line into chat (+ moderation + activity log).
 * Ported from the v2 engine's _inject, with the bits it skipped: word filter, per-bot
 * TTS toggle, PowerChat forward toggle, and a log row for the control panel.
 */
'use strict';
const db = require('../../../db/database');

function botColor(bot) {
    try { return (JSON.parse(bot.persona_json || '{}').color) || bot.avatar_color || '#8a8aff'; } catch { return bot.avatar_color || '#8a8aff'; }
}
function botPersona(bot) { try { return JSON.parse(bot.persona_json || '{}') || {}; } catch { return {}; } }

/** Strip quotes/disclaimers; enforce a word cap. Returns '' when the line must be dropped. */
function clean(text, maxWords = 18) {
    let t = String(text || '').trim();
    t = t.replace(/^["'`“”]+|["'`“”]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (/\b(as an ai|language model|i am a bot|i'm a bot|as a bot|openai|anthropic)\b/i.test(t)) return '';
    if (/^\w+:\s/.test(t) && t.length < 80) t = t.replace(/^\w+:\s/, '');   // "botname: text" echo
    const words = t.split(' ');
    if (words.length > maxWords) t = words.slice(0, maxWords).join(' ').replace(/[,;:]$/, '');
    if (t.length > 240) t = t.slice(0, 240);
    return t.trim();
}

/** Word-filter gate — returns { ok, text, reason }. */
function moderate(text) {
    try {
        const wf = require('../../../chat/word-filter');
        const r = wf.check(text);
        if (!r.safe) return { ok: false, text, reason: `word filter: ${r.matches.slice(0, 3).join(', ')}` };
        if (typeof wf.isSpam === 'function' && wf.isSpam(text)) return { ok: false, text, reason: 'spam pattern' };
    } catch { /* filter unavailable → allow */ }
    return { ok: true, text, reason: null };
}

/**
 * Post a line. Returns the chat message id (or null).
 * @param {object} worker  { streamId, userId, settings }
 */
function post(worker, bot, message, { threadId = null, replyToId = null } = {}) {
    const streamId = worker.streamId;
    const persona = botPersona(bot);
    const color = botColor(bot);
    let id = null;
    try {
        const res = db.saveChatMessage({
            stream_id: streamId,
            channel_user_id: worker.userId,
            user_id: null,
            username: bot.username,
            message,
            message_type: 'chat',
            is_global: false,
            reply_to_id: replyToId || null,
            source_platform: 'ai',                 // marker → excluded from chat-AI feeds
            metadata: { bot: 1, bot_id: bot.id, source: bot.source, thread_id: threadId || undefined },
        });
        id = res && res.lastInsertRowid ? Number(res.lastInsertRowid) : null;
    } catch (e) { console.warn('[AI-Viewers] saveChatMessage failed:', e.message); }

    const chatMsg = {
        type: 'chat', id: id || undefined,
        username: bot.username, core_username: null,
        user_id: null, anon_id: null, role: 'user',
        message, stream_id: streamId, is_global: false,
        reply_to_id: replyToId || null,
        avatar_url: null, profile_color: color,
        is_ai: true, source_platform: 'ai',
        filtered: false, timestamp: new Date().toISOString(),
    };
    try {
        const chatServer = require('../../../chat/chat-server');
        chatServer.broadcastToStream(streamId, chatMsg);
        chatServer.forwardToGlobal(streamId, chatMsg);
        const ttsOn = worker.settings.tts_enabled !== false && persona.tts !== false;
        if (ttsOn) chatServer.synthesizeAndBroadcastTTS(streamId, bot.username, message, null, null, `aibot:${bot.username.toLowerCase()}`, null, id ? `m${id}` : null);
    } catch (e) { console.warn('[AI-Viewers] broadcast failed:', e.message); }

    if (worker.settings.powerchat_forward !== false) {
        try {
            const pc = require('../../../integrations/powerchat-platform');
            if (worker.userId && pc.channelRelayEnabled(worker.userId, streamId)) {
                pc.forwardChat(worker.userId, {
                    chatterName: bot.username,
                    externalChatterId: `ai:${bot.username.toLowerCase()}`,
                    message,
                    messageId: id ? `ov-${id}` : undefined,
                    avatarFallback: '🤖',
                });
            }
        } catch { /* non-critical */ }
    }
    try { db.touchChannelAiBot(bot.id); } catch { /* */ }
    return id;
}

/** Append a row to ai_viewer_log (best-effort). */
function log(worker, row) {
    try {
        db.addAiViewerLog({ channel_user_id: worker.userId, stream_id: worker.streamId || null, ...row });
    } catch { /* */ }
}

module.exports = { post, clean, moderate, log, botPersona, botColor };
