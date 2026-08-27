/**
 * OpenVibe.Live — External Chat Relay Service
 *
 * Relays chat from Twitch (IRC), Kick (Pusher WebSocket), and YouTube (scrape/API)
 * into OpenVibe.Live stream chat. Uses anonymous read-only connections — no auth tokens
 * needed for Twitch or Kick. YouTube requires either an API key or scraping.
 *
 * Architecture:
 *   - Each active restream destination with `chat_relay=1` and a `channel_url` gets a bridge
 *   - Bridges are keyed by `${streamId}:${destId}` to avoid duplicates
 *   - Messages are transformed to OpenVibe.Live chat format with `role: 'external'`
 *   - Bridges auto-reconnect with exponential backoff on disconnect
 *   - All bridges are cleaned up when the stream ends
 *
 * Uses the same pattern as robotstreamer-service.js chat bridges.
 */
const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const db = require('../db/database');
const chatServer = require('../chat/chat-server');

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

// Platform-specific colors for chat display
const PLATFORM_COLORS = {
    twitch: '#9146ff',
    kick: '#53fc18',
    youtube: '#ff0000',
};

const PLATFORM_LABELS = {
    twitch: 'Twitch',
    kick: 'Kick',
    youtube: 'YT',
};

function safeJsonParse(str, fallback = null) {
    try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Extract platform and channel name from a URL.
 * @param {string} url - Channel URL (e.g. https://twitch.tv/username)
 * @returns {{ platform: string, channelName: string } | null}
 */
function parseChannelUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace('www.', '');
        const pathParts = u.pathname.split('/').filter(Boolean);

        if (host.includes('twitch.tv') && pathParts[0]) {
            return { platform: 'twitch', channelName: pathParts[0].toLowerCase() };
        }
        if (host.includes('kick.com') && pathParts[0]) {
            const result = { platform: 'kick', channelName: pathParts[0].toLowerCase() };
            // Support ?chatroom=ID for bypassing Kick's Cloudflare-blocked API
            const chatroomParam = u.searchParams.get('chatroom');
            if (chatroomParam && /^\d+$/.test(chatroomParam)) {
                result.chatroomId = parseInt(chatroomParam, 10);
            }
            // Support ?kickChannelId=ID for Pusher viewer-count subscription
            const kickChParam = u.searchParams.get('kickChannelId');
            if (kickChParam && /^\d+$/.test(kickChParam)) {
                result.kickChannelId = parseInt(kickChParam, 10);
            }
            return result;
        }
        if (host.includes('youtube.com')) {
            // Handle youtube.com/live/VIDEO_ID, youtube.com/watch?v=VIDEO_ID, youtube.com/@channel
            if (pathParts[0] === 'live' && pathParts[1]) {
                return { platform: 'youtube', channelName: pathParts[1] };
            }
            if (pathParts[0] === 'watch') {
                const v = u.searchParams.get('v');
                if (v) return { platform: 'youtube', channelName: v };
            }
            if (pathParts[0]?.startsWith('@')) {
                return { platform: 'youtube', channelName: pathParts[0] };
            }
            if (pathParts[0] === 'channel' && pathParts[1]) {
                return { platform: 'youtube', channelName: pathParts[1] };
            }
        }
        if (host.includes('youtu.be') && pathParts[0]) {
            return { platform: 'youtube', channelName: pathParts[0] };
        }
    } catch {}
    return null;
}

class ChatRelayService {
    constructor() {
        /** @type {Map<string, object>} key = `${streamId}:${destId}` → bridge object */
        this.bridges = new Map();
    }

    /**
     * Start chat relay for eligible restream destinations matching this stream's slot.
     * Called when a stream goes live or restream starts.
     */
    async startForStream(stream) {
        if (!stream?.id || !stream?.user_id) return;

        // Load destinations scoped to this stream's managed_stream_id (slot),
        // falling back to all user destinations if stream has no slot
        let destinations;
        if (stream.managed_stream_id) {
            destinations = db.getRestreamDestinationsByManagedStream(stream.managed_stream_id) || [];
        } else {
            // Legacy: un-slotted destinations only
            const all = db.getRestreamDestinationsByUserId(stream.user_id) || [];
            destinations = all.filter(d => !d.managed_stream_id);
        }
        for (const dest of destinations) {
            if (!dest.enabled || !dest.chat_relay || !dest.channel_url) continue;
            this.startBridge(stream.id, dest);
        }
    }

