const express = require('express');
const db = require('../db/database');
const mediaQueue = require('./media-queue');
const { requireAuth, optionalAuth } = require('../auth/auth');
const downloader = require('./media-downloader');

const router = express.Router();

const permissions = require('../auth/permissions');

/**
 * Resolve which channel's queue a management call is acting on, and authorise it.
 *
 * Every management route used to assume `req.user.id` WAS the streamer, which is why a
 * channel mod could not touch the queue at all — there was no way to even name another
 * channel. Callers may now pass `streamer` (id) or `channelUsername`; omitting both keeps
 * the old behaviour of managing your own queue.
 *
 * Returns the streamer's user id, or throws an Error whose message is viewer-safe.
 */
function resolveQueueTarget(req) {
    const explicit = cleanInt(req.body?.streamer ?? req.query?.streamer, null);
    const uname = req.body?.channelUsername || req.query?.channelUsername;

    let streamerId = explicit;
    if (!streamerId && uname) streamerId = db.getUserByUsername(String(uname))?.id || null;
    if (!streamerId) return req.user.id;                 // own queue
    if (streamerId === req.user.id) return streamerId;

    const channel = db.getChannelByUserId(streamerId);
    if (!channel || !permissions.canModerateChannel(req.user, channel.id)) {
        const err = new Error('You do not have permission to manage this queue');
        err.status = 403;
        throw err;
    }
    return streamerId;
}

/** Owner-or-mod check for a channel identified by its streamer's user id. */
function canManageChannel(user, streamerId) {
    if (!user || !streamerId) return false;
    if (user.id === streamerId) return true;
    const channel = db.getChannelByUserId(streamerId);
    return !!channel && permissions.canModerateChannel(user, channel.id);
}

function cleanInt(value, fallback) {
    const num = parseInt(value, 10);
    return Number.isFinite(num) ? num : fallback;
}

router.get('/channel/:username', optionalAuth, (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'Channel not found' });

        const channel = db.getChannelByUserId(user.id) || db.ensureChannel(user.id);
        const streams = db.getLiveStreamsByUserId(user.id) || [];
        const state = mediaQueue.getState(user.id);

        res.json({
            channel: {
                id: channel?.id || null,
                user_id: user.id,
                username: user.username,
                display_name: user.display_name || user.username,
                avatar_url: user.avatar_url || null,
            },
            live_stream: streams[0] || null,
            state,
            is_owner: !!req.user && req.user.id === user.id,
            // Drives whether the channel's media tab renders queue controls. Mods get the
            // same controls as the streamer; the server re-checks on every action.
            can_manage: canManageChannel(req.user, user.id),
            pricing: (() => {
                const st = mediaQueue.getSettings(user.id);
                const currency = mediaQueue.currencyOf(st);
                return {
                    currency,
                    currency_label: mediaQueue.currencyLabel(currency),
                    cost_mode: st.cost_mode || 'flat',
                    request_cost: st.request_cost,
                    cost_per_minute: st.cost_per_minute,
                    max_duration_seconds: st.max_duration_seconds,
                };
            })(),
            media_player_url: `/media/${user.username}`,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load media queue' });
    }
});

router.get('/settings', requireAuth, (req, res) => {
    res.json({ settings: mediaQueue.getSettings(req.user.id), media_player_url: `/media/${req.user.username}` });
});

router.put('/settings', requireAuth, (req, res) => {
    try {
        const fields = {};
        const mapping = {
            enabled: 'enabled',
            request_cost: 'request_cost',
            max_per_user: 'max_per_user',
            max_duration_seconds: 'max_duration_seconds',
            allow_youtube: 'allow_youtube',
            allow_vimeo: 'allow_vimeo',
            allow_direct_media: 'allow_direct_media',
            auto_advance: 'auto_advance',
            allow_live: 'allow_live',
            cost_mode: 'cost_mode',
            cost_per_minute: 'cost_per_minute',
            download_mode: 'download_mode',
            currency: 'currency',
        };

        for (const [key, target] of Object.entries(mapping)) {
            if (req.body[key] === undefined) continue;

            if (['enabled', 'allow_youtube', 'allow_vimeo', 'allow_direct_media', 'auto_advance', 'allow_live'].includes(key)) {
                fields[target] = req.body[key] ? 1 : 0;
            } else if (key === 'cost_mode') {
                if (!['flat', 'per_minute'].includes(req.body[key])) {
                    return res.status(400).json({ error: 'cost_mode must be flat or per_minute' });
                }
                fields[target] = req.body[key];
            } else if (key === 'currency') {
                if (!['free', 'vibes', 'opencoins', 'points'].includes(req.body[key])) {
                    return res.status(400).json({ error: 'currency must be free, vibes, opencoins or points' });
                }
                fields[target] = req.body[key];
            } else if (key === 'download_mode') {
                if (!['stream', 'download'].includes(req.body[key])) {
                    return res.status(400).json({ error: 'download_mode must be stream or download' });
                }
                fields[target] = req.body[key];
            } else {
                const num = cleanInt(req.body[key], null);
                if (!Number.isFinite(num) || num < 0) {
                    return res.status(400).json({ error: `Invalid ${key}` });
                }
                fields[target] = num;
            }
        }

        const settings = mediaQueue.updateSettings(req.user.id, fields);
        res.json({ settings, media_player_url: `/media/${req.user.username}` });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to update settings' });
    }
});

