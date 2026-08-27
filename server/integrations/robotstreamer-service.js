const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

const db = require('../db/database');
const chatServer = require('../chat/chat-server');
const { authenticateWs } = require('../auth/auth');

const API_HOST = 'api.robotstreamer.com';
const API_PORT = 443;
const RS_ORIGIN = 'https://robotstreamer.com';

function safeJsonParse(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined) return fallback;
    return value === true || value === 1 || value === '1' || value === 'true';
}

// Minimum interval between RS Publish connections for the same stream (prevents rapid reconnect loops)
const RS_PUBLISH_MIN_INTERVAL_MS = 5000;
// Upstream WebSocket keepalive interval — prevents NAT/firewall idle timeout on the SFU connection
const RS_UPSTREAM_PING_INTERVAL_MS = 25000;
// Skip refreshIntegration() if last validation was within this window (avoids 870KB API call on every reconnect)
const RS_REFRESH_CACHE_MS = 5 * 60 * 1000;

class RobotStreamerService {
    constructor() {
        this.chatBridges = new Map();
        /** streamId -> in-flight startForStream promise (see startForStream). */
        this._startingStreams = new Map();
        /** @type {Map<number, { ws: WebSocket, upstream: WebSocket|null, connectedAt: number }>} streamId → active publish session */
        this._activePublish = new Map();
        /** @type {Map<string, { count: number, fetchedAt: number }>} `userId:slotId` → cached RS viewer count */
        this._rsViewerCounts = new Map();
        this.publishProxy = new WebSocket.Server({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
        this.publishProxy.on('connection', (ws, req, ctx) => this._handlePublishConnection(ws, req, ctx));
        this._startRsViewerPolling();
    }

    /** Extract a robot's live viewer count from a robot_page_load response. */
    _extractRobotViewers(pageData, robotId) {
        for (const owner of pageData?.robots || []) {
            for (const r of owner?.robots || []) {
                if (String(r.robot_id) === String(robotId)) return Number(r.viewers || 0);
            }
        }
        return 0;
    }

    /**
     * Poll RobotStreamer's live viewer count for every active chat-mirror bridge and cache
     * it per-slot. robot_page_load is the only endpoint that returns the count (RS's own
     * client polls it on a 30–60s cadence), so we mirror that here.
     */
    _startRsViewerPolling() {
        if (this._rsViewerPollTimer) return;
        this._rsViewerPollTimer = setInterval(async () => {
            for (const [, bridge] of this.chatBridges) {
                if (bridge.stopped || !bridge.token || !bridge.robotId) continue;
                try {
                    const pageData = await this.robotPageLoad(bridge.token, bridge.robotId);
                    const viewers = this._extractRobotViewers(pageData, bridge.robotId);
                    this.setRsViewerCount(bridge.userId, viewers, bridge.managedStreamId || null);
                } catch { /* transient — keep the last cached value */ }
            }
        }, 45000);
        if (this._rsViewerPollTimer.unref) this._rsViewerPollTimer.unref();
    }

    /**
     * Sync a OpenVibe.Live stream title to the RobotStreamer robot's name. Best-effort and
     * non-blocking: fetches the account's current settings, changes only the target robot's
     * robot_name, and echoes everything else back to /v2/set_user_settings (RS's save takes
     * the whole account payload + robots-as-objects; omitting a robot would delete it).
     */
    async syncRobotName(integration, newTitle) {
        try {
            const token = integration?.token;
            const robotId = integration?.robot_id;
            // owner_name may be blank if the integration was set up by pasting a token —
            // fall back to the user_name embedded in the JWT.
            const userName = integration?.owner_name || this.decodeToken(token)?.user_name;
            const title = String(newTitle || '').trim();
            if (!token || !robotId || !userName || !title) return false;

            const settings = await this._rsApiPost('/v1/get_user_settings', { user_name: userName, token });
            if (!settings || (settings.status && settings.status !== 'ok' && settings.status !== true)) return false;

            const robots = (settings.robots || [])
                .map(r => (typeof r === 'string' ? safeJsonParse(r, null) : r))
                .filter(Boolean);
            if (!robots.some(r => String(r.robot_id) === String(robotId))) return false;   // robot not on this account

            const sendRobots = robots.map(r => ({
                robot_id: r.robot_id,
                robot_name: String(r.robot_id) === String(robotId) ? title : r.robot_name,
                robot_desc: r.robot_desc || '',
                tts_price: r.tts_price != null ? r.tts_price : '0',
                pip_camera_id: r.pip_camera_id || '',
                control_filter: r.control_filter || 'all',
                control_enabled: r.control_enabled != null ? r.control_enabled : 'true',
                panels: (typeof r.panels === 'string' ? safeJsonParse(r.panels, r.panels) : r.panels) || [],
                robot_delete: false,
            }));

            // Build the EXACT body /v2/set_user_settings expects. get_user_settings uses
            // DIFFERENT field names for some values (chat_filter_type → filter_type_chat,
            // chat_filter_enabled → filter_enable), so spreading it verbatim breaks the save.
            const body = {
                user_name: userName,
                token,
                email: settings.email || '',
                avatar: settings.avatar || '',
                over18: !!settings.over18,
                nsfw_broadcaster: !!settings.nsfw_broadcaster,
                stream_key: settings.stream_key || '',
                filter_type_chat: settings.chat_filter_type || 'all',
                filter_enable: !!settings.chat_filter_enabled,
                chat_ip_throttling: !!settings.chat_ip_throttling,
                record_streams: settings.record_streams !== false,
                clip_streams: settings.clip_streams !== false,
                chat_filter_words: Array.isArray(settings.chat_filter_words) ? settings.chat_filter_words : [''],
                chat_limit: String(settings.chat_limit || '500'),
                subscription_icon: settings.subscription_icon || '',
                viewer_tags_enabled: settings.viewer_tags_enabled !== false,
                robots: sendRobots,
            };

            const res = await this._rsApiPost('/v2/set_user_settings', body);
            // RS returns status:true on save even when a non-blocking field warning (e.g. an
            // empty stream_key) is present in the error array. A title error would name field
            // "robot_name". Treat status:true as success unless the error array flags robots.
            const errs = Array.isArray(res?.error) ? res.error : [];
            const robotErr = errs.some(e => /robot|name/i.test(e?.field || '') || /robot|name/i.test(e?.error || ''));
            const ok = !!res && (res.status === true || res.status === 'ok') && !robotErr;
            if (!ok) console.warn('[RS] Title sync not confirmed:', JSON.stringify(res?.error || res?.status_readable || res || ''));
            return ok;
        } catch (err) {
            console.warn('[RS] Title sync failed:', err.message);
            return false;
        }
    }

    /**
     * Cache a RobotStreamer viewer count for a user's stream slot.
     * Called from the validate endpoint when the broadcaster polls. Keyed per slot so
     * a channel's two RS robots (one per slot) don't share a single count.
     */
    setRsViewerCount(userId, count, managedStreamId = null) {
        this._rsViewerCounts.set(`${userId}:${managedStreamId || 0}`, { count: Number(count) || 0, fetchedAt: Date.now() });
    }

    /**
     * Get cached RS viewer count for a user's stream slot.
     * Returns count if fresh (<120s), otherwise 0.
     */
    getRsViewerCount(userId, managedStreamId = null) {
        const cached = this._rsViewerCounts.get(`${userId}:${managedStreamId || 0}`);
        if (!cached || Date.now() - cached.fetchedAt > 120000) return 0;
        return cached.count;
    }

    sanitizeIntegration(row, extras = {}) {
        if (!row) {
            return {
                enabled: false,
                mirror_chat: true,
                has_token: false,
                robot_id: '',
                owner_id: '',
                chat_url: '',
                control_url: '',
                rtc_sfu_url: '',
                stream_name: '',
                owner_name: '',
                last_validated_at: null,
                managed_stream_id: null,
                available_robots: [],
                ...extras,
            };
        }

        return {
            enabled: !!row.enabled,
            mirror_chat: row.mirror_chat !== 0,
            has_token: !!row.token,
            managed_stream_id: row.managed_stream_id || null,
            robot_id: row.robot_id || '',
            owner_id: row.owner_id || '',
            chat_url: row.chat_url || '',
            control_url: row.control_url || '',
            rtc_sfu_url: row.rtc_sfu_url || '',
            stream_name: row.stream_name || '',
            owner_name: row.owner_name || '',
            last_validated_at: row.last_validated_at || null,
            available_robots: extras.available_robots || [],
            passthrough: this._passthroughEnabledFor(row),
        };
    }

    /**
     * Is the RAW passthrough relay active for this integration's robot?
     * Passthrough is now the ONLY restream method and is on by default whenever the relay
     * is available; RS_PASSTHROUGH=0 is an emergency kill-switch only.
     */
    _passthroughEnabledFor(integration) {
        try {
            const cfg = require('../config').robotstreamer || {};
            if (cfg.passthrough === false) return false;   // explicit kill-switch
            return require('./rs-passthrough-relay').available();
        } catch { return false; }
    }

    getClientIntegration(userId) {
        return this.sanitizeIntegration(db.getRobotStreamerIntegrationByUserId(userId));
    }

    /**
     * Resolve the effective integration for a stream: the slot-specific row
     * (matching the stream's managed_stream_id) wins, otherwise the
     * account-level default row is used.
     */
    getIntegrationForStream(stream) {
        if (!stream?.user_id) return null;
        return db.getRobotStreamerIntegrationForStream(stream.user_id, stream.managed_stream_id || null);
    }

    normalizeRobotInput(input) {
        const raw = String(input || '').trim();
        if (!raw) return '';

        const urlMatch = raw.match(/robot\/(\d+)/i);
        if (urlMatch) return urlMatch[1];

        const idMatch = raw.match(/^(\d{1,12})$/);
        if (idMatch) return idMatch[1];

        return raw.replace(/[^0-9]/g, '');
    }

    decodeToken(token) {
        const parts = String(token || '').split('.');
        if (parts.length < 2) return null;
        try {
            const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
            return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
        } catch {
            return null;
        }
    }

    extractAvailableRobots(pageData) {
        const robots = [];
        const seen = new Set();
        for (const owner of pageData?.robots || []) {
            for (const robot of owner?.robots || []) {
                const robotId = String(robot.robot_id || '').trim();
                if (!robotId || seen.has(robotId)) continue;
                seen.add(robotId);
                robots.push({
                    robot_id: robotId,
                    robot_name: robot.robot_name || `Robot ${robotId}`,
                    status: robot.status || 'offline',
                    viewers: Number(robot.viewers || 0),
                });
            }
        }
        return robots;
    }

    parseEndpoints(pageData) {
        const endpoints = {};
        if (pageData?.chat_service) {
            endpoints.chat_url = `wss://${pageData.chat_service.host}:${pageData.chat_service.port}/`;
        } else if (pageData?.chat_ssl) {
            endpoints.chat_url = `wss://${pageData.chat_ssl.host}:${pageData.chat_ssl.port}/`;
        }
        if (pageData?.control_service) {
            endpoints.control_url = `wss://${pageData.control_service.host}:${pageData.control_service.port}/echo`;
        }
        if (pageData?.rtc_sfu) {
            endpoints.rtc_sfu_url = `wss://${pageData.rtc_sfu.host}:${pageData.rtc_sfu.port}/`;
        }
        return endpoints;
    }

    async robotPageLoad(token, robotId) {
        const body = JSON.stringify({
            token,
            robot_id: robotId,
            referrer: `${RS_ORIGIN}/robot/${robotId}`,
        });

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: API_HOST,
                port: API_PORT,
                path: '/v1/robot_page_load',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Origin': RS_ORIGIN,
                    'Referer': `${RS_ORIGIN}/`,
                },
                timeout: 15000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`RobotStreamer API returned ${res.statusCode}`));
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error(`RobotStreamer API parse error: ${err.message}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy(new Error('RobotStreamer API timed out'));
            });
            req.write(body);
            req.end();
        });
    }

    /**
     * Minimal JSON POST to the RobotStreamer API. RobotStreamer's auth model passes
     * the token inside the JSON body (no Authorization header), so this is reused by
     * login/get_user_settings the same way robotPageLoad works.
     */
    async _rsApiPost(apiPath, payload) {
        const body = JSON.stringify(payload);
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: API_HOST,
                port: API_PORT,
                path: apiPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Origin': RS_ORIGIN,
                    'Referer': `${RS_ORIGIN}/`,
                },
                timeout: 15000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`RobotStreamer API returned ${res.statusCode}`));
                    }
                    try { resolve(JSON.parse(data)); }
                    catch (err) { reject(new Error(`RobotStreamer API parse error: ${err.message}`)); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('RobotStreamer API timed out')));
            req.write(body);
            req.end();
        });
    }

    /**
     * Log in to RobotStreamer with username + password and return the account token
     * plus the user's robots. The password is used ONLY for this request and is never
     * stored. (Each robot's OBS RTMP key is `<robot_id>?key=<stream_key>`.)
     */
    async loginWithCredentials(userName, password) {
        const name = String(userName || '').trim();
        const pass = String(password || '');
        if (!name || !pass) throw new Error('RobotStreamer username and password are required');

        const login = await this._rsApiPost('/v1/login', { user_name: name, password: pass });
        if (!login || login.status !== 'ok' || !login.token) {
            throw new Error('RobotStreamer login failed — check your username and password (RobotStreamer requires a verified email).');
        }
        const token = String(login.token);
        const resolvedName = login.user_name || name;

        let streamKey = '';
        const robots = [];
        try {
            const settings = await this._rsApiPost('/v1/get_user_settings', { user_name: resolvedName, token });
            streamKey = String(settings?.stream_key || '');
            for (const raw of (settings?.robots || [])) {
                const robot = typeof raw === 'string' ? safeJsonParse(raw, null) : raw;
                if (!robot || robot.robot_id === undefined || robot.robot_id === null) continue;
                robots.push({
                    robot_id: String(robot.robot_id),
                    robot_name: robot.robot_name || `Robot ${robot.robot_id}`,
                    video_type: robot.video_type || '',
                    status: 'offline',
                    viewers: 0,
                });
            }
        } catch (err) {
            // Non-fatal: the token is still valid even if the settings lookup hiccups.
            console.warn('[RobotStreamer] get_user_settings failed:', err.message);
        }

        return {
            token,
            user_name: resolvedName,
            user_id: login.user_id != null ? String(login.user_id) : '',
            stream_key: streamKey,
            robots,
        };
    }

    async validateConfiguration({ token, robotInput }) {
        const resolvedToken = String(token || '').trim();
        const robotId = this.normalizeRobotInput(robotInput);
        if (!resolvedToken) throw new Error('RobotStreamer token is required');
        if (!robotId) throw new Error('RobotStreamer robot ID or stream URL is required');

        const pageData = await this.robotPageLoad(resolvedToken, robotId);
        const tokenPayload = this.decodeToken(resolvedToken) || {};
        const endpoints = this.parseEndpoints(pageData);
        const titleData = pageData?.title_data || {};

        return {
            fields: {
                token: resolvedToken,
                robot_id: robotId,
                owner_id: String(titleData.owner_id || tokenPayload.user_id || '').trim(),
                stream_name: titleData.robot_name || '',
                owner_name: titleData.owner_name || tokenPayload.user_name || '',
                chat_url: endpoints.chat_url || '',
                control_url: endpoints.control_url || '',
                rtc_sfu_url: endpoints.rtc_sfu_url || '',
                last_validated_at: new Date().toISOString(),
            },
            availableRobots: this.extractAvailableRobots(pageData),
        };
    }

    async upsertIntegration(userId, payload = {}, managedStreamId = null) {
        const slotId = managedStreamId || null;
        const existing = slotId
            ? db.getRobotStreamerIntegrationBySlot(userId, slotId)
            : db.getRobotStreamerIntegrationByUserId(userId);
        // When creating a slot-specific config, allow token/robot to fall back to
        // the account-level default row so users don't have to re-paste the token
        // for every slot.
        const fallback = existing || (slotId ? db.getRobotStreamerIntegrationByUserId(userId) : null);
        const updates = {
            enabled: normalizeBoolean(payload.enabled, existing ? !!existing.enabled : false) ? 1 : 0,
            mirror_chat: normalizeBoolean(payload.mirror_chat, existing ? existing.mirror_chat !== 0 : true) ? 1 : 0,
        };

        const providedToken = typeof payload.token === 'string' ? payload.token.trim() : '';
        const providedRobot = this.normalizeRobotInput(payload.robot_input || payload.robot_id || '');
        const needsValidation = !!providedToken
            || !!providedRobot
            || (!existing && updates.enabled)
            || (!!updates.enabled && (!existing?.token || !existing?.robot_id));

        let availableRobots = [];
        if (needsValidation) {
            const validated = await this.validateConfiguration({
                token: providedToken || fallback?.token,
                robotInput: providedRobot || fallback?.robot_id,
            });
            Object.assign(updates, validated.fields);
            availableRobots = validated.availableRobots;
        } else if (!existing && fallback) {
            // Creating a slot row without re-validating — copy config from the default row
            updates.token = fallback.token;
            updates.robot_id = fallback.robot_id;
            updates.owner_id = fallback.owner_id;
            updates.chat_url = fallback.chat_url;
            updates.control_url = fallback.control_url;
            updates.rtc_sfu_url = fallback.rtc_sfu_url;
            updates.stream_name = fallback.stream_name;
            updates.owner_name = fallback.owner_name;
            updates.last_validated_at = fallback.last_validated_at;
        }

        const row = db.upsertRobotStreamerIntegration(userId, updates, slotId);
        return {
            row,
            integration: this.sanitizeIntegration(row, { available_robots: availableRobots }),
        };
    }

    async refreshIntegration(userId, managedStreamId = null) {
        const slotId = managedStreamId || null;
        const existing = slotId
            ? db.getRobotStreamerIntegrationBySlot(userId, slotId)
            : db.getRobotStreamerIntegrationByUserId(userId);
        if (!existing?.token || !existing?.robot_id) return existing;
        const validated = await this.validateConfiguration({ token: existing.token, robotInput: existing.robot_id });
        return db.upsertRobotStreamerIntegration(userId, {
            ...validated.fields,
            enabled: existing.enabled,
            mirror_chat: existing.mirror_chat,
        }, slotId);
    }

    /**
     * Start the native (server-side) RS video publisher for streams whose
     * ingest has no browser publisher: WHIP/OBS and RTMP. Browser broadcasts
     * publish to RS from the client via /ws/robotstreamer-publish instead.
     */
    _maybeStartNativePublish(stream, integration, opts = {}) {
        try {
            if (!integration?.enabled || !integration.token || !integration.robot_id) return;
            if (this._activePublish.has(stream.id)) return; // browser publisher already connected
            const rsNativePublisher = require('./rs-native-publisher');
            if (rsNativePublisher.isActive(stream.id)) return;

            // Determine the real ingest. When the caller KNOWS the ingest (e.g. we
            // were triggered from the WHIP ICE-connected handler), trust that over
            // the configured managed_stream.streaming_method — which can be stale
            // or misconfigured ('browser') even though OBS is pushing via WHIP.
            const db2 = require('../db/database');
            const ms = stream.managed_stream_id ? db2.getManagedStreamById(stream.managed_stream_id) : null;
            let method = ms?.streaming_method || 'browser';
            if (opts.ingest === 'whip' || opts.ingest === 'rtmp') method = opts.ingest;
            if (method !== 'whip' && method !== 'rtmp') {
                console.log(`[RS] Native publish skipped for stream ${stream.id}: method='${method}' (no browserless ingest)`);
                return;
            }

            console.log(`[RS] Starting native video publish for stream ${stream.id} (ingest=${method}, robot=${integration.robot_id})`);
            rsNativePublisher.start(stream, integration);
        } catch (err) {
            console.warn(`[RS] Native publish start failed for stream ${stream.id}:`, err.message);
        }
    }

    /**
     * Idempotent per stream, including while a previous call is still in flight.
     *
     * Four different lifecycle hooks call this — stream creation, the WHIP ingest going
     * live, the boot-time restore sweep, and the integrations route — and several of them
     * fire within milliseconds of each other for the same stream. startForStream is async
     * and awaits refreshIntegration() between checking chatBridges and populating it, so
     * every concurrent caller used to sail past the "already have a bridge" guard, open
     * its own websocket to RobotStreamer, and then have chatBridges.set() overwrite the
     * previous entry. Only the last bridge was tracked; the earlier ones stayed connected
     * and kept mirroring, so viewers saw each RS chat message repeated once per racing
     * caller. Sharing one in-flight promise makes the guard actually hold.
     */
    async startForStream(stream, opts = {}) {
        if (!stream?.id || !stream?.user_id) return;
        const inflight = this._startingStreams.get(stream.id);
        if (inflight) return inflight;
        const p = this._startForStream(stream, opts).finally(() => {
            if (this._startingStreams.get(stream.id) === p) this._startingStreams.delete(stream.id);
        });
        this._startingStreams.set(stream.id, p);
        return p;
    }

    async _startForStream(stream, opts = {}) {
        if (!stream?.id || !stream?.user_id) return;

        let integration = this.getIntegrationForStream(stream);
        if (!integration?.enabled || !integration.token || !integration.robot_id) {
            return null;
        }

        // RAW passthrough relay (zero re-encode) is the ONLY restream path now: the server
        // forwards the source's already-encoded RTP straight to RobotStreamer, replacing both
        // the browser's second encode and the old ffmpeg transcode publisher.
        if (this._passthroughEnabledFor(integration)) {
            try {
                require('./rs-passthrough-relay').start(stream, integration);
                console.log(`[RS] Raw passthrough relay started for stream ${stream.id} (robot ${integration.robot_id})`);
            } catch (err) {
                console.warn(`[RS] Passthrough relay start failed for stream ${stream.id}:`, err.message);
            }
        } else {
            console.warn(`[RS] Passthrough relay unavailable — RobotStreamer video restream disabled for stream ${stream.id} (chat mirror still active). Install werift or unset RS_PASSTHROUGH=0.`);
        }

        if (integration.mirror_chat === 0) return null;

        const existingBridge = this.chatBridges.get(stream.id);
        if (existingBridge) return existingBridge;

        if (!integration.chat_url) {
            try {
                integration = await this.refreshIntegration(stream.user_id, integration.managed_stream_id || null);
            } catch (err) {
                console.warn(`[RS] Failed refreshing integration for stream ${stream.id}:`, err.message);
                return null;
            }
        }

        const bridge = {
            streamId: stream.id,
            userId: stream.user_id,
            managedStreamId: integration.managed_stream_id || stream.managed_stream_id || null,
            token: integration.token,
            robotId: String(integration.robot_id),
            ownerId: String(integration.owner_id || ''),
            chatUrl: integration.chat_url,
            stopped: false,
            ws: null,
            reconnectDelay: 3000,
            reconnectTimer: null,
        };

        const connect = () => {
            if (bridge.stopped) return;

            bridge.ws = new WebSocket(bridge.chatUrl, {
                headers: { Origin: RS_ORIGIN },
            });

            bridge.ws.on('open', () => {
                bridge.reconnectDelay = 3000;
                bridge.ws.send(JSON.stringify({
                    type: 'connect',
                    message: 'joined',
                    token: bridge.token,
                    robot_id: bridge.robotId,
                    owner_id: bridge.ownerId,
                }));
                chatServer.broadcastToStream(stream.id, {
                    type: 'system',
                    message: 'RobotStreamer chat mirror connected',
                    timestamp: new Date().toISOString(),
                });
            });

            bridge.ws.on('message', (raw) => {
                const data = safeJsonParse(raw.toString());
                if (!data) return;

                if (data.type === 'history' || data.type === 'privileges') return;

                if (data.username === '[RS BOT]') {
                    chatServer.broadcastToStream(stream.id, {
                        type: 'system',
                        message: `[RS BOT] ${data.message}`,
                        timestamp: new Date().toISOString(),
                    });
                    return;
                }

                if (data.message === undefined) return;
                if (data.robot_id && String(data.robot_id) !== bridge.robotId) return;

                const msgText = String(data.message || '');

                // Drop RS protocol/meta messages (e.g. {"user_name":"Goosely"})
                if (/^\s*\{.*\}\s*$/.test(msgText)) return;

                const timestamp = Number.isFinite(Number(data.timestamp))
                    ? new Date(Number(data.timestamp)).toISOString()
                    : new Date().toISOString();
                const rawUsername = String(data.username || 'anon');
                const username = `[RS] ${rawUsername}`;

                // Check if this relay user is hidden/banned
                try {
                    const channel = stream.channel_id
                        ? db.getChannelById(stream.channel_id)
                        : db.getChannelByUserId(stream.user_id);
                    if (channel && db.isRelayUserHidden(channel.id, 'rs', rawUsername)) {
                        return; // Silently drop messages from hidden/banned relay users
                    }
                } catch { /* non-critical — allow message through on error */ }

                // Record this relay user (first message = join date) so RobotStreamer
                // chatters get the same chat logs + AI insight as other relay users.
                try { db.recordRelayUser('rs', rawUsername); } catch { /* non-critical */ }

                // Let RobotStreamer viewers trigger channel !sound commands too. If the
                // message is a registered !sound, play it (attributed to the RS user) and
                // don't also mirror the raw "!cmd" text — same as native chatters.
                const trimmed = msgText.trim();
                if (trimmed.startsWith('!')) {
                    const parts = trimmed.split(/\s+/);
                    const scmd = parts[0].slice(1).toLowerCase();
                    if (scmd && db.getChannelSoundByCommand(stream.user_id, scmd)) {
                        try {
                            chatServer.triggerChannelSound(
                                null,
                                { streamId: stream.id, user: null, anonId: null, ip: null },
                                stream, scmd, parts.slice(1),
                                { username, role: 'external', profile_color: '#7dd3fc', avatar_url: data.avatar || null, sourcePlatform: 'rs' }
                            );
                        } catch { /* non-critical */ }
                        return;
                    }
                }

                const mirrored = {
                    type: 'chat',
                    username,
                    user_id: null,
                    anon_id: null,
                    role: 'external',
                    message: msgText,
                    stream_id: stream.id,
                    is_global: false,
                    avatar_url: data.avatar || null,
                    profile_color: '#7dd3fc',
                    timestamp,
                    source_platform: 'rs',
                };

                try {
                    const result = db.saveChatMessage({
                        stream_id: stream.id,
                        user_id: null,
                        anon_id: null,
                        username,
                        message: mirrored.message,
                        message_type: 'chat',
                        is_global: 0,
                        source_platform: 'rs',
                    });
                    if (result?.lastInsertRowid) mirrored.id = Number(result.lastInsertRowid);
                } catch {}

                chatServer.broadcastToStream(stream.id, mirrored);
                try {
                    require('./ai-chatbot-service').onRealChatMessage(stream.id, {
                        username, message: mirrored.message, userId: null, anonId: null,
                        platform: 'rs', relayUsername: username, isStreamer: false, isMod: false, msgId: mirrored.id || null,
                    });
                } catch { /* non-critical */ }
                // Also surface on the global / username-only overlay (tags stream_channel)
                try { chatServer.forwardToGlobal(stream.id, mirrored); } catch { /* non-critical */ }
                // And to viewers of the streamer's other live slots (cross-slot chat)
                try { chatServer.forwardToStreamerRooms(stream.id, mirrored); } catch { /* non-critical */ }

                // Feed relayed RS chat into server-side TTS (same path as native chat)
                try {
                    chatServer.synthesizeAndBroadcastTTS(stream.id, username, mirrored.message, null, 'rs', `rs:${username}`, null, mirrored.id ? `m${mirrored.id}` : null);
                } catch { /* non-critical */ }

                // ...and into the streamer's PowerChat overlay (relayed chat was never forwarded).
                try {
                    const pc = require('./powerchat-platform');
                    if (stream.user_id && pc.slotRelayEnabled(stream.id)) {
                        pc.forwardChat(stream.user_id, {
                            chatterName: username,
                            externalChatterId: `rs:${username}`,
                            message: mirrored.message,
                            messageId: mirrored.id ? `ov-${mirrored.id}` : undefined,
                            avatarUrl: data.avatar || undefined,
                            // Placeholder letter from the REAL name — "[RS] name"
                            // would otherwise render "[" for every RS chatter.
                            avatarFallback: [...String(rawUsername || '')][0] || undefined,
                        });
                    }
                } catch { /* non-critical */ }
            });

            bridge.ws.on('close', () => {
                if (bridge.stopped) return;
                chatServer.broadcastToStream(stream.id, {
                    type: 'system',
                    message: 'RobotStreamer chat mirror disconnected — retrying',
                    timestamp: new Date().toISOString(),
                });
                clearTimeout(bridge.reconnectTimer);
                bridge.reconnectTimer = setTimeout(connect, bridge.reconnectDelay);
                bridge.reconnectDelay = Math.min(bridge.reconnectDelay * 1.5, 30000);
            });

            bridge.ws.on('error', (err) => {
                console.warn(`[RS] Chat bridge error for stream ${stream.id}:`, err.message);
            });
        };

        bridge.disconnect = () => {
            bridge.stopped = true;
            clearTimeout(bridge.reconnectTimer);
            if (bridge.ws) {
                try { bridge.ws.close(1000); } catch {}
                bridge.ws = null;
            }
        };

        // Last-resort guard: if anything still managed to build a second bridge for this
        // stream, close THIS one rather than overwriting the tracked entry and leaking a
        // websocket that keeps mirroring into the same chat.
        const raced = this.chatBridges.get(stream.id);
        if (raced) {
            console.warn(`[RS] Chat bridge for stream ${stream.id} already exists — discarding the duplicate`);
            try { bridge.disconnect(); } catch { /* never connected */ }
            return raced;
        }

        this.chatBridges.set(stream.id, bridge);
        connect();
        return bridge;
    }

    stopChatBridge(streamId) {
        const bridge = this.chatBridges.get(streamId);
        if (bridge) {
            bridge.disconnect();
            this.chatBridges.delete(streamId);
        }
    }

    stopForStream(streamId) {
        this.stopChatBridge(streamId);
        try { require('./rs-native-publisher').stop(streamId); } catch { /* ignore */ }
        try { require('./rs-passthrough-relay').stop(streamId); } catch { /* ignore */ }
    }

    stopForUserLiveStreams(userId) {
        for (const [streamId, bridge] of this.chatBridges) {
            if (bridge.userId === userId) {
                bridge.disconnect();
                this.chatBridges.delete(streamId);
            }
        }
    }

    handleUpgrade(req, socket, head) {
        if (!req.url.startsWith('/ws/robotstreamer-publish')) return false;

        const params = new URL(req.url, 'http://localhost').searchParams;
        const authToken = params.get('token');
        const streamId = parseInt(params.get('streamId') || '', 10);
        const user = authenticateWs(authToken);
        const stream = Number.isFinite(streamId) ? db.getStreamById(streamId) : null;

        if (!user || !stream || stream.user_id !== user.id) {
            socket.destroy();
            return true;
        }

        const integration = this.getIntegrationForStream(stream);
        if (!integration?.enabled || !integration?.token || !integration?.robot_id) {
            socket.destroy();
            return true;
        }

        // When the server-side raw passthrough relay owns this robot, the browser must NOT
        // also publish (double producer). The client already skips it (see canUse gate), but
        // reject here too so a stale client can't collide with the relay. Ensure the relay runs.
        if (this._passthroughEnabledFor(integration)) {
            try { require('./rs-passthrough-relay').start(stream, integration); } catch { /* */ }
            console.log(`[RS] Rejecting browser publish for stream ${stream.id} — server passthrough owns robot ${integration.robot_id}`);
            socket.destroy();
            return true;
        }

        this.publishProxy.handleUpgrade(req, socket, head, (ws) => {
            this.publishProxy.emit('connection', ws, req, { user, stream, integration });
        });

        return true;
    }


    async _handlePublishConnection(ws, req, ctx) {
        let integration = ctx.integration;
        const streamId = ctx.stream.id;

        // ── Single-connection-per-stream guard ──────────────────────
        // Close any existing publish session for this stream before starting a new one.
        // This prevents multiple overlapping upstream connections to the RS SFU.
        const existing = this._activePublish.get(streamId);
        if (existing) {
            const age = Date.now() - existing.connectedAt;
            console.log(`[RS Publish] Replacing existing session for stream ${streamId} (age: ${age}ms)`);

            // Rate-limit: if the previous connection was created very recently,
            // delay the new one to prevent rapid reconnect loops.
            if (age < RS_PUBLISH_MIN_INTERVAL_MS) {
                const wait = RS_PUBLISH_MIN_INTERVAL_MS - age;
                console.log(`[RS Publish] Rate-limiting new connection — waiting ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
                // Client may have disconnected during the wait
                if (ws.readyState !== WebSocket.OPEN) {
                    console.log('[RS Publish] Client disconnected during rate-limit wait');
                    return;
                }
            }