    /**
     * Start a single chat relay bridge for a destination.
     */
    startBridge(streamId, dest) {
        const key = `${streamId}:${dest.id}`;
        if (this.bridges.has(key)) return; // already running

        // A restream destination can only be fed by ONE live session at a time.
        // If a previous (now-stale) session still holds a bridge for this same
        // destination — e.g. the ingest flapped to a new stream session ID before
        // the 5–6 min stale-stream cleanup tore the old one down — kill it now.
        // Otherwise both bridges stay connected to the same external channel and
        // every relayed message is duplicated (once per stale overlapping bridge).
        for (const [existingKey, b] of this.bridges) {
            if (b.destId === dest.id && b.streamId !== streamId) {
                console.log(`[ChatRelay] Replacing stale bridge ${existingKey} -> ${key} (same destination, prevents duplicate relay)`);
                this._teardown(b);
                this.bridges.delete(existingKey);
            }
        }

        const parsed = parseChannelUrl(dest.channel_url);
        if (!parsed) {
            console.warn(`[ChatRelay] Cannot parse channel URL for dest ${dest.id}: ${dest.channel_url}`);
            return;
        }

        const bridge = {
            key,
            streamId,
            destId: dest.id,
            platform: parsed.platform,
            channelName: parsed.channelName,
            chatroomId: parsed.chatroomId || null, // Kick chatroom ID from URL query
            kickChannelId: parsed.kickChannelId || null, // Kick channel ID for viewer-count Pusher subscription
            channelUrl: dest.channel_url,
            destName: dest.name || PLATFORM_LABELS[parsed.platform] || parsed.platform,
            stopped: false,
            ws: null,
            pollTimer: null,
            reconnectDelay: RECONNECT_BASE_MS,
            reconnectTimer: null,
            disconnect: null,
            viewerCount: null, // Populated by Kick Pusher viewer-count events
            platformLive: null, // Whether the platform reports the stream as live
        };

        this.bridges.set(key, bridge);

        switch (parsed.platform) {
            case 'twitch':
                this._connectTwitch(bridge);
                break;
            case 'kick':
                this._connectKick(bridge);
                break;
            case 'youtube':
                this._connectYouTube(bridge);
                break;
            default:
                console.warn(`[ChatRelay] Unsupported platform: ${parsed.platform}`);
                this.bridges.delete(key);
        }
    }

    /**
     * Stop all chat relay bridges for a stream.
     */
    stopForStream(streamId) {
        for (const [key, bridge] of this.bridges) {
            if (bridge.streamId === streamId) {
                this._teardown(bridge);
                this.bridges.delete(key);
            }
        }
    }

    /**
     * Stop a specific bridge by stream + destination ID.
     */
    stopBridge(streamId, destId) {
        const key = `${streamId}:${destId}`;
        const bridge = this.bridges.get(key);
        if (bridge) {
            this._teardown(bridge);
            this.bridges.delete(key);
        }
    }

    /**
     * Stop all bridges for a user's streams.
     */
    stopForUser(userId) {
        const streams = db.getLiveStreamsByUserId(userId) || [];
        for (const stream of streams) {
            this.stopForStream(stream.id);
        }
    }

    /**
     * Check if a relay bridge is active for a given stream + destination.
     */
    hasBridge(streamId, destId) {
        return this.bridges.has(`${streamId}:${destId}`);
    }

    /**
     * Sync relay bridges for a user after destination settings change.
     * Stops bridges for destinations that no longer have relay enabled,
     * starts bridges for newly enabled ones on matching live streams.
     */
    syncForUser(userId) {
        const liveStreams = db.getLiveStreamsByUserId(userId) || [];
        if (!liveStreams.length) return;

        const allDests = db.getRestreamDestinationsByUserId(userId) || [];

        for (const stream of liveStreams) {
            // Filter destinations to those matching this stream's slot
            const destinations = allDests.filter(d =>
                d.managed_stream_id ? d.managed_stream_id === stream.managed_stream_id
                    : !stream.managed_stream_id
            );

            // Stop bridges for disabled/removed relay destinations
            for (const [key, bridge] of this.bridges) {
                if (bridge.streamId !== stream.id) continue;
                const dest = destinations.find(d => d.id === bridge.destId);
                if (!dest || !dest.enabled || !dest.chat_relay || !dest.channel_url) {
                    console.log(`[ChatRelay] Stopping bridge ${key} — relay disabled or destination removed`);
                    this._teardown(bridge);
                    this.bridges.delete(key);
                }
            }

            // Start bridges for newly enabled destinations
            for (const dest of destinations) {
                if (!dest.enabled || !dest.chat_relay || !dest.channel_url) continue;
                if (!this.hasBridge(stream.id, dest.id)) {
                    console.log(`[ChatRelay] Starting new bridge for dest ${dest.id} (${dest.platform}) on stream ${stream.id}`);
                    this.startBridge(stream.id, dest);
                }
            }
        }
    }

    /**
     * Get active relay info for a stream (for the channel API).
     */
    getRelayInfo(streamId) {
        const relays = [];
        for (const [, bridge] of this.bridges) {
            if (bridge.streamId === streamId) {
                relays.push({
                    destId: bridge.destId,
                    platform: bridge.platform,
                    channelName: bridge.channelName,
                    channelUrl: bridge.channelUrl,
                    destName: bridge.destName,
                });
            }
        }
        return relays;
    }

    /**
     * Get viewer count for a specific destination via Kick Pusher (or other future sources).
     * @param {number} destId — restream destination ID
     * @returns {number|null}
     */
    getViewerCount(destId) {
        for (const [, bridge] of this.bridges) {
            if (bridge.destId === destId && bridge.viewerCount != null) {
                return bridge.viewerCount;
            }
        }
        return null;
    }
    /**
     * Get platform live status for a specific destination via Kick Pusher events.
     * Returns true/false if known, null if unknown.
     */
    getPlatformLive(destId) {
        for (const bridge of this.bridges.values()) {
            if (bridge.destId === destId && bridge.platformLive != null) {
                return bridge.platformLive;
            }
        }
        return null;
    }

