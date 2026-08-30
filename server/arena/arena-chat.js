/**
 * OpenVibe.Live — Arena chat commands (viewers play along from any stream chat)
 *
 *   !topic <text>     start a board subject from chat (signed in; one per person + per IP per 24 h; the AI rewrites it)
 *   !bounty <user>    put a bounty on a fighter: double XP for anyone who talks shit about them (1/hour)
 *   !hype             hype the streamer: their newest open beef, else their active board topic
 *   !beef             what beefs this streamer has open + clocks
 *   !board            the pulse + hottest events on the board
 *   !arena [user]     fighter card summary + link
 *
 * Called from ChatServer.handleBangCommand; returns true when the command was handled.
 * Replies go to the sender as a system line; milestones are announced to the room.
 */
'use strict';

const db = require('../db/database');

const COMMANDS = ['!topic', '!bounty', '!hype', '!beef', '!board', '!arena'];
const RATE_MS = 4000;
const BOUNTY_RATE_MS = 60 * 60 * 1000;
const _last = new Map();       // voterKey → ms
const _lastBounty = new Map();

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
    let arena, board, beef;
    try { arena = require('./arena-service'); board = require('./board'); beef = require('./beef'); } catch { reply('The Arena is closed right now.'); return true; }
    if (!arena.arenaEnabled()) { reply('The Arena is closed right now.'); return true; }
    const key = voterKey(client);
    if (limited(_last, key, RATE_MS)) { reply('Easy — one Arena command every few seconds.'); return true; }
    const stream = client.streamId ? db.getStreamById(client.streamId) : null;
    const streamer = stream ? db.getUserById(stream.user_id) : null;
    const who = client.user?.display_name || client.user?.username || 'Chat';

    (async () => {
        try {
            if (cmd === '!topic') {
                if (!client.user?.id) return reply('Sign in to start a topic.');
                const text = parts.slice(1).join(' ').trim();
                if (!text) return reply('Usage: !topic <something the streamers should talk shit about>');
                const onRoster = !!arena.loadRoster().byId[client.user.id];
                const t = await board.submitTopic({ text, userId: client.user.id, ip: client.ip, creatorName: who, onRoster });
                if (t.folded) { reply(`📌 That's already on the board — folded into “${t.text}” as a new thread → ${base()}/arena/topic/${t.id}`); return; }
                board.buildLore(t.id, { force: true }).catch(() => {});
                reply(`📌 On the board as “${t.text}”${t.headline ? ` — ${t.headline}` : ''} → ${base()}/arena/topic/${t.id}`);
                room(`📌 ${who} put a subject on the Arena board: “${t.text}” — say it on mic or keep it going in chat. ${base()}/arena/topic/${t.id}`);
                return;
            }
            if (cmd === '!bounty') {
                if (!client.user?.id) return reply('Sign in to put up a bounty.');
                const target = parts[1] ? db.getUserByUsername(String(parts[1]).replace(/^@/, '')) : null;
                if (!target) return reply('Usage: !bounty <username> — double XP for anyone who talks shit about them on stream.');
                const roster = arena.loadRoster();
                if (!roster.byId[target.id]) return reply(`${target.display_name || target.username} isn't on the Arena roster.`);
                if (target.id === client.user.id) return reply("You can't put a bounty on yourself. Nice try.");
                if (board.openBountyOn(target.id)) return reply(`There's already a bounty on ${target.display_name || target.username}. Go collect it.`);
                if (limited(_lastBounty, key, BOUNTY_RATE_MS)) return reply('One bounty per hour per person.');
                board.assertCanSubmit(client.user.id, client.ip);
                const name = board.fighterBrief(target.id, roster).fighter_name;
                const t = board.createTopic({ text: `Bounty: ${name}`, hint: `Put up by ${who}. Say the name, collect the bag.`, createdBy: 'chat', creatorUserId: client.user.id, creatorName: who, creatorIp: client.ip, kind: 'bounty', targetUserId: target.id, headline: `WANTED: ${name} — chat wants smoke`, tagline: `Double XP for anyone who talks shit about ${name} on stream` });
                reply(`💰 Bounty posted on ${name} → ${base()}/arena/topic/${t.id}`);
                room(`💰 ${who} put a bounty on ${name}. Any streamer who talks shit about them on mic gets double XP for the next ${board.KIND_TTL_HOURS.bounty} hours.`);
                return;
            }
            if (cmd === '!hype') {
                if (!streamer) return reply("!hype works inside a streamer's chat.");
                const open = beef.openBeefsFor(streamer.id);
                if (open.length) {
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
                const t = board.activeTopicFor(streamer.id);
                if (!t) return reply(`${streamer.display_name || streamer.username} has no beef open and hasn't been heard on a board subject yet — the ears auto-detect it when they say one. ${base()}/arena`);
                const r = board.hypeTopic(t.id, streamer.id, key);
                if (!r.added) return reply(`You already hyped them on “${t.text}”. ${r.hypers} hyping.`);
                reply(`🔥 Hyped ${streamer.display_name || streamer.username} on “${t.text}” — ${r.hypers} hyping → ${base()}/arena/topic/${t.id}`);
                if (r.hypers === 1 || r.hypers % 5 === 0) room(`🎤 ${streamer.display_name || streamer.username} is talking shit on “${t.text}” — ${r.hypers} hyping. Type !hype. ${base()}/arena/topic/${t.id}`);
                return;
            }
            if (cmd === '!beef') {
                if (!streamer) return reply(`Open beefs → ${base()}/arena`);
                const open = beef.openBeefsFor(streamer.id).map(b => beef.get(b.id));
                if (!open.length) {
                    const lvl = board.levelView(streamer.id);
                    return reply(`${streamer.display_name || streamer.username} has no beef open right now (Trash Level ${lvl.level}). Another streamer only has to say their name on mic… ${base()}/arena`);
                }
                return reply(open.map(b => `🥊 ${b.headline || `${b.a.fighter_name} vs ${b.b.fighter_name}`}: ${beefLine(b)}`).join('  ·  '));
            }
            if (cmd === '!board') {
                const v = board.boardView();
                const top = v.open.slice(0, 3).map(t => `${t.hot ? '🔥 ' : ''}${t.kind === 'bounty' ? `Bounty: ${t.target?.fighter_name}` : t.text}${t.tagline ? ` — ${t.tagline}` : ''} (${t.mentions.total} mentions)`).join(' · ');
                return reply(`📰 ${v.pulse?.text || 'The board is quiet.'} ${top ? `Hottest: ${top}` : ''} → ${base()}/arena  ·  !topic <text> to add one`);
            }
            if (cmd === '!arena') {
                const target = parts[1] ? db.getUserByUsername(String(parts[1]).replace(/^@/, '')) : streamer;
                if (!target) return reply('Usage: !arena <username>');
                const card = await arena.getFighter(target.id, { generate: false });
                if (!card || card.not_on_roster) return reply(`${target.display_name || target.username} isn't on the Arena roster yet.`);
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
