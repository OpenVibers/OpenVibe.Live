/**
 * OpenVibe.Live — Theme API Routes
 * 
 * GET    /api/themes              — List all public themes (filterable)
 * GET    /api/themes/me           — Get current user's active theme
 * GET    /api/themes/:idOrSlug    — Get theme by ID or slug
 * POST   /api/themes              — Submit a new community theme
 * PUT    /api/themes/:id          — Update a community theme (author only)
 * DELETE /api/themes/:id          — Delete a community theme (author/admin)
 * POST   /api/themes/:id/download — Increment download counter
 * PUT    /api/themes/me           — Set user's active theme
 */

const express = require('express');
const router = express.Router();
const { requireAuth, optionalAuth } = require('../auth/auth');
const themeService = require('./theme-service');

/* ── List all public themes ────────────────────────────────── */
router.get('/', (req, res) => {
    try {
        const { mode, search, sort, limit, offset } = req.query;
        const themes = themeService.getAllThemes({
            mode,
            search,
            sort: sort || 'name',
            limit: Math.min(parseInt(limit) || 100, 200),
            offset: parseInt(offset) || 0,
        });

        // Parse JSON fields for client
        const parsed = themes.map(t => ({
            ...t,
            variables: JSON.parse(t.variables || '{}'),
            preview_colors: JSON.parse(t.preview_colors || '{}'),
            tags: JSON.parse(t.tags || '[]'),
        }));

        res.json({ themes: parsed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Get current user's theme preference ───────────────────── */
router.get('/me', requireAuth, (req, res) => {
    try {
        const pref = themeService.getUserTheme(req.user.id);
        if (!pref) {
            return res.json({ theme: null, custom_variables: {}, is_custom: false });
        }
        let themeData = null;
        if (pref.theme_id) {
            themeData = themeService.getThemeById(pref.theme_id);
            if (themeData) {
                themeData.variables = JSON.parse(themeData.variables || '{}');
                themeData.preview_colors = JSON.parse(themeData.preview_colors || '{}');
                themeData.tags = JSON.parse(themeData.tags || '[]');
            }
        }
        res.json({
            theme: themeData,
            theme_id: pref.theme_id,
            custom_variables: JSON.parse(pref.custom_variables || '{}'),
            is_custom: !!pref.is_custom,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Set user's active theme ───────────────────────────────── */
router.put('/me', requireAuth, (req, res) => {
    try {
        const { theme_id, custom_variables, is_custom } = req.body;
        themeService.setUserTheme(req.user.id, {
            theme_id: theme_id || null,
            custom_variables: custom_variables || {},
            is_custom: !!is_custom,
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Get theme by ID or slug ───────────────────────────────── */
router.get('/:idOrSlug', (req, res) => {
    try {
        const param = req.params.idOrSlug;
        let theme = /^\d+$/.test(param)
            ? themeService.getThemeById(parseInt(param))
            : themeService.getThemeBySlug(param);

        if (!theme) return res.status(404).json({ error: 'Theme not found' });

        theme.variables = JSON.parse(theme.variables || '{}');
        theme.preview_colors = JSON.parse(theme.preview_colors || '{}');
        theme.tags = JSON.parse(theme.tags || '[]');

        res.json({ theme });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Submit community theme ────────────────────────────────── */
router.post('/', requireAuth, (req, res) => {
    try {
        const { name, description, mode, variables, tags } = req.body;
        if (!name || !variables) {
            return res.status(400).json({ error: 'Name and variables are required' });
        }
        if (name.length > 50) {
            return res.status(400).json({ error: 'Name must be 50 characters or less' });
        }

        const result = themeService.createTheme({
            name,
            author_id: req.user.id,
            description: description || '',
            mode: mode || 'dark',
            variables,
            tags: tags || [],
        });

        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/* ── Update community theme ────────────────────────────────── */
router.put('/:id', requireAuth, (req, res) => {
    try {
        const { name, description, mode, variables, tags } = req.body;
        themeService.updateTheme(parseInt(req.params.id), req.user.id, {
            name, description, mode, variables, tags,
        });
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/* ── Delete community theme ────────────────────────────────── */
router.delete('/:id', requireAuth, (req, res) => {
    try {
        const isAdmin = req.user.role === 'admin';
        themeService.deleteTheme(parseInt(req.params.id), req.user.id, isAdmin);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/* ── Download (increment counter) ──────────────────────────── */
router.post('/:id/download', (req, res) => {
    try {
        themeService.downloadTheme(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
