/**
 * OpenVibe.Live — Chat API Routes
 * 
 * POST /api/chat/send                  - Send a chat message (REST fallback)
 * GET  /api/chat/:streamId/history   - Get chat history for a stream
 * GET  /api/chat/:streamId/users     - Get users in chat
 * GET  /api/chat/search              - Search chat messages
 * GET  /api/chat/user/:userId/history - Get a user's chat history
 * GET  /api/chat/user/:username/profile - Get user profile card data
 */
const express = require('express');
const db = require('../db/database');
const { optionalAuth, requireAuth, requireAdmin } = require('../auth/auth');
const permissions = require('../auth/permissions');

const router = express.Router();

/**
 * Attach each author's CURRENT cosmetics (name/particle/hat effects) + tag to
 * history rows, so historical messages render with the same effects as live ones
 * (chat_messages doesn't persist cosmetics). Cached per user_id within the batch.
 */
function enrichMessagesWithCosmetics(messages) {
    let cosmetics = null, tags = null;
    try { cosmetics = require('../monetization/cosmetics'); } catch { /* */ }
    try { tags = require('../game/tags'); } catch { /* */ }
    if ((!cosmetics && !tags) || !Array.isArray(messages)) return messages;
    const cache = new Map();
    for (const m of messages) {
        if (!m || !m.user_id) continue;
        let prof = cache.get(m.user_id);
        if (!prof) {
            prof = {};
            try { if (cosmetics) Object.assign(prof, cosmetics.getCosmeticProfile(m.user_id) || {}); } catch { /* */ }
            try { if (tags) prof.tag = tags.getTagProfile(m.user_id) || null; } catch { /* */ }
            cache.set(m.user_id, prof);
        }
        if (prof.nameFX) m.nameFX = prof.nameFX;
        if (prof.particleFX) m.particleFX = prof.particleFX;
        if (prof.hatFX) m.hatFX = prof.hatFX;
        if (prof.tag) m.tag = prof.tag;
    }
    return messages;
}

const MIN_SELF_DELETE_MINUTES = 3;
const MAX_SELF_DELETE_MINUTES = 10080;
const GIF_ALLOWED_PROVIDERS = new Set(['tenor', 'giphy']);

function getGifProviderConfig(provider) {
    if (provider === 'giphy') {
        return {
            key: db.getSetting('gif_giphy_api_key') || '',
            trendingUrl: 'https://api.giphy.com/v1/gifs/trending',
            searchUrl: 'https://api.giphy.com/v1/gifs/search',
        };
    }
    return {
        key: db.getSetting('gif_tenor_api_key') || '',
        trendingUrl: 'https://tenor.googleapis.com/v2/featured',
        searchUrl: 'https://tenor.googleapis.com/v2/search',
    };
}

function normalizeGifProvider(provider) {
    const normalized = String(provider || 'tenor').trim().toLowerCase();
    return GIF_ALLOWED_PROVIDERS.has(normalized) ? normalized : 'tenor';
}

function mapGifResults(provider, payload) {
    if (provider === 'giphy') {
        const items = Array.isArray(payload?.data) ? payload.data : [];
        return items.map((item) => {
            const tiny = item?.images?.fixed_width_small?.url || item?.images?.preview_gif?.url || item?.images?.fixed_width?.url || '';
            const full = item?.images?.original?.url || item?.images?.fixed_width?.url || tiny;
            return {
                id: item?.id || null,
                preview_url: tiny,
                full_url: full,
                title: item?.title || item?.slug || 'GIF',
                provider: 'giphy',
                source_url: item?.url || full,
            };
        }).filter((item) => item.preview_url && item.full_url);
    }

    const items = Array.isArray(payload?.results) ? payload.results : [];
    return items.map((item) => {
        const tiny = item?.media_formats?.tinygif?.url || item?.media_formats?.gif?.url || '';
        const full = item?.media_formats?.gif?.url || tiny;
        return {
            id: item?.id || null,
            preview_url: tiny,
            full_url: full,
            title: item?.content_description || item?.title || 'GIF',
            provider: 'tenor',
            source_url: item?.itemurl || full,
        };
    }).filter((item) => item.preview_url && item.full_url);
}

