'use strict';
/**
 * The kill switch's reach into OpenVibe.Bot (Agent Streams S7, design 2026-11-06 §6).
 *
 * When an agent stream ends — the owner's End, a moderator's end control, a ticket revoke or the sweep — and the
 * stream's channel is bound to a robot (`channels.bot_robot_id`), Live tells Bot to stop that robot. Bot's own rules
 * still hold: its owner may always stop it, and Live's internal call carries the deployment's shared secret. With
 * `BOT_KILL_URL` unset (and in tests) this is a no-op: a stream ending never fails because Bot is down.
 *
 * This is not a second control path for chat: nothing in Chat, and neither S5 nor S6, reaches this. Only the owner's
 * kill switch (and the stream ending, which the owner can press) does.
 */
const db = require('../db/database');

const URL_BASE = () => String(process.env.BOT_KILL_URL || '').trim().replace(/\/+$/, '');
const SECRET = () => String(process.env.BOT_KILL_SECRET || '');
const TIMEOUT_MS = 2500;

function configured() { return !!URL_BASE() && !!SECRET(); }

/** The robot bound to this agent stream's channel, or null. */
async function robotFor(row) {
    if (!row || !row.channel_id) return null;
    try {
        const channel = await db.get('SELECT bot_robot_id FROM channels WHERE id = ?', [row.channel_id]);
        const id = channel && String(channel.bot_robot_id || '');
        return /^rob_[A-Za-z0-9_-]{4,60}$/.test(id) ? id : null;
    } catch { return null; }
}

/**
 * Stop the robot bound to this stream's channel, if there is one and Bot is configured. Resolves to
 * { stopped, robot_id } either way; a Bot failure is logged, never thrown into the stream's end.
 */
async function stop(row, { fetchImpl = globalThis.fetch } = {}) {
    const robotId = await robotFor(row);
    if (!robotId) return { stopped: false, robot_id: null };
    if (!configured()) return { stopped: false, robot_id: robotId, reason: 'bot_kill_unconfigured' };
    try {
        const res = await fetchImpl(`${URL_BASE()}/internal/robots/${encodeURIComponent(robotId)}/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-OV-Bot-Kill': SECRET() },
            body: JSON.stringify({ reason: 'agent_stream_ended', stream_id: row.public_id || null }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
            console.warn(`[AgentStream] Bot did not stop ${robotId}: ${res.status}`);
            return { stopped: false, robot_id: robotId, reason: `bot_${res.status}` };
        }
        return { stopped: true, robot_id: robotId };
    } catch (err) {
        console.warn(`[AgentStream] Bot stop of ${robotId} failed: ${err.message}`);
        return { stopped: false, robot_id: robotId, reason: 'bot_unreachable' };
    }
}

module.exports = { stop, robotFor, configured, URL_BASE };
