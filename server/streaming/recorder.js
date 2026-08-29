/**
 * OpenVibe.Live — Stream Recorder (OpenVibe.Media backed)
 *
 * The old in-process recorder spawned ffmpeg locally (RTMP pull / PlainRTP → file).
 * Recording is now owned by the OpenVibe.Media service; this module keeps the same
 * call surface for the streaming stack but delegates the heavy lifting:
 *
 *   RTMP        → media.createVod() + media.ingestRtmp(rtmp://127.0.0.1:1935/live/<key>)
 *                 (Media pulls the local RTMP endpoint with its own ffmpeg)
 *   WebRTC/WHIP → media.createVod() + media.ingestRtpStart() → mediasoup PlainRTP
 *                 consumers pointed at 127.0.0.1:<ports Media allocated (12000-12199)>
 *   Browser MediaRecorder chunks → chunk sessions proxied to Media's chunks endpoints
 *                 (driven by server/media-proxy/vods.js; session state tracked here)
 *   JSMPEG      → not supported by Media API v1 (no mpeg-ts push ingest).
 *                 TODO(contract): jsmpeg recording is skipped until Media grows an ingest for it.
 *
 * On stream end: ingestRtpStop / finalizeVod. Media probes, thumbnails, and fires the
 * vod.ready webhook (see server/media-proxy/webhook.js).
 */
'use strict';
const db = require('../db/database');
const media = require('../media-client');

const WEBRTC_PROTOCOLS = new Set(['webrtc', 'browser', 'screen', 'whip']);

class StreamRecorder {
    constructor() {
        /**
         * streamId → {
         *   vodId, protocol, mode, clipsOnly, startedAt, part, baseTitle,
         *   type: 'rtmp' | 'rtp' | 'chunks',
         *   webrtcState?: { roomId, videoTransportId, audioTransportId },
         *   _cancel?: boolean
         * }
         */
        this.activeRecordings = new Map();
        this._finalizing = new Set();
        this._healAttempts = new Map();
    }

    _title(stream, opts = {}) {
        const part = opts.part || 1;
        const baseTitle = opts.baseTitle || stream.title || 'Stream Recording';
        return part > 1 ? `${baseTitle} (Part ${part})` : baseTitle;
    }

    /**
     * Start a server-side recording for a stream via OpenVibe.Media.
     * @param {number} streamId
     * @param {string} protocol - 'rtmp' | 'jsmpeg' | 'webrtc' | 'browser' | 'screen' | 'whip'
     * @param {{ streamKey?: string, videoPort?: number }} endpoint
     * @param {{ mode?: 'vod'|'clips', part?: number, baseTitle?: string }} opts
     */
    startRecording(streamId, protocol, endpoint = {}, opts = {}) {
        if (this.activeRecordings.has(streamId)) {
            console.log(`[VOD] Already recording stream ${streamId}`);
            return;
        }
        const stream = db.getStreamById(streamId);
        if (!stream) {
            console.error(`[VOD] Cannot record — stream ${streamId} not found`);
            return;
        }
        if (protocol === 'jsmpeg') {
            // TODO(contract): Media API v1 has no mpeg-ts/jsmpeg ingest — jsmpeg streams
            // are not server-recorded after the media split.
            console.warn(`[VOD] jsmpeg recording not supported by OpenVibe.Media — skipping stream ${streamId}`);
            return;
        }

        const mode = opts.mode || 'vod';
        const rec = {
            vodId: null,
            protocol,
            endpoint,
            mode,
            clipsOnly: mode === 'clips',
            startedAt: Date.now(),
            part: opts.part || 1,
            baseTitle: opts.baseTitle || stream.title || 'Stream Recording',
            type: protocol === 'rtmp' ? 'rtmp' : 'rtp',
            webrtcState: null,
            _cancel: false,
        };
        this.activeRecordings.set(streamId, rec);

        const run = protocol === 'rtmp'
            ? this._startRtmpRecording(streamId, stream, rec, endpoint, opts)
            : this._startRtpRecording(streamId, stream, rec, opts);

        run.catch((err) => {
            console.error(`[VOD] Recording start failed for stream ${streamId} (${protocol}):`, err.message);
            // _createVod may already have made the VOD row in Media before ingest failed
            // (e.g. "Disk critically low — recording refused"). Leaving it behind creates a
            // ghost with no file that shows up as a 0:00 VOD and — worse — clogs Media's
            // offload sweep, which is exactly what needs to run when the disk is full.
            this._abort(streamId, rec).catch(() => {});
        });
    }

