'use strict';
/**
 * OpenVibe.Chat's internal read API (roadmap T3; Contracts 0.80.0 `chat.moderation.read`).
 *
 * Chat owns the six tables that used to be staged in Live — channel_moderators,
 * channel_moderation_settings, emotes, user_tags, chat_ai_summaries, chat_timeline_events — so
 * Live keeps no copy. The few reads Live's own features still need go through here:
 *
 *   getChannelModeration(channelId)   → { settings, moderator_ids } (Chat's row, or Live's defaults)
 *   getChannelsByModerator(userId)    → the channels a user moderates
 *   getEmoteCount(channelIdOrUserId)  → a channel's emote count
 *
 * Auth: Live's Network service principal (OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET),
 * client-credentials token for audience openvibe.chat with the ability `chat.moderation.read`
 * (the same construction server/media-client.js uses).
 *
 * Every answer is cached 30 s (per channel / per user); invalidate(channelId) drops a channel's
 * entries at once when Live's own UI changes it. A failure answers the safe default — "not a
 * moderator", the moderation defaults, zero emotes — and logs once, never a 500 on the hot path.
 * Off under LIVE_DRILL (a restore drill calls no other service) and without OV_OAUTH_CLIENT_SECRET.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { CHAT_URL } = require('./chat-authority');

const AUDIENCE = 'openvibe.chat';
const CACHE_TTL_MS = 30_000;
const TIMEOUT_MS = 5000;

// Live's channel-moderation defaults (Chat answers the channel's row or these).
const DEFAULT_SETTINGS = Object.freeze({
    slow_mode_seconds: 0, followers_only: 0, emote_only: 0, allow_anonymous: 1, links_allowed: 1,
    gifs_enabled: 1, account_age_gate_hours: 0, caps_percentage_limit: 0, aggressive_filter: 0,
    max_message_length: 500, tts_max_length: 200, slur_filter_enabled: 0, slur_filter_use_builtin: 1,
    slur_filter_terms: '', slur_filter_regexes: '', slur_filter_nudge_message: '', slur_filter_disabled_categories: '[]',
    ip_approval_mode: 0, soundboard_enabled: 1, soundboard_allow_pitch: 1, soundboard_allow_speed: 1,
    soundboard_banned_ids: '', viewer_auto_delete_enabled: 1, viewer_delete_all_enabled: 1,
    custom_emotes_enabled: 1, custom_sounds_enabled: 1, max_sound_seconds: 10, uploads_mods_only: 0,
    mods_can_edit_about: 0, emote_scale: 100, emote_size_min: 50, emote_size_max: 200, sounds_mods_only: 0,
    sound_min_speed: 0.5, sound_max_speed: 3.0, sound_min_pitch_cents: -1200, sound_max_pitch_cents: 1200, sub_only: 0,
});

let tokens = null;
let lastLog = null;
const cache = new Map();     // key → { at, value }
const inflight = new Map();  // key → Promise

function drill() { try { return require('../drill').enabled; } catch { return false; } }
/** True when Live can talk to Chat's internal API at all. */
function enabled() { return Boolean(process.env.OV_OAUTH_CLIENT_SECRET) && !drill(); }

function serviceTokens() {
    if (tokens) return tokens;
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) return null;
    const networkInternalUrl = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    tokens = createServiceTokenClient({
        tokenUrl: `${networkInternalUrl}/oauth/token`,
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'live',
        clientSecret,
        audience: AUDIENCE,
    });
    return tokens;
}

function note(what, err) {
    const m = `OpenVibe.Chat ${what}: ${(err && err.message) || err}`;
    if (m === lastLog) return;   // log once, until it changes or a read succeeds
    lastLog = m;
    console.warn(`[ChatRead] ${m}`);
}

