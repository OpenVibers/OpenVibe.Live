/**
 * OpenVibe.Live — Arena chat commands (viewers play along from chat)
 *
 *   !hype             hype the streamer's latest trash-talk entry (one per person; Crowd score)
 *   !talk             show the current trash-talk topic + how to enter
 *   !arena [user]     fighter card summary + link (defaults to the streamer whose chat this is)
 *   !vote a|b         vote in today's Main Event (signed-in only)
 *   !fight <user>     post a battle link: this streamer vs <user>
 *
 * Called from ChatServer.handleBangCommand; returns true when the command was handled.
 * Replies go to the sender as a system line; hype milestones are announced to the room.
 */
'use strict';

const db = require('../db/database');

const RATE_MS = 4000;
const _last = new Map(); // voterKey → ms

function voterKey(client) {
    if (client.user?.id) return `user:${client.user.id}`;
    if (client.anonId) return `anon:${client.anonId}`;
    return `ip:${String(client.ip || '')}`;
}

function rateLimited(key) {
    const now = Date.now();
    if (now - (_last.get(key) || 0) < RATE_MS) return true;
    _last.set(key, now);
    return false;
}

function base() {
    try { const c = require('../config'); return String(c.baseUrl || '').replace(/\/$/, ''); } catch { return ''; }
}

function handle(chat, ws, client, cmd, parts) {
    if (!['!hype', '!talk', '!arena', '!vote', '!fight'].includes(cmd)) return false;
    const reply = (message) => chat.sendTo(ws, { type: 'system', message });
    let arena, talk;
    try { arena = require('./arena-service'); talk = require('./trash-talk'); } catch { reply('The Arena is closed right now.'); return true; }
    if (!arena.arenaEnabled()) { reply('The Arena is closed right now.'); return true; }
    const key = voterKey(client);
    if (rateLimited(key)) { reply('Easy — one Arena command every few seconds.'); return true; }
    const stream = client.streamId ? db.getStreamById(client.streamId) : null;
    const streamer = stream ? db.getUserById(stream.user_id) : null;

    (async () => {
        try {
            if (cmd === '!hype') {
                if (!streamer) return reply('!hype works inside a streamer\'s chat.');
                // A live session (they are talking trash on stream right now) takes priority.
                try {
                    const s = require('./talk-session').hypeSession(streamer.id, key);
                    if (s) {
                        if (!s.added) return reply(`You already hyped this topic. ${s.hypers} hyping · level ${s.level} · ${s.progress}% to the next topic.`);
                        reply(`🔥 Hyped the live session! ${s.hypers} hyping · level ${s.level} (${s.xp} XP) · topic ${s.progress}% cleared → ${base()}/arena/talk/${encodeURIComponent(streamer.username)}`);
                        if (s.hypers === 1 || s.hypers % 5 === 0) chat.broadcastToStream(client.streamId, { type: 'system', message: `🎤 ${streamer.display_name || streamer.username} is talking trash live — ${s.hypers} hyping. Type !hype to push the topic. ${base()}/arena/talk/${encodeURIComponent(streamer.username)}` });
                        return;
                    }
                } catch (e) { return reply(`Arena: ${e.message}`); }
                const entry = talk.latestEntryFor(streamer.id);
                if (!entry) return reply(`${streamer.display_name || streamer.username} hasn't entered the current Trash Talk topic yet — ${base()}/arena/talk`);
                const r = talk.hype(entry.id, key);
                if (!r.added) return reply(`You already hyped this one. Crowd score ${r.crowd}/10 (${r.crowd_uniques} hyped).`);
                reply(`🔥 Hyped! Crowd score ${r.crowd}/10 (${r.crowd_uniques} hyped) · total ${r.total}/50 · ${r.stamp}`);
                if (r.crowd_uniques === 1 || r.crowd_uniques % 5 === 0) {
                    chat.broadcastToStream(client.streamId, { type: 'system', message: `🎤 Chat is hyping ${streamer.display_name || streamer.username}'s trash talk — ${r.crowd_uniques} so far. Type !hype to add yours.` });
                }
                return;
            }
            if (cmd === '!talk') {
                const t = await talk.getTopic({ generate: false });
                return reply(`🎤 Trash Talk topic: "${t.topic}" — ${t.hint || ''} Streamers enter at ${base()}/arena/talk; viewers type !hype in their chat to boost the Crowd score.`);
            }
            if (cmd === '!arena') {
                const target = parts[1] ? db.getUserByUsername(String(parts[1]).replace(/^@/, '')) : streamer;
                if (!target) return reply('Usage: !arena <username>');
                const card = await arena.getFighter(target.id, { generate: false });
                if (!card || card.not_on_roster) return reply(`${target.display_name || target.username} isn't on the Arena roster yet.`);
                const r = card.ratings;
                return reply(`🥊 ${card.persona.fighter_name} — ${card.persona.title} · #${card.rank} of ${card.roster_size} · PWR ${r.power}${r.talk_bonus ? ` (+${r.talk_bonus} trash talk)` : ''} · ${card.record.wins}W–${card.record.losses}L · "${card.persona.taunt}" → ${base()}/arena/${encodeURIComponent(target.username)}`);
            }
            if (cmd === '!vote') {
                if (!client.user?.id) return reply('Sign in to vote in the Main Event.');
                const side = String(parts[1] || '').toLowerCase();
                const me = await arena.getMainEvent({ generate: false });
                if (!me) return reply('No Main Event today.');
                const pick = side === 'a' || side === me.a.user.username.toLowerCase() ? 'a' : side === 'b' || side === me.b.user.username.toLowerCase() ? 'b' : null;
                if (!pick) return reply(`Usage: !vote a|b — today: (a) ${me.a.persona.fighter_name} vs (b) ${me.b.persona.fighter_name}`);
                const r = arena.castVote(me.id, `user:${client.user.id}`, pick);
                return reply(`🗳️ Voted ${(pick === 'a' ? me.a : me.b).persona.fighter_name}. Crowd: ${r.votes.a}–${r.votes.b} · score ${r.outcome.a}–${r.outcome.b}${r.outcome.winner ? ` · ${(r.outcome.winner === 'a' ? me.a : me.b).persona.fighter_name} leads` : ''} → ${base()}/arena/battle/${encodeURIComponent(me.a.user.username)}/${encodeURIComponent(me.b.user.username)}`);
            }
            if (cmd === '!fight') {
                if (!streamer) return reply('!fight works inside a streamer\'s chat: !fight <username>');
                const opp = parts[1] ? db.getUserByUsername(String(parts[1]).replace(/^@/, '')) : null;
                if (!opp) return reply('Usage: !fight <username>');
                if (opp.id === streamer.id) return reply('They can\'t fight themselves. Yet.');
                const url = `${base()}/arena/battle/${encodeURIComponent(streamer.username)}/${encodeURIComponent(opp.username)}`;
                chat.broadcastToStream(client.streamId, { type: 'system', message: `🥊 ${client.user?.display_name || client.user?.username || 'Chat'} called out ${opp.display_name || opp.username}: ${streamer.display_name || streamer.username} vs ${opp.display_name || opp.username} → ${url}` });
                return;
            }
        } catch (err) {
            reply(`Arena: ${err.message}`);
        }
    })();
    return true;
}

module.exports = { handle, _voterKey: voterKey };
