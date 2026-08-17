/**
 * OpenVibe.Live — RobotStreamer native publisher (worker process)
 *
 * Publishes a server-ingested stream (WHIP/OBS or RTMP — no browser publisher
 * available) to the RobotStreamer mediasoup SFU using node WebRTC.
 *
 * Media path:
 *   local SFU PlainRtpTransport (SDP) or NMS HTTP-FLV  →  ffmpeg
 *     →  rawvideo I420 pipe  →  wrtc RTCVideoSource ┐
 *     →  s16le PCM pipe      →  wrtc RTCAudioSource ┴→ mediasoup-client → RS SFU
 *
 * Runs as a child process (spawned by rs-native-publisher.js) so the native
 * wrtc module and the browser-ish globals mediasoup-client needs stay out of
 * the main server process. Configuration comes via environment variables:
 *
 *   RS_TOKEN, ROBOT_ID        — RobotStreamer credentials (per stream slot)
 *   INPUT_MODE                — 'sdp' | 'url'
 *   INPUT_PATH                — SDP file path or FLV url
 *   HAS_AUDIO                 — '1' | '0'
 *   WIDTH, HEIGHT, FPS        — output frame geometry (default 1280x720@30)
 *   VIDEO_KBPS, MIN_VIDEO_KBPS
 *
 * Adapted from openvibe.games's rs-browser-to-robotstreamer-native publisher.
 */
'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const wrtc = require('@roamhq/wrtc');
const { Device } = require('mediasoup-client');

global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.MediaStreamTrack = wrtc.MediaStreamTrack;
global.MediaStream = wrtc.MediaStream;
global.RTCRtpSender = wrtc.RTCRtpSender;
global.RTCRtpReceiver = wrtc.RTCRtpReceiver;
global.RTCRtpTransceiver = wrtc.RTCRtpTransceiver;

if (!global.MediaStream) {
    global.MediaStream = class MediaStream {
        constructor(tracks = []) {
            this._tracks = Array.from(tracks);
            this.id = `stream-${Math.random().toString(16).slice(2)}`;
        }
        addTrack(track) { if (!this._tracks.includes(track)) this._tracks.push(track); }
        removeTrack(track) { this._tracks = this._tracks.filter(t => t !== track); }
        getTracks() { return this._tracks.slice(); }
        getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
        getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
    };
}

// Node 22 exposes globalThis.navigator via a getter-only property —
// assignment throws, so use defineProperty instead.
const FAKE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
Object.defineProperty(global, 'navigator', {
    value: { userAgent: FAKE_UA, mediaDevices: {} },
    configurable: true,
    writable: true,
});

const {
    RS_TOKEN,
    ROBOT_ID,
    INPUT_MODE,
    INPUT_PATH,
    HAS_AUDIO,
} = process.env;

if (!RS_TOKEN) throw new Error('Missing RS_TOKEN');
if (!ROBOT_ID) throw new Error('Missing ROBOT_ID');
if (!INPUT_MODE || !INPUT_PATH) throw new Error('Missing INPUT_MODE/INPUT_PATH');

const width = Number(process.env.WIDTH || 1280);
const height = Number(process.env.HEIGHT || 720);
const fps = Number(process.env.FPS || 30);
const videoKbps = Number(process.env.VIDEO_KBPS || 3500);
const minVideoKbps = Number(process.env.MIN_VIDEO_KBPS || 1200);
const hasAudio = String(HAS_AUDIO || '1') === '1';
const frameSize = Math.floor(width * height * 3 / 2);

let shuttingDown = false;
let videoPumpTimer = null; // steady encode pacer (cleared on shutdown / ffmpeg exit)

const status = {
    videoFramesIn: 0,
    videoFramesPushed: 0,
    videoFramesDropped: 0,
    audioFramesPushed: 0,
    connected: false,
};

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

