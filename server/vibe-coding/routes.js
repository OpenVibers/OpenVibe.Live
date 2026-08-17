'use strict';

const express = require('express');

const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');
const vibeService = require('./service');

const router = express.Router();

function clampLimit(value, fallback = 20) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(100, Math.max(1, parsed));
}

router.get('/channel/:username/:slotIdOrSlug/events', optionalAuth, (req, res) => {
    try {
        const username = String(req.params.username || '').replace(/^@/, '').trim();
        const channel = db.getChannelByUsername(username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const managed = db.getManagedStreamByIdOrSlug(channel.user_id, req.params.slotIdOrSlug);
        if (!managed) return res.status(404).json({ error: 'Managed stream not found' });

        const limit = clampLimit(req.query.limit, 18);
        const feed = vibeService.getProjectedViewerFeed(managed.id, limit);
        const liveStream = vibeService.getLiveStreamByManagedStreamId(managed.id);

        res.json({
            managed_stream: {
                id: managed.id,
                slug: managed.slug,
                title: managed.title,
            },
            live_stream_id: liveStream?.id || null,
            settings: feed.settings,
            publisher: feed.publisher,
            events: feed.events,
        });
    } catch (err) {
        console.error('[VibeCoding] Public feed error:', err.message);
        res.status(500).json({ error: 'Failed to load vibe-coding feed' });
    }
});

router.get('/managed/:managedStreamId/events', requireAuth, (req, res) => {
    try {
        const managedStreamId = parseInt(req.params.managedStreamId, 10);
        const managed = db.getManagedStreamById(managedStreamId);
        if (!managed || managed.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Managed stream not found' });
        }

        const limit = clampLimit(req.query.limit, 50);
        const rawEvents = vibeService.getStoredEventsForManagedStream(managedStreamId, limit);
        const feed = vibeService.getProjectedViewerFeed(managedStreamId, limit);
        const liveStream = vibeService.getLiveStreamByManagedStreamId(managedStreamId);

        res.json({
            managed_stream_id: managedStreamId,
            live_stream_id: liveStream?.id || null,
            settings: feed.settings,
            publisher: feed.publisher,
            events: rawEvents,
            public_events: feed.events,
        });
    } catch (err) {
        console.error('[VibeCoding] Managed feed error:', err.message);
        res.status(500).json({ error: 'Failed to load vibe-coding events' });
    }
});

router.get('/managed/:managedStreamId/settings', requireAuth, (req, res) => {
    try {
        const managedStreamId = parseInt(req.params.managedStreamId, 10);
        const managed = db.getManagedStreamById(managedStreamId);
        if (!managed || managed.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Managed stream not found' });
        }
        res.json({
            managed_stream_id: managedStreamId,
            settings: vibeService.getManagedStreamVibeCodingSettings(managedStreamId),
        });
    } catch (err) {
        console.error('[VibeCoding] Settings read error:', err.message);
        res.status(500).json({ error: 'Failed to load vibe-coding settings' });
    }
});

router.put('/managed/:managedStreamId/settings', requireAuth, (req, res) => {
    try {
        const managedStreamId = parseInt(req.params.managedStreamId, 10);
        const managed = db.getManagedStreamById(managedStreamId);
        if (!managed || managed.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Managed stream not found' });
        }
        const settings = vibeService.updateManagedStreamVibeCodingSettings(managedStreamId, req.user.id, req.body?.settings || {});
        res.json({ managed_stream_id: managedStreamId, settings });
    } catch (err) {
        console.error('[VibeCoding] Settings save error:', err.message);
        res.status(500).json({ error: 'Failed to save vibe-coding settings' });
    }
});

module.exports = router;