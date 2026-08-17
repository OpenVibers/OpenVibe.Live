/**
 * Breaking News API Routes
 * 
 * Admin: configure sources, set global enable/disable
 * Streamers: toggle news for their own streams
 */
'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/auth');
const { isOwner, isSensitiveSettingKey } = require('../auth/permissions');
const newsService = require('./news-service');

// Source `config` blobs can hold credentials (e.g. NewsAPI apiKey) that live
// outside the site_settings table. Mask them for non-owners on read and refuse
// to let non-owners write them.
function redactSourceConfig(source) {
    if (!source || !source.config || typeof source.config !== 'object') return source;
    const config = {};
    let redacted = false;
    for (const [k, v] of Object.entries(source.config)) {
        if (v && isSensitiveSettingKey(k)) {
            const s = String(v);
            config[k] = s.length <= 8 ? '••••••••' : '••••' + s.slice(-4);
            redacted = true;
        } else {
            config[k] = v;
        }
    }
    return { ...source, config, ...(redacted ? { secretsRedacted: true } : {}) };
}

// ── Get all news sources + their status (admin) ─────────────
router.get('/sources', requireAuth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    let sources = newsService.getSources();
    if (!isOwner(req.user)) sources = sources.map(redactSourceConfig);
    res.json({ sources });
});

// ── Update a news source config (admin) ─────────────────────
router.put('/sources/:id', requireAuth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const { enabled } = req.body;
        let { config } = req.body;
        // Strip credential fields from non-owner writes (they can toggle/enable and
        // edit non-secret config, but not set API keys). Also drop masked placeholders.
        if (config && typeof config === 'object') {
            const owner = isOwner(req.user);
            const clean = {};
            for (const [k, v] of Object.entries(config)) {
                if (isSensitiveSettingKey(k)) {
                    if (!owner) continue;
                    if (typeof v === 'string' && /^••••/.test(v)) continue;
                }
                clean[k] = v;
            }
            config = clean;
        }
        newsService.updateSource(req.params.id, { enabled, config });
        const updated = newsService.getSources().find(s => s.id === req.params.id);
        res.json({ success: true, source: isOwner(req.user) ? updated : redactSourceConfig(updated) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get streamer's news preference ──────────────────────────
router.get('/my-settings', requireAuth, (req, res) => {
    const enabled = newsService.getUserEnabled(req.user.id);
    res.json({ enabled }); // null = inherit from global
});

// ── Set streamer's news preference ──────────────────────────
router.put('/my-settings', requireAuth, (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    newsService.setUserEnabled(req.user.id, enabled);
    res.json({ success: true, enabled });
});

module.exports = router;
