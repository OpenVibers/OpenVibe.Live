/**
 * OpenVibe.Live → OpenVibe.Bot: a channel's chat commands (!forward, !say …, relayed by OpenVibe.Chat through
 * POST /internal/chat-effects/hardware) drive the robot the channel is bound to, through Bot's own gate as the
 * viewer who typed them. Live keeps no robot code and no control socket (plan T15).
 *
 *   command(robotId, subject, { id, kind, value, ms })  → Bot's command_result ({ result, … }); a refusal throws
 *                                                         a BotRefusal with Bot's code and reason
 *   controlTicket(robotId, subject)                     → { ticket, robot_id, role, expires_in }: a one-time Drive
 *                                                         ticket for the robot's panel framed on the channel page,
 *                                                         so a viewer signed in here drives with no popup or second
 *                                                         sign-in (Bot's POST /api/v1/robots/:id/control-ticket)
 *
 * The token is Live's client-credentials token for audience openvibe.bot (Network's grant to `live`:
 * bot.robot.control); X-OV-Subject names the viewer, so Bot's roles, queue, cooldowns and e-stop apply to them.
 * In a restore drill (LIVE_DRILL) nothing is sent.
 */
'use strict';

const { createServiceTokenClient } = require('openvibe-sdk/auth');

const AUDIENCE = 'openvibe.bot';
const TIMEOUT_MS = 5000;

let tokens = null;
let lastLog = null;

function drill() { try { return require('../drill').enabled; } catch { return false; } }
const baseUrl = () => String(process.env.LIVE_BOT_INTERNAL_URL || 'http://127.0.0.1:4630').replace(/\/+$/, '');

class BotRefusal extends Error {
    constructor(code, reason, status) { super(reason || code); this.code = code; this.status = status; }
}
class BotUnavailable extends Error {}

function note(err) {
    const m = `OpenVibe.Bot: ${(err && err.message) || err}`;
    if (m === lastLog) return;
    lastLog = m;
    console.warn(`[Bot] ${m}`);
}

function serviceTokens() {
    if (tokens) return tokens;
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) return null;
    const networkInternalUrl = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    tokens = createServiceTokenClient({ tokenUrl: `${networkInternalUrl}/oauth/token`, clientId: process.env.OV_OAUTH_CLIENT_ID || 'live', clientSecret, audience: AUDIENCE });
    return tokens;
}

/** POST to a robot's route as the viewer: Bot's answer, or a BotRefusal / BotUnavailable. */
async function post(robotId, route, subject, body) {
    if (drill()) throw new BotUnavailable('restore drill: nothing is sent');
    const client = serviceTokens();
    if (!client) throw new BotUnavailable('OV_OAUTH_CLIENT_SECRET is not set');
    let res;
    try {
        res = await fetch(`${baseUrl()}/api/v1/robots/${encodeURIComponent(robotId)}/${route}`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${await client.getToken()}`, 'X-OV-Subject': subject },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) { note(err); throw new BotUnavailable(err.message); }
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) client.invalidate && client.invalidate();
    if (res.status >= 500) { note(`answered ${res.status}`); throw new BotUnavailable(`answered ${res.status}`); }
    if (!res.ok) throw new BotRefusal(out.code || `http_${res.status}`, out.detail || null, res.status);
    lastLog = null;
    return out;
}

const command = (robotId, subject, { id, kind, value, ms }) => post(robotId, 'commands', subject, { id, kind, value, ms });
const controlTicket = (robotId, subject) => post(robotId, 'control-ticket', subject, {});

module.exports = { command, controlTicket, BotRefusal, BotUnavailable, AUDIENCE };
