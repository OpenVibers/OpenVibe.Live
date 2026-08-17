'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const db = require('../db/database');

function requireInternalKey(req, res, next) {
    const key = req.headers['x-internal-key'];
    if (!key || key !== config.internalApiKey) {
        return res.status(403).json({ error: 'Invalid or missing internal key' });
    }
    next();
}

router.use(requireInternalKey);

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
        console.log(`[Internal] role push: ${user.username} -> ${finalRole}`);
        return res.json({ ok: true, id: user.id, username: user.username, role: finalRole });
    } catch (err) {
        console.error('[Internal] user-role error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
