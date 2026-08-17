/**
 * OpenVibe.Live — Control Server
 * 
 * WebSocket server for interactive camp controls.
 * Viewers send commands → server relays → hardware client (Raspberry Pi) OR ONVIF camera.
 * 
 * Architecture:
 *   Browser → WebSocket → Control Server → (Hardware WS OR ONVIF) → Endpoint
 */
const WebSocket = require('ws');
const db = require('../db/database');
const { authenticateWs } = require('../auth/auth');
const { OnvifClient } = require('../core/onvif-client');

class ControlServer {
    constructor() {
        this.wss = null;
        /** @type {Map<string, WebSocket>} streamKey → hardware client WebSocket */
        this.hardwareClients = new Map();
        /** @type {Map<WebSocket, { user: object, streamId: number, heldKeys: Set<string> }>} */
        this.viewerClients = new Map();
        /** @type {Map<string, number>} `${streamId}-${controlId}-${userId}` → last command timestamp */
        this.commandCounts = new Map();
        /** @type {Map<string, number[]>} `${streamId}-burst-${userId}` → recent command timestamps (anti-flood burst cap) */
        this.commandBursts = new Map();
    }

    /**
     * Initialize the control WebSocket server
     */
    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        console.log('[Control] WebSocket control server initialized');
        return this.wss;
    }

    /**
     * Handle WebSocket upgrade for control connections
     */
    handleUpgrade(req, socket, head) {
        if (req.url.startsWith('/ws/control')) {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
            return true;
        }
        return false;
    }

    /**
     * Handle a new control connection
     */
    handleConnection(ws, req) {
        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const token = urlParams.get('token');
        const streamKey = urlParams.get('stream_key');
        const mode = urlParams.get('mode'); // 'hardware' or 'viewer'

        if (mode === 'hardware') {
            this.handleHardwareConnection(ws, streamKey);
        } else {
            this.handleViewerConnection(ws, token, urlParams);
        }
    }

    /**
     * Handle hardware client connection (Raspberry Pi / controller)
     */
    handleHardwareConnection(ws, streamKey) {
        if (!streamKey) {
            ws.close(4001, 'Stream key required');
            return;
        }

        const user = db.getUserByStreamKey(streamKey);
        if (!user) {
            ws.close(4002, 'Invalid stream key');
            return;
        }

        this.hardwareClients.set(streamKey, ws);
        console.log(`[Control] Hardware client connected: ${user.username} (${streamKey.slice(0, 8)}...)`);

        ws.send(JSON.stringify({ type: 'connected', message: 'Hardware client registered' }));

        // Notify all viewers watching this stream that hardware is now online
        this.broadcastToViewers(streamKey, {
            type: 'hardware_status',
            connected: true,
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                // Hardware can send status updates back
                if (msg.type === 'status') {
                    this.broadcastToViewers(streamKey, {
                        type: 'hardware_status',
                        ...msg,
                    });
                }
            } catch { /* ignore */ }
        });

        ws.on('close', () => {
            this.hardwareClients.delete(streamKey);
            console.log(`[Control] Hardware client disconnected: ${streamKey.slice(0, 8)}...`);

            // Notify all viewers that hardware went offline
            this.broadcastToViewers(streamKey, {
                type: 'hardware_status',
                connected: false,
            });
        });
    }

    /**
     * Handle viewer control connection
     */
    handleViewerConnection(ws, token, params) {
        const streamId = parseInt(params.get('stream')) || null;
        const user = authenticateWs(token);

        this.viewerClients.set(ws, { user, streamId, heldKeys: new Set() });

        // Send available controls + channel control settings + hardware connection status
        if (streamId) {
            const controls = db.getStreamControls(streamId);
            const stream = db.getStreamById(streamId);
            let controlSettings = {};
            let hardwareConnected = false;
            if (stream) {
                const streamUser = db.getUserById(stream.user_id);
                const channel = db.getChannelByUserId(stream.user_id);
                if (channel) {
                    controlSettings = {
                        control_mode: channel.control_mode || 'open',
                        anon_controls_enabled: !!channel.anon_controls_enabled,
                        control_rate_limit_ms: channel.control_rate_limit_ms || 100,
                        video_click_enabled: !!channel.video_click_enabled,
                        video_click_rate_limit_ms: channel.video_click_rate_limit_ms || 0,
                    };
                }
                // Check if hardware client is currently connected for this stream
                if (streamUser) {
                    const hwWs = this.hardwareClients.get(streamUser.stream_key);
                    hardwareConnected = !!(hwWs && hwWs.readyState === WebSocket.OPEN);
                }
            }
            ws.send(JSON.stringify({ type: 'controls', controls, settings: controlSettings }));
            // Send initial hardware connection status so viewer knows immediately
            ws.send(JSON.stringify({ type: 'hardware_status', connected: hardwareConnected }));
        }

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'command') {
                    this.handleCommand(ws, msg);
                } else if (msg.type === 'key_down' || msg.type === 'key_up') {
                    this.handleKeyEvent(ws, msg);
                } else if (msg.type === 'video_click') {
                    this.handleVideoClick(ws, msg);
                }
            } catch { /* ignore */ }
        });

        ws.on('close', () => {
            // Force-release any keys this viewer was holding
            const closingClient = this.viewerClients.get(ws);
            if (closingClient && closingClient.heldKeys.size > 0 && closingClient.streamId) {
                const stream = db.getStreamById(closingClient.streamId);
                if (stream) {
                    const user = db.getUserById(stream.user_id);
                    if (user) {
                        const hardwareWs = this.hardwareClients.get(user.stream_key);
                        if (hardwareWs && hardwareWs.readyState === WebSocket.OPEN) {
                            for (const holdKey of closingClient.heldKeys) {
                                // holdKey format: `${streamId}-key-${command}-${userId}`
                                const parts = holdKey.split('-key-');
                                if (parts.length >= 2) {
                                    const command = parts[1].substring(0, parts[1].lastIndexOf('-'));
                                    hardwareWs.send(JSON.stringify({
                                        type: 'key_up',
                                        command,
                                        from_user: closingClient.user?.username || 'anonymous',
                                        reason: 'viewer_disconnected',
                                        timestamp: new Date().toISOString(),
                                    }));
                                }
                            }
                        }
                        // Broadcast key releases to other viewers
                        for (const holdKey of closingClient.heldKeys) {
                            const parts = holdKey.split('-key-');
                            if (parts.length >= 2) {
                                const command = parts[1].substring(0, parts[1].lastIndexOf('-'));
                                this.broadcastToViewers(user.stream_key, {
                                    type: 'key_released',
                                    command,
                                    by: closingClient.user?.username || 'anonymous',
                                });
                            }
                        }
                    }
                }
                closingClient.heldKeys.clear();
            }
            this.viewerClients.delete(ws);
        });
    }

    /**
     * Handle a control command from a viewer
     */
    async handleCommand(ws, msg) {
        const client = this.viewerClients.get(ws);
        if (!client || !client.streamId) return;

        const { command, control_id, isOnvif, cameraId, movement } = msg;
        if (!command && !isOnvif) return;

        const ctx = this.validateControlPermission(ws, client);
        if (!ctx) return;
        const { stream, user, channel } = ctx;

        // ── Rate limiting ─────────────────────────────────────
        // Real per-command throttling is the per-button cooldown_ms below. The only
        // global limit is a fixed anti-flood safety cap (not user-configurable): a
        // ridiculous burst ceiling that just stops a spammer from firehosing commands.
        const now = Date.now();
        const userId = client.user?.id || 'anon';
        const BURST_WINDOW_MS = 1000;
        const BURST_MAX = 20; // ≤20 commands/sec/user
        const burstKey = `${client.streamId}-burst-${userId}`;
        let hits = this.commandBursts.get(burstKey);
        if (!hits) { hits = []; this.commandBursts.set(burstKey, hits); }
        // Drop timestamps outside the window.
        while (hits.length && now - hits[0] > BURST_WINDOW_MS) hits.shift();
        if (hits.length >= BURST_MAX) {
            ws.send(JSON.stringify({ type: 'cooldown', message: 'Too many commands — slow down' }));
            return;
        }

        if (control_id) {
            const control = db.get('SELECT * FROM stream_controls WHERE id = ?', [control_id]);
            if (control) {
                const buttonCooldownMs = Number.isFinite(control.cooldown_ms) ? parseInt(control.cooldown_ms, 10) : 100;
                const key = `${client.streamId}-command-${control_id}-${userId}`;
                const lastCmd = this.commandCounts.get(key) || 0;
                if (now - lastCmd < buttonCooldownMs) {
                    ws.send(JSON.stringify({ type: 'cooldown', message: 'Command on cooldown' }));
                    return;
                }
                this.commandCounts.set(key, now);
            }
        }
        hits.push(now);

        // Handle ONVIF camera movement
        if (isOnvif && cameraId && movement) {
            try {
                const camera = db.getCameraProfile(cameraId);
                if (!camera) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Camera not found' }));
                    return;
                }

                // Create ONVIF client and execute movement
                const bcrypt = require('bcryptjs');
                const password = camera.password_hash; // For now, hash IS the plaintext (MVP)
                
                const onvifClient = new OnvifClient(camera.onvif_url, camera.username, password);
                const connected = await Promise.race([
                    onvifClient.connect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
                ]);

                if (!connected) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Camera unreachable' }));
                    return;
                }

                // Execute movement command
                const movements = {
                    'pan_left': [-camera.pan_speed, 0, 0],
                    'pan_right': [camera.pan_speed, 0, 0],
                    'tilt_up': [0, camera.tilt_speed, 0],
                    'tilt_down': [0, -camera.tilt_speed, 0],
                    'zoom_in': [0, 0, camera.zoom_speed],
                    'zoom_out': [0, 0, -camera.zoom_speed],
                };

                const [panSpeed, tiltSpeed, zoomSpeed] = movements[movement] || [0, 0, 0];

                if (panSpeed !== 0 || tiltSpeed !== 0 || zoomSpeed !== 0) {
                    await onvifClient.relativeMove(panSpeed, tiltSpeed, zoomSpeed, 300);
                }

                onvifClient.disconnect();

                // Broadcast activity to other viewers
                this.broadcastToViewers(user.stream_key, {
                    type: 'onvif_activity',
                    camera_name: camera.name,
                    movement,
                    by: client.user?.username || 'anonymous',
                });

                ws.send(JSON.stringify({ type: 'ok', message: 'Movement executed' }));

            } catch (err) {
                console.error('[Control] ONVIF error:', err.message);
                ws.send(JSON.stringify({ type: 'error', message: 'Camera command failed: ' + err.message }));
            }
            return;
        }

        // Handle traditional hardware commands
        if (!stream.is_live) {
            ws.send(JSON.stringify({ type: 'error', message: 'Stream not live' }));
            return;
        }

        // Check if hardware client is connected
        const hardwareWs = this.hardwareClients.get(user.stream_key);
        if (!hardwareWs || hardwareWs.readyState !== WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Hardware not connected' }));
            return;
        }

        // Forward command to hardware
        hardwareWs.send(JSON.stringify({
            type: 'command',
            command,
            control_id,
            from_user: client.user?.username || 'anonymous',
            timestamp: new Date().toISOString(),
        }));

        // Broadcast command activity to other viewers
        this.broadcastToViewers(user.stream_key, {
            type: 'command_executed',
            command,
            by: client.user?.username || 'anonymous',
        });
    }

    /**
     * Validate control permissions (shared by command, key event, and click handlers)
     */
    validateControlPermission(ws, client) {
        const stream = db.getStreamById(client.streamId);
        if (!stream) return null;

        const user = db.getUserById(stream.user_id);
        if (!user) return null;

        const channel = db.getChannelByUserId(stream.user_id);
        if (channel) {
            const mode = channel.control_mode || 'open';
            if (mode === 'disabled') {
                ws.send(JSON.stringify({ type: 'error', message: 'Controls are disabled' }));
                return null;
            }
            if (!channel.anon_controls_enabled && !client.user) {
                ws.send(JSON.stringify({ type: 'error', message: 'Login required to use controls' }));
                return null;
            }
            if (mode === 'whitelist' && client.user) {
                const isOwner = client.user.id === stream.user_id;
                const isWhitelisted = db.get(
                    'SELECT 1 FROM control_whitelist WHERE channel_id = ? AND user_id = ?',
                    [channel.id, client.user.id]
                );
                if (!isOwner && !isWhitelisted) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are not on the control whitelist' }));
                    return null;
                }
            } else if (mode === 'whitelist' && !client.user) {
                ws.send(JSON.stringify({ type: 'error', message: 'Login required for whitelist mode' }));
                return null;
            }
        }

        return { stream, user, channel };
    }

    /**
     * Handle key_down / key_up events (hold detection)
     */
    handleKeyEvent(ws, msg) {
        const client = this.viewerClients.get(ws);
        if (!client || !client.streamId) return;

        const { command, control_id } = msg;
        if (!command) return;

        const ctx = this.validateControlPermission(ws, client);
        if (!ctx) return;

        // Validate control exists, is keyboard type, and is enabled
        if (control_id) {
            const control = db.get('SELECT * FROM stream_controls WHERE id = ? AND stream_id = ?', [control_id, client.streamId]);
            if (!control) {
                ws.send(JSON.stringify({ type: 'error', message: 'Control not found' }));
                return;
            }
            if (control.control_type !== 'keyboard') {
                ws.send(JSON.stringify({ type: 'error', message: 'Control is not a keyboard type' }));
                return;
            }
            if (control.is_enabled === 0) {
                ws.send(JSON.stringify({ type: 'error', message: 'Control is disabled' }));
                return;
            }
        }

        // Check stream is live
        if (!ctx.stream.is_live) {
            ws.send(JSON.stringify({ type: 'error', message: 'Stream not live' }));
            return;
        }

        // Check hardware connection
        const hardwareWs = this.hardwareClients.get(ctx.user.stream_key);
        const hwConnected = hardwareWs && hardwareWs.readyState === WebSocket.OPEN;

        const holdKey = `${client.streamId}-key-${command}-${client.user?.id || 'anon'}`;
        const heldKeys = client.heldKeys;

        if (msg.type === 'key_down') {
            if (heldKeys.has(holdKey)) return;
            // Reject key_down if hardware is not connected
            if (!hwConnected) {
                ws.send(JSON.stringify({ type: 'error', message: 'Hardware not connected' }));
                return;
            }
            heldKeys.add(holdKey);
        } else {
            // key_up: always allow through to clean up state, even if hardware disconnected
            if (!heldKeys.has(holdKey)) return;
            heldKeys.delete(holdKey);
        }

        // Forward to hardware (if connected)
        if (hwConnected) {
            hardwareWs.send(JSON.stringify({
                type: msg.type, // key_down or key_up
                command,
                control_id,
                from_user: client.user?.username || 'anonymous',
                timestamp: new Date().toISOString(),
            }));
        }

        // Broadcast to viewers
        this.broadcastToViewers(ctx.user.stream_key, {
            type: msg.type === 'key_down' ? 'key_held' : 'key_released',
            command,
            by: client.user?.username || 'anonymous',
        });
    }

    /**
     * Handle video click (x, y normalized 0-1)
     */
    handleVideoClick(ws, msg) {
        const client = this.viewerClients.get(ws);
        if (!client || !client.streamId) return;

        const x = parseFloat(msg.x);
        const y = parseFloat(msg.y);
        if (isNaN(x) || isNaN(y) || x < 0 || x > 1 || y < 0 || y > 1) return;

        const ctx = this.validateControlPermission(ws, client);
        if (!ctx) return;

        // Check that video click is enabled
        if (ctx.channel && !ctx.channel.video_click_enabled) {
            ws.send(JSON.stringify({ type: 'error', message: 'Video click not enabled' }));
            return;
        }

        // Fixed anti-flood floor for video clicks (not user-configurable) — matches the
        // ≤20 commands/sec/user burst philosophy for the button controls above.
        const userId = client.user?.id || 'anon';
        const key = `${client.streamId}-click-${userId}`;
        const lastCmd = this.commandCounts.get(key) || 0;
        const CLICK_MIN_INTERVAL_MS = 50; // 20 clicks/sec ceiling
        if (Date.now() - lastCmd < CLICK_MIN_INTERVAL_MS) {
            ws.send(JSON.stringify({ type: 'cooldown', message: 'Click on cooldown' }));
            return;
        }
        this.commandCounts.set(key, Date.now());

        // Forward to hardware
        const hardwareWs = this.hardwareClients.get(ctx.user.stream_key);
        if (hardwareWs && hardwareWs.readyState === WebSocket.OPEN) {
            hardwareWs.send(JSON.stringify({
                type: 'video_click',
                x: Math.round(x * 10000) / 10000,
                y: Math.round(y * 10000) / 10000,
                from_user: client.user?.username || 'anonymous',
                timestamp: new Date().toISOString(),
            }));
        }

        // Broadcast click activity
        this.broadcastToViewers(ctx.user.stream_key, {
            type: 'video_click_activity',
            x: Math.round(x * 100) / 100,
            y: Math.round(y * 100) / 100,
            by: client.user?.username || 'anonymous',
        });

        ws.send(JSON.stringify({ type: 'ok', message: 'Click sent' }));
    }

    /**
     * Broadcast to all viewers watching a specific stream
     */
    broadcastToViewers(streamKey, data) {
        const user = db.getUserByStreamKey(streamKey);
        if (!user) return;

        const stream = db.getStreamByUserId(user.id);
        if (!stream) return;

        const msg = JSON.stringify(data);
        for (const [ws, client] of this.viewerClients) {
            if (client.streamId === stream.id && ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        }
    }

    close() {
        if (this.wss) {
            this.wss.clients.forEach(ws => ws.close());
            this.wss.close();
        }
    }
}

module.exports = new ControlServer();
