/**
 * AI viewers v3 — who is being addressed?
 *  detect(message, bots, { isStreamer }) → { bots: [usernames named], addressedChat, question }
 * A streamer talking to "chat"/"guys"/"everyone" or asking a question addresses everyone;
 * "@name" or a bare bot username/display name addresses that bot (anyone can do that).
 */
'use strict';

const CHAT_WORDS = /\b(chat|guys|gang|everyone|everybody|yall|y'all|you all|anyone|anybody|viewers|lads|folks|people)\b/i;

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function detect(message, bots, { isStreamer = false } = {}) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    const named = [];
    for (const b of bots || []) {
        const names = [b.username, b.display_name].filter(Boolean).map(n => String(n).toLowerCase());
        for (const n of names) {
            if (n.length < 3) continue;
            if (lower.includes('@' + n) || new RegExp(`(^|[^a-z0-9_])${escapeRe(n)}([^a-z0-9_]|$)`, 'i').test(text)) { named.push(b.username); break; }
        }
    }
    const question = /\?\s*$/.test(text.trim()) || /\b(what do you|whatd?ya|do you (guys|all)|should i|thoughts\??|opinions?\??|who here|anyone (here|know|want))\b/i.test(text);
    const addressedChat = isStreamer && (CHAT_WORDS.test(text) || question || /^(so|ok|okay|alright|hey|yo)\b/i.test(text.trim()) && text.length < 120);
    return { bots: [...new Set(named)], addressedChat, question };
}

module.exports = { detect };
