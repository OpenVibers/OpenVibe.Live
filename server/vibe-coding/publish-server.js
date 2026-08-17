'use strict';

const WebSocket = require('ws');

const { extractWsToken, authenticateWs } = require('../auth/auth');
const vibeService = require('./service');

const VIBE_CODING_PUBLISH_SCOPES = new Set(['vibe_coding_publish', 'stream']);

function hasVibeCodingPublishScope(user) {
    return !!(user && Array.isArray(user.scopes) && user.scopes.some((scope) => VIBE_CODING_PUBLISH_SCOPES.has(scope)));
}

class VibeCodingPublishServer {
    constructor(chatServer, db) {
        this.chatServer = chatServer;
        this.db = db;
        this.wss = null;
        this.clients = new Map();
    }

    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });
        return this.wss;
    }

    handleUpgrade(req, socket, head) {
        if (!req.url || !req.url.startsWith('/ws/vibe-coding/publish')) {
            return false;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
        });
        return true;
    }

    handleConnection(ws, req) {
        const token = extractWsToken(req);
        const user = authenticateWs(token);
        if (!user) {
            ws.close(4401, 'Authentication required');
            return;
        }
        if (user._authSource === 'api_token' && !hasVibeCodingPublishScope(user)) {
            ws.close(4403, 'API token requires vibe_coding_publish scope');
            return;
        }

        const params = new URL(req.url, 'http://localhost').searchParams;
        const managedStreamId = parseInt(params.get('managedStreamId') || '', 10);
        const managedStream = this.db.getManagedStreamById(managedStreamId);
        if (!Number.isFinite(managedStreamId) || !managedStream || managedStream.user_id !== user.id) {
            ws.close(4404, 'Managed stream not found');
            return;
        }

        const client = {
            user,
            managedStreamId,
            slotSlug: params.get('slotSlug') || managedStream.slug || null,
            sessionKey: null,
        };
        this.clients.set(ws, client);

        const feed = vibeService.getProjectedViewerFeed(managedStreamId, 1);
        const liveStream = vibeService.getLiveStreamByManagedStreamId(managedStreamId);
        this.sendTo(ws, {
            type: 'vibe-coding.ready',
            ok: true,
            managed_stream_id: managedStreamId,
            slot_slug: client.slotSlug,
            live_stream_id: liveStream?.id || null,
            settings: feed.settings,
            timestamp: new Date().toISOString(),
        });

        ws.on('message', (data) => {
            this.handleMessage(ws, data);
        });

        ws.on('close', () => {
            if (client.sessionKey) {
                vibeService.markSessionEnded(client.managedStreamId, client.sessionKey);
            }
            this.clients.delete(ws);
        });
    }

    handleMessage(ws, data) {
        const client = this.clients.get(ws);
        if (!client) return;

        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            this.sendTo(ws, { type: 'vibe-coding.error', error: 'Invalid JSON payload' });
            return;
        }

        if (!message || typeof message !== 'object') {
            this.sendTo(ws, { type: 'vibe-coding.error', error: 'Invalid payload' });
            return;
        }

        switch (message.type) {
            case 'vibe-coding.hello':
                client.sessionKey = String(message.sessionKey || '').trim() || null;
                if (!client.sessionKey) {
                    this.sendTo(ws, { type: 'vibe-coding.error', error: 'sessionKey is required' });
                    return;
                }
                vibeService.upsertVibeCodingSession({
                    managedStreamId: client.managedStreamId,
                    userId: client.user.id,
                    slotSlug: client.slotSlug,
                    helloMessage: message,
                });
                this.sendTo(ws, {
                    type: 'vibe-coding.hello.ack',
                    session_key: client.sessionKey,
                    timestamp: new Date().toISOString(),
                });
                return;

            case 'vibe-coding.event':
                if (!message.event || typeof message.event !== 'object') {
                    this.sendTo(ws, { type: 'vibe-coding.error', error: 'event payload is required' });
                    return;
                }
                if (!client.sessionKey) {
                    client.sessionKey = String(message.sessionKey || message.event.sessionKey || '').trim() || null;
                }
                if (!client.sessionKey) {
                    this.sendTo(ws, { type: 'vibe-coding.error', error: 'sessionKey must be established before events are accepted' });
                    return;
                }
                this.processEvent(ws, client, message.event);
                return;

            case 'vibe-coding.ping':
                this.sendTo(ws, { type: 'vibe-coding.pong', timestamp: new Date().toISOString() });
                return;

            default:
                this.sendTo(ws, { type: 'vibe-coding.error', error: `Unsupported message type: ${message.type}` });
        }
    }

    processEvent(ws, client, event) {
        if (!event.eventId || !event.eventType) {
            this.sendTo(ws, { type: 'vibe-coding.error', error: 'eventId and eventType are required' });
            return;
        }

        const liveStream = vibeService.getLiveStreamByManagedStreamId(client.managedStreamId);
        vibeService.storeVibeCodingEvent({
            managedStreamId: client.managedStreamId,
            userId: client.user.id,
            streamId: liveStream?.id || null,
            event,
        });

        const settings = vibeService.getManagedStreamVibeCodingSettings(client.managedStreamId);
        const projected = vibeService.projectViewerEvent(event, settings);
        if (projected && liveStream?.id) {
            this.chatServer.broadcastToStream(liveStream.id, {
                type: 'vibe-coding',
                managed_stream_id: client.managedStreamId,
                slot_slug: client.slotSlug,
                delay_ms: settings.delay_ms,
                event: projected,
            });
        }

        this.sendTo(ws, {
            type: 'vibe-coding.ack',
            event_id: event.eventId,
            live_stream_id: liveStream?.id || null,
            delivered: !!(projected && liveStream?.id),
            timestamp: new Date().toISOString(),
        });
    }

    sendTo(ws, payload) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }
}

module.exports = VibeCodingPublishServer;