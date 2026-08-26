/**
 * OpenVibe.Live — Restream API Routes
 * 
 * CRUD endpoints for managing restream destinations (YouTube, Twitch, Kick, Custom RTMP).
 * Start/stop endpoints for controlling active restreams on live streams.
 * Status endpoint returns real-time FFmpeg process status per destination.
 */
const express = require('express');

const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const restreamManager = require('./restream-manager');
const chatRelayService = require('../integrations/chat-relay-service');

const router = express.Router();

const VALID_PLATFORMS = ['youtube', 'twitch', 'kick', 'custom'];
const VALID_QUALITY_PRESETS = ['auto', 'low', 'medium', 'high', 'ultra', 'source'];
const VALID_ENCODER_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];
const MAX_DESTINATIONS = 10;

/** Platform presets with default RTMP server URLs and UI metadata. */
const PLATFORM_PRESETS = {
    youtube: { name: 'YouTube', defaultServerUrl: 'rtmp://a.rtmp.youtube.com/live2', icon: 'fa-brands fa-youtube', color: '#ff0000' },
    twitch:  { name: 'Twitch', defaultServerUrl: 'rtmps://live.twitch.tv/app', icon: 'fa-brands fa-twitch', color: '#9146ff' },
    kick:    { name: 'Kick', defaultServerUrl: '', icon: 'fa-solid fa-k', color: '#53fc18' },
    custom:  { name: 'Custom RTMP', defaultServerUrl: '', icon: 'fa-solid fa-globe', color: '#888' },
};

/**
 * Sanitize a destination for the client — mask stream key.
 */
function sanitizeDest(d) {
    if (!d) return d;
    return {
        ...d,
        stream_key: d.stream_key ? '****' + d.stream_key.slice(-4) : '',
        has_key: !!d.stream_key,
        quality_preset: d.quality_preset || 'auto',
        channel_url: d.channel_url || '',
        chat_relay: !!d.chat_relay,
        powerchat_relay: d.powerchat_relay !== 0,
        // Circuit-breaker status — non-zero when the destination is paused after repeated failures.
        cooldown_ms: (() => { try { return db.restreamDestinationCooldownMs(d); } catch { return 0; } })(),
        cooldown_until: d.cooldown_until || null,
        consecutive_failures: d.consecutive_failures || 0,
        last_error: d.last_error || null,
    };
}

function getLiveStreamForDestination(dest, userId, requestedStreamId) {
    const liveStreams = db.getLiveStreamsByUserId(userId) || [];
    if (dest.managed_stream_id) {
        return liveStreams.find(s => s.managed_stream_id === dest.managed_stream_id) || null;
    }
    if (requestedStreamId) {
        return liveStreams.find(s => s.id === parseInt(requestedStreamId, 10)) || null;
    }
    // Destination has no managed_stream_id (legacy unbound row — DB backfill not yet run).
    // Return null so start/stop returns a clear error rather than silently picking any stream.
    console.warn(`[Restream] Destination ${dest.id} has no managed_stream_id; refusing to pick first live stream. Assign the destination to a stream slot.`);
    return null;
}

function getLiveStreamsForDestination(dest, userId) {
    const liveStreams = db.getLiveStreamsByUserId(userId) || [];
    if (dest.managed_stream_id) {
        return liveStreams.filter(s => s.managed_stream_id === dest.managed_stream_id);
    }
    return liveStreams;
}

/**
 * Parse and validate custom encoding override fields from request body.
 * Returns only fields that are present and valid; null values clear overrides.
 */
function parseCustomOverrides(body) {
    const overrides = {};

    if (body.custom_video_bitrate !== undefined) {
        const v = body.custom_video_bitrate === null ? null : parseInt(body.custom_video_bitrate, 10);
        overrides.custom_video_bitrate = (v !== null && Number.isFinite(v) && v >= 500 && v <= 50000) ? v : null;
    }
    if (body.custom_audio_bitrate !== undefined) {
        const v = body.custom_audio_bitrate === null ? null : parseInt(body.custom_audio_bitrate, 10);
        overrides.custom_audio_bitrate = (v !== null && Number.isFinite(v) && v >= 32 && v <= 512) ? v : null;
    }
    if (body.custom_fps !== undefined) {
        const v = body.custom_fps === null ? null : parseInt(body.custom_fps, 10);
        overrides.custom_fps = (v !== null && Number.isFinite(v) && v >= 15 && v <= 120) ? v : null;
    }
    if (body.custom_encoder_preset !== undefined) {
        overrides.custom_encoder_preset = VALID_ENCODER_PRESETS.includes(body.custom_encoder_preset)
            ? body.custom_encoder_preset : null;
    }

    return overrides;
}

