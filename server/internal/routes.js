'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const db = require('../db/database');

const { guard } = require('../net/service-guard');
const { http } = require('openvibe-contracts');
const { bindSlot, BindError } = require('../openre/bind');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

// Service-to-service only, loopback only (nothing that came through nginx): each route checks the one capability it
// performs on a Network service token (server/net/service-guard.js); nothing else gets in (X-Internal-Key: plan T2).

// OpenVibe.Chat caches users; a role or avatar pushed here reaches it at once.
async function notifyChat(userId) {
    try {
        const delivery = require('../chat/chat-delivery');
        await delivery.invalidate({ user: Number(userId) });
    } catch { /* non-critical */ }
}

// Footer site copy is written by OpenVibe.AI for the Network directly (network.site_copy); the
// /internal/ai/site-copy fallback that used to live here was retired on 2026-09-23.

router.post('/url-registry/refresh', guard('live.url_registry.refresh'), async (req, res) => {
    try {
        await config.refreshRegistry();
        console.log('[Internal] URL registry refresh requested');
        return res.json({ ok: true, message: 'URL registry refreshed' });
    } catch (err) {
        console.error('[Internal] url-registry/refresh error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Roles are no longer pushed here: POST /internal/user-role (key-only, register C-54/C-55) was retired in
// WS-B task 2. A role change on the Network reaches Live as network.user.updated at POST /internal/network-events
// (server/auth/subject-projection.js), which also applies downgrades.

// ── The account's avatar changed on the Network (or on another site) ─────────
// The avatar is a network-wide property (OpenVibe.Network server/profile/avatar.js). Live keeps a copy on its
// own user row because every stream card, chat line and profile reads it locally.
router.post('/user-avatar', guard('live.avatar.write'), async (req, res) => {
    try {
        const { username, openvibenetwork_id, avatar_url } = req.body || {};
        let url = null;
        if (avatar_url) {
            let u; try { u = new URL(String(avatar_url)); } catch { return res.status(400).json({ ok: false, error: 'bad url' }); }
            if (u.protocol !== 'https:' || u.hostname !== 'openvibe.media' || String(avatar_url).length > 500) return res.status(422).json({ ok: false, error: 'avatars live on openvibe.media' });
            url = u.toString();
        }
        let user = null;
        if (openvibenetwork_id != null) {
            const linked = await db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND service_user_id = ?").get(String(openvibenetwork_id));
            if (linked) user = await db.getUserById(linked.user_id);
        }
        if (!user && username) user = await db.getUserByUsername(username);
        if (!user) return res.status(404).json({ ok: false, error: 'user not found' });
        if ((user.avatar_url || null) !== url) await db.updateUserAvatar(user.id, url, null);
        await notifyChat(user.id);
        return res.json({ ok: true, id: user.id, changed: (user.avatar_url || null) !== url });
    } catch (err) {
        console.error('[Internal] user-avatar error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── Channel points changes for Network's gain/loss API (ask 273) ────────────────
// GET /internal/channel-points/changes?network_user_id=<id>&since_id=&streamer_id=&limit=
// guard('live.channel_points.read'): a Network service token only, loopback only. Reads Live's own
// channel_points_log (the per-channel ledger; Billing stays the only money ledger) for the person
// behind the Network account: one move per row, oldest first, with the cursor for the next page.
router.get('/channel-points/changes', guard('live.channel_points.read'), async (req, res) => {
    try {
        const networkId = String(req.query.network_user_id || '');
        if (!networkId) return res.status(400).json({ ok: false, error: 'network_user_id is required' });
        // The account is named by its Network subject (usr_…); older links that only carry the numeric
        // service id still resolve.
        let linked = SUBJECT_RE.test(networkId)
            ? await db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id DESC LIMIT 1").get(networkId)
            : null;
        if (!linked) linked = await db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND service_user_id = ?").get(networkId);
        if (!linked) return res.status(404).json({ ok: false, error: 'no linked live account' });
        const userId = linked.user_id;
        let streamerId = null;
        if (req.query.streamer_id != null && req.query.streamer_id !== '') {
            streamerId = Number(req.query.streamer_id);
            if (!Number.isInteger(streamerId) || streamerId <= 0) return res.status(400).json({ ok: false, error: 'streamer_id is a user id' });
        }
        let sinceId = 0;
        if (req.query.since_id != null && req.query.since_id !== '') {
            sinceId = Number(req.query.since_id);
            if (!Number.isInteger(sinceId) || sinceId < 0) return res.status(400).json({ ok: false, error: 'since_id is a log id' });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const where = streamerId ? 'user_id = ? AND streamer_id = ? AND id > ?' : 'user_id = ? AND id > ?';
        const args = streamerId ? [userId, streamerId, sinceId] : [userId, sinceId];
        const rows = await db.getDb().prepare(`SELECT id, streamer_id, delta, reason, created_at AS at FROM channel_points_log
            WHERE ${where} ORDER BY id ASC LIMIT ?`).all(...args, limit + 1);
        const page = rows.slice(0, limit);
        const balance = streamerId ? await db.getChannelPoints(userId, streamerId) : null;
        return res.json({
            ok: true, user_id: userId, streamer_id: streamerId, balance,
            moves: page.map((r) => ({ id: r.id, streamer_id: r.streamer_id, at: r.at, delta: r.delta, reason: r.reason || null })),
            cursor: page.length ? page[page.length - 1].id : sinceId,
            next_since: rows.length > limit ? page[page.length - 1].id : null,
        });
    } catch (err) {
        console.error('[Internal] channel-points/changes error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── OpenVibe Live on by default for OpenRestream (live.openre.slot.bind) ─────────
// OpenRestream asks for a slot on the person's channel bound to their OpenRestream stream (server/openre/bind.js).
router.post('/openre/slots', guard('live.openre.slot.bind'), async (req, res) => {
    try {
        const out = await bindSlot(req.body || {});
        return res.status(out.created ? 201 : 200).json(out);
    } catch (err) {
        if (err instanceof BindError) {
            return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: http.requestContext(req.headers) });
        }
        console.error('[Internal] openre/slots error:', err.message);
        return res.status(500).json({ ok: false, error: 'slot bind failed' });
    }
});

module.exports = router;