    async _createVod(streamId, stream, rec, opts) {
        const { id } = await media.createVod({
            title: this._title(stream, opts),
            stream_id: streamId,
            stream_key: rec.endpoint?.streamKey || stream.managed_stream_key || undefined,
            managed_stream_id: stream.managed_stream_id || undefined,
            user_id: stream.user_id,
            clips_only: rec.clipsOnly || undefined,
            visibility: db.resolveStreamVodVisibility(stream),
            meta: {
                protocol: rec.protocol,
                mode: rec.mode,
                clips_only: rec.clipsOnly,
                part: rec.part,
            },
        });
        rec.vodId = id;
        return id;
    }

    async _startRtmpRecording(streamId, stream, rec, endpoint) {
        if (!endpoint.streamKey) throw new Error('RTMP recording needs a stream key');
        const config = require('../config');
        await this._createVod(streamId, stream, rec, rec);
        if (rec._cancel) return this._abort(streamId, rec);
        const rtmpUrl = `rtmp://127.0.0.1:${config.rtmp.port}/live/${endpoint.streamKey}`;
        await media.ingestRtmp(rec.vodId, rtmpUrl);
        console.log(`[VOD] Media RTMP ingest started: stream ${streamId} → vod ${rec.vodId} (${rec.mode})`);
    }

    async _startRtpRecording(streamId, stream, rec) {
        const webrtcSFU = require('./webrtc-sfu');
        const roomId = `stream-${streamId}`;

        // Wait for the broadcaster's video producer (up to 60s — same as the old recorder).
        let videoProducer;
        try {
            videoProducer = await webrtcSFU.waitForProducer(roomId, 'video', 60000);
        } catch {
            console.warn(`[VOD] No video producer for stream ${streamId} within timeout — recording not started`);
            this.activeRecordings.delete(streamId);
            return;
        }
        if (rec._cancel || !this.activeRecordings.has(streamId)) return;
        const audioProducer = webrtcSFU.findProducerByKind(roomId, 'audio');

        // Codec info for Media's SDP: mimeType/clockRate from the producer; payload type
        // from the router's preferred PT (that's what the PlainRTP consumer will emit).
        // TODO(contract): rtp/start wants codec params before the consumer exists — the
        // payloadType is predicted from router capabilities and verified after consume.
        const room = webrtcSFU.rooms?.get(roomId);
        const routerCodecs = room?.router?.rtpCapabilities?.codecs || [];
        const codecInfo = (producerInfo, kind) => {
            if (!producerInfo || !room) return null;
            const entry = room.producers.get(producerInfo.id);
            const pCodec = entry?.producer?.rtpParameters?.codecs?.[0];
            if (!pCodec) return null;
            const routerMatch = routerCodecs.find(rc => rc.mimeType.toLowerCase() === pCodec.mimeType.toLowerCase());
            return {
                payloadType: routerMatch?.preferredPayloadType || pCodec.payloadType,
                codec: (pCodec.mimeType || `${kind}/unknown`).split('/')[1],
                clockRate: pCodec.clockRate,
                ...(kind === 'audio' && pCodec.channels ? { channels: pCodec.channels } : {}),
            };
        };
        const video = codecInfo(videoProducer, 'video');
        const audio = codecInfo(audioProducer, 'audio');
        if (!video) {
            console.warn(`[VOD] Could not resolve video codec info for stream ${streamId} — recording not started`);
            this.activeRecordings.delete(streamId);
            return;
        }

        await this._createVod(streamId, stream, rec, rec);
        if (rec._cancel) return this._abort(streamId, rec);

        const { videoPort, audioPort } = await media.ingestRtpStart(rec.vodId, { video, audio: audio || undefined });
        if (rec._cancel) return this._abort(streamId, rec);

        const webrtcState = { roomId, videoTransportId: null, audioTransportId: null };
        try {
            // Media listens on 127.0.0.1:<port> (RTCP on port+1 — Media allocates its
            // ingest pool in rtp/rtcp pairs, mirroring the inherited recorder).
            const videoConsumer = await webrtcSFU.createPlainConsumer(
                roomId, videoProducer.id, '127.0.0.1', videoPort, videoPort + 1
            );
            webrtcState.videoTransportId = videoConsumer.transportId;
            if (video.payloadType !== videoConsumer.payloadType) {
                console.warn(`[VOD] stream ${streamId}: predicted video PT ${video.payloadType} != consumer PT ${videoConsumer.payloadType} — Media ingest may mis-map`);
            }
            if (audio && audioPort) {
                const audioConsumer = await webrtcSFU.createPlainConsumer(
                    roomId, audioProducer.id, '127.0.0.1', audioPort, audioPort + 1
                );
                webrtcState.audioTransportId = audioConsumer.transportId;
            }
        } catch (err) {
            console.error(`[VOD] PlainRTP wiring to Media failed for stream ${streamId}:`, err.message);
            this._closePlainConsumers(webrtcState);
            await media.ingestRtpStop(rec.vodId).catch(() => {});
            this.activeRecordings.delete(streamId);
            return;
        }

        rec.webrtcState = webrtcState;
        console.log(`[VOD] Media RTP ingest started: stream ${streamId} → vod ${rec.vodId} (v:${videoPort}${audioPort ? ` a:${audioPort}` : ''}, ${rec.mode})`);
    }

