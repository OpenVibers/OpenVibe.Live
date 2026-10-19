/**
 * OpenVibe.Live — The Rundown's chat commands (the Arena's three, which Chat still forwards to
 * /internal/chat-effects/arena-command; the Arena became The Rundown on 2026-10-19).
 *
 *   !arena [user]     what the streamer (or user) has been talking about on The Rundown + a link
 *   !hype, !beef      beefs are gone: a pointer to The Rundown
 *
 * Called from ChatServer.handleBangCommand; returns true when the command was handled. Replies go to
 * the sender as a system line.
 */
'use strict';

const db = require('../db/database');

const COMMANDS = ['!hype', '!beef', '!arena'];
const RATE_MS = 4000;
const _last = new Map();       // voterKey → ms

function voterKey(client) {
    if (client.user?.id) return `user:${client.user.id}`;
    if (client.anonId) return `anon:${client.anonId}`;
    return `ip:${String(client.ip || '')}`;
}
function limited(map, key, ms) {
    const now = Date.now();
    if (now - (map.get(key) || 0) < ms) return true;
    map.set(key, now);
    return false;
}
function base() { try { const c = require('../config'); return String(c.baseUrl || '').replace(/\/$/, ''); } catch { return ''; } }

async function handle(chat, ws, client, cmd, parts) {
    if (!COMMANDS.includes(cmd)) return false;
    const reply = (message) => chat.sendTo(ws, { type: 'system', message });
    if (limited(_last, voterKey(client), RATE_MS)) { reply('Easy — one command every few seconds.'); return true; }
    const work = (async () => {
        try {
            if (cmd !== '!arena') return reply(`Beefs are gone. The Rundown writes up what streamers talk about instead → ${base()}/rundown`);
            const stream = client.streamId ? await db.getStreamById(client.streamId) : null;
            const target = parts[1] ? await db.get('SELECT id, username, display_name FROM users WHERE lower(username) = lower(?)', [String(parts[1]).replace(/^@/, '')])
                : (stream ? await db.get('SELECT id, username, display_name FROM users WHERE id = ?', [stream.user_id]) : null);
            if (!target) return reply(parts[1] ? `Nobody called ${String(parts[1]).slice(0, 30)} here.` : `What streamers talked about, written up → ${base()}/rundown`);
            const read = require('./read');
            const page = await read.streamer(target.username);
            const name = target.display_name || target.username;
            if (!page || page.opted_out) return reply(`${name} keeps themselves out of The Rundown.`);
            const ep = page.episodes[0];
            const topics = page.topics.slice(0, 3).map((t) => t.title);
            if (!ep && !topics.length) return reply(`Nothing on The Rundown about ${name} yet: it takes talk on a transcribed stream → ${base()}/rundown`);
            return reply(`📰 ${name}${ep ? ` — latest episode: “${ep.title}”` : ''}${topics.length ? ` · talks about ${topics.join(', ')}` : ''} → ${base()}/rundown/${encodeURIComponent(target.username)}`);
        } catch (err) {
            reply(`The Rundown: ${err.message}`);
        }
    })();
    if (typeof chat.track === 'function') chat.track(work);
    return true;
}

module.exports = { handle, COMMANDS, _voterKey: voterKey };
