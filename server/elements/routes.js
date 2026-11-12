'use strict';
/**
 * Elements, stage 1: the API.
 *
 *   The streamer's library (signed in):
 *     GET    /api/me/elements                 the library and whether the deck is on
 *     GET    /api/me/elements/settings        the deck switch
 *     PUT    /api/me/elements/settings        { enabled } — off until the streamer turns it on
 *     POST   /api/me/elements                 create (validated through openvibe-sdk/elements)
 *     GET    /api/me/elements/:id             one element
 *     PATCH  /api/me/elements/:id             name, look, recipe, capabilities, sharing, active, position
 *     DELETE /api/me/elements/:id
 *
 *   The Viewer Deck on a channel page (public read, per-viewer hints):
 *     GET    /api/channels/:name/elements             the active elements, their state, what this viewer may press
 *     POST   /api/channels/:name/elements/:id/press   press one: role, cooldowns, daily caps, channel points, live
 *
 * Everything the owner saves goes through the SDK's validate(); everything a press does goes through
 * the SDK's run() and then the product that owns each action. No route here moves money.
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');
const store = require('./store');
const press = require('./press');

const ownerRouter = express.Router();
const channelRouter = express.Router();

const fail = (res, err) => {
    if (err instanceof store.ElementError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...(err.errors ? { errors: err.errors } : {}) });
    }
    console.warn('[Elements]', err && err.message);
    return res.status(500).json({ error: 'The element could not be saved right now.', code: 'elements.error' });
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const publicElement = (e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    look: e.look,
    capabilities: e.capabilities,
    state: e.state,
});

// ── The streamer's library ───────────────────────────────────────────────────
ownerRouter.get('/', requireAuth, wrap(async (req, res) => {
    const [{ enabled }, elements] = await Promise.all([store.settings(req.user.id), store.list(req.user.id)]);
    res.set('Cache-Control', 'no-store');
    res.json({ enabled, elements: elements.map((e) => ({ ...e, author: { name: req.user.display_name || req.user.username } })) });
}));

ownerRouter.get('/settings', requireAuth, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await store.settings(req.user.id));
}));

ownerRouter.put('/settings', requireAuth, wrap(async (req, res) => {
    if (!req.body || typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled is true or false', code: 'element.invalid' });
    res.json(await store.setEnabled(req.user.id, req.body.enabled));
}));

ownerRouter.post('/', requireAuth, wrap(async (req, res) => {
    try {
        const element = await store.create(req.user, req.body);
        res.status(201).json({ element });
    } catch (e) { fail(res, e); }
}));

ownerRouter.get('/:id', requireAuth, wrap(async (req, res) => {
    const found = await store.byPublicId(req.user.id, req.params.id);
    if (!found) return res.status(404).json({ error: 'That element does not exist.', code: 'element.not_found' });
    res.json({ element: { ...found.element, author: { name: req.user.display_name || req.user.username } } });
}));

ownerRouter.patch('/:id', requireAuth, wrap(async (req, res) => {
    try {
        const element = await store.update(req.user, req.params.id, req.body);
        res.json({ element });
    } catch (e) { fail(res, e); }
}));

ownerRouter.delete('/:id', requireAuth, wrap(async (req, res) => {
    try {
        res.json(await store.remove(req.user, req.params.id));
    } catch (e) { fail(res, e); }
}));

// ── The Viewer Deck ─────────────────────────────────────────────────────────
/** What this viewer may press, without running anything: the deck's disabled states come from here. */
async function deckHints(channel, viewer, elements, live) {
    const sdk = store.elementsSdk();
    const need = elements.reduce((highest, { row }) => {
        const role = store.conditionsOf(row).role || 'everyone';
        return (sdk.ROLE_RANK[role] || 0) > (sdk.ROLE_RANK[highest] || 0) ? role : highest;
    }, 'everyone');
    const role = viewer ? (await press.roleOf(channel, viewer, {}, need)).role : null;
    const viewerRank = role ? (sdk.ROLE_RANK[role] || 0) : 0;
    let balance = null;
    if (viewer) { try { balance = Number(await db.getChannelPoints(viewer.id, channel.user_id)) || 0; } catch { balance = null; } }
    const now = Date.now();
    const out = [];
    for (const { row, element } of elements) {
        const conditions = store.conditionsOf(row);
        const needed = conditions.role || 'everyone';
        const cost = conditions.cost && Number.isInteger(conditions.cost.points) ? conditions.cost.points : 0;
        let reason = null, message = null, retryAfter = 0;
        const cooldown = await store.cooldownLeft(row, viewer && viewer.id, now);
        const today = viewer ? await store.remainingToday(row, viewer.id, now) : { per_person: null, overall: null };
        if (!viewer) { reason = 'sign_in'; message = 'Sign in to press the deck.'; }
        else if (!live) { reason = 'offline'; message = 'The deck runs while the channel is live.'; }
        else if ((sdk.ROLE_RANK[role] || 0) < (sdk.ROLE_RANK[needed] || 0)) { reason = 'role'; message = needed === 'owner' ? 'Only the channel owner can press this.' : `Only ${needed}s can press this.`; }
        else if (cost && balance != null && balance < cost) { reason = 'points'; message = `It costs ${cost} points; you have ${balance}.`; }
        else if (cooldown > 0) { reason = 'cooldown'; message = `On cooldown for ${Math.ceil(cooldown / 1000)} more seconds.`; retryAfter = cooldown; }
        else if (today.per_person === 0 || today.overall === 0) { reason = 'daily_cap'; message = 'Today\'s limit for this element is used up.'; }
        out.push({
            ...publicElement(element),
            cost_points: cost,
            cooldown_ms: cooldown,
            daily_remaining: today,
            can_press: !reason,
            reason,
            message,
            ...(retryAfter ? { retry_after_ms: retryAfter } : {}),
        });
    }
    return { role, balance, elements: out };
}