    _closePlainConsumers(webrtcState) {
        if (!webrtcState) return;
        try {
            const webrtcSFU = require('./webrtc-sfu');
            if (webrtcState.videoTransportId) { try { webrtcSFU.closePlainConsumer(webrtcState.roomId, webrtcState.videoTransportId); } catch { /* */ } }
            if (webrtcState.audioTransportId) { try { webrtcSFU.closePlainConsumer(webrtcState.roomId, webrtcState.audioTransportId); } catch { /* */ } }
        } catch { /* */ }
    }

    async _abort(streamId, rec) {
        this.activeRecordings.delete(streamId);
        if (rec.vodId) {
            // Recording never really started — drop the empty VOD shell in Media.
            await media.deleteVod(rec.vodId).catch(() => {});
        }
    }

    /**
     * Register a browser-chunk-upload recording (driven by media-proxy/vods.js) so
     * finalize/stale-cleanup and the live auto-clip job can see it.
     */
    registerChunkSession(streamId, vodId) {
        if (this.activeRecordings.has(streamId)) return this.activeRecordings.get(streamId);
        const rec = {
            vodId, protocol: 'browser', endpoint: {}, mode: 'vod', clipsOnly: false,
            startedAt: Date.now(), part: 1, baseTitle: null, type: 'chunks', webrtcState: null,
        };
        this.activeRecordings.set(streamId, rec);
        return rec;
    }

    getActiveRecording(streamId) {
        return this.activeRecordings.get(streamId) || null;
    }

    isRecording(streamId) { return this.activeRecordings.has(streamId); }
    isActivelyRecording(streamId) { return this.activeRecordings.has(streamId); }
    isFinalizingStream(streamId) { return this._finalizing.has(streamId); }

