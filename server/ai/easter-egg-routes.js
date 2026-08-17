/**
 * easter-egg-routes.js — read + solve API for the daily easter egg.
 *   GET  /api/easter-egg/daily  → title, hints, code LENGTH (never the code), effect, counts
 *   POST /api/easter-egg/solve  → validate a key sequence server-side; record the solve
 */
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const eggJob = require('./easter-egg-job');
let optionalAuth = (req, res, next) => next();
try { ({ optionalAuth } = require('../auth/auth')); } catch { /* */ }

function _solverKey(req) { return (req.user && req.user.id) ? ('u' + req.user.id) : ('a' + (req.ip || 'anon')); }

router.get('/daily', optionalAuth, (req, res) => {
    try {
        const pub = eggJob.getPublic();
        if (!pub) return res.json({ egg: null });
        res.json({
            egg: {
                ...pub,
                foundCount: db.countEasterEggSolves(pub.date),
                solved: db.hasSolvedEasterEgg(pub.date, _solverKey(req)),
            },
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load easter egg' });
    }
});

// Light per-IP rate limit so the secret can't be brute-forced/spammed.
const _attempts = new Map();
router.post('/solve', optionalAuth, (req, res) => {
    try {
        const ip = req.ip || 'anon';
        const now = Date.now();
        const rec = _attempts.get(ip) || { n: 0, t: now };
        if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
        rec.n++; _attempts.set(ip, rec);
        if (rec.n > 60) return res.status(429).json({ error: 'Too many attempts — slow down.' });

        const seq = Array.isArray(req.body && req.body.sequence) ? req.body.sequence.slice(-30) : null;
        if (!seq) return res.status(400).json({ error: 'sequence required' });

        const result = eggJob.checkSolution(seq);
        if (!result || !result.ok) return res.json({ solved: false });

        const firstTime = db.recordEasterEggSolve(result.egg.date, _solverKey(req), (req.user && req.user.id) || null);
        res.json({
            solved: true,
            firstTime,
            egg: { title: result.egg.title, effect: result.egg.effect, reward: result.egg.reward },
            foundCount: db.countEasterEggSolves(result.egg.date),
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to check solution' });
    }
});

module.exports = router;