            try { existing.upstream?.close(1000); } catch {}
            try { existing.ws?.close(1000); } catch {}
            this._activePublish.delete(streamId);
        }

        // Track this connection
        const publishEntry = { ws, upstream: null, connectedAt: Date.now() };
        this._activePublish.set(streamId, publishEntry);

        // ── Buffer client messages IMMEDIATELY ──────────────────────
        // Client sends RPC requests as soon as its WS opens, but we need
        // to do async work (refreshIntegration + upstream WS connect)
        // before we can relay. Buffer everything now, flush later.
        const earlyMessages = [];
        let hasUpstream = false;
        let upstream = null;
        let upstreamReady = false;
        const outboundQueue = [];
        let upstreamPingInterval = null;

        const processAndRelay = (raw) => {
            const msg = safeJsonParse(raw);
            let outgoing = raw;

            if (msg?.request && typeof msg.method === 'string') {
                if (msg.method === 'createWebRtcTransport') {
                    msg.data = {
                        producing: true,
                        consuming: false,
                        streamkey: integration.token,
                    };
                    outgoing = JSON.stringify(msg);
                } else if (msg.method === 'join') {
                    msg.data = {
                        ...(msg.data || {}),
                        token: integration.token,
                    };
                    outgoing = JSON.stringify(msg);
                }
                console.log(`[RS Publish] Client → SFU: ${msg.method} (id=${msg.id}) | upstream ready: ${upstreamReady} | queued: ${outboundQueue.length}`);
            }

            if (!upstreamReady) outboundQueue.push(outgoing);
            else if (upstream) upstream.send(outgoing);
        };

        ws.on('message', (payload) => {
            const raw = payload.toString();
            if (!hasUpstream) {
                earlyMessages.push(raw);
                console.log('[RS Publish] Buffered early message (upstream not created yet), count:', earlyMessages.length);
            } else {
                processAndRelay(raw);
            }
        });

        ws.on('close', () => {
            if (upstreamPingInterval) { clearInterval(upstreamPingInterval); upstreamPingInterval = null; }
            if (upstream) { try { upstream.close(1000); } catch {} }
            // Clean up tracking — only if we're still the active session for this stream
            if (this._activePublish.get(streamId) === publishEntry) {
                this._activePublish.delete(streamId);
            }
        });

        ws.on('error', () => {
            if (upstream) { try { upstream.close(1011); } catch {} }
        });

        // ── Refresh integration (registers session with RS API) ─────
        // Skip if the integration was recently validated to avoid an expensive
        // 870KB+ API call on every client reconnect (which can also invalidate
        // the previous session). Only force-refresh if data is stale.
        const lastValidated = integration.last_validated_at ? new Date(integration.last_validated_at).getTime() : 0;
        const needsRefresh = !lastValidated || (Date.now() - lastValidated) > RS_REFRESH_CACHE_MS;

        if (needsRefresh) {
            console.log('[RS Publish] Refreshing integration for user', ctx.user.id, '(last validated:', integration.last_validated_at || 'never', ', slot:', integration.managed_stream_id || 'default', ')');
            try {
                integration = await this.refreshIntegration(ctx.user.id, integration.managed_stream_id || null);
                console.log('[RS Publish] Refreshed integration:', {
                    robot_id: integration.robot_id,
                    rtc_sfu_url: integration.rtc_sfu_url,
                    owner_id: integration.owner_id,
                    hasToken: !!integration.token,
                    tokenLen: integration.token?.length,
                });
            } catch (err) {
                console.warn('[RS Publish] Refresh failed:', err.message);
                if (!integration?.rtc_sfu_url) {
                    ws.close(1011, `refresh failed: ${err.message}`);
                    return;
                }
            }
        } else {
            console.log('[RS Publish] Using cached integration for user', ctx.user.id, '(validated', Math.round((Date.now() - lastValidated) / 1000), 's ago)');
        }

        if (!integration?.rtc_sfu_url) {
            console.warn('[RS Publish] No SFU URL available after refresh');
            ws.close(1011, 'no SFU URL available');
            return;
        }

        if (ws.readyState !== WebSocket.OPEN) {
            console.warn('[RS Publish] Client disconnected during refresh');
            return;
        }

        let upstreamUrl;
        try {
            const rtcUrl = new URL(integration.rtc_sfu_url);
            const peerId = `p:${crypto.randomBytes(3).toString('hex')}`;
            rtcUrl.searchParams.set('roomId', String(integration.robot_id));
            rtcUrl.searchParams.set('peerId', peerId);
            upstreamUrl = rtcUrl.toString();
        } catch {
            ws.close(1011, 'invalid rtc url');
            return;
        }

        console.log('[RS Publish] Connecting upstream:', upstreamUrl);
        console.log('[RS Publish] Early messages buffered:', earlyMessages.length);

        const upstreamConnectStart = Date.now();
        upstream = new WebSocket(upstreamUrl, ['protoo'], {
            headers: {
                Origin: RS_ORIGIN,
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
            maxPayload: 512 * 1024,
            rejectUnauthorized: false,
            handshakeTimeout: 15000,
        });
        publishEntry.upstream = upstream;

        // Now that upstream exists, drain buffered messages through processAndRelay
        hasUpstream = true;
        console.log('[RS Publish] Draining', earlyMessages.length, 'early messages into outbound queue');
        while (earlyMessages.length) {
            processAndRelay(earlyMessages.shift());
        }

        // ── Upstream event handlers ─────────────────────────────────
        upstream.on('open', () => {
            console.log('[RS Publish] Upstream connected in', Date.now() - upstreamConnectStart, 'ms | subprotocol:', upstream.protocol || '(none)');
            upstreamReady = true;
            console.log('[RS Publish] Flushing', outboundQueue.length, 'queued messages to SFU');
            while (outboundQueue.length) {
                upstream.send(outboundQueue.shift());
            }

            // Start WebSocket ping keepalive to prevent NAT/firewall idle timeout.
            // Without this, connections die after 60-300s of no data flow.
            upstreamPingInterval = setInterval(() => {
                if (upstream.readyState === WebSocket.OPEN) {
                    try { upstream.ping(); } catch {}
                } else {
                    clearInterval(upstreamPingInterval);
                    upstreamPingInterval = null;
                }
            }, RS_UPSTREAM_PING_INTERVAL_MS);
        });

        upstream.on('message', (payload) => {
            const raw = payload.toString();
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(raw);
            }
            const parsed = safeJsonParse(raw);
            if (parsed?.response) {
                const status = parsed.ok === false ? 'ERROR' : 'OK';
                console.log(`[RS Publish] SFU → client: response id=${parsed.id} ${status}`, parsed.ok === false ? JSON.stringify({ error: parsed.error, reason: parsed.reason }) : '');
            } else if (parsed?.request) {
                console.log(`[RS Publish] SFU → client: request method=${parsed.method}`);
            } else if (parsed?.notification) {
                console.log(`[RS Publish] SFU → client: notification method=${parsed.method}`);
            }
        });

        upstream.on('close', (code, reason) => {
            const reasonStr = reason?.toString() || 'upstream closed';
            const sessionAge = Date.now() - publishEntry.connectedAt;
            console.warn(`[RS Publish] Upstream closed: code=${code} reason=${reasonStr} (session age: ${sessionAge}ms)`);
            if (upstreamPingInterval) { clearInterval(upstreamPingInterval); upstreamPingInterval = null; }
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(code || 1006, reasonStr);
            }
        });

        upstream.on('error', (err) => {
            console.error('[RS Publish] Upstream error:', err.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(1011, `upstream error: ${err.message}`);
            }
        });

        upstream.on('unexpected-response', (req, res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                console.error(`[RS Publish] Upstream rejected: HTTP ${res.statusCode} ${res.statusMessage} | body: ${body.slice(0, 500)}`);
                console.error('[RS Publish] Response headers:', JSON.stringify(res.headers));
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1011, `upstream rejected: HTTP ${res.statusCode}`);
                }
            });
        });
    }
}

module.exports = new RobotStreamerService();
