/**
 * Bot panel embed (roadmap T15 R9): a channel bound to an OpenVibe.Bot robot shows that robot's
 * embeddable panel (`<bot origin>/panel/<robot id>/embed`) on its channel page.
 *
 * Everything here is inert unless LIVE_BOT_EMBED=1 (read at call time, like the other LIVE_* flags):
 * with it off the binding route answers 404 and the channel JSON carries no `bot_embed` key. Live never
 * calls Bot to bind: the robot owner's embed_public toggle in Bot decides whether the embed shows anything.
 */
'use strict';

const DEFAULT_BOT_URL = 'https://openvibe.bot';
const ROBOT_ID_RE = /^rob_[A-Za-z0-9_-]{4,60}$/;

let warnedFor = null;

function enabled() {
    return process.env.LIVE_BOT_EMBED === '1';
}

/** A bare origin (no path, query, credentials): https anywhere, http://localhost* only outside production. */
function parseOrigin(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
    if (u.protocol === 'https:') return u.origin;
    const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
    if (u.protocol === 'http:' && local && process.env.NODE_ENV !== 'production') return u.origin;
    return null;
}

/** Bot's origin from LIVE_BOT_URL (default https://openvibe.bot); garbage falls back with one warning. */
function botOrigin() {
    const raw = String(process.env.LIVE_BOT_URL || '').trim().replace(/\/+$/, '');
    if (!raw) return DEFAULT_BOT_URL;
    const origin = parseOrigin(raw);
    if (origin) return origin;
    if (warnedFor !== raw) {
        warnedFor = raw;
        console.warn(`[BotEmbed] LIVE_BOT_URL is not a bare https origin (or http://localhost outside production); using ${DEFAULT_BOT_URL}`);
    }
    return DEFAULT_BOT_URL;
}

function validRobotId(s) {
    return typeof s === 'string' && ROBOT_ID_RE.test(s);
}

function embedUrl(robotId) {
    return `${botOrigin()}/panel/${encodeURIComponent(robotId)}/embed`;
}

/** The channel page's `bot_embed` value: undefined with the flag off, else { enabled, robot_id, url }. */
function channelEmbed(channel) {
    if (!enabled()) return undefined;
    const id = channel && validRobotId(channel.bot_robot_id) ? channel.bot_robot_id : null;
    return { enabled: true, robot_id: id, url: id ? embedUrl(id) : null };
}

module.exports = { enabled, botOrigin, validRobotId, embedUrl, channelEmbed, DEFAULT_BOT_URL };
