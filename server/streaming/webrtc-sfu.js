/**
 * OpenVibe.Live — WebRTC SFU via Mediasoup
 * 
 * Provides low-latency WebRTC streaming using Mediasoup as an SFU.
 * Producers (streamers) send media, consumers (viewers) receive it.
 * 
 * Also provides PlainRtpTransport-based consumers for extracting RTP
 * from the SFU — used by the restream manager to pipe WebRTC → FFmpeg → RTMP.
 */
const EventEmitter = require('events');
const config = require('../config');

let mediasoup;
try {
    mediasoup = require('mediasoup');
} catch {
    console.warn('[WebRTC] mediasoup not installed — WebRTC streaming disabled');
    console.warn('[WebRTC] Install with: npm install mediasoup');
}

class WebRTCSFU extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, { router: any, producers: Map, consumers: Map, transports: Map }>} */
        this.rooms = new Map();
        this.worker = null;
        this.ready = false;
    }

    async init() {
        if (!mediasoup) {
            console.warn('[WebRTC] Mediasoup not available, SFU disabled');
            return;
        }

        try {
            this.worker = await mediasoup.createWorker({
                logLevel: 'warn',
                rtcMinPort: config.mediasoup.minPort,
                rtcMaxPort: config.mediasoup.maxPort,
            });

            this.worker.on('died', () => {
                console.error('[WebRTC] Mediasoup Worker died! Restarting...');
                this.ready = false;
                // Close all rooms gracefully before reinit — prevents unhandled
                // errors from orphaned transports/consumers cascading into crashes.
                for (const roomId of this.rooms.keys()) {
                    try { this.closeRoom(roomId); } catch (e) {
                        console.warn(`[WebRTC] Error closing room ${roomId} after worker death:`, e.message);
                    }
                }
                this.rooms.clear();
                setTimeout(() => this.init(), 2000);
            });

            this.ready = true;
            console.log('[WebRTC] Mediasoup Worker started (PID:', this.worker.pid, ')');
        } catch (err) {
            console.error('[WebRTC] Failed to create Mediasoup worker:', err.message);
        }
    }

    /**
     * Create or get a room for a stream
     */
    async getOrCreateRoom(roomId) {
        if (this.rooms.has(roomId)) return this.rooms.get(roomId);

        if (!this.worker || !this.ready) {
            throw new Error('WebRTC SFU not initialized');
        }

        const router = await this.worker.createRouter({
            mediaCodecs: config.mediasoup.mediaCodecs,
        });

        const room = {
            router,
            producers: new Map(),
            consumers: new Map(),
            transports: new Map(),
            plainRecordingTimers: new Map(),
            plainRecordingTransportConsumers: new Map(),
        };

        this.rooms.set(roomId, room);
        console.log(`[WebRTC] Room created: ${roomId}`);
        return room;
    }

    /**
     * Get router RTP capabilities for a room
     */
    async getRouterCapabilities(roomId) {
        const room = await this.getOrCreateRoom(roomId);
        return room.router.rtpCapabilities;
    }

    /**
     * Create a WebRTC transport (for producer or consumer)
     */
    async createTransport(roomId, peerId, options = {}) {
        const room = await this.getOrCreateRoom(roomId);

        const transportOptions = {
            listenIps: [{
                ip: config.mediasoup.listenIp,
                announcedIp: config.mediasoup.announcedIp,
            }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            // Higher starting estimate → the bandwidth estimator lets viewers pull full-quality
            // video within the first second instead of climbing from 1 Mbps. It still adapts
            // down under real congestion; this only raises the initial ceiling.
            initialAvailableOutgoingBitrate: 3000000,
        };

        // Allow callers (e.g. WHIP ingest) to override transport settings.
        // iceConsentTimeout: 0 disables RFC 7675 consent checks — needed for
        // OBS/libdatachannel WHIP clients that don't respond to consent requests.
        if (typeof options.iceConsentTimeout === 'number') {
            transportOptions.iceConsentTimeout = options.iceConsentTimeout;
        }

        const transport = await room.router.createWebRtcTransport(transportOptions);

        console.log(`[WebRTC] Transport ${transport.id} (${peerId}) listenIp=${config.mediasoup.listenIp}, announcedIp=${config.mediasoup.announcedIp}`);

        transport.on('dtlsstatechange', (dtlsState) => {
            const localRole = transport.dtlsParameters?.role || 'unknown';
            console.log(`[WebRTC] Transport ${transport.id} (${peerId}) DTLS: ${dtlsState} local_role=${localRole}`);
            if (dtlsState === 'closed' || dtlsState === 'failed') {
                console.log(`[WebRTC] Closing transport ${transport.id} (${peerId}) due to DTLS ${dtlsState}`);
                transport.close();
            }
        });

        transport.on('icestatechange', (iceState) => {
            console.log(`[WebRTC] Transport ${transport.id} (${peerId}) ICE: ${iceState}`);
        });

        room.transports.set(`${peerId}-${transport.id}`, transport);

        const candidates = transport.iceCandidates;
        console.log(`[WebRTC] Transport ${transport.id} (${peerId}) created — ICE candidates:`, candidates.map(c => `${c.protocol}://${c.ip}:${c.port}`).join(', '));

        return {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        };
    }

    /**
     * Connect a transport (complete DTLS handshake)
     */
    async connectTransport(roomId, peerId, transportId, dtlsParameters) {
        const room = this.rooms.get(roomId);
        if (!room) throw new Error('Room not found');

        const transport = room.transports.get(`${peerId}-${transportId}`);
        if (!transport) throw new Error('Transport not found');

        console.log(`[WebRTC] connectTransport called for transport ${transport.id} (${peerId}) remote DTLS role=${dtlsParameters.role} fingerprints=${Array.isArray(dtlsParameters.fingerprints) ? dtlsParameters.fingerprints.map(f => f.algorithm).join(',') : 'none'}`);
        await transport.connect({ dtlsParameters });
        console.log(`[WebRTC] connectTransport request accepted for transport ${transport.id} (${peerId}); local DTLS role=${transport.dtlsParameters.role}`);
    }

    /**
     * Create a producer (streamer sending media)
     */
    async produce(roomId, peerId, transportId, kind, rtpParameters) {
        const room = this.rooms.get(roomId);
        if (!room) throw new Error('Room not found');

        const transport = room.transports.get(`${peerId}-${transportId}`);
        if (!transport) throw new Error('Transport not found');

        const producer = await transport.produce({ kind, rtpParameters });

        room.producers.set(producer.id, { producer, peerId, transportId });
        console.log(`[WebRTC] Producer created: ${producer.id} (${kind}) in room ${roomId} on transport ${transportId}`);

        producer.on('transportclose', () => {
            console.log(`[WebRTC] Producer ${producer.id} (${kind}) transport closed in room ${roomId}`);
            room.producers.delete(producer.id);
            this.emit('producer-removed', { roomId, producerId: producer.id, kind });
        });

        this.emit('producer-added', { roomId, producerId: producer.id, kind, peerId });

        return { id: producer.id };
    }

    /**
     * Create a consumer (viewer receiving media)
     */
    async consume(roomId, peerId, transportId, producerId, rtpCapabilities) {
        const room = this.rooms.get(roomId);
        if (!room) throw new Error('Room not found');

        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error('Cannot consume this producer');
        }

        const transport = room.transports.get(`${peerId}-${transportId}`);
        if (!transport) throw new Error('Transport not found');

        const consumer = await transport.consume({
            producerId,
            rtpCapabilities,
            paused: false,
        });

        room.consumers.set(consumer.id, { consumer, peerId });

        consumer.on('transportclose', () => {
            console.log(`[WebRTC] Consumer ${consumer.id} (${consumer.kind}) transport closed`);
            room.consumers.delete(consumer.id);
        });

        consumer.on('producerclose', () => {
            console.log(`[WebRTC] Consumer ${consumer.id} (${consumer.kind}) producer closed — closing consumer`);
            try { consumer.close(); } catch {}
            room.consumers.delete(consumer.id);
        });

        // Log the producer state and consumer startup state
        const producerEntry = room.producers.get(producerId);
        const producerTransportKey = producerEntry ? `${producerEntry.peerId}-${producerEntry.transportId}` : null;
        const producerTransport = producerTransportKey ? room.transports.get(producerTransportKey) : null;
        console.log(`[WebRTC] Consumer ${consumer.id} (${consumer.kind}) for ${peerId} in room ${roomId} — paused=${consumer.paused} producer transport state: ${producerTransport?.connectionState || 'unknown'}`);

        // For video consumers, request a keyframe multiple times so late-joining viewers
        // do not have to wait for an OBS GOP boundary or missed single keyframe request.
        if (consumer.kind === 'video') {
            const scheduleKeyframe = (delayMs, attempt) => {
                setTimeout(async () => {
                    try {
                        await consumer.requestKeyFrame();
                        console.log(`[WebRTC] Keyframe request #${attempt} sent for video consumer ${consumer.id} (${peerId})`);
                    } catch (err) {
                        console.warn(`[WebRTC] Keyframe request #${attempt} failed for consumer ${consumer.id} (${peerId}):`, err.message);
                    }
                }, delayMs);
            };
            scheduleKeyframe(0, 1);
            scheduleKeyframe(400, 2);
            scheduleKeyframe(1200, 3);
        }

        return {
            id: consumer.id,
            producerId: consumer.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
        };
    }

    /**
     * Create a Plain RTP transport (for FFmpeg-based streaming)
     */
    async createPlainTransport(roomId) {
        const room = await this.getOrCreateRoom(roomId);

        const transport = await room.router.createPlainTransport({
            listenIp: { ip: config.mediasoup.listenIp, announcedIp: config.mediasoup.announcedIp },
            rtcpMux: false,
            comedia: true,
        });

        return {
            id: transport.id,
            ip: transport.tuple.localIp,
            port: transport.tuple.localPort,
            rtcpPort: transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined,
        };
    }

    /**
     * Create a PlainRtpTransport consumer for piping media to FFmpeg.
     * Used for WebRTC → RTMP restreaming.
     * 
     * @param {string} roomId - SFU room ID (e.g., 'stream-42')
     * @param {string} producerId - The producer to consume
     * @param {string} remoteIp - Where to send RTP (FFmpeg listen address)
     * @param {number} remoteRtpPort - FFmpeg RTP listen port
     * @param {number} remoteRtcpPort - FFmpeg RTCP listen port
     * @returns {{ transportId, consumerId, kind, rtpParameters, payloadType, ssrc, clockRate }}
     */
    async createPlainConsumer(roomId, producerId, remoteIp, remoteRtpPort, remoteRtcpPort) {
        const room = this.rooms.get(roomId);
        if (!room) throw new Error(`Room ${roomId} not found`);

        // Every rtcpMux:false plain transport burns TWO ports out of the worker's
        // rtcMinPort..rtcMaxPort range, which the .env.example sizes at just 101 ports
        // (10000-10100) and which WebRtcTransports draw from as well. Exhaustion shows up
        // here as an opaque mediasoup error, and for the RS passthrough relay that means
        // _run() throws -> _scheduleRestart() -> a brand new producer (new SSRC) on
        // RobotStreamer. Name the failure so it is diagnosable instead of looking like a
        // random relay restart.
        let transport;
        try {
            transport = await room.router.createPlainTransport({
                listenIp: { ip: '127.0.0.1' },
                rtcpMux: false,
                comedia: false,
            });
        } catch (err) {
            console.error(`[WebRTC] createPlainTransport failed in room ${roomId} ` +
                `(RTC port range ${config.mediasoup.minPort}-${config.mediasoup.maxPort}, ` +
                `${room.transports.size} transports open in this room): ${err.message}`);
            throw err;
        }

        await transport.connect({
            ip: remoteIp,
            port: remoteRtpPort,
            rtcpPort: remoteRtcpPort,
        });

        const consumer = await transport.consume({
            producerId,
            rtpCapabilities: room.router.rtpCapabilities,
            paused: false,
        });

        // Track for cleanup
        const key = `plain-${transport.id}`;
        room.transports.set(key, transport);
        room.consumers.set(consumer.id, { consumer, peerId: '__restream__' });

        const clearPlainRecordingTimers = () => {
            const timers = room.plainRecordingTimers.get(consumer.id) || [];
            for (const timer of timers) {
                try { clearTimeout(timer); } catch {}
            }
            room.plainRecordingTimers.delete(consumer.id);
            room.plainRecordingTransportConsumers.delete(transport.id);
        };

        consumer.on('transportclose', () => {
            room.consumers.delete(consumer.id);
            clearPlainRecordingTimers();
        });

        consumer.on('producerclose', () => {
            // Producer died (broadcaster disconnected) — close transport to free the RTP port
            room.consumers.delete(consumer.id);
            clearPlainRecordingTimers();
            room.transports.delete(key);
            try { transport.close(); } catch {}
        });

        const codec = consumer.rtpParameters.codecs[0];
        const encoding = consumer.rtpParameters.encodings?.[0];

        if (consumer.kind === 'video' && typeof consumer.requestKeyFrame === 'function') {
            const scheduleKeyframe = (delayMs, attempt) => {
                const timer = setTimeout(async () => {
                    try {
                        await consumer.requestKeyFrame();
                        console.log(`[WebRTC] Recording keyframe request #${attempt} sent for consumer ${consumer.id} in room ${roomId}`);
                    } catch (err) {
                        console.warn(`[WebRTC] Recording keyframe request #${attempt} failed for consumer ${consumer.id} in room ${roomId}:`, err.message);
                    }
                }, delayMs);
                const timers = room.plainRecordingTimers.get(consumer.id) || [];
                timers.push(timer);
                room.plainRecordingTimers.set(consumer.id, timers);
            };

            room.plainRecordingTransportConsumers.set(transport.id, consumer.id);
            scheduleKeyframe(0, 1);
            scheduleKeyframe(500, 2);
            scheduleKeyframe(1500, 3);
            scheduleKeyframe(3000, 4);
        }

        return {
            transportId: transport.id,
            consumerId: consumer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            payloadType: codec?.payloadType,
            clockRate: codec?.clockRate,
            mimeType: codec?.mimeType,
            channels: codec?.channels,
            ssrc: encoding?.ssrc,
            codecParameters: codec?.parameters,
            rtcpFeedback: codec?.rtcpFeedback || [],
            headerExtensions: consumer.rtpParameters.headerExtensions || [],
        };
    }

    /**
     * Close a PlainRtpTransport and its consumer.
     * @param {string} roomId
     * @param {string} transportId
     */
    closePlainConsumer(roomId, transportId) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const key = `plain-${transportId}`;
        const transport = room.transports.get(key);
        if (transport) {
            const consumerId = room.plainRecordingTransportConsumers.get(transportId);
            const timers = room.plainRecordingTimers.get(consumerId) || [];
            for (const timer of timers) {
                try { clearTimeout(timer); } catch {}
            }
            room.plainRecordingTimers.delete(consumerId);
            room.plainRecordingTransportConsumers.delete(transportId);
            // Drop the consumer entry here rather than waiting on the 'transportclose'
            // event, so a concurrent requestConsumerKeyFrame() can never reach a consumer
            // whose transport is already gone.
            if (consumerId) room.consumers.delete(consumerId);
            try { transport.close(); } catch {}
            room.transports.delete(key);
        }
    }

    /**
     * Direct (in-process) RTP passthrough consumer for the RobotStreamer raw relay.
     * A DirectTransport delivers the producer's ENCODED RTP to a callback in-process —
     * lossless (no UDP socket, no packet drop) and with zero decode/re-encode. The relay
     * forwards these packets straight into a werift PeerConnection that produces to RS,
     * so RobotStreamer receives goosely's bit-exact original video (no second encode).
     *
     * Uses this router's own capabilities so canConsume always succeeds; the caller reads
     * the returned consumer's payload type and mirrors it downstream. Subscribe to
     * consumer.on('rtp', buf) for packets and call consumer.requestKeyFrame() on RS PLI.
     * @returns {Promise<{ consumer, transport, transportKey, rtpParameters }>}
     */
    async createDirectPassthroughConsumer(roomId, producerId, rtpCapabilities = null) {
        const room = this.rooms.get(roomId);
        if (!room) throw new Error('Room not found');
        const caps = rtpCapabilities || room.router.rtpCapabilities;
        if (!room.router.canConsume({ producerId, rtpCapabilities: caps })) {
            throw new Error('Cannot consume this producer for passthrough');
        }

        const transport = await room.router.createDirectTransport();
        const consumer = await transport.consume({ producerId, rtpCapabilities: caps, paused: false });

        const transportKey = `direct-${transport.id}`;
        room.transports.set(transportKey, transport);
        room.consumers.set(consumer.id, { consumer, peerId: '__rs_passthrough__' });

        consumer.on('transportclose', () => {
            room.consumers.delete(consumer.id);
            room.transports.delete(transportKey);
        });
        consumer.on('producerclose', () => {
            try { transport.close(); } catch {}
            room.consumers.delete(consumer.id);
            room.transports.delete(transportKey);
        });

        // Nudge the source for early keyframes so RS gets a decodable picture fast.
        if (consumer.kind === 'video') {
            for (const d of [0, 400, 1200]) setTimeout(() => { consumer.requestKeyFrame().catch(() => {}); }, d);
        }

        return { consumer, transport, transportKey, rtpParameters: consumer.rtpParameters };
    }

    closeDirectPassthroughConsumer(roomId, transportKey) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        const transport = room.transports.get(transportKey);
        if (transport) {
            try { transport.close(); } catch {}
            room.transports.delete(transportKey);
        }
    }

    /**
     * Snapshot a plain consumer's liveness. When a downstream forwarder (the RS passthrough
     * relay) stops seeing RTP, this says whether the fault is here — consumer closed by some
     * other subsystem, paused, producer gone, or score collapsed — or further downstream.
     * Never throws; returns a flat object safe to drop straight into a log line.
     * @param {string} roomId
     * @param {string} consumerId
     */
    plainConsumerState(roomId, consumerId) {
        const room = this.rooms.get(roomId);
        if (!room) return { found: false, reason: 'room-gone' };
        const entry = room.consumers.get(consumerId);
        if (!entry?.consumer) return { found: false, reason: 'consumer-gone' };
        const c = entry.consumer;
        let producerAlive = false;
        try { producerAlive = !!room.producers.get(c.producerId) || !c.producerPaused; } catch { /* */ }
        return {
            found: true,
            closed: !!c.closed,
            paused: !!c.paused,
            producerPaused: !!c.producerPaused,
            producerAlive,
            score: c.score?.score ?? null,
            producerScore: c.score?.producerScore ?? null,
        };
    }

    /** Ask a consumer's source to emit a keyframe (relays a downstream PLI to the encoder). */
    async requestConsumerKeyFrame(roomId, consumerId) {
        const room = this.rooms.get(roomId);
        const entry = room?.consumers.get(consumerId);
        if (entry?.consumer && !entry.consumer.closed && entry.consumer.kind === 'video') {
            try { await entry.consumer.requestKeyFrame(); } catch { /* transient */ }
        }
    }

    /**
     * Check if a room has producers.
     * @param {string} roomId
     * @returns {boolean}
     */
    hasProducers(roomId) {
        const room = this.rooms.get(roomId);
        return room ? room.producers.size > 0 : false;
    }

    /**
     * Find a producer by kind (audio/video) in a room.
     * @param {string} roomId
     * @param {string} kind - 'audio' or 'video'
     * @returns {{ id: string, peerId: string }|null}
     */
    findProducerByKind(roomId, kind) {
        const room = this.rooms.get(roomId);
        if (!room) return null;
        for (const [id, { producer, peerId }] of room.producers) {
            if (producer.kind === kind && !producer.closed) return { id, peerId };
        }
        return null;
    }

    /**
     * Wait for a producer of a given kind to appear in a room.
     * Resolves with the producer info, or rejects on timeout.
     * @param {string} roomId
     * @param {string} kind - 'audio' or 'video'
     * @param {number} [timeoutMs=30000]
     * @returns {Promise<{ id: string, peerId: string }>}
     */
    waitForProducer(roomId, kind, timeoutMs = 30000) {
        const existing = this.findProducerByKind(roomId, kind);
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener('producer-added', handler);
                reject(new Error(`Timeout waiting for ${kind} producer in ${roomId}`));
            }, timeoutMs);

            const handler = (ev) => {
                if (ev.roomId === roomId && ev.kind === kind) {
                    clearTimeout(timer);
                    this.removeListener('producer-added', handler);
                    resolve({ id: ev.producerId, peerId: ev.peerId });
                }
            };

            this.on('producer-added', handler);
        });
    }

    /**
     * Get all producer IDs in a room
     */
    getProducers(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return [];
        return Array.from(room.producers.entries())
            .filter(([, { producer }]) => !producer.closed)
            .map(([id, { producer, peerId, transportId }]) => {
                // Check if the producer's backing transport is actually connected
                const tKey = `${peerId}-${transportId}`;
                const transport = room.transports.get(tKey);
                const dtlsState = transport ? transport.dtlsState : 'no-transport';
                const iceState = transport ? transport.iceState : 'no-transport';
                return { id, peerId, kind: producer.kind, paused: producer.paused, dtlsState, iceState };
            });
    }

    /**
     * Get viewer count for a room
     */
    getViewerCount(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return 0;
        // Count unique consumer peers
        const peers = new Set();
        room.consumers.forEach(({ peerId }) => peers.add(peerId));
        return peers.size;
    }

    /**
     * Close a room and all its transports
     */
    closeRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        room.transports.forEach(t => t.close());
        room.router.close();
        this.rooms.delete(roomId);
        console.log(`[WebRTC] Room closed: ${roomId}`);
    }

    /**
     * Close all rooms
     */
    closeAll() {
        for (const roomId of this.rooms.keys()) {
            this.closeRoom(roomId);
        }
        if (this.worker) {
            this.worker.close();
        }
    }
}

module.exports = new WebRTCSFU();
