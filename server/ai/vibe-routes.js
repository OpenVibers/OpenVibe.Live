'use strict';
/**
 * /api/vibe — a streamer's Vibe on stream settings (server/ai/vibe-voice.js): the call word that wakes Vibe, whether it
 * listens, and whether its answers are read aloud.
 *   GET /settings → { settings: { enabled, call_word, speak }, hearing }   hearing: the live captions Vibe hears through are on
 *   PUT /settings { enabled?, call_word?, speak? } → { settings } | 422 { error }
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const voice = require('./vibe-voice');

const router = express.Router();

async function hearing() {
    try { return await require('./timeline-job').timelineEnabled(); } catch { return false; }
}

router.get('/settings', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'private, no-store').json({ settings: await voice.settingsFor(req.user.id), hearing: await hearing() });
});

router.put('/settings', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const out = await voice.saveSettings(req.user.id, req.body || {});
    if (out.error) return res.status(422).json({ error: out.error });
    res.json({ settings: out.settings, hearing: await hearing() });
});

module.exports = router;