channelRouter.get('/:name/elements', optionalAuth, wrap(async (req, res) => {
    const channel = await store.channelByUsername(req.params.name);
    if (!channel) return res.status(404).json({ error: 'Channel not found', code: 'channel.not_found' });
    res.set('Cache-Control', 'no-store');
    const enabled = !!Number(channel.deck_enabled);
    const live = (await db.getLiveStreamsByUserId(channel.user_id) || [])[0] || null;
    const deck = enabled ? await store.deck(channel.user_id) : [];
    const hints = await deckHints(channel, req.user || null, deck, live);
    res.json({
        surface: 'live.deck',
        channel: { username: channel.username, display_name: channel.display_name || channel.username, avatar_url: channel.avatar_url || null },
        enabled,
        live: !!live,
        stream_id: live ? Number(live.id) : null,
        viewer: { signed_in: !!req.user, role: hints.role, points: hints.balance },
        elements: hints.elements,
    });
}));

channelRouter.post('/:name/elements/:id/press', requireAuth, wrap(async (req, res) => {
    const channel = await store.channelByUsername(req.params.name);
    if (!channel) return res.status(404).json({ error: 'Channel not found', code: 'channel.not_found' });
    const result = await press.fromPress({ channel, presser: req.user, id: req.params.id });
    res.set('Cache-Control', 'no-store');
    if (!result.ok) {
        if (result.retry_after_ms) res.set('Retry-After', String(Math.max(1, Math.ceil(result.retry_after_ms / 1000))));
        return res.status(result.status || 400).json({
            ok: false, error: result.message, code: result.code,
            ...(result.retry_after_ms ? { retry_after_ms: result.retry_after_ms } : {}),
            ...(result.refunded ? { refunded: true } : {}),
        });
    }
    res.json(result);
}));

module.exports = { ownerRouter, channelRouter, publicElement, deckHints };