function postJson(hostname, path, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname,
            port: 443,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Origin': 'https://robotstreamer.com',
                'Referer': 'https://robotstreamer.com/',
            },
            timeout: 15000,
        }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
                    return;
                }
                try { resolve(JSON.parse(raw)); }
                catch (err) { reject(new Error(`JSON parse failed: ${err.message}: ${raw.slice(0, 500)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('API timeout')));
        req.write(payload);
        req.end();
    });
}

class ProtooPeer {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.nextId = Math.floor(Math.random() * 9000000) + 100000;
        this.pending = new Map();
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url, ['protoo'], {
                headers: {
                    Origin: 'https://robotstreamer.com',
                    Referer: `https://robotstreamer.com/robot/${ROBOT_ID}`,
                    'User-Agent': global.navigator.userAgent,
                },
                rejectUnauthorized: false,
                handshakeTimeout: 15000,
                perMessageDeflate: false,
            });

            const timer = setTimeout(() => reject(new Error('SFU websocket timeout')), 15000);

            this.ws.on('open', () => {
                clearTimeout(timer);
                log('[sfu] upstream open');
                resolve();
            });
            this.ws.on('message', data => this._onMessage(data.toString()));
            this.ws.on('error', err => {
                log('[sfu] websocket error:', err.message);
                reject(err);
            });
            this.ws.on('close', (code, reason) => {
                log('[sfu] websocket closed:', code, reason.toString());
                for (const { reject: rej } of this.pending.values()) rej(new Error(`websocket closed ${code}`));
                this.pending.clear();
                if (!shuttingDown) {
                    // Upstream dropped us — let the parent restart the whole pipeline.
                    process.exit(2);
                }
            });
        });
    }

    _onMessage(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.response && this.pending.has(msg.id)) {
            const pending = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.ok) pending.resolve(msg.data);
            else pending.reject(new Error(msg.errorReason || msg.errorCode || `protoo request ${msg.id} failed`));
            return;
        }

        if (msg.request) {
            this.ws.send(JSON.stringify({ response: true, id: msg.id, ok: true, data: {} }));
        }
    }

    request(method, data = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ request: true, id, method, data }));
            setTimeout(() => {
                if (!this.pending.has(id)) return;
                this.pending.delete(id);
                reject(new Error(`protoo request timeout: ${method}`));
            }, 15000);
        });
    }
}

