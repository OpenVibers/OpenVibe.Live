/**
 * i18n/routes.js — on-demand translation for viewers (mounted at /api/i18n).
 *
 *   POST /api/i18n/translate { text, to }  → { from, to, text }   (text null when nothing to do)
 *
 * The chat auto-translation (server/i18n/translate.js) covers the two automatic directions
 * (foreign → English for everyone, English → the streamer's language). This route is the
 * third: ANY viewer can ask for ANY line in THEIR language — an English viewer on a Spanish
 * stream, a Japanese viewer on an English stream, a Korean viewer reading JapaneseOldGuy.
 * Cached like everything else, budget-metered, and rate-limited per IP so it cannot be used
 * as a free translation API.
 */
'use strict';

const express = require('express');
const { optionalAuth } = require('../auth/auth');
const i18n = require('./translate');

const router = express.Router();
const MAX_CHARS = 600;
const _hits = new Map();   // ip → [timestamps]
function allow(ip, signedIn) {
    const now = Date.now(), win = 60_000, max = signedIn ? 40 : 15;
    const list = (_hits.get(ip) || []).filter(t => now - t < win);
    if (list.length >= max) { _hits.set(ip, list); return false; }
    list.push(now); _hits.set(ip, list);
    if (_hits.size > 5000) for (const [k, v] of _hits) if (!v.length || now - v[v.length - 1] > win) _hits.delete(k);
    return true;
}

router.get('/languages', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ languages: Object.entries(i18n.LANG_NAMES).map(([code, name]) => ({ code, name, flag: i18n.langFlag(code) })), available: i18n.available() });
});

router.post('/translate', optionalAuth, async (req, res) => {
    try {
        if (!i18n.available()) return res.status(503).json({ error: 'Translation is off right now' });
        if (!allow(String(req.ip || ''), !!req.user)) return res.status(429).json({ error: 'Slow down — too many translations' });
        const text = String(req.body?.text || '').trim().slice(0, MAX_CHARS);
        const to = String(req.body?.to || 'en').trim().toLowerCase();
        if (!text) return res.status(400).json({ error: 'Nothing to translate' });
        if (!i18n.isAllowedLang(to) || to === 'auto') return res.status(400).json({ error: 'Unknown target language' });
        const from = i18n.detectLang(text) || 'auto';
        if (from === to) return res.json({ from, to, text: null, same: true });
        const out = await i18n.translate(text, { from, to, context: 'chat' });
        res.json({ from, to, text: out || null, from_name: i18n.langName(from), to_name: i18n.langName(to) });
    } catch (err) {
        res.status(500).json({ error: 'Translation failed' });
    }
});

module.exports = router;
