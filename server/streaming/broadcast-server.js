/**
 * OpenVibe.Live — Broadcast WebSocket Server
 *
 * Handles browser-based broadcasting and viewing via SFU signaling.
 *
 * Flow:
 *   1. Broadcaster connects with JWT token + streamId
 *   2. Broadcaster auto-publishes audio/video into the Mediasoup SFU
 *   3. Viewer connects, sends 'watch', and is either queued or attached to the SFU
 *   4. Legacy P2P relay messages are ignored unless ALLOW_P2P_FALLBACK is enabled
 *
 * Each stream has ONE broadcaster and MANY viewers.
 * The server primarily orchestrates SFU transports and viewer queueing.
 */
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { extractWsToken, authenticateWs } = require('../auth/auth');
const db = require('../db/database');
const webrtcSFU = require('./webrtc-sfu');
const config = require('../config');
const whipHandler = require('./whip-handler');

const WS_HEARTBEAT_MS = 30000;
const MAX_SEND_BACKPRESSURE = 512 * 1024;

class BroadcastServer extends EventEmitter {
    constructor() {
        super();
        this.wss = null;
        /** @type {Map<number, { broadcaster: WebSocket, viewers: Map<string, WebSocket> }>} streamId → room */
        this.rooms = new Map();
        /** @type {Map<WebSocket, { user: object|null, streamId: number, role: string, peerId: string }>} */
        this.clients = new Map();
        this.nextPeerId = 1;
        this.heartbeatInterval = null;
    }

    _logMetric(name, fields = {}) {
        const details = Object.entries(fields)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        console.log(`[BroadcastMetric] ${name}${details ? ` ${details}` : ''}`);
    }

    _isValidIceServerUrl(url) {
        const trimmed = String(url || '').trim();
        return /^(stun|turn|turns):[^/][^\s]*$/i.test(trimmed);
    }

    _normalizeTurnUrl(url) {
        if (typeof url !== 'string') return '';
        const trimmed = url.trim();
        const normalized = trimmed.replace(/^(turns?):\/\//i, '$1:');
        if (!this._isValidIceServerUrl(normalized)) return '';
        return normalized;
    }

    _appendTransportParam(url, transport) {
        if (!url.includes('?')) return `${url}?transport=${transport}`;
        if (/[?&]transport=/i.test(url)) return url;
        return `${url}&transport=${transport}`;
    }

    _sanitizeIceServers(servers) {
        if (!Array.isArray(servers)) return [];
        const result = [];
        for (const server of servers) {
            if (!server || typeof server !== 'object') continue;
            const urls = server.urls;
            const normalizedUrls = Array.isArray(urls) ? urls : [urls];
            const validUrls = normalizedUrls
                .filter((url) => this._isValidIceServerUrl(url))
                .map((url) => String(url).trim());
            if (!validUrls.length) continue;
            const sanitized = { urls: validUrls.length === 1 ? validUrls[0] : validUrls };
            if (server.username) sanitized.username = server.username;
            if (server.credential) sanitized.credential = server.credential;
            result.push(sanitized);
        }
        return result;
    }

    /** Build ICE servers array from config (STUN + optional TURN) */
    _getIceServers() {
        const servers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];
        if (config.turn?.url) {
            const turnUrl = this._normalizeTurnUrl(config.turn.url);
            if (turnUrl) {
                const hasTurnAuth = config.turn.username && config.turn.credential;
                servers.push(
                    hasTurnAuth
                        ? { urls: turnUrl, username: config.turn.username, credential: config.turn.credential }
                        : { urls: turnUrl },
                    hasTurnAuth
                        ? { urls: this._appendTransportParam(turnUrl, 'tcp'), username: config.turn.username, credential: config.turn.credential }
                        : { urls: this._appendTransportParam(turnUrl, 'tcp') },
                );
                if (!hasTurnAuth && (config.turn.username || config.turn.credential)) {
                    console.warn('[ICE] Incomplete TURN credentials configured; emitting TURN URLs without auth.');
                }
            } else {
                console.warn('[ICE] Skipping invalid TURN_URL; only turn: or turns: URLs are accepted:', config.turn.url);
            }
        }
        return this._sanitizeIceServers(servers);
    }

    _queueViewerForSfu(room, ws, client, reason = 'awaiting_source', detail = '') {
        if (!room._pendingWatchers) room._pendingWatchers = new Set();
        room._pendingWatchers.add(client.peerId);
        this.safeSend(ws, {
            type: 'watch-queued',
            reason,
            detail,
            allowP2pFallback: !!config.allowP2pFallback,
        });
        this._logMetric('viewer.queued', {
            streamId: client.streamId,
            peerId: client.peerId,
            reason,
        });
    }