    /**
     * Get aggregated platform viewer counts for a specific stream.
     * Returns { total, breakdown: [{ platform, channelName, destId, viewerCount, platformLive }] }
     */
    getStreamViewerCounts(streamId) {
        const breakdown = [];
        let total = 0;
        for (const bridge of this.bridges.values()) {
            if (bridge.streamId === streamId && bridge.viewerCount != null) {
                breakdown.push({
                    platform: bridge.platform,
                    channelName: bridge.channelName,
                    destId: bridge.destId,
                    viewerCount: bridge.viewerCount,
                    platformLive: bridge.platformLive,
                });
                total += bridge.viewerCount;
            }
        }
        return { total, breakdown };
    }

    // ── Internal: teardown ────────────────────────────────────

    _teardown(bridge) {
        bridge.stopped = true;
        clearTimeout(bridge.reconnectTimer);
        clearTimeout(bridge.pollTimer);
        clearTimeout(bridge._ytResolveTimer);
        if (bridge.ws) {
            try { bridge.ws.close(1000); } catch {}
            bridge.ws = null;
        }
        if (typeof bridge.disconnect === 'function') {
            bridge.disconnect();
        }
    }

    _scheduleReconnect(bridge, connectFn) {
        if (bridge.stopped) return;
        clearTimeout(bridge.reconnectTimer);
        const delay = bridge.reconnectDelay;
        bridge.reconnectDelay = Math.min(bridge.reconnectDelay * 1.5, RECONNECT_MAX_MS);
        bridge.reconnectTimer = setTimeout(() => {
            if (!bridge.stopped) connectFn(bridge);
        }, delay);
    }

    /**
     * Immediately push a bridge's viewer count into the restream manager cache.
     * This avoids the 60s polling delay for Kick Pusher real-time events.
     */
    _pushViewerCountToCache(bridge) {
        try {
            const restreamManager = require('../streaming/restream-manager');
            restreamManager.setViewerCount(
                bridge.destId,
                bridge.viewerCount,
                bridge.platformLive
            );
        } catch { /* restream manager not available — non-critical */ }
    }

    _broadcastMessage(bridge, username, message, extras = {}) {
        const label = PLATFORM_LABELS[bridge.platform] || bridge.platform;
        const color = PLATFORM_COLORS[bridge.platform] || '#888';
        const prefixedUsername = `[${label}] ${username}`;

        // Check if this relay user is hidden/banned
        try {
            const stream = db.getStreamById(bridge.streamId);
            const channel = stream?.channel_id ? db.getChannelById(stream.channel_id) : (stream ? db.getChannelByUserId(stream.user_id) : null);
            if (channel && db.isRelayUserHidden(channel.id, bridge.platform, username)) {
                return; // Silently drop messages from hidden relay users
            }
        } catch { /* non-critical — allow message through on error */ }

        // Record this relay user's activity; their first message becomes a join date.
        try { db.recordRelayUser(bridge.platform, username); } catch { /* non-critical */ }

        const chatMsg = {
            type: 'chat',
            username: prefixedUsername,
            user_id: null,
            anon_id: null,
            role: 'external',
            message: String(message || ''),
            stream_id: bridge.streamId,
            is_global: false,
            avatar_url: extras.avatar_url || null,
            profile_color: color,
            timestamp: extras.timestamp || new Date().toISOString(),
            source_platform: bridge.platform,
        };

        try {
            const result = db.saveChatMessage({
                stream_id: bridge.streamId,
                user_id: null,
                anon_id: null,
                username: prefixedUsername,
                message: chatMsg.message,
                message_type: 'chat',
                is_global: 0,
                source_platform: bridge.platform,
            });
            if (result?.lastInsertRowid) chatMsg.id = Number(result.lastInsertRowid);
        } catch {}

        chatServer.broadcastToStream(bridge.streamId, chatMsg);
        // Also surface on the global / username-only overlay (tags stream_channel)
        try { chatServer.forwardToGlobal(bridge.streamId, chatMsg); } catch { /* non-critical */ }
        // And to viewers of the streamer's other live slots (cross-slot chat)
        try { chatServer.forwardToStreamerRooms(bridge.streamId, chatMsg); } catch { /* non-critical */ }

        // Feed relayed platform chat (Kick/Twitch/YouTube) into server-side TTS
        try {
            chatServer.synthesizeAndBroadcastTTS(bridge.streamId, prefixedUsername, chatMsg.message, null, bridge.platform, `${bridge.platform}:${prefixedUsername}`, null, chatMsg.id ? `m${chatMsg.id}` : null);
        } catch { /* non-critical */ }

        // Merge relayed chat into the streamer's PowerChat unified overlay too. Only
        // native OpenVibe messages were forwarded before, so a streamer whose audience
        // mostly chats on Twitch/Kick saw an empty overlay.
        try {
            const pc = require('./powerchat-platform');
            const stream = db.getStreamById(bridge.streamId);
            if (stream?.user_id && pc.destRelayEnabled(bridge.destId) && pc.slotRelayEnabled(bridge.streamId)) {
                pc.forwardChat(stream.user_id, {
                    chatterName: prefixedUsername,
                    externalChatterId: `${bridge.platform}:${username}`,
                    message: chatMsg.message,
                    messageId: chatMsg.id ? `ov-${chatMsg.id}` : undefined,
                    avatarUrl: extras.avatar_url || undefined,
                    // Placeholder letter from the REAL name — "[Twitch] name" would
                    // otherwise render "[" for every relayed chatter.
                    avatarFallback: [...String(username || '')][0] || undefined,
                });
            }
        } catch { /* non-critical */ }

        // Welcome first-time external chatters in this streamer's channel
        try {
            const stream = db.getStreamById(bridge.streamId);
            if (stream?.user_id) {
                const chatterKey = `ext:${prefixedUsername}`;
                if (db.isFirstChatInChannel(chatterKey, stream.user_id)) {
                    db.recordFirstChat(chatterKey, stream.user_id);
                    chatServer.broadcastToStream(bridge.streamId, {
                        type: 'system',
                        message: `Welcome ${username} from ${PLATFORM_LABELS[bridge.platform] || bridge.platform}! 👋`,
                        timestamp: new Date().toISOString(),
                    });
                }
            }
        } catch { /* non-critical */ }
    }

