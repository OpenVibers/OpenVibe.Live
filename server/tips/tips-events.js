'use strict';
/**
 * OpenVibe.Events → Live: a tip OpenVibe.Tips settled reaches the channel's donation goal and tip history.
 *
 * Since the Billing cutover (2026-10-17) Tips posts its chat lines straight to OpenVibe.Chat, so Live no longer sees
 * them at /internal/tips/deliveries: a tip from openvibe.tips, and a tip on a streamer's own PowerChat (Billing → Tips),
 * would advance neither Live's donation goal nor the channel's tip history (leaderboard, recap, home stats).
 *
 *   POST /internal/tips-events   Live's subscription to tips.interaction.ready (scripts/subscribe-media-events.js
 *                                --tips), signed with LIVE_EVENTS_SECRET (else MEDIA_EVENTS_SECRET), signature v2 only.
 *
 * For each settled interaction Live reads Tips' own view of it (GET /api/v1/interactions/:id, tips.interaction.get) for
 * what may be shown — the public name, and no amount when the supporter hid it — and where it came from. A donation
 * another product announced (origin `billing`: Live's own on-site donations) is already Live's and is left alone. The
 * rest goes into channel_tips once (ref tips:<interaction id>; source powerchat for a tip on the creator's own
 * PowerChat), and a Vibes amount advances the channel's donation goal with its widget update, "Goal reached" line
 * and sound. The chat line is Tips': Live posts none. Each event acts once (inbox consumer live-tips-ready).
 */
const db = require('../db/database');
const channelTips = require('../monetization/channel-tips');

const CONSUMER = 'live-tips-ready';
const AUDIENCE = 'openvibe.tips';
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const INTERACTION_RE = /^tint_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TIMEOUT_MS = 5000;
const stats = { received: 0, applied: 0, duplicate: 0, ignored: 0, refused: 0 };
let inbox = null;
let tokens = null;

const tipsUrl = () => String(process.env.TIPS_URL || 'http://127.0.0.1:4610').replace(/\/+$/, '');
function ensureInbox() {
    if (!inbox) inbox = require('openvibe-sdk/events').createPgInbox(db.getDb());
    return inbox;
}
function serviceTokens() {
    if (tokens) return tokens;
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) return null;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const network = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    tokens = createServiceTokenClient({ tokenUrl: `${network}/oauth/token`, clientId: process.env.OV_OAUTH_CLIENT_ID || 'live', clientSecret, audience: AUDIENCE });
    return tokens;
}

/** Tips' service view of one interaction (null when Tips does not know it). Throws when Tips cannot answer. */
async function readInteraction(id, { fetchImpl = globalThis.fetch } = {}) {
    const client = serviceTokens();
    if (!client) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const res = await fetchImpl(`${tipsUrl()}/api/v1/interactions/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${await client.getToken()}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (res.status === 401 && client.invalidate) client.invalidate();
    if (!res.ok) throw new Error(`Tips answered ${res.status}`);
    const body = await res.json();
    return body && body.interaction ? body.interaction : body;
}

async function liveUser(subject) {
    const id = subject && typeof subject === 'object' ? subject.id : subject;
    if (!SUBJECT_RE.test(String(id || ''))) return null;
    const row = await db.get("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id DESC LIMIT 1", [id]);
    return row ? row.user_id : null;
}

/** Apply one envelope at most once. Returns 'applied' | 'duplicate' | 'ignored:<why>'. Throws to have it redelivered. */
async function apply(ev, { read = readInteraction } = {}) {
    if (!ev || !EVENT_ID_RE.test(String(ev.event_id || ''))) return 'ignored:envelope';
    if (ev.source !== 'tips') return 'ignored:source';
    if (ev.event_type !== 'tips.interaction.ready') return 'ignored:type';
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (p.test) return 'ignored:test';
    if (!INTERACTION_RE.test(String(p.interaction_id || ''))) return 'ignored:payload';
    const creator = await liveUser(p.creator);
    if (!creator) return 'ignored:no-channel';
    const i = await read(p.interaction_id);
    if (!i) return 'ignored:unknown';
    // Announced by the product it happened on (Live's own on-site donations): Live already counted it.
    if (i.origin === 'billing' || i.origin === 'import' || i.settlement === 'simulated' || i.settlement === 'imported' || i.test) return 'ignored:not-ours';
    const shown = i.public && typeof i.public === 'object' ? i.public : {};
    if (shown.hidden) return 'ignored:hidden';
    const amount = shown.amount == null ? null : Math.max(0, Math.round(Number(shown.amount) || 0));
    const supporter = i.supporter && !i.privacy?.anonymous ? await liveUser(i.supporter) : null;
    const live = await db.getStreamByUserId(creator).catch(() => null);
    const streamId = live && live.is_live ? live.id : null;
    const name = String(shown.supporter_name || i.supporter_name || 'Someone').slice(0, 80);

    let after = null;
    const out = await ensureInbox().once(CONSUMER, `tips:${ev.event_id}`, async () => {
        const inserted = await channelTips.record({
            toUserId: creator, fromUserId: supporter, username: name, streamId, amount,
            source: i.origin === 'billing-external' ? 'powerchat' : 'tips', ref: `tips:${p.interaction_id}`,
        });
        if (!inserted || !(amount > 0) || !/^vibes/i.test(String(i.currency || 'vibes'))) return 'recorded';
        const goalResult = await require('../monetization/vibes').applyDonationToGoal(creator, amount, null);
        if (goalResult) after = () => require('../monetization/goal-announce').announceGoal({ userId: creator, streamId, goalResult, by: name, key: `tips:${p.interaction_id}:goal` });
        return 'goal';
    });
    if (out.duplicate) return 'duplicate';
    if (after) { try { await after(); } catch (e) { console.warn('[TipsEvents] goal announcement:', e.message); } }
    return 'applied';
}

/** Express handler (needs req.rawBody from the express.json verify hook). */
async function handler(req, res) {
    const key = require('../auth/network-events').secret();
    if (key.length < 32) return res.status(503).json({ error: 'LIVE_EVENTS_SECRET is not set' });
    const { parseDelivery } = require('openvibe-sdk/events');
    const delivery = parseDelivery(req.rawBody, req.headers, key, { requireV2: true });
    if (!delivery) { stats.refused++; return res.status(401).json({ error: 'bad signature' }); }
    stats.received++;
    try {
        const out = await apply(delivery.event);
        if (out === 'applied') stats.applied++; else if (out === 'duplicate') stats.duplicate++; else stats.ignored++;
        return res.status(204).end();
    } catch (e) {
        console.error(`[TipsEvents] ${delivery.event && delivery.event.event_type} failed:`, e.message);
        return res.status(500).json({ error: 'not applied; retry' });
    }
}

function _reset() { inbox = null; tokens = null; }

module.exports = { handler, apply, readInteraction, stats, CONSUMER, _reset };