// ── GET /presets — platform hints for the client ─────────────
router.get('/presets', requireAuth, (req, res) => {
    res.json({
        presets: PLATFORM_PRESETS,
        qualityPresets: restreamManager.constructor.getQualityPresets(),
        encoderPresets: VALID_ENCODER_PRESETS,
    });
});

// ── GET /destinations — list user's restream destinations ────
// ?managed_stream_id=N — filter by stream slot
router.get('/destinations', requireAuth, (req, res) => {
    try {
        const managedStreamId = req.query.managed_stream_id ? parseInt(req.query.managed_stream_id) : null;
        let dests;
        if (managedStreamId) {
            // Verify ownership
            const ms = db.getManagedStreamById(managedStreamId);
            if (!ms || ms.user_id !== req.user.id) {
                return res.status(403).json({ error: 'Not your stream slot' });
            }
            dests = db.getRestreamDestinationsByManagedStream(managedStreamId) || [];
        } else {
            dests = db.getRestreamDestinationsByUserId(req.user.id) || [];
        }
        res.json({ destinations: dests.map(sanitizeDest) });
    } catch (err) {
        console.error('[Restream] List destinations error:', err.message);
        res.status(500).json({ error: 'Failed to load restream destinations' });
    }
});

// ── POST /destinations — create a new restream destination ───
router.post('/destinations', requireAuth, (req, res) => {
    try {
        const { platform, name, server_url, stream_key, enabled, auto_start, quality_preset, managed_stream_id } = req.body;

        if (!platform || !VALID_PLATFORMS.includes(platform)) {
            return res.status(400).json({ error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` });
        }

        if (quality_preset && !VALID_QUALITY_PRESETS.includes(quality_preset)) {
            return res.status(400).json({ error: `Invalid quality preset. Must be one of: ${VALID_QUALITY_PRESETS.join(', ')}` });
        }

        // Validate managed_stream_id ownership if provided
        let resolvedSlotId = null;
        if (managed_stream_id) {
            const ms = db.getManagedStreamById(parseInt(managed_stream_id));
            if (!ms || ms.user_id !== req.user.id) {
                return res.status(403).json({ error: 'Not your stream slot' });
            }
            resolvedSlotId = ms.id;
        }

        // Enforce a reasonable limit per slot (or globally if no slot)
        const existing = resolvedSlotId
            ? (db.getRestreamDestinationsByManagedStream(resolvedSlotId) || [])
            : (db.getRestreamDestinationsByUserId(req.user.id) || []);
        if (existing.length >= MAX_DESTINATIONS) {
            return res.status(400).json({ error: `Maximum ${MAX_DESTINATIONS} restream destinations allowed` });
        }

        if (!stream_key || typeof stream_key !== 'string' || !stream_key.trim()) {
            return res.status(400).json({ error: 'Stream key is required' });
        }

        // Auto-fill server URL from platform preset if not provided
        let finalUrl = server_url?.trim() || '';
        if (!finalUrl && PLATFORM_PRESETS[platform]?.defaultServerUrl) {
            finalUrl = PLATFORM_PRESETS[platform].defaultServerUrl;
        }
        if (!finalUrl) {
            return res.status(400).json({ error: 'Server URL is required' });
        }

        const dest = db.createRestreamDestination(req.user.id, {
            platform,
            managed_stream_id: resolvedSlotId,
            name: name?.trim() || PLATFORM_PRESETS[platform]?.name || platform,
            server_url: finalUrl,
            stream_key: stream_key.trim(),
            enabled: enabled !== false ? 1 : 0,
            auto_start: auto_start ? 1 : 0,
            quality_preset: quality_preset || 'auto',
            channel_url: req.body.channel_url?.trim() || null,
            chat_relay: req.body.chat_relay ? 1 : 0,
            powerchat_relay: (req.body.powerchat_relay === undefined || req.body.powerchat_relay) ? 1 : 0,
            ...parseCustomOverrides(req.body),
        });

        // Auto-start chat relay if enabled on a live stream
        if (dest.chat_relay && dest.channel_url) {
            try { chatRelayService.syncForUser(req.user.id); } catch (err) {
                console.warn('[ChatRelay] Sync after create failed:', err.message);
            }
        }

        res.json({ destination: sanitizeDest(dest) });
    } catch (err) {
        console.error('[Restream] Create destination error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to create restream destination' });
    }
});

// ── PUT /destinations/:id — update a destination ─────────────
router.put('/destinations/:id', requireAuth, (req, res) => {
    try {
        const dest = db.getRestreamDestinationById(parseInt(req.params.id));
        if (!dest || dest.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Destination not found' });
        }

        const updates = {};
        if (req.body.name !== undefined) updates.name = req.body.name?.trim() || dest.name;
        if (req.body.server_url !== undefined) updates.server_url = req.body.server_url?.trim() || dest.server_url;
        if (req.body.stream_key !== undefined && req.body.stream_key.trim()) {
            updates.stream_key = req.body.stream_key.trim();
        }
        if (req.body.enabled !== undefined) updates.enabled = req.body.enabled ? 1 : 0;
        if (req.body.auto_start !== undefined) updates.auto_start = req.body.auto_start ? 1 : 0;
        if (req.body.quality_preset !== undefined) {
            if (!VALID_QUALITY_PRESETS.includes(req.body.quality_preset)) {
                return res.status(400).json({ error: `Invalid quality preset. Must be one of: ${VALID_QUALITY_PRESETS.join(', ')}` });
            }
            updates.quality_preset = req.body.quality_preset;
        }
        // Custom encoding overrides
        Object.assign(updates, parseCustomOverrides(req.body));

        // Channel URL + chat relay
        if (req.body.channel_url !== undefined) updates.channel_url = req.body.channel_url?.trim() || null;
        if (req.body.chat_relay !== undefined) updates.chat_relay = req.body.chat_relay ? 1 : 0;
        if (req.body.powerchat_relay !== undefined) updates.powerchat_relay = req.body.powerchat_relay ? 1 : 0;

        // Managed stream ID (slot assignment)
        if (req.body.managed_stream_id !== undefined) {
            if (req.body.managed_stream_id) {
                const ms = db.getManagedStreamById(parseInt(req.body.managed_stream_id));
                if (!ms || ms.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not your stream slot' });
                }
                updates.managed_stream_id = ms.id;
            } else {
                updates.managed_stream_id = null;
            }
        }

        const updated = db.updateRestreamDestination(dest.id, updates);

        // Fixing a broken destination (new stream key, or re-enabling it) is the streamer's signal
        // that it should work now — lift any failure cooldown so it retries on the next go-live.
        if (updates.stream_key !== undefined || updates.server_url !== undefined || updates.enabled === 1) {
            try { db.clearRestreamDestinationCooldown(dest.id); } catch { /* */ }
        }

        // If the destination was just DISABLED, stop any active video restream to it right now —
        // otherwise it keeps pushing to Twitch/Kick/etc. for a stream that's already live.
        if (updates.enabled === 0) {
            try {
                const liveStreams = getLiveStreamsForDestination(dest, req.user.id) || [];
                for (const s of liveStreams) {
                    try { restreamManager.stopRestream(s.id, dest.id); } catch { /* */ }
                    try { chatRelayService.stopBridge(s.id, dest.id); } catch { /* */ }
                }
                if (liveStreams.length) console.log(`[Restream] Destination ${dest.id} (${dest.name || dest.platform || ''}) disabled — stopped active restream on ${liveStreams.length} live stream(s)`);
            } catch (err) { console.warn('[Restream] stop-on-disable failed:', err.message); }
        }

        // If chat_relay or channel_url changed, sync relay bridges for live streams
        if (updates.chat_relay !== undefined || updates.channel_url !== undefined || updates.enabled !== undefined) {
            try { chatRelayService.syncForUser(req.user.id); } catch (err) {
                console.warn('[ChatRelay] Sync after update failed:', err.message);
            }
        }

        res.json({ destination: sanitizeDest(updated) });
    } catch (err) {
        console.error('[Restream] Update destination error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to update destination' });
    }
});

// ── DELETE /destinations/:id — delete a destination ──────────
router.delete('/destinations/:id', requireAuth, (req, res) => {
    try {
        const dest = db.getRestreamDestinationById(parseInt(req.params.id));
        if (!dest || dest.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Destination not found' });
        }

        // Stop any active restream for this destination
        const liveStreams = getLiveStreamsForDestination(dest, req.user.id);
        for (const stream of liveStreams) {
            restreamManager.stopRestream(stream.id, dest.id);
            chatRelayService.stopBridge(stream.id, dest.id);
        }

        db.deleteRestreamDestination(dest.id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Restream] Delete destination error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to delete destination' });
    }
});

// ── POST /destinations/:id/start — start restream ────────────
router.post('/destinations/:id/start', requireAuth, async (req, res) => {
    try {
        const dest = db.getRestreamDestinationById(parseInt(req.params.id));
        if (!dest || dest.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Destination not found' });
        }
        if (!dest.server_url || !dest.stream_key) {
            return res.status(400).json({ error: 'Destination is not fully configured (missing server URL or stream key)' });
        }

        // Manual start = the streamer explicitly asking to retry. Lift any failure cooldown now,
        // regardless of whether they're live yet, so the next go-live isn't circuit-broken either.
        try { db.clearRestreamDestinationCooldown(dest.id); } catch { /* */ }

        const stream = getLiveStreamForDestination(dest, req.user.id, req.body?.streamId);
        if (!stream) {
            const message = dest.managed_stream_id
                ? 'No live stream found for this stream slot. Go live on that slot first.'
                : 'This destination has no stream slot assigned. Edit the destination and assign it to a stream slot, then go live on that slot.';
            return res.status(400).json({ error: message });
        }

        if (stream.protocol === 'webrtc') {
            // WebRTC → RTMP requires Mediasoup SFU
            const webrtcSFU = require('./webrtc-sfu');
            if (!webrtcSFU.ready) {
                return res.status(400).json({
                    error: 'WebRTC → RTMP restreaming requires Mediasoup. Install mediasoup: npm install mediasoup',
                });
            }
        }

        const user = db.getUserById(req.user.id);
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }

        const streamKey = stream.managed_stream_key || user.stream_key;
        if (!streamKey) {
            return res.status(400).json({ error: 'No valid stream key found for the current live stream' });
        }

        const session = await restreamManager.startRestream(stream.id, dest, {
            protocol: stream.protocol,
            streamKey,
            forceIgnoreCooldown: true,
        });

        res.json({ ok: true, status: session?.status || 'starting' });
    } catch (err) {
        console.error('[Restream] Start restream error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to start restream' });
    }
});

// ── POST /destinations/:id/stop — stop restream ─────────────
router.post('/destinations/:id/stop', requireAuth, (req, res) => {
    try {
        const dest = db.getRestreamDestinationById(parseInt(req.params.id));
        if (!dest || dest.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Destination not found' });
        }

        const liveStreams = getLiveStreamsForDestination(dest, req.user.id);
        for (const stream of liveStreams) {
            restreamManager.stopRestream(stream.id, dest.id);
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('[Restream] Stop restream error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to stop restream' });
    }
});

// ── GET /status — combined restream status for all live streams
router.get('/status', requireAuth, (req, res) => {
    try {
        const liveStreams = db.getLiveStreamsByUserId(req.user.id) || [];
        const allStatuses = {};
        for (const stream of liveStreams) {
            allStatuses[stream.id] = restreamManager.getStreamStatus(stream.id);
        }
        res.json({ statuses: allStatuses });
    } catch (err) {
        console.error('[Restream] Status error:', err.message);
        res.status(500).json({ error: 'Failed to get restream status' });
    }
});

// ── POST /viewer-counts — broadcaster relays platform viewer counts
// The broadcaster's browser can access Kick/Twitch APIs (not CF-blocked),
// so it polls viewer counts client-side and pushes them to the server.
router.post('/viewer-counts', requireAuth, (req, res) => {
    try {
        const { counts } = req.body;
        if (!Array.isArray(counts)) return res.status(400).json({ error: 'counts must be an array' });
        for (const { destId, count } of counts) {
            if (!Number.isFinite(destId) || (count != null && !Number.isFinite(count))) continue;
            restreamManager.setViewerCount(destId, count);
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update viewer counts' });
    }
});

// ── GET /viewer-counts — get all cached platform viewer counts for the broadcaster
router.get('/viewer-counts', requireAuth, (req, res) => {
    try {
        const ext = restreamManager.getExternalViewerCountsForUser(req.user.id);
        res.json({ total: ext.total, breakdown: ext.breakdown });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get viewer counts' });
    }
});

// ── GET /viewer-config — get safe viewer polling config for the broadcaster
router.get('/viewer-config', requireAuth, (req, res) => {
    try {
        res.json({ config: restreamManager.getViewerPollingConfig() });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get viewer polling config' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  Platform OAuth — "Connect" flow for Twitch / YouTube / Kick
//  Lets a streamer authorize their account so ingest URL + stream key are
//  auto-filled per slot instead of hand-pasted. Kick links identity only
//  (Kick's API does not expose the RTMP key).
// ════════════════════════════════════════════════════════════════════════
const platformOAuth = require('../integrations/platform-oauth');
const config = require('../config');

const OAUTH_STATE_COOKIE = 'restream_oauth_state';
const OAUTH_PLATFORMS = ['twitch', 'youtube', 'kick'];

function oauthCookieOpts() {
    const secure = config.baseUrl.startsWith('https');
    return { httpOnly: true, sameSite: 'lax', secure, maxAge: 10 * 60 * 1000, path: '/api/restream/oauth' };
}

/** Small self-closing page that notifies the opener (popup) then closes. */
function oauthResultPage(payload) {
    const data = JSON.stringify(payload);
    return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center}.ok{color:#53fc18}.err{color:#ff6b6b}</style></head>
<body><div class="box"><h2 class="${payload.ok ? 'ok' : 'err'}">${payload.ok ? '✓ Connected' : '✗ Connection failed'}</h2>
<p>${payload.ok ? (payload.platform + ' account linked. You can close this window.') : (payload.error || 'Something went wrong.')}</p></div>
<script>
(function(){
  var msg = Object.assign({ type: 'restream-oauth' }, ${data});
  // Notify the opener through every available channel — postMessage can be lost
  // when the browser severs window.opener on cross-origin navigation (COOP), so
  // BroadcastChannel + localStorage give the opener a same-origin signal too.
  try { if (window.opener) window.opener.postMessage(msg, '${config.baseUrl}'); } catch(e){}
  try { var bc = new BroadcastChannel('restream-oauth'); bc.postMessage(msg); setTimeout(function(){ try{bc.close();}catch(e){} }, 500); } catch(e){}
  try { localStorage.setItem('restream-oauth', JSON.stringify(Object.assign({ t: Date.now() }, msg))); } catch(e){}
  setTimeout(function(){ try { window.close(); } catch(e){} }, ${payload.ok ? 900 : 2500});
})();
</script></body></html>`;
}

// ── GET /oauth/status — per-platform configured + connection state for the user
router.get('/oauth/status', requireAuth, (req, res) => {
    try {
        const platforms = OAUTH_PLATFORMS.map((platform) => {
            const cfg = platformOAuth.getClientConfig(platform);
            const conn = db.getPlatformConnection(req.user.id, platform);
            return {
                platform,
                name: platformOAuth.PLATFORMS[platform].name,
                configured: cfg.configured,
                providesKey: platformOAuth.PLATFORMS[platform].providesKey,
                connected: Boolean(conn),
                username: conn ? conn.platform_username : null,
                channel_url: conn ? conn.channel_url : null,
            };
        });
        res.json({ platforms });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load OAuth status' });
    }
});

// ── GET /oauth/:platform/start — begin authorization (opened in a popup)
router.get('/oauth/:platform/start', requireAuth, (req, res) => {
    const { platform } = req.params;
    if (!OAUTH_PLATFORMS.includes(platform)) return res.status(400).send('Unknown platform');
    try {
        const managedStreamId = req.query.managed_stream_id ? parseInt(req.query.managed_stream_id, 10) : null;
        const { url, stateToken } = platformOAuth.buildAuthorize(platform, { userId: req.user.id, managedStreamId });
        res.cookie(OAUTH_STATE_COOKIE, stateToken, oauthCookieOpts());
        res.redirect(url);
    } catch (err) {
        res.status(400).send(oauthResultPage({ ok: false, platform, error: err.message }));
    }
});

// ── GET /oauth/:platform/callback — exchange code, save connection + destination
router.get('/oauth/:platform/callback', async (req, res) => {
    const { platform } = req.params;
    const send = (payload) => res.set('Content-Type', 'text/html').send(oauthResultPage(payload));
    if (!OAUTH_PLATFORMS.includes(platform)) return send({ ok: false, platform, error: 'Unknown platform' });

    try {
        const { code, state, error: oauthErr, error_description } = req.query;
        if (oauthErr) {
            console.warn(`[Restream OAuth] ${platform} provider error: ${oauthErr} — ${error_description || ''} | our redirect_uri=${platformOAuth.redirectUri(platform)}`);
            return send({ ok: false, platform, error: error_description || oauthErr });
        }
        if (!code || !state) return send({ ok: false, platform, error: 'Missing authorization code' });

        const stateData = platformOAuth.verifyState(req.cookies?.[OAUTH_STATE_COOKIE]);
        res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/restream/oauth' });
        if (!stateData || stateData.platform !== platform || stateData.nonce !== state) {
            return send({ ok: false, platform, error: 'Invalid or expired authorization state. Please try again.' });
        }

        const userId = stateData.userId;
        const tokens = await platformOAuth.exchangeCode(platform, code, stateData.codeVerifier);
        if (!tokens.accessToken) return send({ ok: false, platform, error: 'Failed to obtain access token' });

        const info = await platformOAuth.fetchConnection(platform, tokens.accessToken);

        const conn = db.upsertPlatformConnection(userId, platform, {
            platform_user_id: info.platform_user_id,
            platform_username: info.platform_username,
            channel_url: info.channel_url,
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            token_expires_at: tokens.expiresAt,
            scope: tokens.scope,
        });

        // Provision / update the restream destination for the target slot
        const managedStreamId = stateData.managedStreamId || null;
        let destProvisioned = false;
        if (managedStreamId) {
            const existing = db.getRestreamDestinationsByManagedStream(managedStreamId)
                .find((d) => d.platform === platform);
            const destFields = {
                name: info.platform_username || platformOAuth.PLATFORMS[platform].name,
                channel_url: info.channel_url || null,
                connection_id: conn.id,
            };
            // Only overwrite ingest fields when the platform actually provides them
            if (info.server_url) destFields.server_url = info.server_url;
            if (info.stream_key) destFields.stream_key = info.stream_key;

            if (existing) {
                db.updateRestreamDestination(existing.id, destFields);
            } else {
                db.createRestreamDestination(userId, {
                    managed_stream_id: managedStreamId,
                    platform,
                    enabled: 1,
                    auto_start: 0,
                    ...destFields,
                });
            }
            destProvisioned = true;
        }

        return send({
            ok: true,
            platform,
            username: info.platform_username,
            needsManualKey: info.needsManualKey,
            destProvisioned,
            managedStreamId,
        });
    } catch (err) {
        console.error('[Restream OAuth] callback error:', err.message);
        return send({ ok: false, platform, error: err.message });
    }
});

// ── DELETE /oauth/:platform/connection — unlink a platform account
router.delete('/oauth/:platform/connection', requireAuth, (req, res) => {
    const { platform } = req.params;
    if (!OAUTH_PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
    try {
        db.deletePlatformConnection(req.user.id, platform);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

module.exports = router;