    // ── Twitch IRC ────────────────────────────────────────────

    _connectTwitch(bridge) {
        if (bridge.stopped) return;

        const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        bridge.ws = ws;

        ws.on('open', () => {
            bridge.reconnectDelay = RECONNECT_BASE_MS;
            // Anonymous read-only connection
            ws.send('NICK justinfan' + Math.floor(Math.random() * 99999 + 1));
            ws.send('CAP REQ :twitch.tv/tags');
            ws.send(`JOIN #${bridge.channelName}`);
            console.log(`[ChatRelay] Twitch: Connected to #${bridge.channelName} for stream ${bridge.streamId}`);
        });

        ws.on('message', (raw) => {
            const data = raw.toString();
            const lines = data.split('\r\n').filter(Boolean);

            for (const line of lines) {
                // Respond to PING to stay connected
                if (line.startsWith('PING')) {
                    ws.send('PONG :tmi.twitch.tv');
                    continue;
                }

                // Parse PRIVMSG (with optional tags prefix)
                const match = line.match(
                    /^(?:@(\S+)\s)?:(\w+)!\w+@\w+\.tmi\.twitch\.tv\s+PRIVMSG\s+#(\w+)\s+:(.+)$/
                );
                if (match) {
                    const [, tagsStr, username, , message] = match;

                    // Parse display-name from tags if available
                    let displayName = username;
                    if (tagsStr) {
                        const dnMatch = tagsStr.match(/display-name=([^;]*)/);
                        if (dnMatch && dnMatch[1]) displayName = dnMatch[1];
                    }

                    this._broadcastMessage(bridge, displayName, message);
                }
            }
        });

        ws.on('close', () => {
            if (bridge.stopped) return;
            console.log(`[ChatRelay] Twitch: Disconnected from #${bridge.channelName} — reconnecting`);
            this._scheduleReconnect(bridge, (b) => this._connectTwitch(b));
        });

        ws.on('error', (err) => {
            console.warn(`[ChatRelay] Twitch error for #${bridge.channelName}:`, err.message);
        });

        bridge.disconnect = () => {
            bridge.stopped = true;
            clearTimeout(bridge.reconnectTimer);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                try { ws.close(1000); } catch {}
            }
            bridge.ws = null;
        };
    }

    // ── Kick (Pusher Protocol) ────────────────────────────────

    async _connectKick(bridge) {
        if (bridge.stopped) return;

        // Step 1: Resolve chatroom ID (and channel ID for viewer-count) — use pre-parsed from URL, or try API
        let chatroomId = bridge.chatroomId;
        if (!chatroomId) {
            try {
                const info = await this._getKickChannelInfo(bridge.channelName);
                chatroomId = info.chatroomId;
                bridge.chatroomId = chatroomId; // cache for reconnects
                // Auto-resolve kickChannelId if not provided in URL
                if (!bridge.kickChannelId && info.kickChannelId) {
                    bridge.kickChannelId = info.kickChannelId;
                    console.log(`[ChatRelay] Kick: Auto-resolved channel ID ${info.kickChannelId} for ${bridge.channelName}`);
                }
            } catch (err) {
                // Kick API is Cloudflare-blocked from servers — slug subscriptions won't receive messages.
                // The broadcast UI auto-detects the chatroom ID from the user's browser and appends ?chatroom=ID.
                // If that didn't happen, log a clear error so the user knows to fix it.
                console.error(`[ChatRelay] Kick: Cannot resolve chatroom ID for ${bridge.channelName} (${err.message}). ` +
                    `Chat relay will NOT work. Edit the Kick destination and re-save to auto-detect the chatroom ID, ` +
                    `or manually add ?chatroom=ID to the Channel URL.`);
                return; // Don't connect — slug subscriptions silently fail
            }
        }

        if (bridge.stopped) return;

        // Step 2: Connect to Pusher
        const PUSHER_KEY = '32cbd69e4b950bf97679';
        const wsUrl = `wss://ws-us2.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;
        const ws = new WebSocket(wsUrl);
        bridge.ws = ws;

        let pingInterval = null;

        ws.on('open', () => {
            bridge.reconnectDelay = RECONNECT_BASE_MS;
        });

        ws.on('message', (raw) => {
            const msg = safeJsonParse(raw.toString());
            if (!msg) return;

            switch (msg.event) {
                case 'pusher:connection_established': {
                    // Subscribe to the chatroom for chat messages
                    ws.send(JSON.stringify({
                        event: 'pusher:subscribe',
                        data: { channel: `chatrooms.${chatroomId}.v2` },
                    }));
                    // Subscribe to the channel for viewer count events (if we have the channel ID)
                    if (bridge.kickChannelId) {
                        ws.send(JSON.stringify({
                            event: 'pusher:subscribe',
                            data: { channel: `channel.${bridge.kickChannelId}` },
                        }));
                    }
                    console.log(`[ChatRelay] Kick: Connected to ${bridge.channelName} (room ${chatroomId}${bridge.kickChannelId ? ', ch ' + bridge.kickChannelId : ''}) for stream ${bridge.streamId}`);

                    // Keep-alive pings
                    const connData = safeJsonParse(msg.data);
                    const timeout = connData?.activity_timeout || 120;
                    pingInterval = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
                        }
                    }, (timeout - 10) * 1000);
                    break;
                }

                case 'pusher_internal:subscription_succeeded': {
                    const subChannel = msg.channel || '';
                    console.log(`[ChatRelay] Kick: Subscription confirmed for ${subChannel}`);
                    break;
                }

                case 'pusher:error': {
                    const errData = safeJsonParse(msg.data) || msg.data;
                    console.warn(`[ChatRelay] Kick: Pusher error for ${bridge.channelName}:`, errData);
                    break;
                }

                case 'App\\Events\\ChatMessageEvent': {
                    const payload = safeJsonParse(msg.data);
                    if (!payload?.sender?.username || !payload?.content) break;

                    this._broadcastMessage(bridge, payload.sender.username, payload.content);
                    break;
                }

                // Kick Pusher viewer count events on channel.{id}
                case 'App\\Events\\LivestreamUpdated':
                case 'App\\Events\\StreamerIsLive': {
                    const payload = safeJsonParse(msg.data);
                    if (payload?.viewer_count != null || payload?.livestream?.viewer_count != null) {
                        bridge.viewerCount = payload.viewer_count ?? payload.livestream?.viewer_count;
                    }
                    bridge.platformLive = true;
                    this._pushViewerCountToCache(bridge);
                    break;
                }

                case 'App\\Events\\StopStreamBroadcast': {
                    bridge.platformLive = false;
                    bridge.viewerCount = 0;
                    this._pushViewerCountToCache(bridge);
                    break;
                }

                default: {
                    // Log unknown channel.* events for discovery (only from the channel subscription)
                    if (msg.channel && msg.channel.startsWith('channel.') && msg.event && !msg.event.startsWith('pusher')) {
                        const payload = safeJsonParse(msg.data);
                        const count = payload?.viewer_count ?? payload?.viewers ?? payload?.livestream?.viewer_count;
                        if (count != null) {
                            bridge.viewerCount = count;
                            this._pushViewerCountToCache(bridge);
                        }
                        console.log(`[ChatRelay] Kick channel event: ${msg.event} (viewers: ${count ?? 'N/A'}) for ${bridge.channelName}`);
                    }
                    break;
                }
            }
        });

        ws.on('close', () => {
            clearInterval(pingInterval);
            // Clear stale viewer count on disconnect so polling doesn't serve outdated data
            bridge.viewerCount = null;
            if (bridge.stopped) return;
            console.log(`[ChatRelay] Kick: Disconnected from ${bridge.channelName} — reconnecting`);
            this._scheduleReconnect(bridge, (b) => this._connectKick(b));
        });

        ws.on('error', (err) => {
            console.warn(`[ChatRelay] Kick error for ${bridge.channelName}:`, err.message);
        });

        bridge.disconnect = () => {
            bridge.stopped = true;
            clearInterval(pingInterval);
            clearTimeout(bridge.reconnectTimer);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                try { ws.close(1000); } catch {}
            }
            bridge.ws = null;
        };
    }

    /**
     * Fetch the chatroom ID (and channel ID) for a Kick channel.
     * @param {string} channelName - Kick channel slug
     * @returns {Promise<{chatroomId: number, kickChannelId: number|null}>}
     */
    async _getKickChannelInfo(channelName) {
        const slug = String(channelName || '').toLowerCase();
        try {
            const info = await new Promise((resolve, reject) => {
                const req = https.get(`https://kick.com/api/v2/channels/${channelName}`, {
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    },
                    timeout: 10000,
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        if (res.statusCode >= 400) {
                            return reject(new Error(`Kick API returned ${res.statusCode}`));
                        }
                        const parsed = safeJsonParse(data);
                        if (!parsed?.chatroom?.id) {
                            return reject(new Error('No chatroom ID found in Kick API response'));
                        }
                        resolve({
                            chatroomId: parsed.chatroom.id,
                            kickChannelId: (typeof parsed.id === 'number') ? parsed.id : null,
                        });
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => req.destroy(new Error('Kick API request timed out')));
            });
            // Persist so future go-lives reuse it even when Kick's API is blocked.
            try { db.setKickChannelCache(slug, info.chatroomId, info.kickChannelId); } catch { /* */ }
            return info;
        } catch (err) {
            // Cloudflare-blocked / transient failure — reuse a previously-resolved id
            // (the chatroom id is stable per channel, so a cached hit is authoritative).
            try {
                const cached = db.getKickChannelCache(slug);
                if (cached?.chatroom_id) {
                    console.log(`[ChatRelay] Kick: Using cached chatroom id ${cached.chatroom_id} for ${slug} (live API failed: ${err.message})`);
                    return { chatroomId: cached.chatroom_id, kickChannelId: cached.kick_channel_id || null };
                }
            } catch { /* */ }
            throw err;
        }
    }

    // ── YouTube Live Chat (Scraping approach — no API key needed) ──

    /**
     * Official YouTube liveChat API path (used when the streamer linked YouTube via
     * OAuth — reliable, unlike page scraping which YouTube blocks). Returns true if
     * it took ownership of the bridge (connection exists), false to fall back.
     */
    async _connectYouTubeApi(bridge) {
        if (bridge.stopped) return false;
        let userId = null;
        try { const s = db.getStreamById(bridge.streamId); userId = s && s.user_id; } catch { /* */ }
        if (!userId) return false;
        const conn = db.getPlatformConnection(userId, 'youtube');
        if (!conn || !conn.access_token) return false;

        const platformOAuth = require('./platform-oauth');
        const token = await platformOAuth.getValidAccessToken(conn);
        if (!token) return false;
        const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        // These reads share the SAME per-project YouTube quota as broadcast creation, so meter
        // them into the global governor and back off (slower re-resolve + poll) as it fills up.
        const noteUnit = (n) => { try { platformOAuth.ytQuotaNote && platformOAuth.ytQuotaNote(n); } catch { /* */ } };
        const quotaPressure = () => { try { return (platformOAuth.ytQuotaPressure && platformOAuth.ytQuotaPressure()) || 0; } catch { return 0; } };

        // Resolve the CURRENT live broadcast's liveChatId. A reconnect (or a flaky stream)
        // makes YouTube spin up a FRESH broadcast + chat each time, so pick the most
        // recently-started active broadcast ("newest wins") rather than the first one — that
        // avoids locking onto a stale broadcast that still lists as 'active' while viewers
        // (and the actual restream) are on a newer one.
        const findLiveChatId = async () => {
            let best = null; // { liveChatId, started }
            for (const status of ['active', 'upcoming']) {
                try {
                    noteUnit(1);
                    const r = await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=${status}&broadcastType=all&maxResults=20`, { headers: H });
                    if (r.ok) {
                        const j = await r.json();
                        for (const b of (j.items || [])) {
                            const lc = b.snippet && b.snippet.liveChatId;
                            if (!lc) continue;
                            const s = b.snippet;
                            const started = Date.parse(s.actualStartTime || s.scheduledStartTime || s.publishedAt || '') || 0;
                            if (!best || started > best.started) best = { liveChatId: lc, started };
                        }
                    }
                } catch { /* try next status */ }
                if (best && status === 'active') break; // an active broadcast beats an upcoming one
            }
            return best && best.liveChatId;
        };

        let liveChatId = await findLiveChatId();
        if (!liveChatId) {
            // Linked but no live chat yet — retry, but BACK OFF. Each attempt spends 2
            // liveBroadcasts.list calls; a flat 15s retry runs forever (≈480 units/hr)
            // when a broadcast never gets a live chat — e.g. while the YouTube Data API
            // quota is exhausted — which silently keeps the quota drained. Back off
            // 15s→30s→1m→2m→5m (cap) so a stuck channel can't burn the daily quota.
            bridge._ytDiscoveryAttempts = (bridge._ytDiscoveryAttempts || 0) + 1;
            const delay = Math.min(15000 * Math.pow(2, bridge._ytDiscoveryAttempts - 1), 300000);
            if (!bridge.stopped) bridge.reconnectTimer = setTimeout(() => this._connectYouTubeApi(bridge).catch(() => {}), delay);
            return true;
        }
        bridge._ytDiscoveryAttempts = 0; // found a live chat — reset backoff

        console.log(`[ChatRelay] YouTube: using official liveChat API for stream ${bridge.streamId} (chat ${liveChatId})`);
        bridge._ytPageToken = undefined;
        bridge._ytFirstPoll = true; // skip the initial backlog; only relay new messages

        // Periodically re-resolve the live chat. If the stream reconnected and YouTube rotated
        // to a new broadcast/chat, follow it — otherwise the relay silently polls a dead chat
        // (only a hard 403/404 would trigger a re-resolve, and a stale broadcast can keep
        // returning empty 200s forever). Cheap: one list call at a slow cadence.
        clearTimeout(bridge._ytResolveTimer);
        const scheduleResolve = () => {
            if (bridge.stopped) return;
            // Slow the re-resolve as quota fills (it's just rotation-following, not latency
            // critical): 90s normally, 5m when quota's getting tight, and skip the list entirely
            // near the ceiling.
            const pr = quotaPressure();
            const delay = pr >= 0.85 ? 600000 : pr >= 0.6 ? 300000 : 90000;
            bridge._ytResolveTimer = setTimeout(async () => {
                if (bridge.stopped) return;
                if (quotaPressure() < 0.85) {
                    try {
                        const current = await findLiveChatId();
                        if (current && current !== liveChatId) {
                            console.log(`[ChatRelay] YouTube: live chat rotated for stream ${bridge.streamId} → ${current}`);
                            liveChatId = current;
                            bridge._ytPageToken = undefined;
                            bridge._ytFirstPoll = true; // don't dump the new chat's backlog
                        }
                    } catch { /* keep the current chat */ }
                }
                scheduleResolve();
            }, delay);
        };
        scheduleResolve();

        const poll = async () => {
            if (bridge.stopped) return;
            try {
                const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');
                url.searchParams.set('liveChatId', liveChatId);
                url.searchParams.set('part', 'snippet,authorDetails');
                url.searchParams.set('maxResults', '200');
                if (bridge._ytPageToken) url.searchParams.set('pageToken', bridge._ytPageToken);
                noteUnit(1);
                const r = await fetch(url, { headers: H });
                if (!r.ok) {
                    if (r.status === 403 || r.status === 404) {
                        // Chat ended / access lost — try to re-resolve after a delay.
                        if (!bridge.stopped) bridge.reconnectTimer = setTimeout(() => this._connectYouTubeApi(bridge).catch(() => {}), 20000);
                        return;
                    }
                    if (!bridge.stopped) bridge.pollTimer = setTimeout(poll, 5000);
                    return;
                }
                const j = await r.json();
                bridge._ytPageToken = j.nextPageToken;
                if (!bridge._ytFirstPoll) {
                    for (const it of (j.items || [])) {
                        const name = it.authorDetails && it.authorDetails.displayName;
                        const sn = it.snippet || {};
                        const text = sn.displayMessage || (sn.textMessageDetails && sn.textMessageDetails.messageText);
                        if (name && text) this._broadcastMessage(bridge, name, text);
                    }
                }
                bridge._ytFirstPoll = false;
                // Poll cadence follows YouTube's hint, but we RAISE the floor as quota fills so a
                // long-running chat poll can't drain the shared project quota. Slightly laggier
                // relayed chat under pressure beats the relay 403ing for everyone.
                const pr = quotaPressure();
                const floor = pr >= 0.85 ? 20000 : pr >= 0.6 ? 12000 : 2500;
                const cap = pr >= 0.6 ? 30000 : 15000;
                const interval = Math.max(floor, Math.min(cap, j.pollingIntervalMillis || 5000));
                if (!bridge.stopped) bridge.pollTimer = setTimeout(poll, interval);
            } catch (e) {
                if (!bridge.stopped) bridge.pollTimer = setTimeout(poll, 6000);
            }
        };
        poll();
        return true;
    }

    async _connectYouTube(bridge) {
        if (bridge.stopped) return;
        // Prefer the official liveChat API when YouTube is linked (scraping is unreliable).
        try {
            if (await this._connectYouTubeApi(bridge)) return;
        } catch (e) {
            console.warn('[ChatRelay] YouTube API path error, falling back to scrape:', e.message);
        }

        // Track consecutive YouTube failures — give up after 5 to avoid log spam
        if (!bridge._ytFailures) bridge._ytFailures = 0;
        const MAX_YT_FAILURES = 5;

        if (bridge._ytFailures >= MAX_YT_FAILURES) {
            // Only log once when giving up
            if (bridge._ytFailures === MAX_YT_FAILURES) {
                console.warn(`[ChatRelay] YouTube: Giving up on chat relay for stream ${bridge.streamId} after ${MAX_YT_FAILURES} consecutive failures (scraping may be blocked by YouTube)`);
                bridge._ytFailures++; // increment past max so this log only fires once
            }
            return; // Stop retrying
        }

        // YouTube chat relay uses internal API scraping (no API key required).
        // The channel_url can be a video URL or a channel URL.
        // For live streams, we need the video ID to fetch the live chat.
        try {
            const videoId = await this._resolveYouTubeVideoId(bridge.channelName, bridge.channelUrl);
            if (!videoId) {
                bridge._ytFailures++;
                console.warn(`[ChatRelay] YouTube: Could not resolve video ID for ${bridge.channelName} (attempt ${bridge._ytFailures}/${MAX_YT_FAILURES})`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
                return;
            }

            if (bridge.stopped) return;

            const chatPageUrl = `https://www.youtube.com/live_chat?v=${videoId}&pbj=1`;
            const html = await this._httpGet(chatPageUrl, {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            });

            if (bridge.stopped) return;

            // Extract ytInitialData
            const match = html.match(/ytInitialData\s*=\s*({.+?});\s*<\/script>/s);
            if (!match) {
                bridge._ytFailures++;
                console.warn(`[ChatRelay] YouTube: Could not extract ytInitialData for video ${videoId} (attempt ${bridge._ytFailures}/${MAX_YT_FAILURES})`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
                return;
            }

            const ytData = safeJsonParse(match[1]);
            const chatContents = ytData?.contents?.liveChatRenderer;
            if (!chatContents) {
                bridge._ytFailures++;
                console.warn(`[ChatRelay] YouTube: No liveChatRenderer found — stream may not be live (attempt ${bridge._ytFailures}/${MAX_YT_FAILURES})`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
                return;
            }

            // Get initial continuation token
            const cont = chatContents.continuations?.[0];
            const continuationToken = cont?.invalidationContinuationData?.continuation
                || cont?.timedContinuationData?.continuation;

            if (!continuationToken) {
                bridge._ytFailures++;
                console.warn(`[ChatRelay] YouTube: No continuation token found (attempt ${bridge._ytFailures}/${MAX_YT_FAILURES})`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
                return;
            }

            console.log(`[ChatRelay] YouTube: Connected to video ${videoId} for stream ${bridge.streamId}`);
            bridge.reconnectDelay = RECONNECT_BASE_MS;
            bridge._ytFailures = 0; // Reset on successful connection

            // Start polling
            this._pollYouTubeChat(bridge, continuationToken);

        } catch (err) {
            bridge._ytFailures = (bridge._ytFailures || 0) + 1;
            console.warn(`[ChatRelay] YouTube: Setup failed for ${bridge.channelName} (attempt ${bridge._ytFailures}):`, err.message);
            this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
        }
    }

    async _pollYouTubeChat(bridge, continuationToken) {
        if (bridge.stopped || !continuationToken) return;

        try {
            const res = await this._httpPost('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', {
                context: {
                    client: { clientName: 'WEB', clientVersion: '2.20250101.00.00' },
                },
                continuation: continuationToken,
            });

            const data = safeJsonParse(res);
            if (!data || bridge.stopped) return;

            const chatActions = data.continuationContents?.liveChatContinuation?.actions || [];
            for (const action of chatActions) {
                const renderer = action.addChatItemAction?.item?.liveChatTextMessageRenderer;
                if (!renderer) continue;

                const username = renderer.authorName?.simpleText || 'YouTube User';
                const messageParts = renderer.message?.runs?.map(r => r.text || '').join('') || '';
                if (messageParts) {
                    this._broadcastMessage(bridge, username, messageParts);
                }
            }

            // Get next continuation
            const nextCont = data.continuationContents?.liveChatContinuation?.continuations?.[0];
            const nextToken = nextCont?.invalidationContinuationData?.continuation
                || nextCont?.timedContinuationData?.continuation;
            const timeoutMs = nextCont?.timedContinuationData?.timeoutMs || 6000;

            if (nextToken && !bridge.stopped) {
                bridge.pollTimer = setTimeout(() => this._pollYouTubeChat(bridge, nextToken), timeoutMs);
            } else if (!bridge.stopped) {
                console.warn(`[ChatRelay] YouTube: Lost continuation token — reconnecting`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
            }
        } catch (err) {
            if (bridge.stopped) return;
            console.warn(`[ChatRelay] YouTube: Poll error:`, err.message);
            this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
        }
    }

    /**
     * Resolve a YouTube video ID from various URL formats.
     * If the input looks like a video ID already, use it directly.
     * If it's a channel handle (@name), try to find their live stream.
     */
    async _resolveYouTubeVideoId(channelName, channelUrl) {
        // If channelName is already a video ID (11 chars alphanumeric + dash/underscore)
        if (/^[a-zA-Z0-9_-]{11}$/.test(channelName)) {
            return channelName;
        }

        // Try fetching the channel page to find a live stream
        try {
            const url = channelUrl.includes('/watch') || channelUrl.includes('/live')
                ? channelUrl
                : channelUrl.replace(/\/?$/, '/live');
            const html = await this._httpGet(url, {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            });
            // Look for canonical video URL in the page
            const videoMatch = html.match(/\"videoId\":\"([a-zA-Z0-9_-]{11})\"/);
            if (videoMatch) return videoMatch[1];
            // Also try og:url meta tag
            const ogMatch = html.match(/content="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
            if (ogMatch) return ogMatch[1];
        } catch {}

        return null;
    }

    // ── HTTP Helpers ──────────────────────────────────────────

    _httpGet(url, headers = {}) {
        return new Promise((resolve, reject) => {
            const mod = url.startsWith('https') ? https : http;
            const req = mod.get(url, { headers, timeout: 15000 }, (res) => {
                // Follow redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(this._httpGet(res.headers.location, headers));
                }
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
        });
    }

    _httpPost(url, body) {
        return new Promise((resolve, reject) => {
            const jsonBody = JSON.stringify(body);
            const mod = url.startsWith('https') ? https : http;
            const urlObj = new URL(url);
            const req = mod.request({
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(jsonBody),
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
                timeout: 15000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
            req.write(jsonBody);
            req.end();
        });
    }
}

module.exports = new ChatRelayService();
