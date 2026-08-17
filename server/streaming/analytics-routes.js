/**
 * OpenVibe.Live — Stream Analytics API Routes
 *
 * Public endpoints:
 * GET /api/analytics/channel/:username         - Channel summary stats (public)
 * GET /api/analytics/channel/:username/streams  - Recent stream history with stats (public)
 * GET /api/analytics/stream/:id                - Single stream analytics + viewer chart (public)
 *
 * Streamer-only:
 * GET /api/analytics/channel/:username/dashboard - Detailed dashboard (owner only)
 */
'use strict';

const express = require('express');
const db = require('../db/database');
const { optionalAuth } = require('../auth/auth');

const router = express.Router();

// ── Public: Channel summary stats ────────────────────────────
// Anyone can see aggregate stats for a channel
router.get('/channel/:username', optionalAuth, (req, res) => {
    try {
        const channel = db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const days = Math.min(parseInt(req.query.days) || 30, 365);
        const data = db.getChannelAnalyticsSummary(channel.user_id, days);

        // Public view — return summary + stream list (no revenue data)
        res.json({
            username: channel.username,
            display_name: channel.display_name || channel.username,
            avatar_url: channel.avatar_url,
            summary: data.summary,
            all_time: data.all_time,
            streams: data.streams.map(s => ({
                id: s.id,
                title: s.title,
                category: s.category,
                started_at: s.started_at,
                ended_at: s.ended_at,
                duration_seconds: s.duration_seconds,
                peak_viewers: s.peak_viewers,
                avg_viewers: s.avg_viewers ? Math.round(s.avg_viewers * 10) / 10 : null,
                unique_chatters: s.unique_chatters,
                total_messages: s.total_messages,
            })),
        });
    } catch (err) {
        console.error('[Analytics] Channel summary error:', err.message);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

// ── Public: Stream history with stats ────────────────────────
router.get('/channel/:username/streams', (req, res) => {
    try {
        const channel = db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const streams = db.all(`
            SELECT s.id, s.title, s.category, s.started_at, s.ended_at, s.duration_seconds,
                   s.peak_viewers, s.viewer_count, s.thumbnail_url,
                   sa.avg_viewers, sa.unique_chatters, sa.total_messages, sa.clips_created
            FROM streams s
            LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
            WHERE s.user_id = ? AND s.duration_seconds > 0
            ORDER BY s.started_at DESC
            LIMIT ? OFFSET ?
        `, [channel.user_id, limit, offset]);

        const countRow = db.get(
            'SELECT COUNT(*) as cnt FROM streams WHERE user_id = ? AND duration_seconds > 0',
            [channel.user_id]
        );

        res.json({
            streams,
            page,
            limit,
            total: countRow?.cnt || 0,
            total_pages: Math.ceil((countRow?.cnt || 0) / limit),
        });
    } catch (err) {
        console.error('[Analytics] Stream history error:', err.message);
        res.status(500).json({ error: 'Failed to load stream history' });
    }
});

// ── Public: Single stream analytics with viewer chart ────────
router.get('/stream/:id', (req, res) => {
    try {
        const streamId = parseInt(req.params.id);
        if (!streamId) return res.status(400).json({ error: 'Invalid stream ID' });

        const stream = db.getStreamById(streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        // Get or compute analytics
        let analytics = db.getStreamAnalytics(streamId);
        if (!analytics && !stream.is_live) {
            // Compute on demand for old streams without cached analytics
            analytics = db.computeAndCacheStreamAnalytics(streamId);
        }

        // Get viewer snapshots for the chart
        const snapshots = db.getViewerSnapshots(streamId);

        // Get the user info for display
        const user = db.getUserById(stream.user_id);

        res.json({
            stream: {
                id: stream.id,
                title: stream.title,
                category: stream.category,
                started_at: stream.started_at,
                ended_at: stream.ended_at,
                duration_seconds: stream.duration_seconds,
                peak_viewers: stream.peak_viewers,
                is_live: !!stream.is_live,
            },
            streamer: {
                username: user?.username,
                display_name: user?.display_name || user?.username,
                avatar_url: user?.avatar_url,
            },
            analytics: analytics ? {
                avg_viewers: Math.round((analytics.avg_viewers || 0) * 10) / 10,
                peak_viewers: analytics.peak_viewers,
                unique_chatters: analytics.unique_chatters,
                total_messages: analytics.total_messages,
                total_watch_minutes: analytics.total_watch_minutes,
                new_followers: analytics.new_followers,
                clips_created: analytics.clips_created,
            } : null,
            viewer_chart: snapshots.map(s => ({
                t: s.recorded_at,
                v: s.viewer_count,
                c: s.chat_messages_5m,
            })),
        });
    } catch (err) {
        console.error('[Analytics] Stream detail error:', err.message);
        res.status(500).json({ error: 'Failed to load stream analytics' });
    }
});

// ── Streamer-only: Detailed dashboard ────────────────────────
// Shows extra data like watch minutes, coins, followers over time
router.get('/channel/:username/dashboard', optionalAuth, (req, res) => {
    try {
        const channel = db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        // Only the channel owner (or admin) can see the dashboard
        const isOwner = req.user && (req.user.id === channel.user_id || req.user.role === 'admin');
        if (!isOwner) return res.status(403).json({ error: 'Access denied' });

        const days = Math.min(parseInt(req.query.days) || 30, 365);
        const data = db.getChannelAnalyticsSummary(channel.user_id, days);

        // Add streamer-only data: watch minutes, coins earned, follower growth
        const streams = data.streams.map(s => ({
            ...s,
            total_watch_minutes: s.total_watch_minutes,
            coins_earned: s.coins_earned,
            new_followers: s.new_followers,
        }));

        // Top chatters for the period
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const topChatters = db.all(`
            SELECT cm.user_id, cm.username, COUNT(*) as message_count
            FROM chat_messages cm
            JOIN streams s ON cm.stream_id = s.id
            WHERE s.user_id = ? AND cm.timestamp >= ? AND cm.is_deleted = 0
              AND cm.is_global = 0 AND cm.message_type = 'chat' AND cm.user_id IS NOT NULL
            GROUP BY cm.user_id
            ORDER BY message_count DESC
            LIMIT 20
        `, [channel.user_id, cutoff]);

        // Top watchers by watch time
        const topWatchers = db.all(`
            SELECT wt.user_id, u.username, u.display_name, SUM(wt.minutes_watched) as total_minutes
            FROM watch_time wt
            JOIN users u ON u.id = wt.user_id
            JOIN streams s ON wt.stream_id = s.id
            WHERE s.user_id = ? AND s.started_at >= ?
            GROUP BY wt.user_id
            ORDER BY total_minutes DESC
            LIMIT 20
        `, [channel.user_id, cutoff]);

        res.json({
            ...data,
            streams,
            top_chatters: topChatters,
            top_watchers: topWatchers,
        });
    } catch (err) {
        console.error('[Analytics] Dashboard error:', err.message);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

module.exports = router;
