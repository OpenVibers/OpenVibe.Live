/**
 * OpenVibe.Live — RobotStreamer native publisher (manager)
 *
 * Server-side RS video restreaming for streams that have no browser publisher:
 * WHIP/OBS ingest (protocol webrtc, streaming_method whip) and RTMP ingest.
 * Extracts media from the local ingest and spawns rs-native-publisher-worker.js
 * (node + wrtc + mediasoup-client) to publish it to the RobotStreamer SFU.
 *
 * Media sources:
 *   - webrtc (WHIP): PlainRtpTransport consumers on the local mediasoup SFU
 *     → SDP file (same mechanism as the WebRTC→RTMP restream path)
 *   - rtmp: node-media-server HTTP-FLV loopback url
 *
 * The worker is restarted with backoff while the stream stays live.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WORKER_PATH = path.join(__dirname, 'rs-native-publisher-worker.js');
const MAX_ATTEMPTS = 10;
const BASE_RESTART_DELAY_MS = 5000;
const MAX_RESTART_DELAY_MS = 30000;

class RsNativePublisher {
    constructor() {
        /** @type {Map<number, object>} streamId → session */
        this.sessions = new Map();
    }

    isActive(streamId) {
        return this.sessions.has(streamId);
    }

    _allocatePort() {
        // Distinct range from restream-manager (20000-30000) to avoid clashes.
        if (!this._nextPort) this._nextPort = 32000;
        const port = this._nextPort;
        this._nextPort += 2;
        if (this._nextPort > 34000) this._nextPort = 32000;
        return port;
    }

    /**
     * Start (or keep) a native RS publish session for a live stream.
     * @param {object} stream - streams row (must be live)
     * @param {object} integration - robotstreamer_integrations row (token+robot resolved)
     */
    start(stream, integration) {
        if (!stream?.id || !integration?.token || !integration?.robot_id) return;

        const existing = this.sessions.get(stream.id);
        if (existing && !existing.stopped) return;

        const session = {
            streamId: stream.id,
            userId: stream.user_id,
            token: integration.token,
            robotId: String(integration.robot_id),
            protocol: stream.protocol,
            stopped: false,
            attempts: 0,
            child: null,
            restartTimer: null,
            webrtcState: null,
        };
        this.sessions.set(stream.id, session);
        console.log(`[RS Native] Starting publisher for stream ${stream.id} (robot ${session.robotId}, protocol ${stream.protocol})`);

        this._launch(session).catch(err => {
            console.warn(`[RS Native] Launch failed for stream ${session.streamId}:`, err.message);
            this._scheduleRestart(session);
        });
    }

    stop(streamId) {
        const session = this.sessions.get(streamId);
        if (!session) return;
        session.stopped = true;
        if (session.restartTimer) { clearTimeout(session.restartTimer); session.restartTimer = null; }
        if (session.child) { try { session.child.kill('SIGTERM'); } catch {} session.child = null; }
        this._cleanupMedia(session);
        this.sessions.delete(streamId);
        console.log(`[RS Native] Stopped publisher for stream ${streamId}`);
    }

    stopAll() {
        for (const streamId of [...this.sessions.keys()]) this.stop(streamId);
    }

    async _launch(session) {
        const db = require('../db/database');
        const stream = db.getStreamById(session.streamId);
        if (!stream?.is_live) {
            this.stop(session.streamId);
            return;
        }

        let inputMode, inputPath, hasAudio;

        if (session.protocol === 'webrtc') {
            ({ inputPath, hasAudio } = await this._prepareSfuInput(session));
            inputMode = 'sdp';
        } else if (session.protocol === 'rtmp') {
            const config = require('../config');
            const user = db.getUserById(session.userId);
            const streamKey = stream.managed_stream_key || user?.stream_key;
            if (!streamKey) throw new Error('No stream key for FLV loopback');
            const flvPort = (config.rtmp?.port || 1935) + 8000;
            inputMode = 'url';
            inputPath = `http://127.0.0.1:${flvPort}/live/${streamKey}.flv`;
            hasAudio = true;
        } else {
            throw new Error(`Unsupported protocol for native RS publish: ${session.protocol}`);
        }

        if (session.stopped) { this._cleanupMedia(session); return; }

        const child = spawn(process.execPath, [WORKER_PATH], {
            env: {
                ...process.env,
                RS_TOKEN: session.token,
                ROBOT_ID: session.robotId,
                INPUT_MODE: inputMode,
                INPUT_PATH: inputPath,
                HAS_AUDIO: hasAudio ? '1' : '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        session.child = child;

        const prefix = `[RS Native ${session.streamId}]`;
        const logChunk = (data) => {
            for (const line of data.toString().split('\n')) {
                if (line.trim()) console.log(prefix, line.trim());
            }
        };
        child.stdout.on('data', logChunk);
        child.stderr.on('data', logChunk);

        child.on('exit', (code, signal) => {
            if (session.child === child) session.child = null;
            this._cleanupMedia(session);
            if (session.stopped) return;
            console.warn(`${prefix} worker exited (code ${code}, signal ${signal || 'none'})`);
            this._scheduleRestart(session);
        });
    }

    _scheduleRestart(session) {
        if (session.stopped || session.restartTimer) return;
        session.attempts++;
        if (session.attempts > MAX_ATTEMPTS) {
            console.warn(`[RS Native] Giving up on stream ${session.streamId} after ${MAX_ATTEMPTS} attempts`);
            this.stop(session.streamId);
            return;
        }
        const delay = Math.min(BASE_RESTART_DELAY_MS * session.attempts, MAX_RESTART_DELAY_MS);
        console.log(`[RS Native] Restarting publisher for stream ${session.streamId} in ${delay}ms (attempt ${session.attempts})`);
        session.restartTimer = setTimeout(() => {
            session.restartTimer = null;
            const db = require('../db/database');
            const stream = db.getStreamById(session.streamId);
            if (!stream?.is_live) {
                this.stop(session.streamId);
                return;
            }
            this._launch(session).catch(err => {
                console.warn(`[RS Native] Relaunch failed for stream ${session.streamId}:`, err.message);
                this._scheduleRestart(session);
            });
        }, delay);
    }

    /**
     * Create PlainRtpTransport consumers on the local SFU and write an SDP
     * file describing them (mirrors restream-manager's WebRTC input path).
     */
    async _prepareSfuInput(session) {
        const webrtcSFU = require('../streaming/webrtc-sfu');
        if (!webrtcSFU.ready) throw new Error('Mediasoup SFU not available');

        const roomId = `stream-${session.streamId}`;
        const videoProducer = await webrtcSFU.waitForProducer(roomId, 'video', 30000);
        const audioProducer = webrtcSFU.findProducerByKind(roomId, 'audio');

        const videoRtpPort = this._allocatePort();
        const videoRtcpPort = videoRtpPort + 1;
        let audioConsumer = null;
        let audioRtpPort = null;

        const videoConsumer = await webrtcSFU.createPlainConsumer(
            roomId, videoProducer.id, '127.0.0.1', videoRtpPort, videoRtcpPort
        );
        try {
            if (audioProducer) {
                audioRtpPort = this._allocatePort();
                audioConsumer = await webrtcSFU.createPlainConsumer(
                    roomId, audioProducer.id, '127.0.0.1', audioRtpPort, audioRtpPort + 1
                );
            }
        } catch (err) {
            webrtcSFU.closePlainConsumer(roomId, videoConsumer.transportId);
            throw err;
        }

        const sdpPath = path.join(os.tmpdir(), `openvibe-rs-native-${session.streamId}.sdp`);
        fs.writeFileSync(sdpPath, this._buildSdp(videoConsumer, audioConsumer, videoRtpPort, audioRtpPort), 'utf8');

        session.webrtcState = {
            roomId,
            sdpPath,
            videoTransportId: videoConsumer.transportId,
            audioTransportId: audioConsumer?.transportId || null,
        };

        console.log(`[RS Native] SFU consumers ready for stream ${session.streamId} (video port ${videoRtpPort}${audioConsumer ? `, audio port ${audioRtpPort}` : ', no audio'})`);
        return { inputPath: sdpPath, hasAudio: !!audioConsumer };
    }

    _cleanupMedia(session) {
        if (!session.webrtcState) return;
        const webrtcSFU = require('../streaming/webrtc-sfu');
        const { roomId, videoTransportId, audioTransportId, sdpPath } = session.webrtcState;
        try { if (videoTransportId) webrtcSFU.closePlainConsumer(roomId, videoTransportId); } catch {}
        try { if (audioTransportId) webrtcSFU.closePlainConsumer(roomId, audioTransportId); } catch {}
        try { fs.unlinkSync(sdpPath); } catch {}
        session.webrtcState = null;
    }

    _buildSdp(videoConsumer, audioConsumer, videoPort, audioPort) {
        const lines = [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=OpenVibe.Live RS Native Relay',
            'c=IN IP4 127.0.0.1',
            't=0 0',
        ];

        const vPT = videoConsumer.payloadType;
        const vCodecName = (videoConsumer.mimeType || 'video/VP8').split('/')[1];
        lines.push(`m=video ${videoPort} RTP/AVP ${vPT}`);
        lines.push(`a=rtpmap:${vPT} ${vCodecName}/${videoConsumer.clockRate}`);
        if (videoConsumer.ssrc) lines.push(`a=ssrc:${videoConsumer.ssrc} cname:rs-native-video`);
        if (videoConsumer.codecParameters) {
            const fmtp = Object.entries(videoConsumer.codecParameters).map(([k, v]) => `${k}=${v}`).join(';');
            if (fmtp) lines.push(`a=fmtp:${vPT} ${fmtp}`);
        }
        lines.push('a=recvonly');

        if (audioConsumer && audioPort) {
            const aPT = audioConsumer.payloadType;
            const aCodecName = (audioConsumer.mimeType || 'audio/opus').split('/')[1];
            const channels = audioConsumer.channels || 2;
            lines.push(`m=audio ${audioPort} RTP/AVP ${aPT}`);
            lines.push(`a=rtpmap:${aPT} ${aCodecName}/${audioConsumer.clockRate}/${channels}`);
            if (audioConsumer.ssrc) lines.push(`a=ssrc:${audioConsumer.ssrc} cname:rs-native-audio`);
            if (audioConsumer.codecParameters) {
                const fmtp = Object.entries(audioConsumer.codecParameters).map(([k, v]) => `${k}=${v}`).join(';');
                if (fmtp) lines.push(`a=fmtp:${aPT} ${fmtp}`);
            }
            lines.push('a=recvonly');
        }

        lines.push('');
        return lines.join('\r\n');
    }
}

module.exports = new RsNativePublisher();
