'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const db = require('../db/database');

function requireInternalKey(req, res, next) {
    const key = req.headers['x-internal-key'];
    // Service-to-service only: nginx adds X-Forwarded-For to everything from outside, loopback callers never do.
    const viaProxy = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip'];
    if (viaProxy || !key || !config.internalApiKey || key !== config.internalApiKey) {
        return res.status(403).json({ error: 'Invalid or missing internal key' });
    }
    next();
}

router.use(requireInternalKey);

// ── Site copy for the shared footer (OpenVibe.Network → here, once a day) ─────────────
// The Network sends facts about each site plus an allow-list of link ids; the model writes a
// short blurb per site and PICKS ids from that list. It never returns URLs or markup, so nothing
// it says can become a link or a tag on another site. Gated by the shared AI budget.
let _siteCopyBusy = false;
router.post('/ai/site-copy', async (req, res) => {
    if (_siteCopyBusy) return res.status(429).json({ ok: false, error: 'busy' });
    const sites = Array.isArray(req.body?.sites) ? req.body.sites.slice(0, 24) : [];
    const links = Array.isArray(req.body?.links) ? req.body.links.slice(0, 80) : [];
    if (!sites.length) return res.status(400).json({ ok: false, error: 'sites required' });
    const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
    const facts = sites.map(x => ({ id: clean(x.id, 40), name: clean(x.name, 60), what: clean(x.what, 400), popular: (Array.isArray(x.popular) ? x.popular : []).slice(0, 8).map(v => clean(v, 60)) }));
    const linkList = links.map(l => ({ id: clean(l.id, 60), name: clean(l.name, 60), about: clean(l.about, 120) }));
    _siteCopyBusy = true;
    try {
        const llm = require('../ai/llm');
        const out = await llm.complete({
            role: 'summary', kind: 'site_copy', source: 'network-footer', maxTokens: 2200, temperature: 0.7, timeoutMs: 60000,
            system: 'You write footer copy for OpenVibe, an open source, community-run network of sites (live streaming, online tools, community pastes, games, media). Voice: plain, confident, specific, a little playful. Never claim anything is free, costs $0, or has no ads. No hype words, no emoji, no markup, no URLs. For each site write one blurb of at most 150 characters saying what a visitor can do there right now, and choose 4 link ids from the provided list that a visitor of that site would most likely want next (prefer other sites and popular tools; never the site itself).',
            user: JSON.stringify({ sites: facts, links: linkList }),
            json: { name: 'site_copy', strict: true, schema: { type: 'object', additionalProperties: false, required: ['sites'], properties: { sites: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'blurb', 'picks'], properties: { id: { type: 'string' }, blurb: { type: 'string' }, picks: { type: 'array', items: { type: 'string' } } } } } } } },
        });
        if (!out || !out.json || !Array.isArray(out.json.sites)) return res.status(503).json({ ok: false, error: 'AI unavailable or over budget' });
        res.json({ ok: true, model: out.model, sites: out.json.sites });
    } catch (err) {
        res.status(502).json({ ok: false, error: err.message });
    } finally { _siteCopyBusy = false; }
});

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