function normalizeAutoDeleteMinutes(value) {
    const mins = parseInt(value, 10);
    if (!Number.isFinite(mins) || mins < MIN_SELF_DELETE_MINUTES) return 0;
    return Math.min(MAX_SELF_DELETE_MINUTES, mins);
}

router.get('/gif/providers', optionalAuth, (req, res) => {
    res.json({
        providers: {
            tenor: !!db.getSetting('gif_tenor_api_key'),
            giphy: !!db.getSetting('gif_giphy_api_key'),
        },
        defaultProvider: db.getSetting('gif_tenor_api_key') ? 'tenor' : (db.getSetting('gif_giphy_api_key') ? 'giphy' : null),
    });
});

router.get('/gif/trending', optionalAuth, async (req, res) => {
    try {
        const provider = normalizeGifProvider(req.query.provider);
        const config = getGifProviderConfig(provider);
        if (!config.key) return res.status(503).json({ error: `${provider} API key not configured` });

        const url = new URL(config.trendingUrl);
        if (provider === 'giphy') {
            url.searchParams.set('api_key', config.key);
            url.searchParams.set('limit', '30');
            url.searchParams.set('rating', 'pg-13');
        } else {
            url.searchParams.set('key', config.key);
            url.searchParams.set('limit', '30');
            url.searchParams.set('media_filter', 'tinygif,gif');
        }

        const upstream = await fetch(url, { headers: { 'User-Agent': 'OpenVibe.Live/1.0' } });
        if (!upstream.ok) return res.status(502).json({ error: `GIF provider request failed (${upstream.status})` });
        const payload = await upstream.json();
        res.json({ provider, results: mapGifResults(provider, payload) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load GIFs' });
    }
});

router.get('/gif/search', optionalAuth, async (req, res) => {
    try {
        const provider = normalizeGifProvider(req.query.provider);
        const query = String(req.query.q || '').trim();
        if (query.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });

        const config = getGifProviderConfig(provider);
        if (!config.key) return res.status(503).json({ error: `${provider} API key not configured` });

        const url = new URL(config.searchUrl);
        if (provider === 'giphy') {
            url.searchParams.set('api_key', config.key);
            url.searchParams.set('q', query);
            url.searchParams.set('limit', '30');
            url.searchParams.set('rating', 'pg-13');
        } else {
            url.searchParams.set('key', config.key);
            url.searchParams.set('q', query);
            url.searchParams.set('limit', '30');
            url.searchParams.set('media_filter', 'tinygif,gif');
        }

        const upstream = await fetch(url, { headers: { 'User-Agent': 'OpenVibe.Live/1.0' } });
        if (!upstream.ok) return res.status(502).json({ error: `GIF provider request failed (${upstream.status})` });
        const payload = await upstream.json();
        res.json({ provider, results: mapGifResults(provider, payload) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to search GIFs' });
    }
});

/**
 * Hydrate reply_to context onto an array of message rows.
 * Each row must have reply_to_id (from DB). Adds a reply_to object
 * with { id, username, user_id, message } for the parent message.
 */
function hydrateReplies(messages) {
    const replyIds = [...new Set(messages.map(m => m.reply_to_id).filter(Boolean))];
    if (!replyIds.length) return messages;
    const placeholders = replyIds.map(() => '?').join(',');
    const parents = db.all(
        `SELECT id, username, user_id, message
         FROM chat_messages
         WHERE id IN (${placeholders})
           AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)`,
        replyIds
    );
    const parentMap = new Map(parents.map(p => [p.id, p]));
    return messages.map(m => {
        if (m.reply_to_id && parentMap.has(m.reply_to_id)) {
            const p = parentMap.get(m.reply_to_id);
            m.reply_to = {
                id: p.id,
                username: p.username,
                user_id: p.user_id,
                message: p.message.length > 100 ? p.message.slice(0, 100) + '…' : p.message,
            };
        }
        return m;
    });
}

// ── Send Chat Message (REST fallback when WS is down) ────────
router.post('/send', requireAuth, (req, res) => {
    try {
        const text = (req.body.message || '').trim();
        // 6000 = the absolute ceiling any channel/admin can configure (see chat-server handleChatMessage).
        if (!text || text.length > 6000) {
            return res.status(400).json({ error: 'Invalid message' });
        }

        // Ban check
        if (db.isUserBanned(req.user.id, null)) {
            return res.status(403).json({ error: 'You are banned from chat' });
        }

        const chatServer = require('./chat-server');

        // Word filter
        const wordFilter = require('./word-filter');
        const filterResult = wordFilter.check(text);
        const filtered = filterResult.safe ? text : filterResult.filtered;

        if (wordFilter.isSpam(filtered)) {
            return res.status(400).json({ error: 'Message blocked: detected as spam' });
        }

        const username = req.user.display_name || req.user.username;
        const autoDeleteMinutes = normalizeAutoDeleteMinutes(req.body.auto_delete_minutes);
        const autoDeleteAt = autoDeleteMinutes
            ? new Date(Date.now() + autoDeleteMinutes * 60 * 1000).toISOString()
            : null;

        // Reply-to support
        const replyToId = req.body.reply_to_id ? parseInt(req.body.reply_to_id) : null;
        let replyTo = null;
        if (replyToId) {
            const parent = db.getChatMessageById(replyToId);
            if (parent && !parent.is_deleted) {
                replyTo = {
                    id: parent.id,
                    username: parent.username,
                    user_id: parent.user_id,
                    message: parent.message.length > 100 ? parent.message.slice(0, 100) + '…' : parent.message,
                };
            }
        }

        const chatMsg = {
            type: 'chat',
            username,
            core_username: req.user.username,
            user_id: req.user.id,
            anon_id: null,
            role: req.user.role || 'user',
            message: filtered,
            stream_id: null,
            is_global: true,
            avatar_url: req.user.avatar_url || null,
            profile_color: req.user.profile_color || '#999',
            filtered: !filterResult.safe,
            timestamp: new Date().toISOString(),
            auto_delete_at: autoDeleteAt,
        };

        // Attach cosmetics
        try {
            const cosmetics = require('../game/cosmetics');
            const cosmeticProfile = cosmetics.getCosmeticProfile(req.user.id);
            if (cosmeticProfile.nameFX) chatMsg.nameFX = cosmeticProfile.nameFX;
            if (cosmeticProfile.particleFX) chatMsg.particleFX = cosmeticProfile.particleFX;
            if (cosmeticProfile.hatFX) chatMsg.hatFX = cosmeticProfile.hatFX;
            if (cosmeticProfile.voiceFX) chatMsg.voiceFX = cosmeticProfile.voiceFX;
        } catch { /* non-critical */ }

        // Attach tag
        try {
            const tags = require('../game/tags');
            const tagProfile = tags.getTagProfile(req.user.id);
            if (tagProfile) chatMsg.tag = tagProfile;
        } catch { /* non-critical */ }

        // Save to database
        let savedId = null;
        try {
            const result = db.saveChatMessage({
                stream_id: null,
                user_id: req.user.id,
                anon_id: null,
                username,
                message: filtered,
                message_type: 'chat',
                is_global: true,
                reply_to_id: replyToId,
                auto_delete_at: autoDeleteAt,
            });
            savedId = result.lastInsertRowid;
        } catch { /* non-critical */ }

        // Attach message ID and reply context to broadcast
        if (savedId) chatMsg.id = Number(savedId);
        if (replyTo) chatMsg.reply_to = replyTo;

        // Broadcast to all global chat clients
        chatServer.broadcastGlobal(chatMsg);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Chat] REST send error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ── Search Chat Messages (admin or self) ─────────────────────
router.get('/search', requireAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');
        const query = req.query.q || '';
        const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id) : null;

        // Admin / global_mod can search anyone; others search only their own
        const effectiveUserId = permissions.canViewOtherUserLogs(req.user) ? userId : req.user.id;

        const result = db.searchChatMessages({
            query, userId: effectiveUserId, streamId, limit, offset,
        });

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// ── User Chat History ────────────────────────────────────────
router.get('/user/:userId/history', requireAuth, (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');

        // Admin / global_mod can view anyone; others view only their own
        if (!permissions.canViewOtherUserLogs(req.user) && req.user.id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = db.getUserChatHistory(userId, limit, offset);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

// ── User Profile Card ────────────────────────────────────────
router.get('/user/:username/profile', optionalAuth, (req, res) => {
    try {
        // Try core username first, then fall back to display_name lookup
        let user = db.getUserByUsername(req.params.username);
        if (!user) {
            user = db.get('SELECT * FROM users WHERE display_name = ? COLLATE NOCASE', [req.params.username]);
        }
        if (!user) return res.status(404).json({ error: 'User not found' });

        const profile = db.getUserProfile(user.id);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        // Add game stats if available
        try {
            const game = require('../game/game-engine');
            const player = game.getPlayer(user.id);
            if (player) {
                profile.game = {
                    total_level: player.total_level,
                    mining_level: player.mining_level,
                    fishing_level: player.fishing_level,
                    woodcut_level: player.woodcut_level,
                    farming_level: player.farming_level,
                    combat_level: player.combat_level,
                    crafting_level: player.crafting_level,
                    mining_xp: player.mining_xp,
                    fishing_xp: player.fishing_xp,
                    woodcut_xp: player.woodcut_xp,
                    farming_xp: player.farming_xp,
                    combat_xp: player.combat_xp,
                    crafting_xp: player.crafting_xp,
                    total_coins_earned: player.total_coins_earned || 0,
                };
            }
        } catch { /* game not initialized or player doesn't exist */ }

        res.json(profile);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

// ── Chat-relay (external) user info: join date (first message) etc. ──
router.get('/relay-user/:platform/:username', optionalAuth, (req, res) => {
    try {
        const r = db.getRelayUser(req.params.platform, req.params.username);
        res.json({ relayUser: r || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get relay user' });
    }
});

// Anonymous chatter info: first-seen (anon-number assignment) + first chat + count.
router.get('/anon/:anonId', optionalAuth, (req, res) => {
    try {
        const anonId = String(req.params.anonId || '');
        if (!/^anon\d+$/i.test(anonId)) return res.status(400).json({ error: 'Invalid anon id' });
        res.json({ anon: db.getAnonMeta(anonId) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get anon info' });
    }
});

// An anonymous chatter's chat-message history — same gate as native logs.
router.get('/anon/:anonId/logs', requireAuth, (req, res) => {
    try {
        if (!permissions.canViewOtherUserLogs(req.user)) return res.status(403).json({ error: 'Not authorized' });
        const anonId = String(req.params.anonId || '');
        if (!/^anon\d+$/i.test(anonId)) return res.status(400).json({ error: 'Invalid anon id' });
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const query = String(req.query.q || '').trim();
        const r = db.getAnonChatHistory(anonId, { limit, offset, query });
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get anon user logs' });
    }
});

// A relay (external-platform) user's chat-message history — same gate as native logs.
router.get('/relay-user/:platform/:username/logs', requireAuth, (req, res) => {
    try {
        if (!permissions.canViewOtherUserLogs(req.user)) return res.status(403).json({ error: 'Not authorized' });
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const query = String(req.query.q || '').trim();
        const r = db.getRelayUserChatHistory(req.params.platform, req.params.username, { limit, offset, query });
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get relay user logs' });
    }
});

// ── Global Chat History (all streams) ────────────────────────
router.get('/global/history', optionalAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '500'), 500);
        const before = req.query.before;
        const channelUsername = String(req.query.username || '').trim();

        let sql = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
                          u.username AS core_username,
                          COALESCE(su.username, cu.username) AS stream_channel,
                          s.is_live AS source_is_live,
                          s.managed_stream_id AS source_managed_id,
                          COALESCE(ms.title, s.title) AS source_stream_title,
                          ms.slug AS source_slug
                   FROM chat_messages cm
                   LEFT JOIN users u ON cm.user_id = u.id
                   LEFT JOIN streams s ON cm.stream_id = s.id
                   LEFT JOIN users su ON s.user_id = su.id
                   LEFT JOIN users cu ON cm.channel_user_id = cu.id
                   LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
                   WHERE cm.is_deleted = 0 AND cm.message_type IN ('chat', 'system', 'channel-sound', 'soundboard', 'donation')
                     AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
        const params = [];

        if (channelUsername) {
            sql += ` AND LOWER(COALESCE(su.username, cu.username)) = LOWER(?)`;
            params.push(channelUsername);
        }

        if (before) {
            sql += ` AND cm.timestamp < ?`;
            params.push(before);
        }

        sql += ` ORDER BY cm.timestamp DESC LIMIT ?`;
        params.push(limit);

        const messages = enrichMessagesWithCosmetics(hydrateReplies(db.all(sql, params).reverse()));
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get global chat history' });
    }
});

// ── Chat Replay (for VOD/clip playback sync) ────────────────
router.get('/:streamId/replay', optionalAuth, (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        if (!streamId) return res.status(400).json({ error: 'Invalid stream ID' });

        const from = req.query.from || null;  // ISO timestamp
        const to = req.query.to || null;      // ISO timestamp

        const messages = db.getChatReplay(streamId, from, to);
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat replay' });
    }
});

// ── Chat History ─────────────────────────────────────────────
// Loads history for a streamer's chat. By default this spans ALL of that
// broadcaster's stream sessions (not just the one slot/session being viewed),
// so viewers keep context when a stream restarts or the streamer runs multiple
// slots. Each message carries its source stream (title/slug/live) so the client
// can label it and let viewers hop between the streamer's live slots.
// Pass ?scope=stream to restrict to the single session (legacy behavior).
router.get('/:streamId/history', optionalAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '500'), 500);
        const before = req.query.before; // ISO timestamp for pagination
        const scope = req.query.scope || 'streamer';

        // Resolve which broadcaster this stream belongs to.
        const stream = db.getStreamById(req.params.streamId);
        const broadcasterId = stream ? stream.user_id : null;
        const spanStreamer = scope !== 'stream' && broadcasterId;

        // COALESCE the channel name from the source stream's owner (live rows) OR the
        // message's channel_user_id (offline rows) so the streamer/channel tag renders
        // in history for both. cu = the broadcaster resolved from channel_user_id.
        const select = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
                          u.username AS core_username,
                          s.title AS source_stream_title, s.managed_stream_id AS source_managed_id,
                          s.is_live AS source_is_live, ms.slug AS source_slug,
                          COALESCE(bu.username, cu.username) AS source_channel`;
        let sql;
        const params = [];
        if (spanStreamer) {
            // Span by channel_user_id (LEFT JOIN streams) so OFFLINE messages
            // (stream_id NULL) survive when the streamer goes live — the old INNER
            // JOIN on streams dropped them.
            sql = `${select}
                   FROM chat_messages cm
                   LEFT JOIN users u ON cm.user_id = u.id
                   LEFT JOIN streams s ON cm.stream_id = s.id
                   LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
                   LEFT JOIN users bu ON s.user_id = bu.id
                   LEFT JOIN users cu ON cm.channel_user_id = cu.id
                   WHERE cm.channel_user_id = ? AND cm.is_deleted = 0
                     AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
            params.push(broadcasterId);
        } else {
            sql = `${select}
                   FROM chat_messages cm
                   LEFT JOIN users u ON cm.user_id = u.id
                   LEFT JOIN streams s ON cm.stream_id = s.id
                   LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
                   LEFT JOIN users bu ON s.user_id = bu.id
                   LEFT JOIN users cu ON cm.channel_user_id = cu.id
                   WHERE cm.stream_id = ? AND cm.is_deleted = 0
                     AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
            params.push(req.params.streamId);
        }

        if (before) {
            sql += ` AND cm.timestamp < ?`;
            params.push(before);
        }

        sql += ` ORDER BY cm.timestamp DESC LIMIT ?`;
        params.push(limit);

        const messages = enrichMessagesWithCosmetics(hydrateReplies(db.all(sql, params).reverse()));

        // Currently-live slots for this broadcaster — lets the client render a
        // "hop between live streams" affordance.
        let liveSlots = [];
        let channel = null;
        if (broadcasterId) {
            try {
                const owner = db.getUserById(broadcasterId);
                channel = owner ? owner.username : null;
                liveSlots = (db.getManagedStreamsByUserId(broadcasterId) || [])
                    .filter(ms => ms.is_currently_live)
                    .map(ms => ({
                        managed_stream_id: ms.id,
                        slug: ms.slug,
                        title: ms.title,
                        live_session_id: ms.live_session_id,
                    }));
            } catch { /* non-critical */ }
        }
        res.json({
            messages, liveSlots, channel,
            activeStreamId: parseInt(req.params.streamId) || null,
            activeManagedId: stream ? (stream.managed_stream_id || null) : null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

// Persistent per-streamer chat history keyed by the broadcaster's USER id — spans
// every live slot AND offline periods (channel_user_id), so it works when the
// streamer has no active session. Used by the channel page (online + offline).
router.get('/channel/:userId/history', optionalAuth, (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (!userId) return res.status(400).json({ error: 'Bad user id' });
        const limit = Math.min(parseInt(req.query.limit || '500'), 500);
        const before = req.query.before;
        const select = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
                          u.username AS core_username,
                          s.title AS source_stream_title, s.managed_stream_id AS source_managed_id,
                          s.is_live AS source_is_live, ms.slug AS source_slug,
                          COALESCE(bu.username, cu.username) AS source_channel`;
        let sql = `${select}
                   FROM chat_messages cm
                   LEFT JOIN users u ON cm.user_id = u.id
                   LEFT JOIN streams s ON cm.stream_id = s.id
                   LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
                   LEFT JOIN users bu ON s.user_id = bu.id
                   LEFT JOIN users cu ON cm.channel_user_id = cu.id
                   WHERE cm.channel_user_id = ? AND cm.is_deleted = 0
                     AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
        const params = [userId];
        if (before) { sql += ' AND cm.timestamp < ?'; params.push(before); }
        sql += ' ORDER BY cm.timestamp DESC LIMIT ?'; params.push(limit);
        const messages = enrichMessagesWithCosmetics(hydrateReplies(db.all(sql, params).reverse()));
        let liveSlots = [], channel = null;
        try {
            const owner = db.getUserById(userId);
            channel = owner ? owner.username : null;
            liveSlots = (db.getManagedStreamsByUserId(userId) || [])
                .filter(ms => ms.is_currently_live)
                .map(ms => ({ managed_stream_id: ms.id, slug: ms.slug, title: ms.title, live_session_id: ms.live_session_id }));
        } catch { /* non-critical */ }
        res.json({ messages, liveSlots, channel, activeStreamId: null, activeManagedId: null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get channel chat history' });
    }
});

// ── Chat User Count ──────────────────────────────────────────
router.get('/:streamId/users', (req, res) => {
    const chatServer = require('./chat-server');
    const count = chatServer.getStreamViewerCount(parseInt(req.params.streamId));
    res.json({ count });
});

// ── Chat Log Management ─────────────────────────────────────

// Preview count of messages in a time range
router.post('/admin/purge/preview', requireAuth, (req, res) => {
    try {
        const { streamId, from, to } = req.body;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        // Must be admin or stream owner
        let effectiveStreamId = streamId || null;
        if (!permissions.isAdmin(req.user)) {
            if (streamId) {
                const stream = db.getStreamById(streamId);
                if (!stream || stream.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
            } else {
                // Non-admin without streamId: scope to their most recent stream
                const userStreams = db.getStreamsByUserId(req.user.id, 1);
                if (!userStreams?.length) {
                    return res.json({ count: 0 });
                }
                effectiveStreamId = userStreams[0].id;
            }
        }

        const count = db.countChatMessagesByTimeRange(effectiveStreamId, from, to);
        res.json({ count });
    } catch (e) {
        console.error('[Chat] Purge preview error:', e.message);
        res.status(500).json({ error: 'Failed to count messages' });
    }
});

// Delete messages in a time range (soft delete)
router.delete('/admin/purge', requireAuth, (req, res) => {
    try {
        const { streamId, from, to } = req.body;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        let effectiveStreamId = streamId || null;
        if (!permissions.isAdmin(req.user)) {
            if (streamId) {
                const stream = db.getStreamById(streamId);
                if (!stream || stream.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
            } else {
                // Non-admin without streamId: scope to their most recent stream
                const userStreams = db.getStreamsByUserId(req.user.id, 1);
                if (!userStreams?.length) {
                    return res.json({ deleted: 0 });
                }
                effectiveStreamId = userStreams[0].id;
            }
        }

        const result = db.deleteChatMessagesByTimeRange(effectiveStreamId, from, to, req.user.display_name || req.user.username);

        // Broadcast delete event to live chat
        try {
            const chatServer = require('./chat-server');
            const payload = { type: 'purge', streamId: effectiveStreamId, from, to, by: req.user.display_name };
            if (effectiveStreamId) {
                chatServer.broadcastToStream(effectiveStreamId, payload);
            } else {
                chatServer.broadcastGlobal(payload);
            }
        } catch { /* chat server may not be initialized */ }

        console.log(`[Chat] Purged messages: stream=${effectiveStreamId || 'global'} from=${from} to=${to} by=${req.user.username} changes=${result?.changes || 0}`);
        res.json({ deleted: result?.changes || 0 });
    } catch (e) {
        console.error('[Chat] Purge error:', e.message);
        res.status(500).json({ error: 'Failed to purge messages' });
    }
});

// Get paginated chat logs with filters
router.get('/admin/logs', requireAuth, (req, res) => {
    try {
        const { streamId, username, search, from, to, messageType, page, limit, includeDeleted } = req.query;

        // Must be admin or stream owner
        let effectiveStreamId = streamId ? parseInt(streamId) : undefined;
        if (!permissions.isAdmin(req.user)) {
            if (streamId) {
                const stream = db.getStreamById(parseInt(streamId));
                if (!stream || stream.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
            } else {
                // Non-admin without streamId: scope to their most recent stream
                const userStreams = db.getStreamsByUserId(req.user.id, 1);
                if (!userStreams?.length) {
                    return res.json({ rows: [], total: 0, page: 1, limit: 50, totalPages: 0 });
                }
                effectiveStreamId = userStreams[0].id;
            }
        }

        const result = db.getChatLogs({
            streamId: effectiveStreamId,
            username, search, from, to, messageType,
            page: parseInt(page) || 1,
            limit: Math.min(parseInt(limit) || 50, 200),
            includeDeleted: includeDeleted === 'true' && permissions.isAdmin(req.user),
        });
        res.json(result);
    } catch (e) {
        console.error('[Chat] Logs error:', e.message);
        res.status(500).json({ error: 'Failed to get chat logs' });
    }
});

// Export chat logs as CSV or JSON
router.get('/admin/logs/export', requireAuth, (req, res) => {
    try {
        const { streamId, username, search, from, to, messageType, format } = req.query;

        if (!permissions.isAdmin(req.user)) {
            if (streamId) {
                const stream = db.getStreamById(parseInt(streamId));
                if (!stream || stream.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
            } else {
                return res.status(403).json({ error: 'Only admins can export all chat logs' });
            }
        }

        // Get all matching rows (up to 50k)
        const result = db.getChatLogs({
            streamId: streamId ? parseInt(streamId) : undefined,
            username, search, from, to, messageType,
            page: 1, limit: 50000,
        });

        if (format === 'csv') {
            const header = 'id,timestamp,username,message,message_type,stream_id,is_global,source_platform\n';
            const csvRows = result.rows.map(r => {
                const msg = (r.message || '').replace(/"/g, '""');
                return `${r.id},"${r.timestamp}","${(r.username || '').replace(/"/g, '""')}","${msg}","${r.message_type || ''}",${r.stream_id || ''},"${r.is_global || 0}","${r.source_platform || ''}"`;
            });
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="chat-logs-${Date.now()}.csv"`);
            res.send(header + csvRows.join('\n'));
        } else {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="chat-logs-${Date.now()}.json"`);
            res.json(result.rows);
        }
    } catch (e) {
        console.error('[Chat] Export error:', e.message);
        res.status(500).json({ error: 'Failed to export chat logs' });
    }
});

module.exports = router;