async function api(path) {
    const client = serviceTokens();
    if (!client) throw new Error('not configured');
    const token = await client.getToken();
    const res = await fetch(`${CHAT_URL}${path}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const out = await res.json().catch(() => null);
    if (!out || out.ok !== true) throw new Error(`refused (${(out && out.error) || 'bad answer'})`);
    return out;
}

function cached(key) { const h = cache.get(key); return h && Date.now() - h.at < CACHE_TTL_MS ? h : null; }
function remember(key, value) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
}

function defaultModeration(channelId) {
    return { settings: { ...DEFAULT_SETTINGS, channel_id: channelId || 0 }, moderator_ids: [] };
}

/** { settings, moderator_ids } for a channel (cached 30 s). */
async function getChannelModeration(channelId) {
    channelId = Number(channelId) || 0;
    if (!channelId) return defaultModeration(0);
    const key = `m:${channelId}`;
    const hit = cached(key);
    if (hit) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        if (!enabled()) return defaultModeration(channelId);
        try {
            const out = await api(`/internal/moderation/channels/${channelId}`);
            const settings = out.settings && typeof out.settings === 'object' ? { ...DEFAULT_SETTINGS, ...out.settings } : { ...DEFAULT_SETTINGS };
            const value = {
                settings: { ...settings, channel_id: channelId },
                moderator_ids: Array.isArray(out.moderator_ids) ? out.moderator_ids.map(Number) : [],
            };
            lastLog = null;
            remember(key, value);
            return value;
        } catch (err) {
            note(`channel ${channelId}`, err);
            const value = defaultModeration(channelId);
            remember(key, value);
            return value;
        }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

/** The channels a user moderates (cached 30 s); each row carries `id` = channel_id. */
async function getChannelsByModerator(userId) {
    userId = Number(userId) || 0;
    if (!userId) return [];
    const key = `u:${userId}`;
    const hit = cached(key);
    if (hit) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        if (!enabled()) return [];
        try {
            const out = await api(`/internal/moderation/users/${userId}/channels`);
            const value = (Array.isArray(out.channels) ? out.channels : []).map((c) => {
                const id = Number(c.channel_id) || 0;
                return { id, channel_id: id, title: c.title || null, user_id: c.owner_user_id != null ? Number(c.owner_user_id) : null, owner_username: c.owner_username || null };
            });
            lastLog = null;
            remember(key, value);
            return value;
        } catch (err) {
            note(`user ${userId} channels`, err);
            remember(key, []);
            return [];
        }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

/** A channel's emote count (a channels.id is resolved to its owner by Chat). */
async function getEmoteCount(channelIdOrUserId) {
    const id = Number(channelIdOrUserId) || 0;
    if (!id) return 0;
    const key = `e:${id}`;
    const hit = cached(key);
    if (hit) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        if (!enabled()) return 0;
        try {
            const out = await api(`/internal/moderation/channels/${id}/emote-count`);
            const n = Number(out.count) || 0;
            lastLog = null;
            remember(key, n);
            return n;
        } catch (err) {
            note(`channel ${id} emote count`, err);
            remember(key, 0);
            return 0;
        }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

// ── Synchronous peeks (hot paths that cannot await) ─────────────
// Return the cached answer, else the safe default and refresh in the background.

function peekChannelModeration(channelId) {
    const h = cached(`m:${Number(channelId) || 0}`);
    if (h) return h.value;
    getChannelModeration(channelId).catch(() => {});
    return null;
}
function peekChannelsByModerator(userId) {
    const h = cached(`u:${Number(userId) || 0}`);
    if (h) return h.value;
    getChannelsByModerator(userId).catch(() => {});
    return null;
}
/** The cached settings for a channel, defaults when unknown (never blocks). */
function settingsSync(channelId) {
    const h = cached(`m:${Number(channelId) || 0}`);
    return h ? h.value.settings : defaultModeration(channelId).settings;
}

/** Drop a channel's cached answer (Live changed it through its own UI — none after T3). */
function invalidate(channelId) {
    const id = Number(channelId) || 0;
    if (!id) return;
    cache.delete(`m:${id}`);
    cache.delete(`e:${id}`);
}

/** Drop every cached answer and the token (tests and env flips). */
function _reset() { cache.clear(); inflight.clear(); tokens = null; lastLog = null; }

module.exports = {
    enabled, getChannelModeration, getChannelsByModerator, getEmoteCount,
    peekChannelModeration, peekChannelsByModerator, settingsSync, defaultModeration,
    DEFAULT_SETTINGS, invalidate, _reset, AUDIENCE, CACHE_TTL_MS,
};
