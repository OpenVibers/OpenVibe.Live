const express = require('express');
const canvasService = require('./canvas-service');
const { optionalAuth, requireAuth, requireAdmin, requireStaff } = require('../auth/auth');
const { isStaff } = require('../auth/permissions');

const router = express.Router();

function requestIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
}

router.get('/state', optionalAuth, (req, res) => {
    try {
        res.json(canvasService.getBoardState(req.user || null, requestIp(req)));
    } catch (err) {
        res.status(500).json({ error: 'Failed to load canvas state' });
    }
});

router.get('/history', optionalAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '60', 10), 200);
        res.json({ actions: canvasService.getRecentActions(limit) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load canvas history' });
    }
});

router.post('/place', requireAuth, (req, res) => {
    try {
        res.json(canvasService.placeTile(req.user, requestIp(req), req.body));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message, ...(err.data || {}) });
    }
});

router.get('/staff/bans', requireStaff, (req, res) => {
    res.json({ bans: canvasService.getBans() });
});

router.post('/staff/bans', requireStaff, (req, res) => {
    try {
        res.status(201).json({ ban: canvasService.createBan(req.body || {}, req.user) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create canvas ban' });
    }
});

router.delete('/staff/bans/:id', requireStaff, (req, res) => {
    try {
        canvasService.removeBan(Number(req.params.id), req.user);
        res.json({ message: 'Canvas ban removed' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove canvas ban' });
    }
});

router.get('/staff/regions', requireStaff, (req, res) => {
    res.json({ regions: canvasService.getActiveRegions() });
});

router.post('/staff/regions', requireStaff, (req, res) => {
    try {
        res.status(201).json({ region: canvasService.createRegion(req.body || {}, req.user) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create canvas region' });
    }
});

router.delete('/staff/regions/:id', requireStaff, (req, res) => {
    try {
        canvasService.removeRegion(Number(req.params.id), req.user);
        res.json({ message: 'Canvas region removed' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove canvas region' });
    }
});

router.post('/staff/rollback', requireStaff, (req, res) => {
    try {
        res.json(canvasService.rollback(req.body || {}, req.user));
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to rollback canvas changes' });
    }
});

router.get('/staff/heatmap', requireStaff, (req, res) => {
    try {
        res.json(canvasService.getHeatmap(Number(req.query.hours || 12)));
    } catch (err) {
        res.status(500).json({ error: 'Failed to load canvas heatmap' });
    }
});

router.get('/staff/actions', requireStaff, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 300);
        res.json({ actions: canvasService.getRecentActions(limit) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load canvas action log' });
    }
});

router.get('/staff/snapshots', requireStaff, (req, res) => {
    res.json({ snapshots: canvasService.getSnapshots() });
});

router.get('/admin/overrides', requireAdmin, (req, res) => {
    res.json({ overrides: canvasService.getOverrides() });
});

router.get('/admin/settings', requireAdmin, (req, res) => {
    res.json({ settings: canvasService.getSettings() });
});

router.post('/admin/overrides', requireAdmin, (req, res) => {
    try {
        res.json({ override: canvasService.upsertOverride(req.body || {}, req.user) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save canvas override' });
    }
});

router.delete('/admin/overrides/:userId', requireAdmin, (req, res) => {
    try {
        canvasService.removeOverride(Number(req.params.userId), req.user);
        res.json({ message: 'Canvas override removed' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove canvas override' });
    }
});

router.post('/admin/settings', requireAdmin, (req, res) => {
    try {
        res.json({ settings: canvasService.updateSettings(req.body || {}, req.user) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update canvas settings' });
    }
});

router.post('/admin/snapshots', requireAdmin, (req, res) => {
    try {
        res.status(201).json({ snapshot: canvasService.createSnapshot(req.body?.name, req.user) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create canvas snapshot' });
    }
});

router.post('/admin/snapshots/:id/restore', requireAdmin, (req, res) => {
    try {
        res.json(canvasService.restoreSnapshot(Number(req.params.id), req.user));
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to restore snapshot' });
    }
});

router.post('/admin/wipe', requireAdmin, (req, res) => {
    try {
        res.json(canvasService.wipeBoard(req.user));
    } catch (err) {
        res.status(500).json({ error: 'Failed to wipe canvas' });
    }
});

module.exports = router;
