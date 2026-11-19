'use strict';
/**
 * live-global.js — Live's global chat hears who went live (plan 2026-11-13 §H item 14: "Live's global chat shows Live's
 * own activity (go-live, past broadcasts, new VODs from Live streams only)"; the recordings are vod-notify.js).
 *
 * A stream that goes live (live-events.js announceGoLive, not a quick reconnect within the hour) is looked at again a
 * minute later; if it is still live, one line goes to global chat, the same row the channel's own chat gets:
 *
 *   🔴 <name> is live. Share the stream: https://openvibe.live/@<name>
 *
 * with metadata { kind: 'live_link', url }, which public/js/chat.js draws as the go-live card (Watch).
 *
 * Not said: a stream gone again within the minute (a test, a reconnect's sliver), an 18+ stream (the stream's flag or
 * the channel's forced one), a banned account's, or an agent stream's (its owner chooses who sees it). Global chat
 * hears a channel at most once in 30 minutes and ten go-lives an hour in all. Said once: Chat keeps the line's key
 * (live:link:<stream id>:global).
 */

const DELAY_MS = 60 * 1000;
const GLOBAL_GAP_MS = 30 * 60 * 1000;
const GLOBAL_PER_HOUR = 10;

function createLiveGlobal({ db, deliver, base = 'https://openvibe.live', now = () => Date.now(), log = console, delayMs = DELAY_MS, setTimer = setTimeout } = {}) {
    const lastByChannel = new Map();   // channel user id → when it last went to global chat
    let times = [];                    // when each go-live of the last hour went to global chat

    /** The stream as it is now: live, 18+, banned, an agent slot. */
    async function current(streamId) {
        return await db.get(`SELECT s.id, s.user_id, s.is_live, s.ended_at, s.is_nsfw, COALESCE(ms.kind, 'normal') AS slot_kind,
                u.username, u.display_name, u.is_banned, COALESCE(c.force_nsfw, 0) AS force_nsfw
            FROM streams s
            JOIN users u ON u.id = s.user_id
            LEFT JOIN managed_streams ms ON ms.id = s.managed_stream_id
            LEFT JOIN channels c ON c.user_id = s.user_id
            WHERE s.id = ?`, [streamId]);
    }

    /** → { posted: boolean, why? } */
    async function post(streamId) {
        const id = Number(streamId);
        if (!Number.isSafeInteger(id) || id <= 0) return { posted: false, why: 'no id' };
        const s = await current(id);
        if (!s) return { posted: false, why: 'no stream' };
        if (!Number(s.is_live) || s.ended_at) return { posted: false, why: 'not live any more' };
        if (Number(s.is_nsfw) || Number(s.force_nsfw)) return { posted: false, why: '18+' };
        if (Number(s.is_banned)) return { posted: false, why: 'banned' };
        if (s.slot_kind === 'agent') return { posted: false, why: 'an agent stream' };
        if (!s.username) return { posted: false, why: 'no name' };
        const t = now();
        times = times.filter((x) => t - x < 3600_000);
        if (t - (lastByChannel.get(s.user_id) || 0) < GLOBAL_GAP_MS) return { posted: false, why: 'heard lately' };
        if (times.length >= GLOBAL_PER_HOUR) return { posted: false, why: 'the hour is full' };
        const url = `${String(base).replace(/\/+$/, '')}/@${encodeURIComponent(s.username)}`;
        const name = String(s.display_name || s.username).replace(/\s+/g, ' ').trim().slice(0, 60) || s.username;
        lastByChannel.set(s.user_id, t);
        times.push(t);
        try {
            await deliver({
                user_id: null, username: 'OpenVibe.Live', message: `\u{1F534} ${name} is live. Share the stream: ${url}`.slice(0, 480),
                message_type: 'system', metadata: { kind: 'live_link', url }, is_global: true, key: `live:link:${id}:global`,
            });
            return { posted: true };
        } catch (e) {
            if (log && log.warn) log.warn(`[LiveGlobal] go-live line for stream ${id} failed: ${e.message}`);
            return { posted: false, why: 'delivery failed' };
        }
    }

    /** Look at the stream again in a minute, and say it in global chat if it is still live. */
    function schedule(streamId) {
        const timer = setTimer(() => { post(streamId).catch((e) => { if (log && log.warn) log.warn(`[LiveGlobal] ${e.message}`); }); }, delayMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        return timer;
    }

    return { post, schedule };
}

let _default = null;
/** The service's own instance: the database, Chat's delivery and the public address. */
function schedule(streamId) {
    if (!_default) {
        let base = 'https://openvibe.live';
        try { base = String(require('../config').baseUrl || base); } catch { /* the public address */ }
        _default = createLiveGlobal({ db: require('../db/database'), deliver: (b) => require('../chat/chat-delivery').message(b), base });
    }
    return _default.schedule(streamId);
}

module.exports = { createLiveGlobal, schedule, DELAY_MS, GLOBAL_GAP_MS, GLOBAL_PER_HOUR };
