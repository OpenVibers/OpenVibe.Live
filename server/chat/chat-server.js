/**
 * OpenVibe.Live — WebSocket Chat Server
 * 
 * Features:
 * - Anonymous chat with sequential numbering (anon12345)  
 * - Global chat + per-stream chat
 * - Word filtering (safe/unsafe mode)
 * - Anti-VPN approval queue
 * - Streamer moderation (ban, timeout, delete)
 * - Chat commands (/help, /tts, /color, etc.)
 * - Rate limiting
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { extractWsToken, authenticateWs } = require('../auth/auth');
const permissions = require('../auth/permissions');
const wordFilter = require('./word-filter');
const cosmetics = require('../monetization/cosmetics');
const ttsEngine = require('./tts-engine');
const soundboard = require('./soundboard-service');
const dm = require('./dm');
const ipUtils = require('../admin/ip-utils');

const DEBUG_DM_DELIVERY = process.env.DEBUG_DM_DELIVERY === '1';

const WS_HEARTBEAT_MS = 30000;
const CHAT_AUTO_DELETE_SWEEP_MS = 30000;
const MIN_CHAT_AUTO_DELETE_MINUTES = 3;
const MAX_CHAT_AUTO_DELETE_MINUTES = 10080;
const MAX_SEND_BACKPRESSURE = 256 * 1024;
const RATE_LIMIT_CACHE_TTL_MS = 10 * 60 * 1000;
const SOUNDBOARD_RATE_LIMIT_MS = 8000;
const SOUNDBOARD_STREAM_MAX_PER_WINDOW = 15;
const SOUNDBOARD_STREAM_WINDOW_MS = 60 * 1000;
const GOTTI_GIF_URL = 'https://media1.tenor.com/m/Y-GsLUQT9LQAAAAd/deez-something-came-in-the-mail-today.gif';
const GOTTI_CAPTION = 'Something came in the mail today... deez nuts. GOTTI!';
const DEFAULT_SLUR_NUDGE = 'This streamer enabled Anti-Slur Nudge for this chat. Free speech is still alive, but this lane is closed today. Try a different word and keep it funny.';
// Built-in slur categories and normalization are defined in moderation-utils.js
// (single source of truth — browser-side chat.js mirrors the same patterns).
const {
    CORE_SLUR_CATEGORIES,
    normalizeSlurText: _modNormalizeSlurText,
    normalizeSlurPatternText: _modNormalizeSlurPatternText,
    containsCoreSlur: _modContainsCoreSlur,
    containsRegexSlur: _modContainsRegexSlur,
    containsConfiguredSlur: _modContainsConfiguredSlur,
    compileRegexList: _modCompileRegexList,
} = require('./moderation-utils');

class ChatServer {
    constructor() {
        this.wss = null;
        /** @type {Map<WebSocket, { user: object|null, anonId: string, streamId: number|null, ip: string }>} */
        this.clients = new Map();
        /** @type {Map<string, number>} IP → unified anon number (warm cache, backed by openvibe.network) */
        this.anonMap = new Map();
        this.nextAnonId = 1;
        this._anonDbLoaded = false;
        /** @type {Map<string, number>} `${ip}:${streamId}` → last message time (rate limiting) */
        this.rateLimits = new Map();
        this.DEFAULT_RATE_LIMIT_MS = 1000; // 1 message per second
        /** @type {Map<number, number>} streamId → slow mode ms (0 = off, default rate limit applies) */
        this.slowModeByStream = new Map();
        this.heartbeatInterval = null;
        /** @type {Map<number, number>} streamId → current TTS queue size */
        this.ttsQueueSize = new Map();
        /** @type {Map<string, number>} `${streamId}:${userId}` → user's TTS queue count */
        this.ttsUserCounts = new Map();
        /** @type {Map<string, number>} `${streamId}:${userKey}` → last soundboard trigger */
        this.soundboardRateLimits = new Map();
        /** @type {Map<number, {count: number, windowStart: number}>} streamId → stream-level soundboard rate window */
        this.soundboardStreamLimits = new Map();
        this._autoDeleteSweepInterval = null;

        // ── Unified anon resolution via openvibe.network internal API ──
        this._openvibeToolsUrl = process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:3100';
        this._internalKey = process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY || '';
        /** @type {Map<string, Promise<number>>} IP → pending resolve promise (dedup concurrent) */
        this._pendingResolves = new Map();
    }

    normalizeIp(ip) {
        let normalized = String(ip || 'unknown').trim();
        if (!normalized) normalized = 'unknown';
        if (normalized === '::1') return '127.0.0.1';
        if (normalized.startsWith('::ffff:')) return normalized.slice(7);
        return normalized;
    }

    /**
     * Extract the real client IP from Express/WS request.
     * Prefers CF-Connecting-IP (set by Cloudflare, unforgeable through proxy),
     * then X-Forwarded-For first entry, then socket remote address.
     */
    getClientIp(req) {
        const raw = req.headers?.['cf-connecting-ip']
            || req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || req.connection?.remoteAddress
            || 'unknown';
        return this.normalizeIp(raw);
    }

    /**
     * Warm the in-memory anonMap from DB on first use.
     * This ensures anon numbers survive server restarts.
     */
    _loadAnonMappings() {
        if (this._anonDbLoaded) return;
        this._anonDbLoaded = true;
        try {
            const { maxNum, mappings } = db.loadAnonMappings();
            for (const [ip, num] of mappings) {
                this.anonMap.set(ip, num);
            }
            this.nextAnonId = maxNum + 1;
            if (mappings.size > 0) {
                console.log(`[Chat] Loaded ${mappings.size} persistent anon mappings (next: anon${this.nextAnonId})`);
            }
        } catch (e) {
            console.warn('[Chat] Failed to load anon mappings from DB:', e.message);
        }
    }

    /**
     * Resolve anon number from openvibe.network unified API.
     * Returns a Promise<number>. Caches in memory and falls back to local DB.
     */
    async _resolveUnifiedAnonNum(ip) {
        // Already cached
        if (this.anonMap.has(ip)) return this.anonMap.get(ip);

        // Dedup concurrent resolves for the same IP
        if (this._pendingResolves.has(ip)) return this._pendingResolves.get(ip);

        const promise = (async () => {
            try {
                const res = await fetch(`${this._openvibeToolsUrl}/internal/resolve-anon`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Internal-Key': this._internalKey,
                    },
                    body: JSON.stringify({ ip }),
                });
                if (res.ok) {
                    const data = await res.json();
                    const num = data.anon_number;
                    this.anonMap.set(ip, num);
                    if (num >= this.nextAnonId) this.nextAnonId = num + 1;
                    // Also sync to local DB for warmup cache
                    try { db.getOrCreateAnonNum(ip); } catch { /* ok */ }
                    return num;
                }
                throw new Error(`HTTP ${res.status}`);
            } catch (e) {
                console.warn(`[Chat] Unified anon resolve failed for ${ip}, falling back to local:`, e.message);
                // Fallback to local DB
                try {
                    const num = db.getOrCreateAnonNum(ip);
                    this.anonMap.set(ip, num);
                    if (num >= this.nextAnonId) this.nextAnonId = num + 1;
                    return num;
                } catch {
                    const num = this.nextAnonId++;
                    this.anonMap.set(ip, num);
                    return num;
                }
            } finally {
                this._pendingResolves.delete(ip);
            }
        })();

        this._pendingResolves.set(ip, promise);
        return promise;
    }

    getAnonIdForIp(ip) {
        this._loadAnonMappings();
        const anonKey = this.normalizeIp(ip);
        if (this.anonMap.has(anonKey)) {
            return `anon${this.anonMap.get(anonKey)}`;
        }
        // Synchronous fallback for immediate use — kick off async resolve in background
        this._resolveUnifiedAnonNum(anonKey).catch(() => {});
        // Use local DB for synchronous path
        try {
            const num = db.getOrCreateAnonNum(anonKey);
            this.anonMap.set(anonKey, num);
            if (num >= this.nextAnonId) this.nextAnonId = num + 1;
            return `anon${num}`;
        } catch (e) {
            // Fallback: use in-memory only
            const num = this.nextAnonId++;
            this.anonMap.set(anonKey, num);
            return `anon${num}`;
        }
    }

    getAnonIdForConnection(ip, streamId = null) {
        const anonKey = this.normalizeIp(ip);
        for (const [, info] of this.clients) {
            if (info.ip !== anonKey || !info.anonId) continue;
            if (streamId == null || info.streamId === streamId) {
                return info.anonId;
            }
        }
        return this.getAnonIdForIp(anonKey);
    }

    /**
     * Attach to an existing HTTP server for WebSocket upgrade
     */
    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

        // Word filter
        wordFilter.load();

        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (!this.wss) return;

            const now = Date.now();
            for (const [ip, lastSeen] of this.rateLimits.entries()) {
                if ((now - lastSeen) > RATE_LIMIT_CACHE_TTL_MS) {
                    this.rateLimits.delete(ip);
                }
            }

            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    try { ws.terminate(); } catch {}
                    return;
                }
                ws.isAlive = false;
                try { ws.ping(); } catch {}
            });
        }, WS_HEARTBEAT_MS);

        // ── Viewer snapshot recording (every 60s) ────────────
        if (this._snapshotInterval) clearInterval(this._snapshotInterval);
        this._snapshotInterval = setInterval(() => {
            this._recordViewerSnapshots();
        }, 60_000);

        if (this._autoDeleteSweepInterval) clearInterval(this._autoDeleteSweepInterval);
        this._autoDeleteSweepInterval = setInterval(() => {
            this._sweepExpiredChatMessages();
        }, CHAT_AUTO_DELETE_SWEEP_MS);
        this._sweepExpiredChatMessages();

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        console.log('[Chat] WebSocket chat server initialized');
        return this.wss;
    }

    /**
     * Handle WebSocket upgrade for chat connections
     */
    handleUpgrade(req, socket, head) {
        if (req.url.startsWith('/ws/chat')) {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
            return true;
        }
        return false;
    }

    /**
     * Handle a new chat connection
     */
    handleConnection(ws, req) {
        const ip = this.getClientIp(req);

        // Diagnostic: log IP resolution chain for first few connections
        if (this.anonMap.size < 20) {
            console.log('[Chat] IP resolution — cf-connecting-ip:', req.headers?.['cf-connecting-ip'] || '(none)',
                '| x-forwarded-for:', req.headers?.['x-forwarded-for'] || '(none)',
                '| x-real-ip:', req.headers?.['x-real-ip'] || '(none)',
                '| socket:', req.socket?.remoteAddress || '(none)',
                '| resolved:', ip);
        }

        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const token = extractWsToken(req);
        const streamId = parseInt(urlParams.get('stream')) || null;

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        try { ws._socket?.setNoDelay(true); } catch {}

        // Authenticate (optional — anon if no token)
        const user = authenticateWs(token);

        // Generate or reuse anon ID for this IP
        const anonId = user ? null : this.getAnonIdForConnection(ip, streamId);

        const clientInfo = {
            user,
            anonId,
            streamId,
            ip,
            joinedAt: Date.now(),
        };
        this.clients.set(ws, clientInfo);

        // Log IP for tracking
        try {
            const geo = ipUtils.enrichIp(ip);
            db.logIp({ userId: user?.id, anonId, ip, action: 'chat', geo });
        } catch (e) { /* non-critical */ }

        // (No verbose welcome message — the client shows a concise "Connected to
        // chat" / "Chatting as X" instead.)

        // Send user count + users list update
        this.broadcastUserCount(streamId);
        this.broadcastUsersList(streamId);

        // ── Message handler ──────────────────────────────────
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(ws, msg);
            } catch (err) {
                console.warn('[Chat] Malformed message from', ws._clientIp || 'unknown', ':', err.message);
            }
        });

        ws.on('close', () => {
            this.clients.delete(ws);
            this.broadcastUserCount(streamId);
            this.broadcastUsersList(streamId);
        });

        ws.on('error', (err) => {
            console.warn('[Chat] WebSocket error for', ws._clientIp || 'unknown', ':', err.message);
            this.clients.delete(ws);
        });
    }

    /**
     * Handle incoming chat message
     */
    handleMessage(ws, msg) {
        const client = this.clients.get(ws);
        if (!client) return;

        // Rate limiting (only for chat messages, not join/leave)
        if (msg.type === 'chat') {
            const now = Date.now();
            const rateKey = `${client.ip}:${client.streamId || 'global'}`;
            const lastMsg = this.rateLimits.get(rateKey) || 0;
            const streamSlowMs = this.slowModeByStream.get(client.streamId) || 0;
            const effectiveLimit = Math.max(this.DEFAULT_RATE_LIMIT_MS, streamSlowMs);
            if (now - lastMsg < effectiveLimit) {
                this.sendTo(ws, { type: 'system', message: 'Slow down! You are sending messages too fast.' });
                return;
            }
            this.rateLimits.set(rateKey, now);
        }

        switch (msg.type) {
            case 'chat':
                this.handleChatMessage(ws, client, msg);
                break;
            case 'self-delete-history':
                this.handleSelfDeleteHistory(ws, client);
                break;
            case 'join':
            case 'join_stream': {
                // (Re-)authenticate if a token is provided
                if (msg.token) {
                    const user = authenticateWs(msg.token);
                    if (user) {
                        if (!client.user || client.user.id === user.id) {
                            client.user = user;
                            client.anonId = null; // no longer anonymous
                        } else {
                            console.warn(`[Chat] Ignoring token identity mismatch for ${client.user.username} -> ${user.username}`);
                        }
                    }
                }
                const oldStream = client.streamId;
                client.streamId = parseInt(msg.streamId || msg.stream_id) || null;
                // Channel room: the streamer's stable user id. Lets a viewer stay in
                // the SAME chat room across live-slot switches AND while the streamer
                // is offline. Prefer an explicit channelUserId from the client; else
                // derive it from the live stream's owner.
                let channelUserId = parseInt(msg.channelUserId || msg.channel_user_id) || null;
                if (!channelUserId && client.streamId) {
                    try { const s = db.getStreamById(client.streamId); if (s) channelUserId = s.user_id; } catch { /* ignore */ }
                }
                client.channelUserId = channelUserId;
                // Update viewer counts for old and new streams
                if (oldStream !== client.streamId) {
                    if (oldStream) this.broadcastUserCount(oldStream);
                    this.broadcastUserCount(client.streamId);
                }
                // Send identity confirmation so the client knows who it is
                const displayName = client.user ? (client.user.display_name || client.user.username) : client.anonId;
                const streamSlowSec = client.streamId ? Math.round((this.slowModeByStream.get(client.streamId) || 0) / 1000) : 0;
                const streamSettings = this._getChannelChatSettings(client.streamId);
                this.sendTo(ws, {
                    type: 'auth',
                    authenticated: !!client.user,
                    username: displayName,
                    core_username: client.user?.username || null,
                    role: client.user ? client.user.role : 'anon',
                    user_id: client.user?.id || null,
                    slowmode_seconds: streamSlowSec,
                    allow_auto_delete: !client.streamId || streamSettings.viewer_auto_delete_enabled !== 0,
                    allow_self_delete_all: !client.streamId || streamSettings.viewer_delete_all_enabled !== 0,
                    gifs_enabled: !client.streamId || streamSettings.gifs_enabled !== 0,
                    custom_emotes_enabled: !client.streamId || streamSettings.custom_emotes_enabled !== 0,
                    custom_sounds_enabled: !client.streamId || streamSettings.custom_sounds_enabled !== 0,
                    uploads_mods_only: !!(client.streamId && streamSettings.uploads_mods_only),
                    max_sound_seconds: client.streamId ? (streamSettings.max_sound_seconds || 10) : 10,
                    emote_scale: client.streamId ? (streamSettings.emote_scale || 100) : 100,
                    soundboard_enabled: !client.streamId || streamSettings.soundboard_enabled !== 0,
                    soundboard_allow_pitch: !client.streamId || streamSettings.soundboard_allow_pitch !== 0,
                    soundboard_allow_speed: !client.streamId || streamSettings.soundboard_allow_speed !== 0,
                    slur_filter_enabled: !!(client.streamId && streamSettings.slur_filter_enabled),
                    slur_filter_use_builtin: streamSettings.slur_filter_use_builtin !== 0,
                    slur_filter_disabled_categories: (() => { try { return JSON.parse(streamSettings.slur_filter_disabled_categories || '[]') || []; } catch { return []; } })(),
                    slur_filter_terms: this._parseSlurFilterTerms(streamSettings.slur_filter_terms),
                    slur_filter_regexes: this._parseRegexLines(streamSettings.slur_filter_regexes),
                    slur_filter_nudge_message: String(streamSettings.slur_filter_nudge_message || ''),
                    min_auto_delete_minutes: MIN_CHAT_AUTO_DELETE_MINUTES,
                });
                break;
            }
            case 'leave_stream':
                client.streamId = null;
                break;
            case 'get-users':
                this.sendTo(ws, { type: 'users-list', users: this.getUserList(client.streamId) });
                break;
            default:
                break;
        }
    }

    handleSelfDeleteHistory(ws, client) {
        if (!client) return;

        const canBypass = client.streamId ? permissions.canModerateStream(client.user, client.streamId) : false;
        const chatSettings = this._getChannelChatSettings(client.streamId);
        if (client.streamId && !canBypass && chatSettings.viewer_delete_all_enabled === 0) {
            this.sendTo(ws, { type: 'error', message: 'This streamer has disabled viewer self-delete for this chat.' });
            return;
        }

        let ids = [];
        if (client.user?.id) {
            ids = db.deleteUserChatMessages(client.user.id, {
                streamId: client.streamId || null,
                deletedBy: client.user.id,
            });
        } else if (client.anonId) {
            ids = db.deleteAnonChatMessages(client.anonId, {
                streamId: client.streamId || null,
                deletedBy: null,
            });
        } else {
            this.sendTo(ws, { type: 'error', message: 'Join chat first before deleting history.' });
            return;
        }

        this._broadcastDeletedMessages(client.streamId || null, ids);

        try {
            db.logModerationAction({
                scope_type: client.streamId ? 'stream' : 'site',
                scope_id: client.streamId || undefined,
                actor_user_id: client.user?.id || undefined,
                action_type: 'self_message_delete_all',
                details: {
                    count: ids.length,
                    stream_id: client.streamId || null,
                    anon_id: client.user ? null : client.anonId,
                },
            });
        } catch { /* non-critical */ }

        this.sendTo(ws, {
            type: 'self-delete-result',
            count: ids.length,
            scope: client.streamId ? 'stream' : 'global',
        });
    }

    /**
     * Build a deduplicated list of users in a given stream (or global if null).
     * Returns { logged: [{username, display_name, avatar_url, role}], anonCount: N }
     */
    getUserList(streamId) {
        const seen = new Set();
        const logged = [];
        let anonCount = 0;
        for (const [, c] of this.clients) {
            if (c.streamId !== streamId) continue;
            if (c.user) {
                if (seen.has(c.user.id)) continue;
                seen.add(c.user.id);
                logged.push({
                    username: c.user.username,
                    display_name: c.user.display_name || c.user.username,
                    avatar_url: c.user.avatar_url || null,
                    role: c.user.role,
                });
            } else if (c.anonId) {
                if (seen.has(c.anonId)) continue;
                seen.add(c.anonId);
                anonCount++;
            }
        }
        // Sort: admins first, then mods, then alphabetical
        const rolePriority = { admin: 0, global_mod: 1, streamer: 2, user: 3 };
        logged.sort((a, b) => (rolePriority[a.role] ?? 9) - (rolePriority[b.role] ?? 9) || a.display_name.localeCompare(b.display_name));
        return { logged, anonCount };
    }

    _parseSlurFilterTerms(rawTerms) {
        return String(rawTerms || '')
            .split(/[\n,]/)
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 200);
    }

    _parseRegexLines(rawRegexes) {
        return String(rawRegexes || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 300);
    }

    // Normalization and matching are delegated to moderation-utils.js (shared module).
    // These thin wrappers preserve the existing call sites inside this class.
    _normalizeSlurText(input) { return _modNormalizeSlurText(input); }
    _normalizeSlurPatternText(input) { return _modNormalizeSlurPatternText(input); }
    _containsCoreSlur(text, disabledCategories = []) { return _modContainsCoreSlur(text, disabledCategories); }
    _containsRegexSlur(text, regexLines) { return _modContainsRegexSlur(text, regexLines); }
    _containsConfiguredSlur(text, terms) { return _modContainsConfiguredSlur(text, terms); }
    _compileRegexList(patternStrings, opts) { return _modCompileRegexList(patternStrings, opts); }

    /**
     * Handle a chat message
     */
    handleChatMessage(ws, client, msg) {
        let text = (msg.message || '').trim();
        // Absolute upper bound (DoS guard) = the highest value any channel/admin can configure
        // (admins can set a channel up to 6000). The REAL per-channel limit is enforced below at
        // the `max_message_length` check — this must never be lower than that or it silently
        // swallows long messages the channel actually allows.
        if (!text || text.length > 6000) return;

        // ── Stream utility commands (!sr, !queue, !nowplaying, !skip) ──
        if (text.startsWith('!')) {
            this.handleBangCommand(ws, client, text);
            return;
        }

        // ── Chat commands ────────────────────────────────────
        if (text.startsWith('/')) {
            this.handleCommand(ws, client, text);
            return;
        }

        // ── Ban check ────────────────────────────────────────
        if (client.user && db.isUserBanned(client.user.id, client.streamId)) {
            this.sendTo(ws, { type: 'system', message: 'You are banned from this chat.' });
            return;
        }
        if (db.isIpBanned(client.ip, client.streamId)) {
            this.sendTo(ws, { type: 'system', message: 'You are banned from this chat.' });
            return;
        }

        // ── IP Approval Mode (Anti-VPN) ─────────────────────
        if (client.streamId && client.ip) {
            try {
                const stream = db.getStreamById(client.streamId);
                const channel = stream?.channel_id ? db.getChannelById(stream.channel_id) : (stream ? db.getChannelByUserId(stream.user_id) : null);
                if (channel) {
                    const settings = db.getChannelModerationSettings(channel.id);
                    if (settings?.ip_approval_mode) {
                        const isStaffBypass = client.user && permissions.isGlobalModOrAbove(client.user);
                        const isOwner = client.user && stream && stream.user_id === client.user.id;
                        if (!isStaffBypass && !isOwner) {
                            if (!db.isIpApproved(channel.id, client.ip)) {
                                // Auto-approve IPs that have existing non-deleted chat messages in this channel's streams
                                const existing = db.get(
                                    `SELECT 1 FROM chat_messages cm
                                     JOIN streams s ON cm.stream_id = s.id
                                     WHERE s.channel_id = ? AND cm.is_deleted = 0
                                     AND (cm.user_id = ? OR cm.anon_id = ?)
                                     LIMIT 1`,
                                    [channel.id, client.user?.id || -1, client.anonId || '']
                                );
                                if (existing) {
                                    // This user has chatted before — auto-approve their IP
                                    db.approveIp(channel.id, client.ip, null, 'auto_existing');
                                } else {
                                    // Hold the message for streamer approval
                                    const username = client.user ? client.user.display_name : client.anonId;
                                    db.holdMessageForApproval({
                                        channelId: channel.id,
                                        streamId: client.streamId,
                                        ip: client.ip,
                                        userId: client.user?.id || null,
                                        anonId: client.anonId || null,
                                        username,
                                        message: text,
                                    });
                                    this.sendTo(ws, {
                                        type: 'system',
                                        message: 'This channel has IP approval mode enabled. Your message is being held for review by the streamer.',
                                    });
                                    // Notify the streamer that a new IP needs approval
                                    this._notifyStreamerPendingIp(client.streamId, stream.user_id, username, client.ip);
                                    return;
                                }
                            }
                        }
                    }
                }
            } catch { /* non-critical — don't block chat for IP approval errors */ }
        }

        // ── Channel moderation settings ──────────────────────
        if (client.streamId) {
            const chatSettings = this._getChannelChatSettings(client.streamId);
            const isStaff = client.user && permissions.isGlobalModOrAbove(client.user);
            const canModerateThisStream = permissions.canModerateStream(client.user, client.streamId);

            // Max message length
            const maxLen = Math.max(50, Number(chatSettings.max_message_length || 500));
            if (text.length > maxLen) {
                this.sendTo(ws, { type: 'system', message: `Message too long. Max ${maxLen} characters.` });
                return;
            }

            // Anonymous not allowed
            if (!client.user && !chatSettings.allow_anonymous) {
                this.sendTo(ws, { type: 'system', message: 'This channel requires a logged-in account to chat.' });
                return;
            }

            // Links disabled — exempt [gif:url] tags (validated separately)
            if (chatSettings.links_allowed === 0 && !isStaff) {
                const textWithoutGifs = text.replace(/\[gif:https?:\/\/[^\]]+\]/gi, '');
                if (/(https?:\/\/|www\.)/i.test(textWithoutGifs)) {
                    this.sendTo(ws, { type: 'system', message: 'Links are disabled in this channel chat.' });
                    return;
                }
            }

            // Validate [gif:url] — only allow trusted domains
            const gifTagMatch = text.match(/\[gif:(https?:\/\/[^\]]+)\]/i);
            if (gifTagMatch) {
                const ALLOWED_GIF_DOMAINS = ['tenor.com', 'media.tenor.com', 'media1.tenor.com', 'c.tenor.com', 'giphy.com', 'media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'i.giphy.com'];
                try {
                    const gifUrl = new URL(gifTagMatch[1]);
                    if (!ALLOWED_GIF_DOMAINS.includes(gifUrl.hostname)) {
                        this.sendTo(ws, { type: 'system', message: 'Only Tenor and Giphy GIFs are allowed.' });
                        return;
                    }
                } catch {
                    this.sendTo(ws, { type: 'system', message: 'Invalid GIF URL.' });
                    return;
                }
            }

            // Followers only
            if (chatSettings.followers_only && client.user && !isStaff) {
                const stream = db.getStreamById(client.streamId);
                if (stream && stream.user_id !== client.user.id && !db.isFollowing(client.user.id, stream.user_id)) {
                    this.sendTo(ws, { type: 'system', message: 'This chat is currently followers-only.' });
                    return;
                }
            }

            // Account age gate
            if (chatSettings.account_age_gate_hours && client.user && !isStaff) {
                const ageMs = Date.now() - new Date(client.user.created_at).getTime();
                if (ageMs < Number(chatSettings.account_age_gate_hours) * 3600000) {
                    this.sendTo(ws, { type: 'system', message: `This chat requires accounts older than ${chatSettings.account_age_gate_hours} hour(s).` });
                    return;
                }
            }

            // Optional per-streamer anti-slur filter
            if (chatSettings.slur_filter_enabled && !isStaff && !canModerateThisStream) {
                const blockedTerms = this._parseSlurFilterTerms(chatSettings.slur_filter_terms);
                const configuredRegexLines = this._parseRegexLines(chatSettings.slur_filter_regexes);
                const hitConfigured = blockedTerms.length && this._containsConfiguredSlur(text, blockedTerms);
                const hitCore = chatSettings.slur_filter_use_builtin !== 0 && this._containsCoreSlur(text, (() => { try { return JSON.parse(chatSettings.slur_filter_disabled_categories || '[]') || []; } catch { return []; } })());
                const hitRegex = configuredRegexLines.length && this._containsRegexSlur(text, configuredRegexLines);
                if (hitConfigured || hitCore || hitRegex) {
                    this.sendTo(ws, {
                        type: 'slur-blocked',
                        message: String(chatSettings.slur_filter_nudge_message || '').trim() || DEFAULT_SLUR_NUDGE,
                        streamer_enabled: true,
                    });
                    return;
                }
            }

        }

        const username = client.user ? client.user.display_name : client.anonId;
        const coreUsername = client.user ? client.user.username : null;
        const role = client.user ? client.user.role : 'anon';

        // Voice channel tagging — clients can tag messages with the voice channel they're in
        const voiceChannelId = (typeof msg.voiceChannelId === 'string' && msg.voiceChannelId) ? msg.voiceChannelId : null;

        // Reply-to support — client sends reply_to_id, we look up the parent message
        const replyToId = msg.reply_to_id ? parseInt(msg.reply_to_id) : null;
        let replyTo = null;
        if (replyToId) {
            try {
                const parent = db.getChatMessageById(replyToId);
                const parentStillVisible = parent && !parent.is_deleted
                    && (!parent.auto_delete_at || new Date(parent.auto_delete_at).getTime() > Date.now());
                if (parentStillVisible) {
                    replyTo = {
                        id: parent.id,
                        username: parent.username,
                        user_id: parent.user_id,
                        message: parent.message.length > 100 ? parent.message.slice(0, 100) + '…' : parent.message,
                    };
                }
            } catch { /* non-critical */ }
        }

        const requestedAutoDeleteMinutes = parseInt(msg.auto_delete_minutes, 10);
        const allowViewerAutoDelete = !client.streamId
            || this._getChannelChatSettings(client.streamId).viewer_auto_delete_enabled !== 0
            || permissions.canModerateStream(client.user, client.streamId);
        const autoDeleteAt = Number.isFinite(requestedAutoDeleteMinutes)
            && requestedAutoDeleteMinutes >= MIN_CHAT_AUTO_DELETE_MINUTES
            && allowViewerAutoDelete
            ? new Date(Date.now() + Math.min(MAX_CHAT_AUTO_DELETE_MINUTES, requestedAutoDeleteMinutes) * 60 * 1000).toISOString()
            : null;

        const chatMsg = {
            type: 'chat',
            username,
            core_username: coreUsername,
            user_id: client.user?.id || null,
            anon_id: client.anonId,
            role,
            message: text,
            stream_id: client.streamId,
            channel_user_id: client.channelUserId || null,
            is_global: !client.streamId && !client.channelUserId,
            avatar_url: client.user?.avatar_url || null,
            profile_color: client.user?.profile_color || '#999',
            filtered: false,
            timestamp: new Date().toISOString(),
            auto_delete_at: autoDeleteAt,
        };

        // Preserve voice channel tag so clients can filter voice-call messages
        if (voiceChannelId) chatMsg.voiceChannelId = voiceChannelId;

        // Attach cosmetic data for chat rendering
        if (client.user?.id) {
            try {
                const cosmeticProfile = cosmetics.getCosmeticProfile(client.user.id);
                if (cosmeticProfile.nameFX) chatMsg.nameFX = cosmeticProfile.nameFX;
                if (cosmeticProfile.particleFX) chatMsg.particleFX = cosmeticProfile.particleFX;
                if (cosmeticProfile.hatFX) chatMsg.hatFX = cosmeticProfile.hatFX;
                if (cosmeticProfile.voiceFX) chatMsg.voiceFX = cosmeticProfile.voiceFX;
            } catch { /* non-critical */ }

            // Attach equipped tag for chat rendering
            try {
                const tags = require('../game/tags');
                const tagProfile = tags.getTagProfile(client.user.id);
                if (tagProfile) chatMsg.tag = tagProfile;
            } catch { /* non-critical */ }
        }

        // Save to database
        try {
            const result = db.saveChatMessage({
                stream_id: client.streamId || null,
                channel_user_id: client.channelUserId || null,
                user_id: client.user?.id,
                anon_id: client.anonId,
                username,
                message: text,
                message_type: 'chat',
                is_global: !client.streamId && !client.channelUserId,
                reply_to_id: replyToId,
                auto_delete_at: autoDeleteAt,
            });
            if (result.lastInsertRowid) chatMsg.id = Number(result.lastInsertRowid);
        } catch { /* non-critical */ }

        // Attach reply context to broadcast
        if (replyTo) chatMsg.reply_to = replyTo;

        // Award OpenCoins for chatting (logged-in users only)
        if (client.user?.id && client.streamId) {
            try {
                const openvibeCoins = require('../monetization/opencoins');
                const coinResult = openvibeCoins.awardChat(client.user.id, client.streamId);
                if (coinResult) {
                    this.sendTo(ws, {
                        type: 'coin_earned',
                        coins: coinResult.coins,
                        total: coinResult.total,
                        streamerId: coinResult.streamerId,
                        reason: 'Chat bonus',
                    });
                }
            } catch { /* non-critical */ }
        }

        // Welcome first-time chatters in this streamer's channel
        if (client.streamId) {
            try {
                const stream = db.getStreamById(client.streamId);
                if (stream?.user_id) {
                    const chatterKey = client.user ? `user:${client.user.id}` : `anon:${client.anonId}`;
                    if (db.isFirstChatInChannel(chatterKey, stream.user_id)) {
                        db.recordFirstChat(chatterKey, stream.user_id);
                        const welcomeName = client.user?.display_name || client.user?.username || client.anonId || 'stranger';
                        this.broadcastToStream(client.streamId, {
                            type: 'system',
                            message: `Welcome ${welcomeName} to the chat! 👋`,
                            timestamp: new Date().toISOString(),
                        });
                    }
                }
            } catch { /* non-critical */ }
        }

        // Broadcast to appropriate audience
        if (client.streamId || client.channelUserId) {
            // Deliver to the streamer's whole channel room (every live slot + offline
            // viewers) plus the specific stream room. This subsumes cross-slot
            // forwarding so a viewer isn't interrupted when the streamer switches
            // slots or briefly drops offline.
            this.broadcastToChannelRoom(client.channelUserId, client.streamId, chatMsg);
            // Surface on the homepage global feed (tagged with the channel).
            if (client.streamId) this.forwardToGlobal(client.streamId, chatMsg);
            else this.forwardToGlobalByChannel(client.channelUserId, chatMsg);
        }
        if (client.streamId) {

            // Trigger server-side TTS synthesis (async, non-blocking).
            // identityKey uses the immutable login handle (or anon id) so the
            // per-user voice is stable even if the display name changes.
            this.synthesizeAndBroadcastTTS(
                client.streamId,
                username,
                text,
                chatMsg.voiceFX,
                null,
                client.user ? `user:${client.user.username}` : `anon:${client.anonId}`
            );

            // Check for 101soundboards links in the message (async, non-blocking)
            this.processSoundboard(ws, client, text);

            // Let AI chat viewers react to REAL typed chat (streamer or viewers).
            // Bots inject via broadcastToStream directly, so this path only sees
            // genuine human messages.
            try {
                require('../integrations/ai-chatbot-service').onRealChatMessage(client.streamId, {
                    username,
                    message: text,
                    userId: client.user?.id || null,
                });
            } catch { /* non-critical */ }

        } else if (!client.channelUserId) {
            // Pure global chat (homepage) — offline channel messages were already
            // delivered to the channel room above.
            this.broadcastGlobal(chatMsg);
        } else if (this._channelOwnerInRoom(client.channelUserId)) {
            // OFFLINE channel chat with the channel OWNER present in their own room:
            // synthesize TTS so their "TTS on my channel even when offline" option has
            // audio to play (client-side settings + the one-speaking-tab lock decide
            // whether it's actually audible). Owner absent = skip the synth cost.
            this.synthesizeAndBroadcastTTS(
                null,
                username,
                text,
                chatMsg.voiceFX,
                null,
                client.user ? `user:${client.user.username}` : `anon:${client.anonId}`,
                client.channelUserId
            );
        }

        // Merge real chat into the streamer's PowerChat unified overlay (chat:write).
        // Scoped to the CHANNEL, not the live session. This used to sit inside the
        // `if (client.streamId)` block above, so it only fired while the streamer was
        // live — yet viewers can chat in a channel whenever they like, and those
        // messages are already persisted and broadcast channel-wide. The overlay simply
        // never saw them. Chat is a property of the channel; only TTS, soundboards and
        // AI viewers genuinely need a live stream.
        try {
            const pc = require('../integrations/powerchat-platform');
            // Relay is per CHANNEL, not per slot: a popout pinned to an expired stream
            // id keeps chatting in the same channel, so the slot check follows the
            // channel's current live stream rather than the stale id.
            if (client.channelUserId && pc.channelRelayEnabled(client.channelUserId, client.streamId)) {
                let isMod = false, isSub = false;
                try { isMod = !!(client.user && permissions.canModerateChannel(client.user, client.channelUserId)); } catch { /* */ }
                try { isSub = !!(client.user && db.isActiveSubscriber(client.user.id, client.channelUserId)); } catch { /* */ }
                pc.forwardChat(client.channelUserId, {
                    chatterName: username,
                    externalChatterId: client.user?.id ? ('u' + client.user.id) : ('a' + (client.anonId || 'anon')),
                    message: text,
                    avatarUrl: client.user?.avatar_url || undefined,
                    isModerator: isMod,
                    isSubscriber: isSub,
                });
            }
        } catch { /* non-critical */ }
    }

    handleBangCommand(ws, client, text) {
        const parts = text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();

        if (cmd === '!gotti') {
            const username = client.user ? client.user.display_name : client.anonId;
            const coreUsername = client.user ? client.user.username : null;
            const role = client.user ? client.user.role : 'anon';
            const gottiMsg = {
                type: 'gotti',
                username,
                core_username: coreUsername,
                user_id: client.user?.id || null,
                anon_id: client.anonId,
                role,
                stream_id: client.streamId,
                is_global: !client.streamId,
                avatar_url: client.user?.avatar_url || null,
                profile_color: client.user?.profile_color || '#999',
                message: GOTTI_CAPTION,
                gif_url: GOTTI_GIF_URL,
                source_url: 'https://tenor.com/view/deez-something-came-in-the-mail-today-deez-nuts-discord-gif-20388619',
                timestamp: new Date().toISOString(),
            };

            if (client.user?.id) {
                try {
                    const cosmeticProfile = cosmetics.getCosmeticProfile(client.user.id);
                    if (cosmeticProfile.nameFX) gottiMsg.nameFX = cosmeticProfile.nameFX;
                    if (cosmeticProfile.particleFX) gottiMsg.particleFX = cosmeticProfile.particleFX;
                    if (cosmeticProfile.hatFX) gottiMsg.hatFX = cosmeticProfile.hatFX;
                } catch { /* non-critical */ }

                try {
                    const tags = require('../game/tags');
                    const tagProfile = tags.getTagProfile(client.user.id);
                    if (tagProfile) gottiMsg.tag = tagProfile;
                } catch { /* non-critical */ }
            }

            if (client.streamId) {
                this.broadcastToStream(client.streamId, gottiMsg);
                this.forwardToGlobal(client.streamId, gottiMsg);
            } else {
                this.broadcastGlobal(gottiMsg);
            }
            return;
        }

        if (cmd === '!sb') {
            if (!client.streamId) {
                this.sendTo(ws, { type: 'system', message: 'Soundboard commands only work in a stream chat.' });
                return;
            }
            const chatSettings = this._getChannelChatSettings(client.streamId);
            if (chatSettings.soundboard_enabled === 0) {
                this.sendTo(ws, { type: 'system', message: 'This streamer has disabled 101soundboards in chat.' });
                return;
            }
            const sbArgs = text.slice(parts[0].length).trim();
            const parsed = soundboard.parseSoundboardMessage(`!sb ${sbArgs}`, {
                allowPitch: chatSettings.soundboard_allow_pitch !== 0,
                allowSpeed: chatSettings.soundboard_allow_speed !== 0,
            });
            if (!parsed) {
                this.sendTo(ws, { type: 'system', message: 'Usage: !sb <sound-id or 101soundboards URL> [100p|-100p] [0.5-3 speed]' });
                return;
            }
            this.processSoundboard(ws, client, text);
            return;
        }

        if (!client.streamId) {
            this.sendTo(ws, { type: 'system', message: 'Media request commands only work in a stream chat.' });
            return;
        }

        const args = text.slice(parts[0].length).trim();

        try {
            const stream = db.getStreamById(client.streamId);
            if (!stream?.user_id) {
                this.sendTo(ws, { type: 'system', message: 'Could not resolve the current stream owner.' });
                return;
            }

            const mediaQueue = require('../media/media-queue');

            switch (cmd) {
                case '!sr':
                case '!yt':
                case '!youtube':
                case '!req':
                case '!request': {
                    if (!client.user?.id) {
                        this.sendTo(ws, { type: 'system', message: 'You must be logged in to request media.' });
                        return;
                    }

                    mediaQueue.addRequest({
                        streamerId: stream.user_id,
                        streamId: client.streamId,
                        userId: client.user.id,
                        username: client.user.display_name || client.user.username,
                        input: args,
                    }).then((request) => {
                        this.broadcastToStream(client.streamId, {
                            type: 'system',
                            message: `${request.username} added “${request.title}”${request.duration_seconds ? ` (${Math.floor(request.duration_seconds / 60)}m${request.duration_seconds % 60}s)` : ''} to the media queue for ${request.cost} gold.`,
                            timestamp: new Date().toISOString(),
                        });
                        this.sendTo(ws, {
                            type: 'coin_earned',
                            coins: 0,
                            currency: 'gold',
                            total: null, // client refreshes via /api/coins/balance (network wallet)
                            reason: 'Media request purchase',
                        });
                    }).catch((err) => {
                        this.sendTo(ws, { type: 'system', message: err.message || 'Failed to add media request.' });
                    });
                    return;
                }

                case '!queue': {
                    const state = mediaQueue.getState(stream.user_id);
                    const items = state.queue.slice(0, 3);
                    if (!items.length) {
                        this.sendTo(ws, { type: 'system', message: 'The media queue is empty. Use !sr, !yt, !youtube, !req, or !request with a URL to queue something.' });
                        return;
                    }
                    const summary = items.map((item, index) => `#${index + 1} ${item.title}`).join(' • ');
                    this.sendTo(ws, { type: 'system', message: `Queued: ${summary}` });
                    return;
                }

                case '!np':
                case '!nowplaying':
                case '!watching': {
                    const state = mediaQueue.getState(stream.user_id);
                    if (state.now_playing) {
                        const np = state.now_playing;
                        const durText = np.duration_seconds ? ` [${Math.floor(np.duration_seconds / 60)}m${np.duration_seconds % 60}s]` : '';
                        this.sendTo(ws, { type: 'system', message: `Now playing: ${np.title}${durText} (requested by ${np.username})` });
                    } else if (state.queue[0]) {
                        this.sendTo(ws, { type: 'system', message: `Nothing is playing yet. Up next: ${state.queue[0].title}` });
                    } else {
                        this.sendTo(ws, { type: 'system', message: 'Nothing is playing right now.' });
                    }
                    return;
                }

                case '!skip': {
                    if (!this.canModerate(client) && client.user?.id !== stream.user_id) {
                        this.sendTo(ws, { type: 'system', message: 'Only the streamer or a moderator can skip media.' });
                        return;
                    }
                    const ended = mediaQueue.finishCurrent(stream.user_id, 'skipped');
                    const next = mediaQueue.startNext(stream.user_id);
                    if (ended) {
                        this.broadcastToStream(client.streamId, {
                            type: 'system',
                            message: `Skipped: ${ended.title}${next ? ` • Up next: ${next.title}` : ''}`,
                            timestamp: new Date().toISOString(),
                        });
                    } else {
                        this.sendTo(ws, { type: 'system', message: 'Nothing is currently playing.' });
                    }
                    return;
                }

                case '!mediahelp': {
                    this.sendTo(ws, { type: 'system', message: 'Media commands: !sr/!yt/!youtube/!req/!request <url>, !queue, !nowplaying, !skip' });
                    return;
                }

                // ── Cozmo robot commands ───────────────
                case '!forward':
                case '!backward':
                case '!left':
                case '!right':
                case '!liftup':
                case '!liftdown':
                case '!headup':
                case '!headdown': {
                    const controlServer = require('../controls/control-server');
                    const cozmoMap = {
                        '!forward': 'forward', '!backward': 'backward',
                        '!left': 'turn_left', '!right': 'turn_right',
                        '!liftup': 'lift_up', '!liftdown': 'lift_down',
                        '!headup': 'head_up', '!headdown': 'head_down',
                    };
                    const user = db.getUserById(stream.user_id);
                    if (!user) return;
                    const hwWs = controlServer.hardwareClients.get(user.stream_key);
                    if (!hwWs || hwWs.readyState !== 1) {
                        this.sendTo(ws, { type: 'system', message: 'No hardware client connected.' });
                        return;
                    }
                    hwWs.send(JSON.stringify({
                        type: 'command',
                        command: cozmoMap[cmd],
                        from_user: client.user?.display_name || `anon${client.anonId || ''}`,
                        timestamp: new Date().toISOString(),
                    }));
                    return;
                }

                case '!say': {
                    if (!args) return;
                    const controlServer2 = require('../controls/control-server');
                    const user2 = db.getUserById(stream.user_id);
                    if (!user2) return;
                    const hwWs2 = controlServer2.hardwareClients.get(user2.stream_key);
                    if (!hwWs2 || hwWs2.readyState !== 1) {
                        this.sendTo(ws, { type: 'system', message: 'No hardware client connected.' });
                        return;
                    }
                    hwWs2.send(JSON.stringify({
                        type: 'command',
                        command: `say:${args.slice(0, 200)}`,
                        from_user: client.user?.display_name || `anon${client.anonId || ''}`,
                        timestamp: new Date().toISOString(),
                    }));
                    return;
                }

                default:
                    // Unknown !command → try a per-channel viewer-uploaded sound clip.
                    // Forward trailing tokens (e.g. "500p", "0.5") as pitch/speed args.
                    this.triggerChannelSound(ws, client, stream, cmd.slice(1), parts.slice(1));
                    return;
            }
        } catch (err) {
            this.sendTo(ws, { type: 'system', message: err.message || 'Media command failed.' });
        }
    }

    /**
     * Play a per-channel viewer-uploaded sound clip (triggered by !command).
     * Silent no-op when the command is not a registered sound so unknown
     * commands don't spam the chat.
     */
    triggerChannelSound(ws, client, stream, command, args = [], relay = null) {
        try {
            if (!stream?.user_id || !command) return;
            const cmd = String(command).toLowerCase();
            const sound = db.getChannelSoundByCommand(stream.user_id, cmd);
            if (!sound) return; // not a sound command — stay silent

            const chatSettings = this._getChannelChatSettings(client.streamId);
            if (chatSettings.custom_sounds_enabled === 0) {
                if (ws) this.sendTo(ws, { type: 'system', message: 'This streamer has disabled chat sound commands.' });
                return;
            }

            // Pitch/speed args (e.g. "!honk 500p 0.5"), clamped to the channel's limits.
            const mods = soundboard.parseModifiers(args || [], {
                allowPitch: chatSettings.soundboard_allow_pitch !== 0,
                allowSpeed: chatSettings.soundboard_allow_speed !== 0,
                minSpeed: chatSettings.sound_min_speed,
                maxSpeed: chatSettings.sound_max_speed,
                minPitch: chatSettings.sound_min_pitch_rate,
                maxPitch: chatSettings.sound_max_pitch_rate,
            });

            // Banned users can't trigger sounds
            if (client.user && db.isUserBanned(client.user.id, client.streamId)) return;
            if (client.ip && db.isIpBanned(client.ip, client.streamId)) return;

            // Rate limits — reuse the soundboard limiter (per-user + per-stream window)
            const now = Date.now();
            const rateKey = `${client.streamId}:${relay ? `rs${relay.username}` : (client.user ? `u${client.user.id}` : `a${client.anonId}`)}`;
            const lastUsedAt = this.soundboardRateLimits.get(rateKey) || 0;
            if ((now - lastUsedAt) < SOUNDBOARD_RATE_LIMIT_MS) {
                const remaining = Math.ceil((SOUNDBOARD_RATE_LIMIT_MS - (now - lastUsedAt)) / 1000);
                if (ws) this.sendTo(ws, { type: 'system', message: `Wait ${remaining}s before triggering another sound.` });
                return;
            }
            const streamWindow = this.soundboardStreamLimits.get(client.streamId) || { count: 0, windowStart: now };
            if ((now - streamWindow.windowStart) >= SOUNDBOARD_STREAM_WINDOW_MS) {
                streamWindow.count = 0;
                streamWindow.windowStart = now;
            }
            if (streamWindow.count >= SOUNDBOARD_STREAM_MAX_PER_WINDOW) {
                if (ws) this.sendTo(ws, { type: 'system', message: 'Too many sounds are playing right now — try again shortly.' });
                return;
            }

            // Read + encode the clip
            if (!sound.url || !fs.existsSync(sound.url)) return;
            let audioB64;
            try {
                audioB64 = fs.readFileSync(sound.url).toString('base64');
            } catch { return; }

            this.soundboardRateLimits.set(rateKey, now);
            streamWindow.count += 1;
            this.soundboardStreamLimits.set(client.streamId, streamWindow);

            const username = relay ? relay.username
                : (client.user ? (client.user.display_name || client.user.username) : (client.anonId || 'someone'));

            // Announce as a RICH chat message (same identity/cosmetics/tag as a normal
            // message) so it shows the user's nametag, badges, avatar and cosmetics —
            // not a plain "x played !command" text line.
            const soundMsg = {
                type: 'chat',
                username,
                core_username: relay ? null : (client.user ? client.user.username : null),
                user_id: client.user?.id || null,
                anon_id: relay ? null : client.anonId,
                role: relay ? (relay.role || 'external') : (client.user ? client.user.role : 'anon'),
                message: `played !${cmd}`,
                message_type: 'channel-sound',
                sound: { command: cmd, pitch: mods.pitch, speed: mods.speed, pitchShift: mods.pitchShift, args: (args || []).join(' '), emoteCode: sound.emote_code || '' },
                stream_id: client.streamId,
                is_global: !client.streamId,
                avatar_url: (relay ? relay.avatar_url : client.user?.avatar_url) || null,
                profile_color: (relay ? relay.profile_color : client.user?.profile_color) || '#999',
                source_platform: relay ? relay.sourcePlatform : undefined,
                timestamp: new Date().toISOString(),
            };
            if (!relay && client.user?.id) {
                try {
                    const cp = cosmetics.getCosmeticProfile(client.user.id);
                    if (cp.nameFX) soundMsg.nameFX = cp.nameFX;
                    if (cp.particleFX) soundMsg.particleFX = cp.particleFX;
                    if (cp.hatFX) soundMsg.hatFX = cp.hatFX;
                } catch { /* non-critical */ }
                try {
                    const tagProfile = require('../game/tags').getTagProfile(client.user.id);
                    if (tagProfile) soundMsg.tag = tagProfile;
                } catch { /* non-critical */ }
            }
            // Persist the announce so it survives a reload — history rebuilds the
            // rich sound row from metadata (the audio itself is never replayed).
            try {
                const saved = db.saveChatMessage({
                    stream_id: client.streamId || null,
                    channel_user_id: stream.user_id,
                    user_id: client.user?.id,
                    anon_id: relay ? null : client.anonId,
                    username,
                    message: soundMsg.message,
                    message_type: 'channel-sound',
                    is_global: false,
                    source_platform: relay ? relay.sourcePlatform : null,
                    metadata: { sound: soundMsg.sound },
                });
                if (saved.lastInsertRowid) soundMsg.id = Number(saved.lastInsertRowid);
            } catch { /* non-critical */ }
            this.broadcastToStream(client.streamId, soundMsg);
            // Also surface it on the global chat feed / global overlay (with stream_channel).
            this.forwardToGlobal(client.streamId, soundMsg);
            this.broadcastToStream(client.streamId, {
                type: 'soundboard-audio',
                username,
                title: `!${cmd}`,
                audio: audioB64,
                mimeType: sound.mime || 'audio/mpeg',
                pitch: mods.pitch,
                speed: mods.speed,
                pitchShift: mods.pitchShift,
                source: 'channel-sound',
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            console.error('[ChannelSound] trigger error:', err.message);
        }
    }

    /**
     * Handle chat commands
     */
    handleCommand(ws, client, text) {
        const parts = text.slice(1).split(' ');
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');
        const argParts = parts.slice(1);

        switch (cmd) {
            case 'help':
                this.sendTo(ws, {
                    type: 'system',
                    message: `Commands: /help, /tts <message>, /color <#hex>, /viewers, /uptime, /me <action>, /paste <content>` +
                        `\nMedia: !sr/!yt/!youtube/!req/!request <url>, !queue, !nowplaying` +
                        (this.canModerate(client)
                            ? `\nMod: /ban <user>, /unban <user>, /timeout <user> [seconds], /clear, /slow <seconds>`
                            : ''),
                });
                break;

            case 'tts':
                if (!args) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /tts <message>' });
                    return;
                }
                {
                    const ttsMsg = {
                        type: 'tts',
                        username: client.user?.display_name || client.anonId,
                        core_username: client.user?.username || null,
                        message: args,
                        timestamp: new Date().toISOString(),
                    };
                    // Attach voice cosmetic if equipped
                    let voiceFX = null;
                    if (client.user?.id) {
                        try {
                            const cp = cosmetics.getCosmeticProfile(client.user.id);
                            if (cp.voiceFX) {
                                ttsMsg.voiceFX = cp.voiceFX;
                                voiceFX = cp.voiceFX;
                            }
                        } catch { /* non-critical */ }
                    }
                    this.broadcastToStream(client.streamId, ttsMsg);

                    // Also synthesize server-side TTS for site-wide mode
                    this.synthesizeAndBroadcastTTS(
                        client.streamId,
                        ttsMsg.username,
                        args,
                        voiceFX,
                        null,
                        client.user ? `user:${client.user.username}` : `anon:${client.anonId}`
                    );
                }
                break;

            case 'color':
                if (!client.user) {
                    this.sendTo(ws, { type: 'system', message: 'You must be logged in to change color.' });
                } else if (!args || !/^#[0-9a-fA-F]{6}$/.test(args)) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /color #ff00ff (hex color code)' });
                } else {
                    db.run('UPDATE users SET profile_color = ? WHERE id = ?', [args, client.user.id]);
                    client.user.profile_color = args;
                    this.sendTo(ws, { type: 'system', message: `Color set to ${args}` });
                }
                break;

            case 'viewers': {
                const count = this.getStreamViewerCount(client.streamId);
                this.sendTo(ws, { type: 'system', message: `${count} viewer(s) in chat` });
                break;
            }

            case 'uptime': {
                if (!client.streamId) {
                    this.sendTo(ws, { type: 'system', message: 'Not in a stream chat.' });
                    break;
                }
                try {
                    const stream = db.getStreamById(client.streamId);
                    if (stream && stream.started_at) {
                        const start = new Date(stream.started_at.replace(' ', 'T') + 'Z').getTime();
                        const elapsed = Date.now() - start;
                        const hours = Math.floor(elapsed / 3600000);
                        const minutes = Math.floor((elapsed % 3600000) / 60000);
                        const seconds = Math.floor((elapsed % 60000) / 1000);
                        const parts = [];
                        if (hours > 0) parts.push(`${hours}h`);
                        parts.push(`${minutes}m`);
                        parts.push(`${seconds}s`);
                        this.sendTo(ws, { type: 'system', message: `Stream uptime: ${parts.join(' ')}` });
                    } else {
                        this.sendTo(ws, { type: 'system', message: 'Stream is offline.' });
                    }
                } catch {
                    this.sendTo(ws, { type: 'system', message: 'Could not determine uptime.' });
                }
                break;
            }

            case 'w':
            case 'whisper':
            case 'msg': {
                this.sendTo(ws, { type: 'system', message: 'Whispers have been replaced by DMs! Click the message icon in the navbar to open Messenger.' });
                break;
            }

            case 'me': {
                if (!args) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /me <action>' });
                    break;
                }
                const username = client.user?.display_name || client.anonId;
                this.broadcastToStream(client.streamId, {
                    type: 'chat',
                    username,
                    core_username: client.user?.username || null,
                    role: client.user?.role || 'anon',
                    message: `* ${username} ${args}`,
                    is_action: true,
                    timestamp: new Date().toISOString(),
                });
                break;
            }

            case 'ban':
                this.handleModAction(ws, client, 'ban', args);
                break;

            case 'unban':
                this.handleModAction(ws, client, 'unban', args);
                break;

            case 'timeout':
                this.handleModAction(ws, client, 'timeout', args);
                break;

            case 'clear':
                if (this.canModerate(client)) {
                    this.broadcastToStream(client.streamId, { type: 'clear' });
                    this.logChatModeration(client, client.streamId ? 'clear_chat' : 'clear_global_chat');
                } else {
                    this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
                }
                break;

            case 'slow': {
                if (this.canModerate(client)) {
                    let seconds;
                    if (args === 'off' || args === 'disable' || args === '0') {
                        seconds = 0;
                    } else {
                        seconds = parseInt(args);
                        if (!Number.isFinite(seconds) || seconds < 0) seconds = 3;
                    }
                    // Per-stream slow mode (not global)
                    if (client.streamId) {
                        this.slowModeByStream.set(client.streamId, seconds > 0 ? seconds * 1000 : 0);
                        // Persist to DB
                        try {
                            const stream = db.getStreamById(client.streamId);
                            if (stream?.channel_id) {
                                db.upsertChannelModerationSettings(stream.channel_id, { slow_mode_seconds: seconds });
                            }
                        } catch { /* non-critical */ }
                    }
                    // Dedicated slowmode event so clients can show/hide UI
                    this.broadcastToStream(client.streamId, {
                        type: 'slowmode',
                        seconds,
                    });
                    const msg = seconds > 0
                        ? `Slow mode enabled: ${seconds}s between messages`
                        : 'Slow mode disabled.';
                    this.broadcastToStream(client.streamId, {
                        type: 'system',
                        message: msg,
                    });
                    this.logChatModeration(client, 'slowmode_update', { seconds });
                } else {
                    this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
                }
                break;
            }

            case 'paste': {
                // /paste <content> — create a quick paste from chat
                if (!args.trim()) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /paste <content to share>' });
                    break;
                }
                {
                    const title = `Chat paste by ${client.username || client.displayName || 'anon'}`;
                    const userId = client.userId || client.user?.id || null;
                    // Pastes live in OpenVibe.Media now — post through the media client.
                    require('../media-client').createPaste({
                        title,
                        content: args.trim(),
                        language: 'auto',
                        visibility: 'public',
                        user_id: userId || undefined,
                        stream_id: client.streamId || undefined,
                    }).then((paste) => {
                        const siteUrl = process.env.SITE_URL || '';
                        const pasteUrl = `${siteUrl}/p/${paste.slug}`;
                        // Show link to everyone in stream
                        this.broadcastToStream(client.streamId, {
                            type: 'system',
                            message: `📋 ${client.displayName || client.username || 'Anonymous'} shared a paste: ${pasteUrl}`,
                        });
                    }).catch((err) => {
                        console.error('[Chat] /paste error:', err.message);
                        this.sendTo(ws, { type: 'system', message: 'Failed to create paste.' });
                    });
                }
                break;
            }

            default:
                this.sendTo(ws, { type: 'system', message: `Unknown command: /${cmd}. Type /help for a list.` });
        }
    }

    /**
     * Handle mod actions (ban, unban, timeout)
     */
    handleModAction(ws, client, action, args) {
        if (!this.canModerate(client)) {
            this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
            return;
        }

        const target = args.split(' ')[0];
        if (!target) return;

        switch (action) {
            case 'ban': {
                const targetUser = db.getUserByUsername(target);
                if (targetUser) {
                    // Prevent non-admins from banning admins
                    if (permissions.isGlobalModOrAbove(targetUser) && targetUser.role === 'admin' && client.user.role !== 'admin') {
                        this.sendTo(ws, { type: 'system', message: 'You cannot ban an admin.' });
                        return;
                    }
                    db.run(
                        `INSERT INTO bans (stream_id, user_id, reason, banned_by) VALUES (?, ?, ?, ?)`,
                        [client.streamId, targetUser.id, 'Banned by moderator', client.user.id]
                    );
                    this.sendTo(ws, { type: 'system', message: `${target} has been banned.` });
                    this.broadcastToStream(client.streamId, {
                        type: 'system', message: `${target} has been banned.`
                    });
                    this.logChatModeration(client, client.streamId ? 'channel_ban' : 'site_ban', { username: targetUser.username }, targetUser.id);
                } else {
                    // Ban by anon ID
                    const anonTarget = this.findClientByAnonId(target, client.streamId);
                    if (anonTarget) {
                        db.run(
                            `INSERT INTO bans (stream_id, ip_address, anon_id, reason, banned_by) VALUES (?, ?, ?, ?, ?)`,
                            [client.streamId, anonTarget.ip, target, 'Banned by moderator', client.user.id]
                        );
                        this.sendTo(ws, { type: 'system', message: `${target} has been banned.` });
                    }
                    this.logChatModeration(client, client.streamId ? 'channel_anon_ban' : 'site_anon_ban', { anon_id: target });
                }
                break;
            }
            case 'timeout': {
                const duration = parseInt(args.split(' ')[1]) || 300; // Default 5 min
                const targetUser = db.getUserByUsername(target);
                const expires = new Date(Date.now() + duration * 1000).toISOString();
                if (targetUser) {
                    db.run(
                        `INSERT INTO bans (stream_id, user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
                        [client.streamId, targetUser.id, `Timeout ${duration}s`, client.user.id, expires]
                    );
                    this.logChatModeration(client, client.streamId ? 'channel_timeout' : 'site_timeout', { username: targetUser.username, duration }, targetUser.id);
                }
                this.sendTo(ws, { type: 'system', message: `${target} timed out for ${duration}s.` });
                break;
            }
            case 'unban': {
                const targetUser = db.getUserByUsername(target);
                if (targetUser) {
                    db.run('DELETE FROM bans WHERE user_id = ? AND (stream_id = ? OR stream_id IS NULL)',
                        [targetUser.id, client.streamId]);
                    this.logChatModeration(client, client.streamId ? 'channel_unban' : 'site_unban', { username: targetUser.username }, targetUser.id);
                }
                this.sendTo(ws, { type: 'system', message: `${target} has been unbanned.` });
                break;
            }
        }
    }

    // ── Helper methods ───────────────────────────────────────
    /**
     * Synthesize TTS audio for a chat message and broadcast to stream.
     * Runs asynchronously — does not block message delivery.
     */
    // Is the channel owner connected to their OWN channel room right now? Gates
    // offline-channel TTS synthesis so we never pay for audio nobody will hear.
    _channelOwnerInRoom(channelUserId) {
        if (!channelUserId) return false;
        for (const [ws, client] of this.clients) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            if (client.user && Number(client.user.id) === Number(channelUserId)
                && Number(client.channelUserId) === Number(channelUserId)) return true;
        }
        return false;
    }

    // TTS audio delivery: to the stream room while live, to the CHANNEL room for
    // offline channel chat (streamId null).
    _broadcastTtsPayload(streamId, channelUserId, payload) {
        if (streamId) this.broadcastToStream(streamId, payload);
        else if (channelUserId) this.broadcastToChannelRoom(channelUserId, null, payload);
    }

    // streamId may be null for OFFLINE channel chat — pass channelUserId instead and
    // the audio is delivered to the channel room rather than a stream room.
    async synthesizeAndBroadcastTTS(streamId, username, text, voiceFX, sourcePlatform = null, identityKey = null, channelUserId = null) {
        // Queue accounting key: per-stream when live, per-channel when offline.
        const queueKey = streamId || (channelUserId ? `ch:${channelUserId}` : null);
        try {
            // "." prefix = user opted this message out of TTS — never synthesize or broadcast it.
            if (String(text || '').trimStart().startsWith('.')) return;

            const settings = ttsEngine.getTTSSettings();
            if (!settings.enabled) return;

            // Queue limit checks
            const limits = ttsEngine.getQueueLimits();
            const globalCount = this.ttsQueueSize.get(queueKey) || 0;
            if (globalCount >= limits.maxGlobal) return;

            // Determine voice ID from equipped cosmetic
            let voiceId = null;
            if (voiceFX?.itemId && ttsEngine.VOICE_CATALOG[voiceFX.itemId]) {
                voiceId = voiceFX.itemId;
            }

            // Increment queue counter
            this.ttsQueueSize.set(queueKey, globalCount + 1);

            // Honor the channel's configured TTS length (streamers can raise it up to 1200);
            // falls back to the site default when unset. Without this the server synth always
            // truncated at the global 200 even when the channel allowed more.
            let ttsMaxOverride;
            try { ttsMaxOverride = Number(this._getChannelChatSettings(streamId).tts_max_length) || undefined; } catch { /* use engine default */ }

            let result;
            if (!voiceId && settings.perUserVoices) {
                // No equipped cosmetic voice → give this chatter a stable per-username voice.
                const idKey = identityKey || username || 'anon';
                result = await ttsEngine.synthesizeUserVoice(text, idKey, username, ttsMaxOverride);
            } else {
                result = await ttsEngine.synthesize(text, voiceId || settings.defaultVoice, username, ttsMaxOverride);
            }

            // Decrement queue counter
            const current = this.ttsQueueSize.get(queueKey) || 1;
            this.ttsQueueSize.set(queueKey, Math.max(0, current - 1));

            if (!result) return;

            // Broadcast TTS audio to all clients in the stream
            this._broadcastTtsPayload(streamId, channelUserId, {
                type: 'tts-audio',
                username,
                // Stable sender identity ("user:<login>" / "anon:<id>") so clients can
                // skip their OWN message's TTS locally — senders were hearing their
                // message twice (their tab + the stream audio).
                sender_key: identityKey || undefined,
                message: text,
                audio: result.audio,
                mimeType: result.mimeType,
                engine: result.engine,
                voiceName: result.voiceName,
                voiceId: result.voiceId,
                fallback: result.fallback || false,
                source_platform: sourcePlatform || undefined,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            // Ensure queue counter is decremented on error
            const current = this.ttsQueueSize.get(queueKey) || 1;
            this.ttsQueueSize.set(queueKey, Math.max(0, current - 1));
            console.error('[TTS] Synthesis broadcast error:', err.message);
        }
    }

    /**
     * Process a chat message for 101soundboards links or !sb commands.
     * Fetches the audio, caches it, and broadcasts to stream clients.
     */
    async processSoundboard(ws, client, text) {
        try {
            if (!soundboard.isConfigured()) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'Soundboard is not configured on this server.' });
                }
                return;
            }

            const streamId = client?.streamId || null;
            if (!streamId) return;

            const chatSettings = this._getChannelChatSettings(streamId);
            if (chatSettings.soundboard_enabled === 0) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'This streamer has disabled 101soundboards in chat.' });
                }
                return;
            }

            const parsed = soundboard.parseSoundboardMessage(text, {
                allowPitch: chatSettings.soundboard_allow_pitch !== 0,
                allowSpeed: chatSettings.soundboard_allow_speed !== 0,
            });
            if (!parsed) return;

            const bannedIds = new Set(soundboard.normalizeBannedIds(chatSettings.soundboard_banned_ids));
            if (bannedIds.has(String(parsed.soundId))) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'That 101soundboards sound is blocked by this streamer.' });
                }
                return;
            }

            const userKey = client.user?.id ? `user:${client.user.id}` : `anon:${client.anonId || client.ip}`;
            const rateKey = `${streamId}:${userKey}`;
            const lastUsedAt = this.soundboardRateLimits.get(rateKey) || 0;
            const now = Date.now();
            if ((now - lastUsedAt) < SOUNDBOARD_RATE_LIMIT_MS) {
                if (String(text || '').trim().startsWith('!sb')) {
                    const remaining = Math.ceil((SOUNDBOARD_RATE_LIMIT_MS - (now - lastUsedAt)) / 1000);
                    this.sendTo(ws, { type: 'system', message: `Wait ${remaining}s before using another soundboard clip.` });
                }
                return;
            }

            // Per-stream global rate limit (15 sounds/min across all users)
            const streamWindow = this.soundboardStreamLimits.get(streamId) || { count: 0, windowStart: now };
            if ((now - streamWindow.windowStart) >= SOUNDBOARD_STREAM_WINDOW_MS) {
                streamWindow.count = 0;
                streamWindow.windowStart = now;
            }
            if (streamWindow.count >= SOUNDBOARD_STREAM_MAX_PER_WINDOW) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'Too many soundboard clips are playing in this stream right now. Try again soon.' });
                }
                return;
            }
            streamWindow.count++;
            this.soundboardStreamLimits.set(streamId, streamWindow);

            const result = await soundboard.getSoundboardAudio(parsed.soundId);
            if (!result) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'Could not load that 101soundboards clip.' });
                }
                return;
            }

            this.soundboardRateLimits.set(rateKey, now);

            const username = client.user?.display_name || client.user?.username || client.anonId || 'anon';
            const coreUsername = client.user?.username || null;
            const role = client.user ? client.user.role : 'anon';

            const sbMsg = {
                type: 'chat',
                username,
                core_username: coreUsername,
                user_id: client.user?.id || null,
                anon_id: client.anonId,
                role,
                stream_id: streamId,
                avatar_url: client.user?.avatar_url || null,
                profile_color: client.user?.profile_color || '#999',
                message_type: 'soundboard',
                message: `played ${result.title}`,
                soundboard: {
                    soundId: result.soundId,
                    title: result.title,
                    sourceUrl: result.sourceUrl,
                    pitch: parsed.pitch,
                    speed: parsed.speed,
                    pitchShift: parsed.pitchShift,
                },
                timestamp: new Date().toISOString(),
            };
            // Persist so the announce survives a reload (rebuilt from metadata).
            try {
                const saved = db.saveChatMessage({
                    stream_id: streamId,
                    user_id: client.user?.id,
                    anon_id: client.anonId,
                    username,
                    message: sbMsg.message,
                    message_type: 'soundboard',
                    is_global: false,
                    metadata: { soundboard: sbMsg.soundboard },
                });
                if (saved.lastInsertRowid) sbMsg.id = Number(saved.lastInsertRowid);
            } catch { /* non-critical */ }
            this.broadcastToStream(streamId, sbMsg);

            this.broadcastToStream(streamId, {
                type: 'soundboard-audio',
                username,
                audio: result.audio,
                mimeType: result.mimeType,
                soundId: result.soundId,
                title: result.title,
                sourceUrl: result.sourceUrl,
                pitch: parsed.pitch,
                speed: parsed.speed,
                pitchShift: parsed.pitchShift,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            if (String(text || '').trim().startsWith('!sb')) {
                this.sendTo(ws, { type: 'system', message: err.message || 'Could not load that 101soundboards clip.' });
            }
            console.error('[Soundboard] Process error:', err.message);
        }
    }

    /**
     * Can this client moderate their current stream's chat?
     * Uses the permission layer: admin, global_mod, stream owner, or channel mod.
     * Streamers do NOT get mod powers in other people's chats.
     */
    canModerate(client) {
        if (!client.user) return false;
        return permissions.canModerateStream(client.user, client.streamId);
    }

    /** @deprecated Use canModerate(client) — kept temporarily for any external callers */
    isMod(client) {
        return this.canModerate(client);
    }

    findClientByAnonId(anonId, streamId) {
        for (const [, info] of this.clients) {
            if (info.anonId === anonId && info.streamId === streamId) {
                return info;
            }
        }
        return null;
    }

    /**
     * Find the IP address of a connected user by user ID.
     * Returns the IP from their most recent connection, or null if not connected.
     */
    getConnectedUserIp(userId) {
        for (const [, info] of this.clients) {
            if (info.user?.id === userId) return info.ip;
        }
        return null;
    }

    /**
     * Disconnect all WebSocket clients for a given user ID or IP.
     * Used after banning to immediately kick them.
     */
    disconnectUser({ userId, ip, streamId } = {}) {
        for (const [ws, info] of this.clients) {
            const matchUser = userId && info.user?.id === userId;
            const matchIp = ip && info.ip === ip;
            const matchStream = streamId ? info.streamId === streamId : true;
            if ((matchUser || matchIp) && matchStream) {
                this.sendTo(ws, { type: 'system', message: 'You have been banned.' });
                try { ws.close(1000, 'banned'); } catch {}
            }
        }
    }

    findWsByUsername(name, streamId) {
        const nameLower = name.toLowerCase();
        for (const [ws, info] of this.clients) {
            if (info.streamId !== streamId) continue;
            const uname = info.user?.display_name || info.user?.username || info.anonId;
            if (uname && uname.toLowerCase() === nameLower) return ws;
        }
        return null;
    }

    sendTo(ws, data) {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
            ws.send(JSON.stringify(data));
        }
    }

    broadcastToStream(streamId, data) {
        const msg = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (client.streamId === streamId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(msg);
            }
        }
    }

    /**
     * Deliver to a streamer's whole channel room: any client in that streamer's
     * channel (`channelUserId`, stable across slots + offline) OR in the specific
     * live-session stream room (`streamId`, for backward-compat with clients that
     * joined before channel rooms existed). Deduped per connection.
     */
    broadcastToChannelRoom(channelUserId, streamId, data) {
        const msg = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_SEND_BACKPRESSURE) continue;
            const inChannel = channelUserId && client.channelUserId === channelUserId;
            const inStream = streamId && client.streamId === streamId;
            if (inChannel || inStream) ws.send(msg);
        }
    }

    /**
     * Forward an OFFLINE channel message to the homepage global feed, tagged with
     * the channel username (parallels forwardToGlobal but keyed by user id since
     * there's no live session id to resolve).
     */
    forwardToGlobalByChannel(channelUserId, data) {
        if (!channelUserId) return;
        let username = null;
        try { username = db.getUserById(channelUserId)?.username; } catch { /* ignore */ }
        if (!username) return;
        const globalMsg = JSON.stringify({ ...data, stream_channel: username, source_channel: username });
        for (const [ws, client] of this.clients) {
            if (!client.streamId && !client.channelUserId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(globalMsg);
            }
        }
    }

    broadcastGlobal(data) {
        const msg = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            // Pure global clients only (see forwardToGlobal) — channel/stream viewers get
            // global activity via their dedicated cross-feed socket, not their main one.
            if (!client.streamId && !client.channelUserId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(msg);
            }
        }
    }

    /**
     * Notify everyone watching any of a channel owner's live streams that the
     * channel's emotes/sounds changed, so their chat pickers refresh live
     * (no page reload). No-op when the owner has no live streams / viewers.
     */
    broadcastToOwnerStreams(ownerUserId, data) {
        try {
            const streams = db.getLiveStreamsByUserId(ownerUserId) || [];
            if (!streams.length) return;
            const ids = new Set(streams.map(s => String(s.id)));
            const msg = JSON.stringify(data);
            for (const [ws, client] of this.clients) {
                if (ids.has(String(client.streamId)) && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                    ws.send(msg);
                }
            }
        } catch { /* ignore */ }
    }

    /**
     * Forward a stream message to all global-connected clients
     * so the global chat feed shows activity from every stream.
     */
    forwardToGlobal(streamId, data) {
        // Look up stream owner username + slot title/slug (cached per stream)
        if (!this._streamNameCache) this._streamNameCache = new Map();
        let info = this._streamNameCache.get(streamId);
        if (!info || typeof info !== 'object') {
            try {
                const stream = db.getStreamById(streamId);
                info = {
                    username: stream?.username || `stream-${streamId}`,
                    title: stream?.managed_stream_title || stream?.title || null,
                    slug: stream?.managed_stream_slug || null,
                    managedId: stream?.managed_stream_id || null,
                };
                this._streamNameCache.set(streamId, info);
                // Auto-expire cache after 5 min
                setTimeout(() => this._streamNameCache.delete(streamId), 300000);
            } catch {
                info = { username: `stream-${streamId}`, title: null, slug: null, managedId: null };
            }
        }
        const globalMsg = JSON.stringify({
            ...data,
            stream_channel: info.username,
            source_channel: info.username,
            source_stream_id: streamId,
            source_stream_title: info.title,
            source_slug: info.slug,
            source_managed_id: info.managedId,
            source_is_live: 1, // this path only fires for a live send
        });
        for (const [ws, client] of this.clients) {
            // Only PURE global clients (no stream AND no channel) — otherwise an
            // offline-channel viewer's main socket (streamId null, channelUserId set)
            // would render this via addChatMessage AND get it again as a cross-feed on
            // its dedicated global socket → duplicate. Channel/stream viewers receive the
            // cross-feed exclusively through their separate global-feed connection.
            if (!client.streamId && !client.channelUserId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(globalMsg);
            }
        }
    }

    /**
     * Deliver a stream message to viewers of the SAME streamer's OTHER live slots
     * ("Show All Chats Under This Streamer"). Tagged with source-slot info so the
     * client can show a stream-title badge + let viewers hop between slots. Only
     * fires when the streamer has 2+ live slots.
     */
    forwardToStreamerRooms(streamId, data) {
        try {
            const stream = db.getStreamById(streamId);
            if (!stream || !stream.user_id) return;
            const siblings = db.getLiveStreamsByUserId(stream.user_id) || [];
            if (siblings.length < 2) return;
            const siblingIds = new Set(siblings.map(s => s.id));
            const payload = JSON.stringify({
                ...data,
                cross_stream: true,
                source_stream_id: streamId,
                source_stream_title: stream.managed_stream_title || stream.title || null,
                source_slug: stream.managed_stream_slug || null,
                source_managed_id: stream.managed_stream_id || null,
                source_channel: stream.username || null,
                source_is_live: 1,
            });
            for (const [ws, client] of this.clients) {
                if (client.streamId && client.streamId !== streamId && siblingIds.has(client.streamId)
                    && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                    ws.send(payload);
                }
            }
        } catch { /* non-critical */ }
    }

    _broadcastDeletedMessages(streamId, ids) {
        if (!Array.isArray(ids) || ids.length === 0) return;
        const payload = { type: 'delete-messages', ids };
        if (streamId) {
            this.broadcastToStream(streamId, payload);
            this.forwardToGlobal(streamId, payload);
            return;
        }
        this.broadcastAll(payload);
    }

    _sweepExpiredChatMessages() {
        try {
            const expired = db.deleteExpiredChatMessages(500);
            if (!expired.length) return;
            const byScope = new Map();
            for (const row of expired) {
                const key = row.stream_id ? `stream:${row.stream_id}` : 'global';
                if (!byScope.has(key)) byScope.set(key, []);
                byScope.get(key).push(row.id);
            }
            for (const [key, ids] of byScope.entries()) {
                const streamId = key === 'global' ? null : parseInt(key.split(':')[1], 10);
                this._broadcastDeletedMessages(streamId, ids);
            }
        } catch (err) {
            console.warn('[Chat] Failed to sweep expired auto-delete messages:', err.message);
        }
    }

    broadcastUserCount(streamId) {
        const count = this.getStreamViewerCount(streamId);
        const data = JSON.stringify({ type: 'user-count', count, stream_id: streamId });
        for (const [ws, client] of this.clients) {
            if (client.streamId === streamId && ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        }
        // Persist to DB so the /api/streams endpoint returns real counts
        if (streamId) {
            try { db.updateViewerCount(streamId, count); } catch {}
        }
    }

    /**
     * Record viewer snapshots for all active streams.
     * Called every 60 seconds by the snapshot interval timer.
     */
    _recordViewerSnapshots() {
        // Collect unique active stream IDs
        const streamIds = new Set();
        for (const [, client] of this.clients) {
            if (client.streamId) streamIds.add(client.streamId);
        }
        for (const streamId of streamIds) {
            try {
                const count = this.getStreamViewerCount(streamId);
                const chatActivity = db.getRecentChatActivity(streamId, 5);
                db.insertViewerSnapshot(streamId, count, chatActivity);
            } catch (err) {
                // Non-critical — don't crash the chat server over analytics
            }
        }
    }

    /**
     * Push the current users list to all clients in a stream/global.
     * Throttled to avoid flooding on rapid join/leave bursts.
     */
    broadcastUsersList(streamId) {
        const key = `users-${streamId ?? 'global'}`;
        if (this._usersListTimers?.has(key)) return; // already scheduled
        if (!this._usersListTimers) this._usersListTimers = new Map();
        this._usersListTimers.set(key, setTimeout(() => {
            this._usersListTimers.delete(key);
            const users = this.getUserList(streamId);
            const data = JSON.stringify({ type: 'users-list', users });
            for (const [ws, client] of this.clients) {
                if (client.streamId === streamId && ws.readyState === WebSocket.OPEN) {
                    try { ws.send(data); } catch {}
                }
            }
        }, 500));
    }

    /**
     * Count unique IPs watching a stream (not raw connections).
     * Multiple tabs from the same IP count as one viewer.
     */
    getStreamViewerCount(streamId) {
        const ips = new Set();
        for (const [, client] of this.clients) {
            if (client.streamId === streamId && client.ip) {
                ips.add(client.ip);
            }
        }
        return ips.size;
    }

    getTotalConnections() {
        return this.clients.size;
    }

    /**
     * Send a DM payload to all WebSocket connections belonging to a given user ID.
     * Used by the DM REST API for real-time delivery.
     */
    sendDm(userId, data) {
        const convId = data?.conversation_id;
        if (convId && !dm.isParticipant(convId, userId)) {
            if (DEBUG_DM_DELIVERY) {
                console.warn(`[DM] blocked delivery to user ${userId} for conversation ${convId} (not a participant)`, data.type, data);
            }
            return;
        }
        const payload = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (client.user?.id === userId && ws.readyState === WebSocket.OPEN) {
                if (DEBUG_DM_DELIVERY) {
                    console.debug(`[DM] delivering ${data.type} conversation ${convId} to ws user ${client.user.id} (${client.user.username})`);
                }
                try {
                    if (ws.bufferedAmount < MAX_SEND_BACKPRESSURE) {
                        ws.send(payload);
                    }
                } catch { /* non-critical */ }
            }
        }
    }

    /**
     * Push a profile/identity update to all chat connections belonging to a user.
     * Refreshes cached client.user so subsequent messages use the new info.
     */
    sendUserUpdate(userId, userData) {
        const freshUser = db.getUserById(userId);
        const payload = JSON.stringify({
            type: 'user-updated',
            user: {
                id: userData.id,
                username: userData.username,
                display_name: userData.display_name,
                role: userData.role,
                avatar_url: userData.avatar_url,
                profile_color: userData.profile_color,
            },
        });
        for (const [ws, client] of this.clients) {
            if (client.user?.id === userId && ws.readyState === WebSocket.OPEN) {
                // Refresh cached user object so future messages use new name
                if (freshUser) client.user = freshUser;
                try {
                    if (ws.bufferedAmount < MAX_SEND_BACKPRESSURE) ws.send(payload);
                } catch { /* non-critical */ }
            }
        }
    }

    /**
     * Broadcast a message to ALL connected chat clients (every stream + global).
     * Used for server-wide announcements (restarts, updates).
     */
    broadcastAll(data) {
        const msg = JSON.stringify(data);
        for (const [ws] of this.clients) {
            if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(msg);
            }
        }
    }

    close() {
        if (this.wss) {
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            if (this._snapshotInterval) {
                clearInterval(this._snapshotInterval);
                this._snapshotInterval = null;
            }
            if (this._autoDeleteSweepInterval) {
                clearInterval(this._autoDeleteSweepInterval);
                this._autoDeleteSweepInterval = null;
            }
            this.wss.clients.forEach(ws => ws.close());
            this.wss.close();
        }
    }

    /**
     * Notify the stream owner that a new IP needs approval.
     * Sends a system message only to the streamer's connection.
     */
    _notifyStreamerPendingIp(streamId, streamOwnerId, username, ip) {
        if (!streamOwnerId) return;
        try {
            for (const [ws, client] of this.clients) {
                if (client.user?.id === streamOwnerId && client.streamId === streamId) {
                    this.sendTo(ws, {
                        type: 'system',
                        message: `⏳ New IP needs approval: ${username} (${ip}). Open Dashboard → Moderation to review.`,
                        ip_approval_alert: true,
                    });
                    break;
                }
            }
        } catch { /* non-critical */ }
    }

    /**
     * Get channel moderation settings for a stream.
     * Caches the channel lookup to avoid repeated DB queries.
     */
    _getChannelChatSettings(streamId) {
        const defaults = {
            slow_mode_seconds: 0, followers_only: 0, emote_only: 0,
            allow_anonymous: 1, links_allowed: 1, account_age_gate_hours: 0,
            caps_percentage_limit: 0, aggressive_filter: 0, max_message_length: 500,
            slur_filter_enabled: 0, slur_filter_use_builtin: 1, slur_filter_terms: '', slur_filter_regexes: '', slur_filter_nudge_message: '', slur_filter_disabled_categories: '[]',
            ip_approval_mode: 0,
            gifs_enabled: 1,
            soundboard_enabled: 1,
            soundboard_allow_pitch: 1,
            soundboard_allow_speed: 1,
            soundboard_banned_ids: '',
            viewer_auto_delete_enabled: 1,
            viewer_delete_all_enabled: 1,
            custom_emotes_enabled: 1,
            custom_sounds_enabled: 1,
            max_sound_seconds: 10,
            uploads_mods_only: 0,
            emote_scale: 100,
            sound_min_speed: 0.5,
            sound_max_speed: 3.0,
            sound_min_pitch_cents: -1200,
            sound_max_pitch_cents: 1200,
        };
        // Derive pitch rate bounds from the configured cents (2^(cents/1200)).
        const finalize = (s) => ({
            ...s,
            sound_min_pitch_rate: Math.pow(2, (Number(s.sound_min_pitch_cents) ?? -1200) / 1200),
            sound_max_pitch_rate: Math.pow(2, (Number(s.sound_max_pitch_cents) ?? 1200) / 1200),
        });
        if (!streamId) return finalize(defaults);
        try {
            const stream = db.getStreamById(streamId);
            if (!stream) return finalize(defaults);
            const channel = stream.channel_id ? db.getChannelById(stream.channel_id) : db.getChannelByUserId(stream.user_id);
            if (!channel) return finalize(defaults);
            return finalize({ ...defaults, ...db.getChannelModerationSettings(channel.id) });
        } catch {
            return finalize(defaults);
        }
    }

    /**
     * Log a moderation action from a chat command (/ban, /timeout, /clear, /slowmode).
     * Non-critical — failures are silently ignored.
     */
    logChatModeration(client, actionType, details = {}, targetUserId = null) {
        try {
            const stream = client.streamId ? db.getStreamById(client.streamId) : null;
            const channel = stream?.channel_id
                ? db.getChannelById(stream.channel_id)
                : stream ? db.getChannelByUserId(stream.user_id) : null;
            db.logModerationAction({
                scope_type: channel ? 'channel' : 'site',
                scope_id: channel?.id || undefined,
                actor_user_id: client.user?.id || undefined,
                target_user_id: targetUserId || undefined,
                action_type: actionType,
                details: { stream_id: client.streamId || null, ...details },
            });
        } catch { /* non-critical */ }
    }
}

module.exports = new ChatServer();
