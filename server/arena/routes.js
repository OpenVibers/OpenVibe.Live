/**
 * OpenVibe.Live — Arena API (mounted at /api/arena)
 *
 *   GET  /fighters                     leaderboard (roster ranked by POWER)
 *   GET  /fighters/:user               fighter card (ratings, persona, portrait, record)
 *   POST /fighters/:user/refresh       admin: regenerate persona (+ portrait)
 *   GET  /battle/:a/:b                 today's battle for the pair (creates it on first view)
 *   POST /battle/:a/:b/vote {side}     crowd vote — one per user (or per IP when anonymous)
 *   GET  /live                         currently-live fighters paired up
 *   GET  /status                       feature status (AI on? image gen? roster size)
 */
'use strict';

const express = require('express');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const arena = require('./arena-service');

const router = express.Router();

function gate(req, res, next) {
    if (!arena.arenaEnabled()) return res.status(404).json({ error: 'Arena is disabled' });
    next();
}
router.use(gate);

router.get('/status', (req, res) => {
    try { res.json(arena.status()); }
    catch (err) { console.error('[Arena] status:', err.message); res.status(500).json({ error: 'Arena unavailable' }); }
});

router.get('/fighters', (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ fighters: arena.listFighters(), ai: arena.aiOn(), image_generation: arena.imageGenAvailable() });
    } catch (err) {
        console.error('[Arena] fighters:', err.message);
        res.status(500).json({ error: 'Failed to load the roster' });
    }
});

router.get('/live', (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(arena.getLiveMatchups());
    } catch (err) {
        console.error('[Arena] live:', err.message);
        res.status(500).json({ error: 'Failed to load live matchups' });
    }
});

router.get('/fighters/:user', async (req, res) => {
    try {
        const generate = req.query.generate !== '0';
        const card = await arena.getFighter(req.params.user, { generate });
        if (!card) return res.status(404).json({ error: 'No such fighter' });
        res.set('Cache-Control', 'no-store');
        res.json(card);
    } catch (err) {
        console.error('[Arena] fighter:', err.message);
        res.status(500).json({ error: 'Failed to load fighter' });
    }
});

router.post('/fighters/:user/refresh', requireAuth, permissions.requireAdmin, async (req, res) => {
    try {
        const card = await arena.getFighter(req.params.user, { generate: false });
        if (!card || card.not_on_roster) return res.status(404).json({ error: 'No such fighter on the roster' });
        const persona = await arena.generatePersona(card.user.id, { force: true });
        let image = null;
        if (req.body?.image !== false && arena.imageGenAvailable()) image = await arena.generateImage(card.user.id, { force: true });
        res.json({ ok: true, persona, image_url: image });
    } catch (err) {
        console.error('[Arena] refresh:', err.message);
        res.status(500).json({ error: 'Refresh failed' });
    }
});

router.get('/battle/:a/:b', optionalAuth, async (req, res) => {
    try {
        const battle = await arena.getBattle(req.params.a, req.params.b, { generate: req.query.generate !== '0' });
        if (!battle) return res.status(404).json({ error: 'Pick two different fighters' });
        if (battle.error) return res.status(400).json({ error: battle.error });
        let yourVote = null;
        try {
            const key = arena.voterKeyFor(req);
            const row = require('../db/database').get('SELECT side FROM arena_votes WHERE battle_id = ? AND voter_key = ?', [battle.id, key]);
            yourVote = row ? row.side : null;
        } catch { /* */ }
        res.set('Cache-Control', 'no-store');
        res.json({ ...battle, your_vote: yourVote });
    } catch (err) {
        console.error('[Arena] battle:', err.message);
        res.status(500).json({ error: 'The arena lights went out. Try again.' });
    }
});

router.post('/battle/:a/:b/vote', optionalAuth, async (req, res) => {
    try {
        const battle = await arena.getBattle(req.params.a, req.params.b, { generate: false });
        if (!battle || battle.error) return res.status(404).json({ error: 'No such battle' });
        const side = String(req.body?.side || '');
        const result = arena.castVote(battle.id, arena.voterKeyFor(req), side);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
