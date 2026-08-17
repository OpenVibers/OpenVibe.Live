/**
 * OpenVibe.Live — JSMPEG WebSocket Relay
 * 
 * Receives MPEG1 video/audio from FFmpeg via HTTP POST,
 * relays to browser clients via WebSocket (JSMpeg.js decoder).
 * 
 * Architecture (per RobotStreamer):
 *   FFmpeg → HTTP POST → this relay → WebSocket → browser canvas
 */
const http = require('http');
const WebSocket = require('ws');

const MAX_WS_BACKPRESSURE = 512 * 1024;

function matchesStreamPath(url, streamKey) {
    try {
        const pathname = new URL(url || '/', 'http://localhost').pathname;
        const parts = pathname.split('/').filter(Boolean);
        return parts[0] === streamKey;
    } catch {
        return false;
    }
}

class JSMPEGRelay {
    constructor() {
        /** @type {Map<string, { videoWss: WebSocket.Server, audioWss: WebSocket.Server, videoServer: http.Server, audioServer: http.Server }>} */
        this.channels = new Map();
        this.nextVideoPort = 9710;
        this.nextAudioPort = 9711;
    }

    /**
     * Create a new JSMPEG channel for a stream
     * @param {string} streamKey - Unique stream key
     * @returns {{ videoPort: number, audioPort: number }}
     */
    createChannel(streamKey) {
        if (this.channels.has(streamKey)) {
            const ch = this.channels.get(streamKey);
            return { videoPort: ch.videoPort, audioPort: ch.audioPort };
        }

        const videoPort = this.nextVideoPort;
        const audioPort = this.nextAudioPort;
        this.nextVideoPort += 2;
        this.nextAudioPort += 2;

        // Shared data tap set — restream manager registers callbacks here
        const dataTaps = new Set();

        // ── Video relay ──────────────────────────────────────
        const videoWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
        const videoServer = http.createServer((req, res) => {
            // FFmpeg sends MPEG1 data via HTTP POST
            req.socket.setNoDelay(true);
            if (req.method === 'POST' && matchesStreamPath(req.url, streamKey)) {
                req.on('data', (chunk) => {
                    // Broadcast to WebSocket viewers
                    if (videoWss.clients.size > 0) {
                        videoWss.clients.forEach(client => {
                            if (client.readyState !== WebSocket.OPEN) return;
                            if (client.bufferedAmount > MAX_WS_BACKPRESSURE) return;
                            client.send(chunk, { binary: true, compress: false }, () => {});
                        });
                    }
                    // Feed data taps (restream FFmpeg processes)
                    if (dataTaps.size > 0) {
                        for (const tap of dataTaps) {
                            try { tap('video', chunk); } catch (e) { console.error(`[JSMPEG] Video data tap error (${streamKey}):`, e.message); }
                        }
                    }
                });
                req.on('end', () => {
                    res.writeHead(200);
                    res.end();
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        videoServer.on('upgrade', (req, socket, head) => {
            videoWss.handleUpgrade(req, socket, head, (ws) => {
                videoWss.emit('connection', ws, req);
                console.log(`[JSMPEG] Video viewer connected (${streamKey}), total: ${videoWss.clients.size}`);
                ws.on('close', () => {
                    console.log(`[JSMPEG] Video viewer disconnected (${streamKey}), total: ${videoWss.clients.size}`);
                });
            });
        });

        videoServer.listen(videoPort, () => {
            console.log(`[JSMPEG] Video relay for ${streamKey} on port ${videoPort}`);
        });

        // ── Audio relay ──────────────────────────────────────
        const audioWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
        const audioServer = http.createServer((req, res) => {
            req.socket.setNoDelay(true);
            if (req.method === 'POST' && matchesStreamPath(req.url, streamKey)) {
                req.on('data', (chunk) => {
                    // Broadcast to WebSocket viewers
                    if (audioWss.clients.size > 0) {
                        audioWss.clients.forEach(client => {
                            if (client.readyState !== WebSocket.OPEN) return;
                            if (client.bufferedAmount > MAX_WS_BACKPRESSURE) return;
                            client.send(chunk, { binary: true, compress: false }, () => {});
                        });
                    }
                    // Feed data taps (restream FFmpeg processes)
                    if (dataTaps.size > 0) {
                        for (const tap of dataTaps) {
                            try { tap('audio', chunk); } catch (e) { console.error(`[JSMPEG] Audio data tap error (${streamKey}):`, e.message); }
                        }
                    }
                });
                req.on('end', () => {
                    res.writeHead(200);
                    res.end();
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        audioServer.on('upgrade', (req, socket, head) => {
            audioWss.handleUpgrade(req, socket, head, (ws) => {
                audioWss.emit('connection', ws, req);
            });
        });

        audioServer.listen(audioPort, () => {
            console.log(`[JSMPEG] Audio relay for ${streamKey} on port ${audioPort}`);
        });

        this.channels.set(streamKey, {
            videoWss, audioWss, videoServer, audioServer,
            videoPort, audioPort,
            dataTaps,
        });

        return { videoPort, audioPort };
    }

    /**
     * Register a data tap for restreaming. Callback receives (type, chunk)
     * where type is 'video' or 'audio' and chunk is a Buffer.
     * @param {string} streamKey
     * @param {function} callback - (type: 'video'|'audio', chunk: Buffer) => void
     * @returns {boolean} true if channel exists and tap was registered
     */
    registerDataTap(streamKey, callback) {
        const ch = this.channels.get(streamKey);
        if (!ch) return false;
        ch.dataTaps.add(callback);
        return true;
    }

    /**
     * Unregister a data tap.
     */
    unregisterDataTap(streamKey, callback) {
        const ch = this.channels.get(streamKey);
        if (!ch?.dataTaps) return;
        ch.dataTaps.delete(callback);
    }

    /**
     * Get viewer count for a channel
     */
    getViewerCount(streamKey) {
        const ch = this.channels.get(streamKey);
        if (!ch) return 0;
        return ch.videoWss.clients.size;
    }

    /**
     * Destroy a channel when stream ends
     */
    destroyChannel(streamKey) {
        const ch = this.channels.get(streamKey);
        if (!ch) return;

        ch.dataTaps.clear();
        ch.videoWss.clients.forEach(c => c.close());
        ch.audioWss.clients.forEach(c => c.close());
        ch.videoServer.close();
        ch.audioServer.close();
        this.channels.delete(streamKey);
        console.log(`[JSMPEG] Channel destroyed: ${streamKey}`);
    }

    /**
     * Get channel info
     */
    getChannelInfo(streamKey) {
        const ch = this.channels.get(streamKey);
        if (!ch) return null;
        return {
            videoPort: ch.videoPort,
            audioPort: ch.audioPort,
            viewers: ch.videoWss.clients.size,
        };
    }

    /**
     * Close all channels
     */
    closeAll() {
        for (const key of this.channels.keys()) {
            this.destroyChannel(key);
        }
    }
}

module.exports = new JSMPEGRelay();
