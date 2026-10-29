'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const poll = require('./service');
const router = express.Router();

router.get('/channel/:username', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const user = await db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'Channel not found' });
        return res.json({ poll: await poll.current(user.id) });
    } catch (err) { console.warn('[BenchStream] read:', err.message); return res.status(503).json({ error: 'Bench is unavailable' }); }
});

router.get('/mine', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json({ poll: await poll.current(req.user.id) }); }
    catch (err) { console.warn('[BenchStream] mine:', err.message); return res.status(503).json({ error: 'Bench is unavailable' }); }
});

router.post('/mine', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const b = req.body || {};
        return res.status(201).json({ poll: await poll.start(req.user.id, {
            kind: b.kind, prompt: b.prompt, durationSeconds: b.duration_seconds == null ? 60 : b.duration_seconds,
        }) });
    } catch (err) {
        if (/^(Choose|Write|Vote time|Go live|Finish|Sign in again)/.test(err.message)) return res.status(400).json({ error: err.message });
        console.warn('[BenchStream] start:', err.message);
        return res.status(503).json({ error: 'Bench could not start the round' });
    }
});

module.exports = router;