    /**
     * Stop (and finalize) the recording for a stream. Safe to call repeatedly.
     */
    stopRecording(streamId) {
        const rec = this.activeRecordings.get(streamId);
        if (!rec) return;
        rec._cancel = true;
        this.activeRecordings.delete(streamId);
        this._finalizing.add(streamId);

        const finish = (async () => {
            this._closePlainConsumers(rec.webrtcState);
            if (!rec.vodId) return;
            if (rec.type === 'rtp') {
                await media.ingestRtpStop(rec.vodId).catch((e) => console.warn(`[VOD] rtp stop failed (vod ${rec.vodId}):`, e.message));
            } else if (rec.type === 'chunks') {
                await media.completeVodChunks(rec.vodId).catch(() => {});
                await media.finalizeVod(rec.vodId).catch((e) => console.warn(`[VOD] finalize failed (vod ${rec.vodId}):`, e.message));
            } else {
                await media.finalizeVod(rec.vodId).catch((e) => console.warn(`[VOD] finalize failed (vod ${rec.vodId}):`, e.message));
            }
            if (rec.clipsOnly) {
                // Ephemeral clips-only recording (VOD-disabled slot): never published — remove it.
                await media.deleteVod(rec.vodId).catch(() => {});
                console.log(`[VOD] Discarded ephemeral clips-only recording (vod ${rec.vodId}, stream ${streamId})`);
            } else {
                console.log(`[VOD] Recording stopped: stream ${streamId} → vod ${rec.vodId} (Media finalizing)`);
            }
        })();
        finish.catch(() => {}).finally(() => this._finalizing.delete(streamId));
    }

    /**
     * Drop-in for the old vodRoutes.finalizeVodRecording(streamId): stop + finalize
     * whatever recording (server ingest or chunk session) is active for the stream.
     */
    async finalizeStream(streamId) {
        if (this._finalizing.has(streamId)) return null;
        const rec = this.activeRecordings.get(streamId);
        if (!rec) return null;
        this.stopRecording(streamId);
        return { vodId: rec.vodId };
    }

    /**
     * Heal recordings for live streams that should be recording but aren't (server
     * restart / Media restart). RTMP re-points Media at the still-connected publisher;
     * WebRTC re-creates PlainRTP consumers via a fresh rtp ingest.
     */
    reconcileLiveRecordings() {
        let streams;
        try { streams = db.getLiveStreams(); } catch { return; }
        const now = Date.now();

        for (const stream of streams) {
            const sid = stream.id;
            if (this.isActivelyRecording(sid)) continue;

            let mode = 'none';
            try { mode = db.resolveStreamRecordingMode(stream); } catch { /* */ }
            if (mode === 'none') continue;
            if (now - (this._healAttempts.get(sid) || 0) < 60000) continue;

            const proto = stream.protocol;
            if (WEBRTC_PROTOCOLS.has(proto)) {
                this._healAttempts.set(sid, now);
                console.log(`[VOD] Auto-healing recording for live ${proto} stream ${sid} (mode: ${mode})`);
                try { this.startRecording(sid, proto, {}, { mode }); }
                catch (e) { console.warn(`[VOD] heal failed for stream ${sid}:`, e.message); }
            } else if (proto === 'rtmp') {
                let streamKey = null;
                try {
                    const rtmp = require('./rtmp-server');
                    if (rtmp && rtmp.activeStreams) {
                        for (const [key, info] of rtmp.activeStreams) { if (info && info.streamId === sid) { streamKey = key; break; } }
                    }
                } catch { /* */ }
                if (!streamKey) continue; // publisher gone → leave for stale cleanup
                this._healAttempts.set(sid, now);
                console.log(`[VOD] Auto-healing RTMP recording for live stream ${sid} (mode: ${mode})`);
                try { this.startRecording(sid, 'rtmp', { streamKey }, { mode }); }
                catch (e) { console.warn(`[VOD] heal failed for stream ${sid}:`, e.message); }
            }
        }

        const liveIds = new Set(streams.map(s => s.id));
        for (const id of Array.from(this._healAttempts.keys())) if (!liveIds.has(id)) this._healAttempts.delete(id);
    }

    /** Called by the Media webhook when a vod finishes/fails so state can't go stale. */
    onVodSettled(vodId) {
        for (const [sid, rec] of this.activeRecordings) {
            if (rec.vodId === vodId) {
                this._closePlainConsumers(rec.webrtcState);
                this.activeRecordings.delete(sid);
                break;
            }
        }
    }

    stopAll() {
        for (const [streamId] of this.activeRecordings) {
            this.stopRecording(streamId);
        }
    }
}

module.exports = new StreamRecorder();
