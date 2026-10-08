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
function allow(ip, signedIn, weight = 1) {
    const now = Date.now(), win = 60_000, max = signedIn ? 40 : 15;
    const list = (_hits.get(ip) || []).filter(t => now - t < win);
    if (list.length + weight > max) { _hits.set(ip, list); return false; }
    for (let i = 0; i < weight; i++) list.push(now);
    _hits.set(ip, list);
    if (_hits.size > 5000) for (const [k, v] of _hits) if (!v.length || now - v[v.length - 1] > win) _hits.delete(k);
    return true;
}

router.get('/languages', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ languages: Object.entries(i18n.LANG_NAMES).map(([code, name]) => ({ code, name, flag: i18n.langFlag(code) })), available: await i18n.available() });
});

router.post('/translate', optionalAuth, async (req, res) => {
    try {
        if (!await i18n.available()) return res.status(503).json({ error: 'Translation is off right now' });
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

// Auto-translate in chat: up to 20 lines per request, one model call for the ones no one has asked for before
// (translateMany). The limit counts lines, a quarter each (most come from the cache), so a busy chat cannot
// out-spend the one-at-a-time button.
router.post('/translate-batch', optionalAuth, async (req, res) => {
    try {
        if (!await i18n.available()) return res.status(503).json({ error: 'Translation is off right now' });
        const to = String(req.body?.to || 'en').trim().toLowerCase();
        if (!i18n.isAllowedLang(to) || to === 'auto') return res.status(400).json({ error: 'Unknown target language' });
        const texts = (Array.isArray(req.body?.texts) ? req.body.texts : []).slice(0, 20).map((t) => String(t || '').trim().slice(0, MAX_CHARS));
        if (!texts.length) return res.status(400).json({ error: 'Nothing to translate' });
        if (!allow(String(req.ip || ''), !!req.user, Math.ceil(texts.length / 4))) return res.status(429).json({ error: 'Slow down — too many translations' });
        const results = await i18n.translateMany(texts, { to, context: 'chat' });
        res.json({ to, to_name: i18n.langName(to), results });
    } catch {
        res.status(500).json({ error: 'Translation failed' });
    }
});

module.exports = router;