    _requestSfuProduceWarmup(room, streamId) {
        if (!room?.broadcaster || room.broadcaster.readyState !== WebSocket.OPEN) return false;
        const now = Date.now();
        if (room._sfuProduceRequestedAt && (now - room._sfuProduceRequestedAt) < 4000) {
            return true;
        }
        room._sfuProduceRequestedAt = now;
        const requested = this.requestSfuProduce(streamId);
        if (requested) {
            console.log(`[Broadcast] Requested SFU warm-up for stream ${streamId}`);
        } else {
            room._sfuProduceRequestedAt = 0;
        }
        return requested;
    }

    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (!this.wss) return;
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    try { ws.terminate(); } catch {}
                    return;
                }
                ws.isAlive = false;
                try { ws.ping(); } catch {}
            });
        }, WS_HEARTBEAT_MS);

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        console.log('[Broadcast] WebSocket broadcast server initialized');

        // When a WHIP producer is added to the SFU, notify any pending viewers
        webrtcSFU.on('producer-added', ({ roomId, kind }) => {
            if (kind !== 'video') return; // Notify only on video producer
            const match = roomId.match(/^stream-(\d+)$/);
            if (!match) return;
            const streamId = parseInt(match[1]);
            this._notifyPendingWatchers(streamId);
        });

        // When WHIP ICE connects, pending viewers that were queued during ICE negotiation
        // can now be served — the producers are truly live.
        webrtcSFU.on('whip-ice-connected', ({ streamId }) => {
            this._notifyPendingWatchers(streamId);
        });

        // When a WHIP producer is removed (ICE timeout / DELETE), notify active SFU viewers
        // so they learn the source is gone and can wait cleanly instead of showing frozen video.
        webrtcSFU.on('producer-removed', ({ roomId, kind }) => {
            if (kind !== 'video') return;
            const match = roomId.match(/^stream-(\d+)$/);
            if (!match) return;
            const streamId = parseInt(match[1]);
            // Only notify if there are no remaining healthy producers (avoid false alarms
            // when only one of multiple producers is removed)
            const remaining = webrtcSFU.getProducers(roomId).filter(
                p => !p.paused && p.dtlsState === 'connected' && (p.iceState === 'connected' || p.iceState === 'completed')
            );
            if (remaining.length === 0) {
                this._notifyViewersSourceLost(streamId);
            }
        });

        return this.wss;
    }

    handleUpgrade(req, socket, head) {
        if (req.url.startsWith('/ws/broadcast')) {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
            return true;
        }
        return false;
    }

    handleConnection(ws, req) {
        const url = new URL(req.url, 'http://localhost');
        const token = extractWsToken(req);
        const streamId = parseInt(url.searchParams.get('streamId'));
        const role = url.searchParams.get('role') || 'viewer'; // 'broadcaster' or 'viewer'

        if (role === 'broadcaster') {
            console.log(`[Broadcast] Broadcaster WS arrived: streamId=${streamId} token=${token ? 'present' : 'missing'}`);
        }

        if (role !== 'broadcaster' && role !== 'viewer') {
            ws.close(4004, 'Invalid role');
            return;
        }

        if (!streamId || isNaN(streamId)) {
            ws.close(4001, 'Missing streamId');
            return;
        }

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        try { ws._socket?.setNoDelay(true); } catch {}

        // Authenticate
        const user = authenticateWs(token);

        // Broadcaster must be authenticated and own the stream
        if (role === 'broadcaster') {
            if (!user) {
                console.warn(`[Broadcast] Broadcaster auth failed for stream ${streamId}: no valid token (token present=${!!token})`);
                ws.close(4002, 'Authentication required for broadcasting');
                return;
            }
            const stream = db.getStreamById(streamId);
            if (!stream || stream.user_id !== user.id) {
                console.warn(`[Broadcast] Broadcaster ownership check failed for stream ${streamId}: user=${user.username} (${user.id}), stream.user_id=${stream?.user_id}`);
                ws.close(4003, 'Not your stream');
                return;
            }
        }

        const peerId = `peer-${this.nextPeerId++}`;

        const clientInfo = { user, streamId, role, peerId };
        this.clients.set(ws, clientInfo);

        // Set up room
        if (!this.rooms.has(streamId)) {
            this.rooms.set(streamId, { broadcaster: null, viewers: new Map() });
        }
        const room = this.rooms.get(streamId);

        if (role === 'broadcaster') {
            room._sfuProduceRequestedAt = 0;
            // Cancel any pending disconnect timer
            if (room._disconnectTimer) {
                clearTimeout(room._disconnectTimer);
                room._disconnectTimer = null;
            }
            // Close old broadcaster if any
            if (room.broadcaster) {
                const oldWs = room.broadcaster;
                this.clients.delete(oldWs);
                try { oldWs.close(4010, 'Replaced by new broadcaster'); } catch {}
            }
            room.broadcaster = ws;
            console.log(`[Broadcast] Broadcaster connected: stream ${streamId} (${user.username})`);
            this.emit('broadcaster-connected', { streamId, userId: user.id });

            // Notify existing viewers to re-negotiate
            for (const [viewerPeerId, viewerWs] of room.viewers) {
                this.safeSend(viewerWs, { type: 'broadcaster-ready', peerId: viewerPeerId });
            }

            // Drain any pending watchers that sent 'watch' while broadcaster was disconnected
            if (room._pendingWatchers && room._pendingWatchers.size > 0) {
                for (const pendingPeerId of room._pendingWatchers) {
                    if (room.viewers.has(pendingPeerId)) {
                        const viewerWs = room.viewers.get(pendingPeerId);
                        this.safeSend(viewerWs, { type: 'broadcaster-ready', peerId: pendingPeerId });
                    }
                }
                room._pendingWatchers.clear();
            }
        } else {
            room.viewers.set(peerId, ws);
            console.log(`[Broadcast] Viewer connected: stream ${streamId} (${peerId})`);

            // If broadcaster is already connected, notify viewer
            if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                this.safeSend(ws, { type: 'broadcaster-ready', peerId });
            }
        }

        // Send welcome
        this.safeSend(ws, {
            type: 'welcome',
            peerId,
            role,
            streamId,
            viewerCount: room.viewers.size,
            iceServers: this._getIceServers(),
            allowP2pFallback: !!config.allowP2pFallback,
        });

        // Broadcast viewer count
        this.broadcastViewerCount(streamId);

        // Handle messages
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                this.handleMessage(ws, msg);
            } catch (err) {
                console.error('[Broadcast] Invalid message:', err.message);
            }
        });

        ws.on('close', () => {
            this.handleDisconnect(ws);
        });

        ws.on('error', (err) => {
            console.error('[Broadcast] WS error:', err.message);
            this.handleDisconnect(ws);
        });
    }

    handleMessage(ws, msg) {
        const client = this.clients.get(ws);
        if (!client) return;

        const room = this.rooms.get(client.streamId);
        if (!room) return;

        switch (msg.type) {
            case 'offer':
            case 'answer':
            case 'ice-candidate':
                if (!config.allowP2pFallback) {
                    this._logMetric('p2p.relay.attempt', {
                        streamId: client.streamId,
                        peerId: client.peerId,
                        type: msg.type,
                        outcome: 'ignored',
                    });
                    console.warn(`[Broadcast] Ignoring legacy ${msg.type} for stream ${client.streamId} — SFU-only mode is active`);
                    break;
                }
                // For SFU viewers, ignore direct P2P signaling — mediasoup handles everything.
                if (client._sfuViewerTransportId) break;
                this.relaySignaling(ws, client, room, msg);
                break;

            case 'watch':
                // Viewer requests to watch
                if (client.role === 'viewer') {
                    this._tryCreateSfuViewer(ws, client).then(handled => {
                        if (handled) return; // SFU viewer signaling started

                        if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                            this._requestSfuProduceWarmup(room, client.streamId);
                            this._queueViewerForSfu(
                                room,
                                ws,
                                client,
                                'warming_up',
                                'The broadcaster is connected, but the live source is still publishing into the SFU.'
                            );
                            console.log(`[Broadcast] Viewer ${client.peerId} queued while SFU warm-up completes for stream ${client.streamId}`);
                        } else {
                            this._queueViewerForSfu(
                                room,
                                ws,
                                client,
                                'awaiting_broadcaster',
                                'The stream exists, but no active broadcaster session is connected right now.'
                            );
                            console.log(`[Broadcast] Viewer ${client.peerId} wants to watch stream ${client.streamId} but no broadcaster or SFU source is ready — queued as pending`);
                        }
                    }).catch(err => {
                        console.error(`[Broadcast] SFU viewer error for ${client.peerId}:`, err.message);
                        if (config.allowP2pFallback && room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                            this._logMetric('p2p.relay.attempt', {
                                streamId: client.streamId,
                                peerId: client.peerId,
                                type: 'viewer-joined',
                                outcome: 'fallback',
                            });
                            this.safeSend(room.broadcaster, {
                                type: 'viewer-joined',
                                peerId: client.peerId,
                            });
                            return;
                        }

                        if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                            this._requestSfuProduceWarmup(room, client.streamId);
                        }
                        this._queueViewerForSfu(
                            room,
                            ws,
                            client,
                            'sfu_error',
                            'The low-latency media path hit a setup error. The server will keep retrying in SFU-only mode.'
                        );
                    });
                }
                break;

            case 'stats':
                // Broadcaster reporting stats — relay to room or store
                if (client.role === 'broadcaster') {
                    // Could store stats, for now just track
                }
                break;

            case 'chat-tts':
                // TTS message from chat to broadcaster
                if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                    this.safeSend(room.broadcaster, {
                        type: 'chat-tts',
                        text: msg.text,
                        username: msg.username,
                    });
                }
                break;

            // ── SFU Produce Signaling (for WebRTC → RTMP restreaming) ──
            case 'sfu-get-capabilities':
                if (client.role === 'broadcaster') {
                    console.log(`[SFU Signaling] stream ${client.streamId}: get-capabilities`);
                    this._handleSfuGetCapabilities(ws, client);
                }
                break;
            case 'sfu-create-transport':
                if (client.role === 'broadcaster') {
                    console.log(`[SFU Signaling] stream ${client.streamId}: create-transport`);
                    this._handleSfuCreateTransport(ws, client);
                }
                break;
            case 'sfu-connect-transport':
                if (client.role === 'broadcaster') {
                    console.log(`[SFU Signaling] stream ${client.streamId}: connect-transport`);
                    this._handleSfuConnectTransport(ws, client, msg);
                }
                break;
            case 'sfu-produce':
                if (client.role === 'broadcaster') {
                    console.log(`[SFU Signaling] stream ${client.streamId}: produce (${msg.kind})`);
                    this._handleSfuProduce(ws, client, msg);
                }
                break;
            case 'sfu-stop-produce':
                if (client.role === 'broadcaster') {
                    console.log(`[SFU Signaling] stream ${client.streamId}: stop-produce`);
                    this._handleSfuStopProduce(ws, client);
                }
                break;

            // Diagnostic: browser reports SFU produce outcome
            case 'sfu-produce-status':
                if (client.role === 'broadcaster') {
                    const status = msg.status || 'unknown';
                    const detail = msg.error || msg.detail || '';
                    console.log(`[SFU Signaling] stream ${client.streamId}: produce-status=${status}${detail ? ' — ' + detail : ''}`);
                }
                break;

            // ── SFU Viewer Signaling (mediasoup-client on viewer side) ──
            case 'sfu-viewer-create-transport':
                if (client.role === 'viewer') {
                    this._handleSfuViewerCreateTransport(ws, client).catch(err => {
                        console.error(`[Broadcast] SFU viewer create-transport error for ${client.peerId}:`, err.message);
                        this.safeSend(ws, { type: 'sfu-viewer-error', error: err.message });
                    });
                }
                break;
            case 'sfu-viewer-connect-transport':
                if (client.role === 'viewer') {
                    this._handleSfuViewerConnectTransport(ws, client, msg).catch(err => {
                        console.error(`[Broadcast] SFU viewer connect-transport error for ${client.peerId}:`, err.message);
                        this.safeSend(ws, { type: 'sfu-viewer-error', error: err.message });
                    });
                }
                break;
            case 'sfu-viewer-consume':
                if (client.role === 'viewer') {
                    this._handleSfuViewerConsume(ws, client, msg).catch(err => {
                        console.error(`[Broadcast] SFU viewer consume error for ${client.peerId}:`, err.message);
                        this.safeSend(ws, { type: 'sfu-viewer-error', error: err.message });
                    });
                }
                break;

            default:
                break;
        }
    }

    relaySignaling(ws, client, room, msg) {
        this._logMetric('p2p.relay.attempt', {
            streamId: client.streamId,
            peerId: client.peerId,
            type: msg.type,
            outcome: 'relayed',
        });
        if (client.role === 'broadcaster') {
            // Broadcaster sending to a specific viewer
            const targetPeerId = msg.targetPeerId;
            if (targetPeerId && room.viewers.has(targetPeerId)) {
                const viewerWs = room.viewers.get(targetPeerId);
                if (viewerWs.readyState === WebSocket.OPEN) {
                    this.safeSend(viewerWs, {
                        type: msg.type,
                        sdp: msg.sdp,
                        candidate: msg.candidate,
                        fromPeerId: 'broadcaster',
                    });
                } else {
                    console.warn(`[Broadcast] Cannot relay ${msg.type} to ${targetPeerId} — viewer WS not open (state: ${viewerWs.readyState})`);
                }
            } else if (targetPeerId) {
                console.warn(`[Broadcast] Cannot relay ${msg.type} — viewer ${targetPeerId} not found in room (stream ${client.streamId})`);
            }
        } else {
            // Viewer sending to broadcaster
            if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                this.safeSend(room.broadcaster, {
                    type: msg.type,
                    sdp: msg.sdp,
                    candidate: msg.candidate,
                    fromPeerId: client.peerId,
                });
            } else {
                console.warn(`[Broadcast] Cannot relay ${msg.type} from viewer ${client.peerId} — broadcaster not connected (stream ${client.streamId})`);
            }
        }
    }

    handleDisconnect(ws) {
        const client = this.clients.get(ws);
        if (!client) return;

        const room = this.rooms.get(client.streamId);
        if (room) {
            if (client.role === 'broadcaster') {
                room.broadcaster = null;
                room._sfuProduceRequestedAt = 0;
                console.log(`[Broadcast] Broadcaster disconnected: stream ${client.streamId}`);

                // Start a grace timer — if broadcaster doesn't reconnect, end the stream cleanly
                if (room._disconnectTimer) clearTimeout(room._disconnectTimer);
                room._disconnectTimer = setTimeout(() => {
                    // Check if broadcaster reconnected
                    const currentRoom = this.rooms.get(client.streamId);
                    if (currentRoom && !currentRoom.broadcaster) {
                        console.log(`[Broadcast] Broadcaster did not reconnect, ending stream ${client.streamId}`);
                        try {
                            db.endStream(client.streamId);
                            require('./recorder').finalizeStream(client.streamId).catch((err) => {
                                console.warn(`[Broadcast] Failed to finalize VOD for stale stream ${client.streamId}:`, err.message);
                            });
                            webrtcSFU.closeRoom(`stream-${client.streamId}`);
                        } catch (err) {
                            console.error('[Broadcast] Failed to end stale stream:', err.message);
                        }
                        // Notify all viewers
                        for (const [, vWs] of (currentRoom.viewers || new Map())) {
                            this.safeSend(vWs, { type: 'stream-ended' });
                        }
                    }
                }, 60000);

                // Notify all viewers (they may get a reconnection)
                for (const [peerId, viewerWs] of room.viewers) {
                    this.safeSend(viewerWs, { type: 'broadcaster-disconnected' });
                }
            } else {
                room.viewers.delete(client.peerId);
                if (room._pendingWatchers) room._pendingWatchers.delete(client.peerId);

                // Clean up SFU viewer transport if this was an SFU consumer
                this._cleanupSfuViewerTransport(client);

                console.log(`[Broadcast] Viewer disconnected: stream ${client.streamId} (${client.peerId})`);

                // Notify broadcaster only when legacy P2P fallback is explicitly enabled.
                if (config.allowP2pFallback && room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                    this.safeSend(room.broadcaster, {
                        type: 'viewer-left',
                        peerId: client.peerId,
                    });
                }
            }

            this.broadcastViewerCount(client.streamId);

            // Clean up empty room
            if (!room.broadcaster && room.viewers.size === 0) {
                this.rooms.delete(client.streamId);
            }
        }

        this.clients.delete(ws);
    }

    broadcastViewerCount(streamId) {
        const room = this.rooms.get(streamId);
        if (!room) return;

        const count = room.viewers.size;
        const msg = { type: 'viewer-count', count };

        if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
            this.safeSend(room.broadcaster, msg);
        }
        for (const [, viewerWs] of room.viewers) {
            if (viewerWs.readyState === WebSocket.OPEN) {
                this.safeSend(viewerWs, msg);
            }
        }
    }

    safeSend(ws, data) {
        try {
            if (ws.readyState !== WebSocket.OPEN) {
                // Don't log — disconnect handlers already log this
                return;
            }
            if (ws.bufferedAmount > MAX_SEND_BACKPRESSURE) {
                const client = this.clients.get(ws);
                console.warn(`[Broadcast] Dropping ${data?.type || 'unknown'} message — backpressure ${ws.bufferedAmount} bytes (${client?.role || '?'} ${client?.peerId || '?'} stream ${client?.streamId || '?'})`);
                return;
            }
            ws.send(JSON.stringify(data));
        } catch (err) {
            const client = this.clients.get(ws);
            console.warn(`[Broadcast] safeSend error for ${data?.type || 'unknown'}: ${err.message} (${client?.role || '?'} ${client?.peerId || '?'})`);
        }
    }

    getViewerCount(streamId) {
        const room = this.rooms.get(streamId);
        return room ? room.viewers.size : 0;
    }

    // ── SFU Produce Signaling (for WebRTC → RTMP restreaming) ────

    /**
     * Signal the broadcaster to start producing into the Mediasoup SFU.
     * Called by the restream manager when a WebRTC restream is requested.
     * @param {number} streamId
     * @returns {boolean} true if signal was sent
     */
    requestSfuProduce(streamId) {
        const room = this.rooms.get(streamId);
        if (!room?.broadcaster || room.broadcaster.readyState !== WebSocket.OPEN) return false;
        this.safeSend(room.broadcaster, { type: 'sfu-produce-request' });
        return true;
    }

    /**
     * Check if a broadcaster is connected for a stream.
     * @param {number} streamId
     * @returns {boolean}
     */
    isBroadcasterConnected(streamId) {
        const room = this.rooms.get(streamId);
        return !!(room?.broadcaster && room.broadcaster.readyState === WebSocket.OPEN);
    }

    async _handleSfuGetCapabilities(ws, client) {
        try {
            const roomId = `stream-${client.streamId}`;
            const caps = await webrtcSFU.getRouterCapabilities(roomId);
            this.safeSend(ws, { type: 'sfu-capabilities', rtpCapabilities: caps });
        } catch (err) {
            console.error('[Broadcast] SFU get-capabilities error:', err.message);
            this.safeSend(ws, { type: 'sfu-error', error: err.message });
        }
    }

    async _handleSfuCreateTransport(ws, client) {
        try {
            const roomId = `stream-${client.streamId}`;
            const transport = await webrtcSFU.createTransport(roomId, `sfu-${client.peerId}`);
            const iceServers = this._getIceServers();
            console.log(`[Broadcast] SFU create transport for ${client.peerId} using ${iceServers.length} ICE server(s)`);
            this.safeSend(ws, { type: 'sfu-transport-created', ...transport, iceServers });
        } catch (err) {
            console.error('[Broadcast] SFU create-transport error:', err.message);
            this.safeSend(ws, { type: 'sfu-error', error: err.message });
        }
    }

    async _handleSfuConnectTransport(ws, client, msg) {
        try {
            const roomId = `stream-${client.streamId}`;
            await webrtcSFU.connectTransport(
                roomId, `sfu-${client.peerId}`, msg.transportId, msg.dtlsParameters
            );
            this.safeSend(ws, { type: 'sfu-transport-connected', transportId: msg.transportId });
        } catch (err) {
            console.error('[Broadcast] SFU connect-transport error:', err.message);
            this.safeSend(ws, { type: 'sfu-error', error: err.message });
        }
    }

    async _handleSfuProduce(ws, client, msg) {
        try {
            const roomId = `stream-${client.streamId}`;
            const result = await webrtcSFU.produce(
                roomId, `sfu-${client.peerId}`, msg.transportId, msg.kind, msg.rtpParameters
            );
            this.safeSend(ws, { type: 'sfu-produced', id: result.id, kind: msg.kind });

            // Promote to streamer role on first real feed ingest
            if (client.userId) {
                db.ensureStreamerRoleOnFeed(client.userId);
            }
        } catch (err) {
            console.error('[Broadcast] SFU produce error:', err.message);
            this.safeSend(ws, { type: 'sfu-error', error: err.message });
        }
    }

    _handleSfuStopProduce(ws, client) {
        // Close the SFU room producers for this broadcaster
        // The room itself stays open — PlainTransport consumers will detect producer close
        const roomId = `stream-${client.streamId}`;
        const room = webrtcSFU.rooms?.get(roomId);
        if (!room) return;

        const peerId = `sfu-${client.peerId}`;
        const toRemove = [];
        for (const [id, { producer, peerId: pid }] of room.producers) {
            if (pid === peerId) {
                try { producer.close(); } catch {}
                toRemove.push(id);
            }
        }
        for (const id of toRemove) room.producers.delete(id);
        if (toRemove.length) console.log(`[Broadcast] SFU: Closed ${toRemove.length} producer(s) for ${peerId}`);
    }

    // ── SFU Viewer Path (mediasoup-client signaling) ──────────

    /**
     * Check if SFU producers exist and notify viewer to start mediasoup-client flow.
     * Returns true if an sfu-viewer-ready was sent.
     */
    async _tryCreateSfuViewer(ws, client) {
        const roomId = `stream-${client.streamId}`;
        if (!whipHandler.hasSfuProducers(client.streamId)) return false;

        // If viewer already has a DTLS-connected transport, do not tear it down.
        // A re-watch at this point was almost certainly triggered by the client-side stall
        // timer firing before the first keyframe arrived — NOT by a real transport failure.
        // Instead, nudge the producer with a keyframe request to unstick the decoder.
        if (client._sfuViewerTransportId && client._sfuViewerRoomId) {
            const existingRoom = webrtcSFU.rooms?.get(client._sfuViewerRoomId);
            if (existingRoom) {
                const tKey = `${client.peerId}-${client._sfuViewerTransportId}`;
                const existingTransport = existingRoom.transports.get(tKey);
                if (existingTransport && !existingTransport.closed && existingTransport.dtlsState === 'connected') {
                    const activeConsumerIds = (client._sfuViewerConsumerIds || []).filter(cid => {
                        const entry = existingRoom.consumers.get(cid);
                        return entry?.consumer && !entry.consumer.closed;
                    });

                    if (activeConsumerIds.length > 0) {
                        // Consumers are alive — nudge with keyframe and ack the client so
                        // startWatchOfferTimeout doesn't fire and loop.
                        console.log(`[Broadcast] Viewer ${client.peerId} re-watch with connected SFU transport ${client._sfuViewerTransportId} (${activeConsumerIds.length} consumers) — requesting keyframe`);
                        for (const cid of activeConsumerIds) {
                            const entry = existingRoom.consumers.get(cid);
                            if (entry?.consumer && entry.consumer.kind === 'video') {
                                entry.consumer.requestKeyFrame().catch(err => {
                                    console.warn(`[Broadcast] Keyframe re-request failed for consumer ${cid}:`, err.message);
                                });
                            }
                        }
                        this.safeSend(ws, { type: 'sfu-keyframe-requested' });
                        return true; // handled — viewer session is still alive
                    }

                    // Transport is connected but no consumers — the client's consume setup
                    // failed (e.g. Firefox codec negotiation). Reset so a fresh transport
                    // and sfu-viewer-ready are sent on the fall-through path below.
                    console.log(`[Broadcast] Viewer ${client.peerId} re-watch: connected transport but no active consumers — resetting for fresh consume`);
                    this._cleanupSfuViewerTransport(client);
                }
            }
        }

        // Clean up previous SFU viewer transport (e.g. on re-watch after real transport failure)
        this._cleanupSfuViewerTransport(client);

        // Get router capabilities and producer list
        const caps = await webrtcSFU.getRouterCapabilities(roomId);
        const allProducers = webrtcSFU.getProducers(roomId);
        if (!caps || !allProducers || allProducers.length === 0) return false;

        // Filter to only producers whose backing transport is connected
        // (producers on a transport that never completed ICE/DTLS have no RTP data)
        const liveProducers = allProducers.filter(p => {
            if (p.paused) {
                console.log(`[Broadcast] Skipping paused producer ${p.id} (${p.kind}) for viewer ${client.peerId}`);
                return false;
            }
            if (p.dtlsState !== 'connected') {
                console.log(`[Broadcast] Skipping producer ${p.id} (${p.kind}) — DTLS: ${p.dtlsState}, ICE: ${p.iceState} (not connected)`);
                return false;
            }
            // Also require ICE to be in a healthy state — DTLS is application-layer and stays
            // 'connected' even after ICE drops, but no RTP flows without ICE connectivity.
            if (p.iceState !== 'connected' && p.iceState !== 'completed') {
                console.log(`[Broadcast] Skipping producer ${p.id} (${p.kind}) — ICE state unhealthy: ${p.iceState} (DTLS: ${p.dtlsState})`);
                return false;
            }
            return true;
        });

        if (liveProducers.length === 0) {
            if (allProducers.length > 0) {
                // Producers exist but none have healthy ICE/DTLS.
                // Check if this is a brand-new WHIP session still establishing ICE (within 30s).
                // In that case, queue the viewer as pending so they are notified when ICE connects,
                // rather than immediately sending ingest_stale which causes a reconnect loop.
                const recentWhipSession = Array.from(whipHandler.sessions.values()).find(
                    s => s.streamId === client.streamId && (Date.now() - (s.createdAt || 0)) < 30000
                );
                if (recentWhipSession) {
                    const room = this.rooms.get(client.streamId);
                    if (room) {
                        if (!room._pendingWatchers) room._pendingWatchers = new Set();
                        room._pendingWatchers.add(client.peerId);
                    }
                    console.log(`[Broadcast] WHIP ICE establishing for stream ${client.streamId} — queueing viewer ${client.peerId} as pending`);
                    this.safeSend(ws, { type: 'watch-queued' });
                    return true;
                }
                // True stale: ICE never connected or has definitively failed.
                console.log(`[Broadcast] All ${allProducers.length} producer(s) are stale for stream ${client.streamId} — sending source-unavailable to ${client.peerId}`);
                this.safeSend(ws, { type: 'sfu-source-unavailable', reason: 'ingest_stale' });
                return true; // handled — do not fall through to P2P offer path
            }
            console.log(`[Broadcast] No live producers for stream ${client.streamId} (${allProducers.length} total, all dead/disconnected) — falling back to P2P`);
            return false;
        }

        // Send capabilities + producer list — viewer will use mediasoup-client Device
        this.safeSend(ws, {
            type: 'sfu-viewer-ready',
            rtpCapabilities: caps,
            producers: liveProducers.map(p => ({ id: p.id, kind: p.kind })),
        });

        console.log(`[Broadcast] SFU viewer ready sent to ${client.peerId} for stream ${client.streamId} (${liveProducers.length}/${allProducers.length} live producer(s))`);
        return true;
    }

    async _handleSfuViewerCreateTransport(ws, client) {
        const roomId = `stream-${client.streamId}`;
        // Clean up previous transport on re-negotiate
        this._cleanupSfuViewerTransport(client);

        const transport = await webrtcSFU.createTransport(roomId, client.peerId);
        client._sfuViewerTransportId = transport.id;
        client._sfuViewerRoomId = roomId;
        client._sfuViewerConsumerIds = [];

        const iceServers = this._getIceServers();
        console.log(`[Broadcast] SFU viewer transport ${transport.id} created for ${client.peerId} with ${iceServers.length} ICE server(s)`);
        this.safeSend(ws, {
            type: 'sfu-viewer-transport-created',
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            iceServers,
        });
    }

    async _handleSfuViewerConnectTransport(ws, client, msg) {
        const roomId = client._sfuViewerRoomId || `stream-${client.streamId}`;
        await webrtcSFU.connectTransport(
            roomId, client.peerId, msg.transportId, msg.dtlsParameters
        );
        this.safeSend(ws, { type: 'sfu-viewer-transport-connected', transportId: msg.transportId });
        console.log(`[Broadcast] SFU viewer ${client.peerId} transport connected for stream ${client.streamId}`);
    }

    async _handleSfuViewerConsume(ws, client, msg) {
        const roomId = client._sfuViewerRoomId || `stream-${client.streamId}`;
        const result = await webrtcSFU.consume(
            roomId, client.peerId, msg.transportId, msg.producerId, msg.rtpCapabilities
        );
        if (!client._sfuViewerConsumerIds) client._sfuViewerConsumerIds = [];
        client._sfuViewerConsumerIds.push(result.id);

        this.safeSend(ws, {
            type: 'sfu-viewer-consumed',
            id: result.id,
            producerId: result.producerId,
            kind: result.kind,
            rtpParameters: result.rtpParameters,
        });
        console.log(`[Broadcast] SFU viewer ${client.peerId} consuming ${result.kind} for stream ${client.streamId}`);
    }

    _cleanupSfuViewerTransport(client) {
        if (!client._sfuViewerTransportId) return;
        const roomId = client._sfuViewerRoomId || `stream-${client.streamId}`;
        // Close consumers
        const room = webrtcSFU.rooms?.get(roomId);
        if (room) {
            for (const cid of (client._sfuViewerConsumerIds || [])) {
                const entry = room.consumers.get(cid);
                if (entry) {
                    try { entry.consumer.close(); } catch {}
                    room.consumers.delete(cid);
                }
            }
            // Close transport
            const tKey = `${client.peerId}-${client._sfuViewerTransportId}`;
            const transport = room.transports.get(tKey);
            if (transport) {
                try { transport.close(); } catch {}
                room.transports.delete(tKey);
            }
        }
        client._sfuViewerTransportId = null;
        client._sfuViewerRoomId = null;
        client._sfuViewerConsumerIds = null;
    }

    /**
     * Notify active SFU viewers that the ingest source is gone so they can
     * wait cleanly instead of showing a frozen frame until the stall timer fires.
     * Only sent to viewers that currently have an SFU transport open.
     */
    _notifyViewersSourceLost(streamId) {
        let notified = 0;
        for (const [viewerWs, client] of this.clients) {
            if (client.streamId === streamId && client.role === 'viewer' && client._sfuViewerTransportId) {
                this.safeSend(viewerWs, { type: 'sfu-source-unavailable', reason: 'producer_removed' });
                notified++;
            }
        }
        if (notified > 0) {
            console.log(`[Broadcast] Notified ${notified} SFU viewer(s) of source loss for stream ${streamId}`);
        }
    }

    /**
     * Notify pending viewers that SFU producers are now available.
     * Called when a WHIP producer is added.
     */
    _notifyPendingWatchers(streamId) {
        const room = this.rooms.get(streamId);
        if (!room?._pendingWatchers?.size) return;

        for (const peerId of room._pendingWatchers) {
            const viewerWs = room.viewers.get(peerId);
            if (viewerWs?.readyState === WebSocket.OPEN) {
                this.safeSend(viewerWs, { type: 'broadcaster-ready', peerId });
                this._logMetric('viewer.notified', { streamId, peerId, reason: 'source_ready' });
            }
        }
        room._sfuProduceRequestedAt = 0;
        room._pendingWatchers.clear();
        console.log(`[Broadcast] Notified pending viewers of SFU producers for stream ${streamId}`);
    }

    /**
     * Cleanly end a stream: close broadcaster WS, notify viewers, clear room.
     * Called from DELETE /streams/:id and stale heartbeat cleanup.
     */
    endStream(streamId) {
        const room = this.rooms.get(streamId);
        if (!room) return;

        // Cancel any pending disconnect timer
        if (room._disconnectTimer) {
            clearTimeout(room._disconnectTimer);
            room._disconnectTimer = null;
        }

        // Close broadcaster WS
        if (room.broadcaster) {
            this.safeSend(room.broadcaster, { type: 'stream-ended' });
            this.clients.delete(room.broadcaster);
            try { room.broadcaster.close(4020, 'Stream ended'); } catch {}
            room.broadcaster = null;
        }

        // Notify all viewers
        for (const [, viewerWs] of room.viewers) {
            this.safeSend(viewerWs, { type: 'stream-ended' });
        }

        this.rooms.delete(streamId);
    }

    getTotalConnections() {
        return this.clients.size;
    }

    close() {
        if (this.wss) {
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            for (const ws of this.clients.keys()) {
                try { ws.close(); } catch {}
            }
            this.clients.clear();
            this.rooms.clear();
        }
    }
}

module.exports = new BroadcastServer();