/**
 * Price a request BEFORE it is submitted.
 *
 * Chosen over reserve-and-settle because it is the version a viewer can actually reason
 * about: they see the real title, the real length and the exact price for THIS link, then
 * confirm. What they agreed to is what gets charged — nothing is taken and later adjusted.
 * It also surfaces a too-long video as a clear "no" instead of a failed charge.
 */
router.post('/quote', optionalAuth, async (req, res) => {
    try {
        let streamerId = cleanInt(req.body.streamerId, null);
        if (!streamerId && req.body.username) {
            streamerId = db.getUserByUsername(String(req.body.username))?.id || null;
        }
        if (!streamerId) return res.status(400).json({ error: 'streamerId or username required' });

        const input = String(req.body.input || '').trim();
        if (!input) return res.status(400).json({ error: 'input required' });

        const settings = mediaQueue.getSettings(streamerId);
        if (!settings.enabled) return res.status(403).json({ error: 'Media requests are closed for this channel' });

        const normalized = await mediaQueue.normalizeInput(input, settings);
        const duration = Number(normalized.duration_seconds) || 0;
        const maxDuration = Number(settings.max_duration_seconds) || 600;
        const currency = mediaQueue.currencyOf(settings);
        const cost = currency === 'free' ? 0 : mediaQueue.calculateCost(settings, duration);

        const tooLong = duration > 0 && duration > maxDuration;

        // What the viewer can actually pay right now, so the UI can say "you have X".
        let balance = null;
        if (req.user && currency === 'points') balance = db.getChannelPoints(req.user.id, streamerId);
        else if (req.user && currency === 'vibes') balance = db.getUserById(req.user.id)?.openvibe_bucks_balance ?? null;

        res.json({
            title: normalized.title,
            provider: normalized.provider,
            thumbnail_url: normalized.thumbnail_url,
            duration_seconds: duration,
            max_duration_seconds: maxDuration,
            too_long: tooLong,
            currency,
            currency_label: mediaQueue.currencyLabel(currency),
            cost_mode: settings.cost_mode || 'flat',
            cost_per_minute: settings.cost_per_minute,
            cost,
            balance,
            affordable: balance == null ? null : balance >= cost,
            allowed: !tooLong,
            reason: tooLong
                ? `That video is ${Math.floor(duration / 60)}m${duration % 60}s — this channel allows up to ${Math.floor(maxDuration / 60)}m.`
                : null,
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Could not price that link' });
    }
});

router.post('/request', requireAuth, async (req, res) => {
    try {
        let streamerId = cleanInt(req.body.streamerId, null);
        let streamId = cleanInt(req.body.streamId, null);

        if (!streamerId && req.body.username) {
            const streamer = db.getUserByUsername(String(req.body.username));
            streamerId = streamer?.id || null;
        }
        if (!streamerId && streamId) {
            const stream = db.getStreamById(streamId);
            streamerId = stream?.user_id || null;
        }
        if (!streamerId) return res.status(400).json({ error: 'streamerId or username required' });
        if (!streamId) {
            const live = db.getLiveStreamsByUserId(streamerId) || [];
            streamId = live[0]?.id || null;
        }

        const username = req.user.display_name || req.user.username;
        const request = await mediaQueue.addRequest({
            streamerId,
            streamId,
            userId: req.user.id,
            username,
            input: req.body.input,
        });

        const remaining = await require('../monetization/wallet-client')
            .balanceForToken(require('../auth/auth').extractToken(req)).catch(() => null);
        res.status(201).json({ request, remaining: remaining ?? 0 });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to add request' });
    }
});

router.post('/start', requireAuth, (req, res) => {
    try {
        const request = mediaQueue.startNext(resolveQueueTarget(req));
        res.json({ request });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message || 'Failed to start next request' });
    }
});

router.post('/advance', requireAuth, (req, res) => {
    try {
        const target = resolveQueueTarget(req);
        const ended = mediaQueue.finishCurrent(target, req.body.status === 'skipped' ? 'skipped' : 'played');
        const next = mediaQueue.startNext(target);
        res.json({ ended, next });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message || 'Failed to advance queue' });
    }
});

