'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const db = require('../db/database');

const { internalKeyOk } = require('../net/internal-key');

// Service-to-service only: loopback (nothing that came through nginx) and INTERNAL_API_KEY,
// compared in constant time (server/net/internal-key.js).
function requireInternalKey(req, res, next) {
    if (!internalKeyOk(req)) {
        return res.status(403).json({ error: 'Invalid or missing internal key' });
    }
    next();
}

router.use(requireInternalKey);

// CHAT_AUTHORITY=chat: OpenVibe.Chat caches users; a role or avatar pushed here reaches it at once.
function notifyChat(userId) {
    try { const cs = require('../chat/chat-server'); if (cs.remote) cs.userChanged(userId); } catch { /* non-critical */ }
}

// ── The staged chat tables (roadmap C-04, server/chat/chat-tables.js) ─────────────
// GET  /internal/chat-tables          who writes each table (here and in OpenVibe.Chat), the relay to
//                                     Chat, the dual-read counts
// POST /internal/chat-tables/:table   { dual_read?: bool, reset_counters?: bool, authority?: 'live'|'chat',
//                                       by?: 'who', force?: true (back to 'live' with Chat down) } — the
//                                       flag, the counters, then the handoff
router.get('/chat-tables', async (req, res) => {
    try { res.json(await require('../chat/chat-tables').status()); } catch (err) { res.status(500).json({ error: err.message }); }
});
// POST /internal/chat-tables/relay { paused: bool } — hold the relay to Chat (the capture goes on) for an import
router.post('/chat-tables/relay', (req, res) => {
    try {
        const sync = require('../chat/chat-tables-sync');
        if (req.body && req.body.paused !== undefined) sync.setPaused(req.body.paused === true || req.body.paused === 'true');
        res.json({ ok: true, relay: sync.relayStats() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/chat-tables/:table', async (req, res) => {
    const chatTables = require('../chat/chat-tables');
    const table = String(req.params.table);
    const b = req.body || {};
    try {
        if (!chatTables.TABLES[table]) return res.status(404).json({ error: `${table} is not a staged table` });
        if (b.dual_read !== undefined) chatTables.setDualRead(table, b.dual_read === true || b.dual_read === 'true' || b.dual_read === 1);
        if (b.reset_counters) require('../chat/chat-tables-sync').resetDualReadStats(table);
        let handoff = null;
        if (b.authority !== undefined) handoff = await chatTables.setAuthority(table, String(b.authority), { by: String(b.by || 'operator').slice(0, 80), force: b.force === true });
        const st = await chatTables.status();
        res.json({ ok: true, handoff, table: st.tables[table], chat_error: st.chat_error });
    } catch (err) {
        const st = await chatTables.status({ askChat: false }).catch(() => null);
        res.status(err.status || 500).json({ ok: false, error: err.message, table: st ? st.tables[table] : null });
    }
});

// Footer site copy is written by OpenVibe.AI for the Network directly (network.site_copy); the
// /internal/ai/site-copy fallback that used to live here was retired on 2026-09-23.

router.post('/url-registry/refresh', async (req, res) => {
    try {
        await config.refreshRegistry();
        console.log('[Internal] URL registry refresh requested');
        return res.json({ ok: true, message: 'URL registry refreshed' });
    } catch (err) {
        console.error('[Internal] url-registry/refresh error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Authoritative role push from openvibe.network (the SSO/role authority). Used so a
// role change propagates to the local user record immediately — instead of
// waiting on the user's next token (up to 24h) and without letting a stale token
// downgrade them. Matches by openvibe.network account link first, then username.
// ── The account's avatar changed on the Network (or on another site) ─────────
// The avatar is a network-wide property (OpenVibe.Network server/profile/avatar.js). Live keeps a copy on its
// own user row because every stream card, chat line and profile reads it locally.
router.post('/user-avatar', (req, res) => {
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
            const linked = db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND service_user_id = ?").get(String(openvibenetwork_id));
            if (linked) user = db.getUserById(linked.user_id);
        }
        if (!user && username) user = db.getUserByUsername(username);
        if (!user) return res.status(404).json({ ok: false, error: 'user not found' });
        if ((user.avatar_url || null) !== url) db.updateUserAvatar(user.id, url, null);
        notifyChat(user.id);
        return res.json({ ok: true, id: user.id, changed: (user.avatar_url || null) !== url });
    } catch (err) {
        console.error('[Internal] user-avatar error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/user-role', (req, res) => {
    try {
        const { username, openvibenetwork_id, role } = req.body || {};
        const VALID = ['user', 'streamer', 'global_mod', 'admin'];
        if (!VALID.includes(role)) return res.status(400).json({ ok: false, error: 'invalid role' });

        let user = null;
        if (openvibenetwork_id != null) {
            const linked = db.getDb().prepare(
                "SELECT user_id FROM linked_accounts WHERE service = 'network' AND service_user_id = ?"
            ).get(String(openvibenetwork_id));
            if (linked) user = db.getUserById(linked.user_id);
        }
        if (!user && username) user = db.getUserByUsername(username);
        if (!user) return res.status(404).json({ ok: false, error: 'user not found' });

        // Never strip the owner's admin role via a role push (is_owner is local).
        const finalRole = (user.is_owner && role !== 'admin') ? 'admin' : role;
        db.getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(finalRole, user.id);
        notifyChat(user.id);
        console.log(`[Internal] role push: ${user.username} -> ${finalRole}`);
        return res.json({ ok: true, id: user.id, username: user.username, role: finalRole });
    } catch (err) {
        console.error('[Internal] user-role error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