function createDevice() {
    const names = ['Chrome111', 'Chrome74', undefined];
    let lastErr;
    for (const handlerName of names) {
        try {
            return handlerName ? new Device({ handlerName }) : new Device();
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr;
}

/**
 * One ffmpeg for both outputs: rawvideo on fd 1 (stdout), s16le PCM on fd 3.
 * SDP inputs (RTP ports) can only be bound once, so a single process must
 * demux both tracks.
 */
function spawnFfmpeg(videoSource, audioSource) {
    const inputArgs = INPUT_MODE === 'sdp'
        ? [
            '-protocol_whitelist', 'file,rtp,udp',
            // Big input queue + UDP socket receive buffer so the local SFU→ffmpeg RTP path
            // (no NACK/retransmit, unlike browser consumers) doesn't drop packets when the
            // encoder briefly backs up — that packet loss was corrupting frames → choppy.
            '-thread_queue_size', '8192',
            '-buffer_size', '16000000',
            '-analyzeduration', '2000000',
            '-probesize', '2000000',
            '-fflags', '+genpts+discardcorrupt+nobuffer+igndts',
            '-flags', 'low_delay',
            // The SFU→ffmpeg leg is a single in-order localhost RTP flow, so large reorder
            // buffering is almost pure added latency. Keep it small (60ms / 16 pkts) — enough
            // to smooth the rare out-of-order packet without inflating glass-to-glass delay.
            '-max_delay', '60000',
            '-reorder_queue_size', '16',
            '-use_wallclock_as_timestamps', '1',
            '-err_detect', 'ignore_err',
            '-avoid_negative_ts', 'make_zero',
            '-i', INPUT_PATH,
        ]
        : [
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-i', INPUT_PATH,
        ];

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        ...inputArgs,
        '-map', '0:v:0',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p`,
        '-pix_fmt', 'yuv420p',
        '-f', 'rawvideo',
        'pipe:1',
    ];

    if (hasAudio) {
        args.push(
            '-map', '0:a:0',
            '-vn',
            '-af', 'aresample=async=1:first_pts=0:min_hard_comp=0.100,asetnsamples=n=960:p=1',
            '-ac', '2',
            '-ar', '48000',
            '-f', 's16le',
            'pipe:3',
        );
    }

    log('[ffmpeg] starting:', 'ffmpeg', args.join(' '));

    const ff = spawn('ffmpeg', args, {
        stdio: hasAudio ? ['ignore', 'pipe', 'inherit', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    });

    // ── Video: fixed-size I420 frames → RTCVideoSource, evenly paced ──
    // Ping-pong two preallocated buffers instead of allocating a fresh ~1.3MB buffer per frame.
    // At 30fps that was ~40MB/s of allocation → GC pauses that stalled the event loop, backed up
    // the RTP read, and caused UDP packet loss. wrtc.onFrame copies the I420 data synchronously.
    //
    // ffmpeg emits frames to stdout in bursts (a 'data' chunk often carries several frames back
    // to back). Handing those straight to the encoder makes libwebrtc timestamp them by ARRIVAL,
    // so a burst becomes a cluster of near-simultaneous frames followed by a gap = visible judder
    // / "bad framerate" on RobotStreamer even though the source is smooth. Instead we ASSEMBLE
    // frames here and let a steady 1000/fps pacer hand the newest complete frame to the encoder,
    // so RS receives evenly-spaced frames (smooth motion). A brief source stall re-sends the last
    // frame (holds framerate instead of freezing); a burst just skips intermediates (we only ever
    // expose the latest). The single-threaded event loop guarantees the pacer and this assembler
    // never overlap, so two buffers suffice — the write target is always != the exposed frame.
    const frameBufs = [Buffer.allocUnsafe(frameSize), Buffer.allocUnsafe(frameSize)];
    let bufIdx = 0;
    let frameBuf = frameBufs[0];
    let frameOffset = 0;
    let latestFrame = null; // most-recent complete frame, ready to encode

    ff.stdout.on('data', chunk => {
        let pos = 0;
        while (pos < chunk.length) {
            const need = frameSize - frameOffset;
            const take = Math.min(need, chunk.length - pos);
            chunk.copy(frameBuf, frameOffset, pos, pos + take);
            frameOffset += take;
            pos += take;

            if (frameOffset === frameSize) {
                status.videoFramesIn++;
                latestFrame = frameBuf;          // expose the just-completed buffer
                bufIdx ^= 1;                      // assemble the next frame in the other buffer
                frameBuf = frameBufs[bufIdx];
                frameOffset = 0;
            }
        }
    });

    // Steady encode pacer — feed the newest complete frame at the target cadence so libwebrtc
    // stamps evenly-spaced timestamps regardless of ffmpeg's bursty stdout delivery.
    if (videoPumpTimer) clearInterval(videoPumpTimer);
    videoPumpTimer = setInterval(() => {
        if (!latestFrame) return;
        try {
            videoSource.onFrame({ width, height, data: latestFrame });
            status.videoFramesPushed++;
        } catch (err) {
            log('[video] onFrame failed:', err.message);
        }
    }, Math.max(1, Math.round(1000 / fps)));

    // ── Audio: 10ms PCM blocks → RTCAudioSource ─────────────────
    if (hasAudio && ff.stdio[3]) {
        const bytesPer10ms = 480 * 2 * 2; // 480 samples × 2ch × 2 bytes
        let accum = Buffer.alloc(0);

        ff.stdio[3].on('data', chunk => {
            accum = Buffer.concat([accum, chunk]);

            // Latency cap: if backed up over 80ms, keep the newest 20ms.
            const maxBytes = bytesPer10ms * 8;
            if (accum.length > maxBytes) {
                accum = accum.subarray(accum.length - bytesPer10ms * 2);
            }

            while (accum.length >= bytesPer10ms) {
                const block = accum.subarray(0, bytesPer10ms);
                accum = accum.subarray(bytesPer10ms);

                const samples = new Int16Array(480 * 2);
                for (let i = 0; i < samples.length; i++) {
                    samples[i] = block.readInt16LE(i * 2);
                }

                try {
                    audioSource.onData({
                        samples,
                        sampleRate: 48000,
                        bitsPerSample: 16,
                        channelCount: 2,
                        numberOfFrames: 480,
                    });
                    status.audioFramesPushed++;
                } catch (err) {
                    log('[audio] onData failed:', err.message);
                }
            }
        });
    }

    ff.on('exit', (code, signal) => {
        log('[ffmpeg] exited:', { code, signal });
        if (videoPumpTimer) { clearInterval(videoPumpTimer); videoPumpTimer = null; }
        if (!shuttingDown) process.exit(3);
    });

    return ff;
}

function waitForVideoFrames(minFrames = 5, timeoutMs = 15000) {
    const start = Date.now();
    return new Promise(resolve => {
        const timer = setInterval(() => {
            if (status.videoFramesIn >= minFrames || Date.now() - start >= timeoutMs) {
                clearInterval(timer);
                log('[video] warmup:', { framesIn: status.videoFramesIn, waitedMs: Date.now() - start });
                resolve();
            }
        }, 100);
    });
}

async function applySenderParams(sender, kind) {
    if (!sender || typeof sender.getParameters !== 'function') return;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const params = sender.getParameters();
            params.degradationPreference = 'maintain-framerate';
            params.priority = 'high';
            if (!params.encodings || !params.encodings.length) params.encodings = [{}];
            for (const enc of params.encodings) {
                enc.active = true;
                enc.priority = 'high';
                enc.networkPriority = 'high';
                if (kind === 'video') {
                    enc.maxBitrate = videoKbps * 1000;
                    enc.minBitrate = minVideoKbps * 1000;
                    enc.maxFramerate = fps;
                    enc.scaleResolutionDownBy = 1;
                }
            }
            await sender.setParameters(params);
            return;
        } catch (err) {
            log(`[${kind}] setParameters attempt ${attempt} failed:`, err.message);
            await new Promise(r => setTimeout(r, 250));
        }
    }
}

async function main() {
    log(`RobotStreamer page load (robot ${ROBOT_ID})...`);
    const pageData = await postJson('api.robotstreamer.com', '/v1/robot_page_load', {
        token: RS_TOKEN,
        robot_id: ROBOT_ID,
        referrer: `https://robotstreamer.com/robot/${ROBOT_ID}`,
    });

    if (!pageData?.rtc_sfu?.host || !pageData?.rtc_sfu?.port) {
        throw new Error('page_load missing rtc_sfu');
    }

    const peerId = `p:${crypto.randomBytes(3).toString('hex')}`;
    const sfuUrl = `wss://${pageData.rtc_sfu.host}:${pageData.rtc_sfu.port}/?roomId=${encodeURIComponent(ROBOT_ID)}&peerId=${encodeURIComponent(peerId)}`;
    log('Connecting SFU:', sfuUrl);

    const peer = new ProtooPeer(sfuUrl);
    await peer.connect();

    const routerRtpCapabilities = await peer.request('getRouterRtpCapabilities');
    const device = createDevice();
    await device.load({ routerRtpCapabilities });
    log('mediasoup device loaded');

    const transportInfo = await peer.request('createWebRtcTransport', {
        producing: true,
        consuming: false,
        streamkey: RS_TOKEN,
    });

    const sendTransport = device.createSendTransport(transportInfo);

    sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        peer.request('connectWebRtcTransport', {
            transportId: sendTransport.id,
            dtlsParameters,
        }).then(callback).catch(errback);
    });

    sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
            const data = await peer.request('produce', {
                transportId: sendTransport.id,
                kind,
                rtpParameters,
                appData,
            });
            callback({ id: data.id });
        } catch (err) {
            errback(err);
        }
    });

    await peer.request('join', {
        device,
        rtpCapabilities: device.rtpCapabilities,
        token: RS_TOKEN,
    });
    log('Joined RobotStreamer room');

    const videoSource = new wrtc.nonstandard.RTCVideoSource();
    const audioSource = new wrtc.nonstandard.RTCAudioSource();
    const videoTrack = videoSource.createTrack();
    const audioTrack = hasAudio ? audioSource.createTrack() : null;
    videoTrack.contentHint = 'motion';

    // Start capture BEFORE producing so RS never sees a dead first frame.
    const ff = spawnFfmpeg(videoSource, audioSource);
    await waitForVideoFrames(5, 15000);
    if (status.videoFramesIn === 0) {
        throw new Error('No video frames from source — ingest not flowing');
    }

    let videoSender = null;
    const videoProducer = await sendTransport.produce({
        track: videoTrack,
        stopTracks: false,
        disableTrackOnPause: false,
        zeroRtpOnPause: false,
        encodings: [{
            active: true,
            maxBitrate: videoKbps * 1000,
            minBitrate: minVideoKbps * 1000,
            maxFramerate: fps,
            scaleResolutionDownBy: 1,
            priority: 'high',
            networkPriority: 'high',
        }],
        codecOptions: {
            videoGoogleStartBitrate: videoKbps,
            videoGoogleMinBitrate: minVideoKbps,
            videoGoogleMaxBitrate: videoKbps,
        },
        onRtpSender: sender => { videoSender = sender; },
        appData: { source: 'openvibelive-native-relay' },
    });
    await applySenderParams(videoSender, 'video');
    log('Video producer created:', videoProducer.id);

    if (hasAudio) {
        const audioProducer = await sendTransport.produce({
            track: audioTrack,
            codecOptions: {
                opusStereo: true,
                opusDtx: false,
                opusFec: false,
                opusMaxPlaybackRate: 48000,
            },
            appData: { source: 'openvibelive-native-relay', lowLatency: true },
        });
        log('Audio producer created:', audioProducer.id);
    }

    status.connected = true;
    log('LIVE: publishing to RobotStreamer');

    setInterval(() => {
        const line = { ...status };
        status.videoFramesIn = 0;
        status.videoFramesPushed = 0;
        log('[stats]', JSON.stringify(line));
    }, 10000).unref?.();

    const shutdown = () => {
        shuttingDown = true;
        if (videoPumpTimer) { clearInterval(videoPumpTimer); videoPumpTimer = null; }
        try { ff.kill('SIGTERM'); } catch {}
        try { videoTrack.stop(); } catch {}
        try { audioTrack?.stop(); } catch {}
        try { sendTransport.close(); } catch {}
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    console.error('[fatal]', err && (err.stack || err.message || String(err)));
    process.exit(1);
});