router.post('/queue/:id/play', requireAuth, (req, res) => {
    try {
        const target = resolveQueueTarget(req);
        if (db.getActiveMediaRequestByStreamer(target)) {
            return res.status(400).json({ error: 'Finish or skip the current item first' });
        }
        const request = db.getMediaRequestByStreamerAndId(target, req.params.id);
        if (!request || request.status !== 'pending') return res.status(404).json({ error: 'Pending request not found' });
        db.updateMediaRequest(request.id, { queue_position: 0 });
        db.renormalizePendingMediaRequestPositions(target);
        const started = mediaQueue.startNext(target);
        res.json({ request: started });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message || 'Failed to start request' });
    }
});

router.post('/queue/:id/skip', requireAuth, (req, res) => {
    try {
        const request = mediaQueue.skip(resolveQueueTarget(req), cleanInt(req.params.id, 0));
        res.json({ request });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message || 'Failed to skip request' });
    }
});

router.post('/queue/:id/move', requireAuth, (req, res) => {
    try {
        const direction = req.body.direction === 'down' ? 'down' : 'up';
        const request = mediaQueue.move(resolveQueueTarget(req), cleanInt(req.params.id, 0), direction);
        res.json({ request });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message || 'Failed to reorder request' });
    }
});

router.delete('/queue/:id', requireAuth, (req, res) => {
    try {
        const request = mediaQueue.skip(resolveQueueTarget(req), cleanInt(req.params.id, 0));
        res.json({ request });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message || 'Failed to remove request' });
    }
});

// ── Stream URL extraction ──────────────────────────────────
// Client calls this to get a direct playable URL for the current/specific request
router.get('/queue/:id/stream-url', optionalAuth, async (req, res) => {
    try {
        const request = db.getMediaRequestById(cleanInt(req.params.id, 0));
        if (!request) return res.status(404).json({ error: 'Request not found' });

        // If already extracted (or marked ready for embed), return immediately
        if (request.download_status === 'ready') {
            return res.json({
                stream_url: request.stream_url || null,
                embed_url: request.embed_url || null,
                provider: request.provider,
                download_status: 'ready',
            });
        }

        // If extraction already failed, don't retry — return the failure
        if (request.download_status === 'failed') {
            return res.json({
                stream_url: null,
                embed_url: request.embed_url || null,
                provider: request.provider,
                download_status: 'failed',
                last_error: request.last_error,
            });
        }

        // Kick off extraction and return status
        mediaQueue.extractStreamUrlForRequest(request.id).catch(() => {});
        const updated = db.getMediaRequestById(request.id);
        res.json({
            stream_url: updated?.stream_url || null,
            embed_url: updated?.embed_url || null,
            provider: updated?.provider,
            download_status: updated?.download_status || 'extracting',
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get stream URL' });
    }
});

// ── Playback position save (called periodically by player) ──
router.post('/queue/:id/position', optionalAuth, (req, res) => {
    try {
        const requestId = cleanInt(req.params.id, 0);
        const position = Number(req.body.position);
        if (!Number.isFinite(position) || position < 0) {
            return res.status(400).json({ error: 'Invalid position' });
        }
        mediaQueue.savePlaybackPosition(requestId, position);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save position' });
    }
});

// ── Manual refund by streamer ──────────────────────────────
router.post('/queue/:id/refund', requireAuth, (req, res) => {
    try {
        const request = db.getMediaRequestById(cleanInt(req.params.id, 0));
        if (!request) return res.status(404).json({ error: 'Request not found' });
        if (!canManageChannel(req.user, request.streamer_id)) {
            return res.status(403).json({ error: 'Only the channel owner or its mods can issue refunds' });
        }
        const amount = mediaQueue.refund(request.id);
        res.json({ refunded: amount, request: db.getMediaRequestById(request.id) });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to refund' });
    }
});

// ── Report playback failure (auto-refunds) ──────────────────
router.post('/queue/:id/fail', requireAuth, (req, res) => {
    try {
        const request = db.getMediaRequestById(cleanInt(req.params.id, 0));
        if (!request) return res.status(404).json({ error: 'Request not found' });
        if (!canManageChannel(req.user, request.streamer_id)) {
            return res.status(403).json({ error: 'Only the channel owner or its mods can report failures' });
        }
        const failed = mediaQueue.failRequest(request.id, req.body.error || 'Playback failed');
        res.json({ request: failed });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to report failure' });
    }
});

// ── Download status / info ──────────────────────────────────
router.get('/downloader/status', requireAuth, (req, res) => {
    res.json({
        available: downloader.isAvailable(),
        cache_dir: downloader.CACHE_DIR,
    });
});

module.exports = router;
