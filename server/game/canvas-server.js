const { WebSocketServer, WebSocket } = require('ws');
const { authenticateWs } = require('../auth/auth');
const canvasService = require('./canvas-service');

class CanvasServer {
    constructor() {
        this.wss = null;
        this.clients = new Map();
        this.bound = false;
    }

    init() {
        if (this.wss) return;
        this.wss = new WebSocketServer({ noServer: true });
        this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
        if (!this.bound) {
            canvasService.on('tile_patch', (tile) => this.broadcast({ type: 'tile_patch', tile }));
            canvasService.on('bulk_patch', (tiles) => this.broadcast({ type: 'bulk_patch', tiles }));
            canvasService.on('board_state', (settings) => this.broadcast({ type: 'board_state', settings }));
            canvasService.on('board_reset', () => this.broadcast({ type: 'board_reset' }));
            this.bound = true;
        }
        console.log('[Canvas WS] Ready');
    }

    handleUpgrade(req, socket, head) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname !== '/ws/canvas') return false;
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
        return true;
    }

    onConnection(ws, req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        const user = authenticateWs(token);
        const client = {
            user,
            ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
            cursor: null,
        };
        this.clients.set(ws, client);
        this.send(ws, {
            type: 'presence_snapshot',
            users: this.getPresence(),
        });
        this.broadcastPresence();

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === 'cursor' && Number.isInteger(msg.x) && Number.isInteger(msg.y)) {
                client.cursor = { x: msg.x, y: msg.y };
                this.broadcastPresence();
            }
        });

        ws.on('close', () => {
            this.clients.delete(ws);
            this.broadcastPresence();
        });
    }

    getPresence() {
        const users = [];
        for (const [, client] of this.clients) {
            users.push({
                username: client.user?.display_name || client.user?.username || 'viewer',
                user_id: client.user?.id || null,
                cursor: client.cursor,
            });
        }
        return users;
    }

    broadcastPresence() {
        this.broadcast({
            type: 'presence',
            users: this.getPresence(),
            count: this.clients.size,
        });
    }

    send(ws, payload) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    broadcast(payload) {
        const raw = JSON.stringify(payload);
        for (const [ws] of this.clients) {
            if (ws.readyState === WebSocket.OPEN) ws.send(raw);
        }
    }

    close() {
        if (this.wss) this.wss.close();
        this.wss = null;
        this.clients.clear();
    }
}

module.exports = new CanvasServer();
