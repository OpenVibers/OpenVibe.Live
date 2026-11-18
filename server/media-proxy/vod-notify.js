'use strict';
/**
 * vod-notify.js — a finished public recording of a Live stream is said in chat (plan 2026-11-13 §H item 14: "When a
 * stream ends: the VOD, if public, is posted in that channel's chat and in Live's global chat").
 *
 * Media's vod.ready outcome (server/media-proxy/outcomes.js) calls announce(data) with the recording's public row. One
 * line goes to the channel's chat and, when the stream was not 18+, one to global chat:
 *
 *   📼 <name> saved a broadcast: “<title>” (1h 02m) at https://openvibe.live/vod/<id>
 *
 * with metadata { kind: 'vod_link', url, vod_id, title, duration }, which public/js/chat.js draws as an event card
 * (Watch). Live's own /vod/<id> is the address: event cards link only to Live, and it answers 301 to the recording's
 * openvibe.video watch page.
 *
 * Said once: Chat keeps each line's key (vod:link:<id>, vod:link:<id>:global), so a repair that sends vod.ready again
 * posts nothing. Not said: a recording that is not public, one that is not a Live stream's, or one under two minutes (a
 * test, a reconnect's sliver). Global chat hears a channel at most once in 30 minutes and six recordings an hour in all;
 * the channel's own chat always hears its own.
 */

const MIN_SECONDS = 120;
const GLOBAL_GAP_MS = 30 * 60 * 1000;
const GLOBAL_PER_HOUR = 6;

function length(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${Math.max(1, m)} min`;
}

function createVodNotify({ db, deliver, base = 'https://openvibe.live', now = () => Date.now(), log = console } = {}) {
    const lastGlobalByChannel = new Map();   // channel user id → when its last recording went to global chat
    let globalTimes = [];                    // when each recording of the last hour went to global chat

    /** → { posted: ['channel', 'global'?], why? } */
    async function announce(data) {
        const vodId = Number(data && data.id);
        if (!Number.isSafeInteger(vodId) || vodId <= 0) return { posted: [], why: 'no id' };
        if (!data.stream_id) return { posted: [], why: 'not a Live stream\'s recording' };
        const isPublic = data.is_public === true || data.visibility === 'public' || data.audience === 'public';
        if (!isPublic) return { posted: [], why: 'not public' };
        const seconds = Number(data.duration_seconds || data.duration || 0);
        if (!(seconds >= MIN_SECONDS)) return { posted: [], why: 'too short' };
        const stream = await db.getStreamById(data.stream_id);
        if (!stream || !stream.user_id) return { posted: [], why: 'no stream' };
        const user = await db.getUserById(stream.user_id);
        const name = (user && (user.display_name || user.username)) || stream.username || 'A streamer';
        const title = String(data.title || stream.title || 'Untitled broadcast').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Untitled broadcast';
        const url = `${String(base).replace(/\/+$/, '')}/vod/${vodId}`;
        const message = `\u{1F4FC} ${name} saved a broadcast: “${title}” (${length(seconds)}) at ${url}`.slice(0, 480);
        const metadata = { kind: 'vod_link', url, vod_id: vodId, title, duration: Math.round(seconds) };
        const line = { user_id: null, username: 'OpenVibe.Live', message, message_type: 'system', metadata };
        const posted = [];
        try {
            await deliver({ ...line, stream_id: stream.id, channel_user_id: stream.user_id, key: `vod:link:${vodId}` });
            posted.push('channel');
        } catch (e) { if (log && log.warn) log.warn(`[VodNotify] channel line for VOD ${vodId} failed: ${e.message}`); }

        const t = now();
        globalTimes = globalTimes.filter((x) => t - x < 3600_000);
        const nsfw = !!(stream.is_nsfw || stream.force_nsfw);
        const quiet = t - (lastGlobalByChannel.get(stream.user_id) || 0) < GLOBAL_GAP_MS;
        if (!nsfw && !quiet && globalTimes.length < GLOBAL_PER_HOUR) {
            try {
                await deliver({ ...line, is_global: true, key: `vod:link:${vodId}:global` });
                lastGlobalByChannel.set(stream.user_id, t);
                globalTimes.push(t);
                posted.push('global');
            } catch (e) { if (log && log.warn) log.warn(`[VodNotify] global line for VOD ${vodId} failed: ${e.message}`); }
        }
        return { posted };
    }

    return { announce };
}

let _default = null;
/** The service's own instance: the database, Chat's delivery and the public address. */
function announce(data) {
    if (!_default) {
        let base = 'https://openvibe.live';
        try { base = String(require('../config').baseUrl || base); } catch { /* the public address */ }
        _default = createVodNotify({ db: require('../db/database'), deliver: (b) => require('../chat/chat-delivery').message(b), base });
    }
    return _default.announce(data);
}

module.exports = { createVodNotify, announce, length, MIN_SECONDS, GLOBAL_GAP_MS, GLOBAL_PER_HOUR };
