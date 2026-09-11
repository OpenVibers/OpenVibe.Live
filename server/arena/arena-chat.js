/**
 * OpenVibe.Live — Arena chat commands (viewers watch along from any stream chat)
 *
 *   !hype             hype the streamer in their newest open beef (one per person per side)
 *   !beef             what beefs this streamer has open + clocks
 *   !arena [user]     fighter card summary + link
 *
 * Nothing in chat starts, feeds or decides anything — the Arena is pure mic. Called from
 * ChatServer.handleBangCommand; returns true when the command was handled. Replies go to the
 * sender as a system line; milestones are announced to the room.
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
function clock(b) {
    if (!b.on_clock || b.clock_seconds_left == null) return '';
    const s = b.clock_seconds_left, who = (b.on_clock === 'a' ? b.a : b.b).fighter_name;
    const t = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
    return ` · ${who} on the clock (${t} to answer)`;
}
function beefLine(b) { return `${b.a.fighter_name} ${b.share_a}% — ${100 - b.share_a}% ${b.b.fighter_name}${clock(b)} → ${base()}/arena/beef/${b.id}`; }

function handle(chat, ws, client, cmd, parts) {
    if (!COMMANDS.includes(cmd)) return false;
    const reply = (message) => chat.sendTo(ws, { type: 'system', message });
    const room = (message) => client.streamId && chat.broadcastToStream(client.streamId, { type: 'system', message });
    let arena, mic, beef;
    try { arena = require('./arena-service'); mic = require('./mic'); beef = require('./beef'); } catch { reply('The Arena is closed right now.'); return true; }
    if (!arena.arenaEnabled()) { reply('The Arena is closed right now.'); return true; }
    const key = voterKey(client);
    if (limited(_last, key, RATE_MS)) { reply('Easy — one Arena command every few seconds.'); return true; }
    const stream = client.streamId ? db.getStreamById(client.streamId) : null;
    const streamer = stream ? db.getUserById(stream.user_id) : null;

    (async () => {
        try {
            if (cmd === '!hype') {
                if (!streamer) return reply("!hype works inside a streamer's chat.");
                const open = beef.openBeefsFor(streamer.id);
                if (!open.length) return reply(`${streamer.display_name || streamer.username} has no beef open. Another fighter only has to get called out on mic… ${base()}/arena`);
                const b = open[0];
                const side = b.a_user_id === streamer.id ? 'a' : 'b';
                const r = beef.hype(b.id, side, key);
                const v = beef.get(b.id);
                if (!r.added) return reply(`You already hyped this beef. ${beefLine(v)}`);
                reply(`🔥 Hyped ${streamer.display_name || streamer.username} in their beef. ${beefLine(v)}`);
                const n = side === 'a' ? v.a.crowd : v.b.crowd;
                if (n === 1 || n % 5 === 0) room(`🔥 Chat is hyping ${streamer.display_name || streamer.username}'s beef with ${(side === 'a' ? v.b : v.a).fighter_name} — ${n} so far. Type !hype to add yours. ${base()}/arena/beef/${v.id}`);
                return;
            }
            if (cmd === '!beef') {
                if (!streamer) return reply(`Open beefs → ${base()}/arena`);
                const open = beef.openBeefsFor(streamer.id).map(b => beef.get(b.id));
                if (!open.length) {
                    const lvl = mic.levelView(streamer.id);
                    return reply(`${streamer.display_name || streamer.username} has no beef open right now (Trash Level ${lvl.level}). Another streamer only has to say their name on mic… ${base()}/arena`);
                }
                return reply(open.map(b => `🥊 ${b.headline || `${b.a.fighter_name} vs ${b.b.fighter_name}`}: ${beefLine(b)}`).join('  ·  '));
            }
            if (cmd === '!arena') {
                const target = parts[1] ? db.getUserByUsername(String(parts[1]).replace(/^@/, '')) : streamer;
                if (!target) return reply('Usage: !arena <username>');
                const card = await arena.getFighter(target.id, { generate: false });
                if (!card || card.not_on_roster) return reply(`${target.display_name || target.username} isn't on the Arena roster yet — it takes mic time on a transcribed stream.`);
                const r = card.ratings;
                return reply(`🥊 ${card.persona.fighter_name} — ${card.persona.title} · #${card.rank} of ${card.roster_size} · PWR ${r.power}${r.talk_bonus ? ` (+${r.talk_bonus} mouth)` : ''} · Trash Level ${card.level.level} · beefs ${card.record.wins}W–${card.record.losses}L · “${card.persona.taunt}” → ${base()}/arena/${encodeURIComponent(target.username)}`);
            }
        } catch (err) {
            reply(`Arena: ${err.message}`);
        }
    })();
    return true;
}

module.exports = { handle, COMMANDS, _voterKey: voterKey };
