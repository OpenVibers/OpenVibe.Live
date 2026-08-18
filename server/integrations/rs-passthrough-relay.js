/**
 * OpenVibe.Live — RobotStreamer RAW passthrough relay (zero re-encode).
 *
 * The old native publisher decodes the stream and RE-ENCODES it to RobotStreamer
 * (ffmpeg + libwebrtc), and browser broadcasters publish to RS from the browser as a
 * SECOND encode. Both waste CPU and soften the picture. This relay instead forwards
 * goosely's ALREADY-ENCODED RTP straight through:
 *
 *   our mediasoup SFU (goosely's producer, NACK-protected)
 *     → DirectTransport consumer (in-process, lossless, encoded RTP)
 *     → werift MediaStreamTrack.writeRtp (packets unchanged, no decode/encode)
 *     → werift RTCPeerConnection (DTLS-SRTP, its own ICE) joined to RS's mediasoup SFU
 *     → RobotStreamer (bit-exact original video, their low-latency WebRTC path)
 *
 * RTCP: RS's PLI/keyframe requests are relayed back to the source via
 * consumer.requestKeyFrame(). No transcode anywhere; RS gets the original bytes.
 *
 * The werift↔mediasoup bridge (hand-rolled SDP answer from RS's transport params) is
 * validated end-to-end in scratch/werift-ms-harness.js. RS's SFU is mediasoup, so the
 * same bridge applies. Gated behind config.robotstreamer.passthrough (default off) with
 * the transcode publisher kept as fallback.
 */
const WebSocket = require('ws');
const https = require('node:https');
const crypto = require('node:crypto');
const dgram = require('node:dgram');

let werift = null;
try { werift = require('werift'); } catch { /* optional dep — relay disabled if absent */ }

const RS_API_HOST = 'api.robotstreamer.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) OpenVibe.Live-RelayPassthrough';

function log(streamId, ...a) { console.log(`[RS Passthrough ${streamId}]`, ...a); }

// ── RS HTTP API (robot_page_load → rtc_sfu host/port) ────────────────────
function postJson(host, path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request({
            host, port: 443, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': UA },
            timeout: 15000, rejectUnauthorized: false,
        }, res => {
            let raw = '';
            res.on('data', d => raw += d);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('RS API timeout')));
        req.write(payload); req.end();
    });
}

// ── protoo peer (mediasoup signaling over WS) ────────────────────────────
class ProtooPeer {
    constructor(url, robotId, onClose) {
        this.url = url; this.robotId = robotId; this.onClose = onClose;
        this.ws = null; this.nextId = Math.floor(Math.random() * 9000000) + 100000; this.pending = new Map();
    }
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url, ['protoo'], {
                headers: { Origin: 'https://robotstreamer.com', Referer: `https://robotstreamer.com/robot/${this.robotId}`, 'User-Agent': UA },
                rejectUnauthorized: false, handshakeTimeout: 15000, perMessageDeflate: false,
            });
            const timer = setTimeout(() => reject(new Error('RS SFU ws timeout')), 15000);
            this.ws.on('open', () => { clearTimeout(timer); resolve(); });
            this.ws.on('message', d => this._onMessage(d.toString()));
            this.ws.on('error', err => { clearTimeout(timer); reject(err); });
            this.ws.on('close', (code) => {
                for (const { reject: rej } of this.pending.values()) rej(new Error(`ws closed ${code}`));
                this.pending.clear();
                if (this.onClose) this.onClose(code);
            });
        });
    }
    _onMessage(raw) {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (msg.response && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id); this.pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.errorReason || msg.errorCode || `request ${msg.id} failed`));
            return;
        }
        // RS may push notifications/requests (e.g. keepalive) — ack requests so it stays happy.
        if (msg.request) { try { this.ws.send(JSON.stringify({ response: true, id: msg.id, ok: true, data: {} })); } catch {} }
    }
    request(method, data = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { this.ws.send(JSON.stringify({ request: true, id, method, data })); }
            catch (e) { this.pending.delete(id); return reject(e); }
            setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`request timeout: ${method}`)); } }, 15000);
        });
    }
    close() { try { this.ws?.close(1000); } catch {} }
}

// ── SDP bridge (werift offer ↔ mediasoup transport params) ───────────────
// Parse werift's local offer into per-m-line media info + session fingerprint.
function parseOffer(sdp) {
    const out = { fingerprint: null, media: [] };
    let cur = null;
    for (const l of sdp.split(/\r?\n/)) {
        if (l.startsWith('a=fingerprint:') && !out.fingerprint) out.fingerprint = l.slice(14).trim();
        else if (l.startsWith('m=')) {
            const kind = l.slice(2).split(' ')[0];
            cur = { kind, pts: [], rtpmap: {}, fmtp: {}, ext: [], ssrc: null, cname: null, mid: null };
            out.media.push(cur);
        } else if (cur) {
            let m;
            if (l.startsWith('a=mid:')) cur.mid = l.slice(6).trim();
            else if ((m = l.match(/^a=rtpmap:(\d+) ([^/]+)\/(\d+)(?:\/(\d+))?/))) { cur.rtpmap[m[1]] = { name: m[2], clock: +m[3], channels: m[4] ? +m[4] : undefined }; if (!cur.pts.includes(m[1])) cur.pts.push(m[1]); }
            else if ((m = l.match(/^a=fmtp:(\d+) (.+)/))) cur.fmtp[m[1]] = m[2];
            else if ((m = l.match(/^a=extmap:(\d+)(?:\/\w+)? (\S+)/))) cur.ext.push({ id: +m[1], uri: m[2] });
            else if ((m = l.match(/^a=ssrc:(\d+) cname:(\S+)/))) { cur.ssrc = +m[1]; cur.cname = m[2]; }
            else if (!cur.ssrc && (m = l.match(/^a=ssrc:(\d+)/))) cur.ssrc = +m[1];
        }
    }
    return out;
}

// Build an SDP answer from RS's WebRtcTransport params. RS is ice-lite + DTLS server,
// so setup:passive → werift becomes DTLS client. One transport, BUNDLE over all m-lines.
function buildAnswer(transportInfo, offer) {
    const fp = (transportInfo.dtlsParameters.fingerprints.find(f => f.algorithm === 'sha-256') || transportInfo.dtlsParameters.fingerprints[0]);
    const ice = transportInfo.iceParameters;
    const mids = offer.media.map(m => m.mid).join(' ');
    const lines = [
        'v=0', 'o=robotstreamer 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0',
        `a=group:BUNDLE ${mids}`, 'a=msid-semantic: WMS *',
    ];
    for (const md of offer.media) {
        const pt = md.pts[0];
        const rm = md.rtpmap[pt];
        const isVideo = md.kind === 'video';
        lines.push(`m=${md.kind} 7 UDP/TLS/RTP/SAVPF ${pt}`);
        lines.push('c=IN IP4 127.0.0.1');
        lines.push('a=rtcp:9 IN IP4 0.0.0.0');
        lines.push(`a=ice-ufrag:${ice.usernameFragment}`);
        lines.push(`a=ice-pwd:${ice.password}`);
        lines.push('a=ice-lite');
        lines.push(`a=fingerprint:sha-256 ${fp.value}`);
        lines.push('a=setup:passive');
        lines.push(`a=mid:${md.mid}`);
        lines.push('a=recvonly');
        lines.push('a=rtcp-mux');
        lines.push('a=rtcp-rsize');
        lines.push(`a=rtpmap:${pt} ${rm.name}/${rm.clock}${rm.channels ? '/' + rm.channels : ''}`);
        if (md.fmtp[pt]) lines.push(`a=fmtp:${pt} ${md.fmtp[pt]}`);
        if (isVideo) {
            lines.push(`a=rtcp-fb:${pt} nack`);
            lines.push(`a=rtcp-fb:${pt} nack pli`);
            lines.push(`a=rtcp-fb:${pt} ccm fir`);
            lines.push(`a=rtcp-fb:${pt} goog-remb`);
            lines.push(`a=rtcp-fb:${pt} transport-cc`);
        } else {
            lines.push(`a=rtcp-fb:${pt} transport-cc`);
        }
        // Echo the extensions werift offered so they stay negotiated on the send path —
        // RS (and its viewers) need transport-cc + abs-send-time or the bandwidth estimator
        // has no feedback and never lets the large keyframe through (endless PLI, black video).
        for (const e of md.ext) lines.push(`a=extmap:${e.id} ${e.uri}`);
    }
    // ICE candidates apply to the whole bundle; attach to first m-line only is fine for werift.
    let candLines = '';
    for (const cand of transportInfo.iceCandidates) {
        candLines += `a=candidate:${cand.foundation} 1 ${cand.protocol} ${cand.priority} ${cand.ip} ${cand.port} typ ${cand.type}${cand.tcpType ? ' tcptype ' + cand.tcpType : ''}\r\n`;
    }
    // insert candidates after the first m-line's attributes (append to whole sdp; werift tolerates)
    return lines.join('\r\n') + '\r\n' + candLines + 'a=end-of-candidates\r\n';
}

// werift's sender stamps header extensions using the IDs we configure on the PC (below),
// NOT the (renumbered) ids in its own offer SDP. So the produce must declare THESE ids to
// match what's actually on the wire, or RS mis-maps transport-cc/abs-send-time.
const CANON_EXT_ID = {
    'urn:ietf:params:rtp-hdrext:sdes:mid': 1,
    'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time': 4,
    'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01': 5,
    'urn:ietf:params:rtp-hdrext:ssrc-audio-level': 10,
};

// Is this RTP payload the START of a video KEYFRAME? (VP8: P bit 0 on the first partition;
// H264: an IDR / SPS / PPS NAL, incl. FU-A fragments and STAP-A aggregates.)
function isVideoKeyframe(payload, isH264) {
    if (!payload || payload.length < 1) return false;
    if (isH264) {
        const nal = payload[0] & 0x1f;
        if (nal === 5 || nal === 7 || nal === 8) return true;         // IDR / SPS / PPS
        if (nal === 28 || nal === 29) {                                // FU-A / FU-B
            const fu = payload[1] || 0;
            return (fu & 0x80) !== 0 && (fu & 0x1f) === 5;             // start of a fragmented IDR
        }
        if (nal === 24) {                                              // STAP-A: scan aggregated NALs
            let i = 1;
            while (i + 2 <= payload.length) {
                const size = (payload[i] << 8) | payload[i + 1]; i += 2;
                const t = payload[i] & 0x1f;
                if (t === 5 || t === 7 || t === 8) return true;
                i += size;
            }
        }
        return false;
    }
    // VP8 payload descriptor → skip to the VP8 payload header, then test the key-frame (P) bit.
    let i = 0;
    const b0 = payload[i++];
    const X = (b0 & 0x80) !== 0, S = (b0 & 0x10) !== 0, PID = b0 & 0x07;
    if (X) {
        const ext = payload[i++] || 0;
        const I = (ext & 0x80) !== 0, L = (ext & 0x40) !== 0, T = (ext & 0x20) !== 0, K = (ext & 0x10) !== 0;
        if (I) { const pic = payload[i++] || 0; if (pic & 0x80) i++; } // 15-bit picture id
        if (L) i++;
        if (T || K) i++;
    }
    if (!S || PID !== 0 || i >= payload.length) return false;         // only the first packet of a frame
    return (payload[i] & 0x01) === 0;                                  // P==0 → keyframe
}

// mediasoup produce rtpParameters mirroring exactly what werift will send on this m-line.
function buildProduceParams(md) {
    const pt = +md.pts[0];
    const rm = md.rtpmap[md.pts[0]];
    const codec = {
        mimeType: `${md.kind}/${rm.name}`,
        payloadType: pt,
        clockRate: rm.clock,
        parameters: {},
        rtcpFeedback: md.kind === 'video'
            ? [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }, { type: 'transport-cc' }]
            : [{ type: 'transport-cc' }],
    };
    if (rm.channels) codec.channels = rm.channels;
    if (md.fmtp[md.pts[0]]) {
        for (const kv of md.fmtp[md.pts[0]].split(';')) {
            const [k, v] = kv.trim().split('=');
            if (k) codec.parameters[k] = /^\d+$/.test(v) ? +v : v;
        }
    }
    return {
        mid: md.mid,
        codecs: [codec],
        // Declare exactly the extensions werift stamps on each packet (transport-cc /
        // abs-send-time / mid) with the ON-WIRE ids (canonical, not the offer's renumbered
        // ones) so RS reads them and its BWE works — otherwise keyframes never fully arrive
        // and the viewer stays black.
        headerExtensions: md.ext
            .filter(e => CANON_EXT_ID[e.uri] != null)
            .map(e => ({ uri: e.uri, id: CANON_EXT_ID[e.uri], encrypt: false, parameters: {} })),
        encodings: [{ ssrc: md.ssrc }],
        rtcp: { cname: md.cname || 'openvibe-relay', reducedSize: true },
    };
}

// Open a lossless in-process ingest for a producer: a mediasoup PlainTransport consumer
// pipes the producer's ENCODED RTP to a localhost UDP socket we read. (DirectTransport's
// consumer 'rtp' event does not fire in this mediasoup build, so we use the same
// PlainTransport→UDP mechanism the transcode publisher uses — proven to deliver RTP.)
async function openPlainIngest(sfu, roomId, producerId) {
    const socket = dgram.createSocket('udp4');
    await new Promise((res, rej) => {
        socket.once('error', rej);
        socket.bind(0, '127.0.0.1', () => { socket.removeListener('error', rej); res(); });
    });
    try { socket.setRecvBufferSize?.(4 * 1024 * 1024); } catch { /* best effort */ }
    const port = socket.address().port;
    const info = await sfu.createPlainConsumer(roomId, producerId, '127.0.0.1', port, port + 1);
    return {
        socket, port, transportId: info.transportId, consumerId: info.consumerId,
        payloadType: info.payloadType, kind: info.kind,
        mimeType: info.mimeType, clockRate: info.clockRate, channels: info.channels,
        codecParameters: info.codecParameters || {},
    };
}

// ── Relay ────────────────────────────────────────────────────────────────
class RsPassthroughRelay {
    constructor() {
        /** @type {Map<number, object>} streamId → session */
        this.sessions = new Map();
    }

    available() { return !!werift; }
    isActive(streamId) { return this.sessions.has(streamId); }

    async start(stream, integration) {
        if (!werift) { log(stream.id, 'werift not installed — cannot start passthrough'); return false; }
        if (this.sessions.has(stream.id)) return true;
        const session = { streamId: stream.id, robotId: integration.robot_id, token: integration.token, stopped: false, peer: null, pc: null, ingests: [], roomId: `stream-${stream.id}`, restartTimer: null };
        this.sessions.set(stream.id, session);
        this._run(session).catch(err => {
            log(stream.id, 'run error:', err.message);
            this._teardown(session);
            this._scheduleRestart(session, stream, integration);
        });
        return true;
    }

    stop(streamId) {
        const s = this.sessions.get(streamId);
        if (!s) return;
        s.stopped = true;
        if (s.restartTimer) clearTimeout(s.restartTimer);
        this._teardown(s);
        this.sessions.delete(streamId);
        log(streamId, 'stopped');
    }

    /**
     * Cleanly end EVERY passthrough on process shutdown. Closing each protoo peer makes RS's SFU
     * close our producers immediately and notify its viewers (consumerClosed) — instead of the old
     * process dying abruptly and leaving stale producers that RS only reaps on an ICE/DTLS timeout.
     * That timeout race is what black-screened RS video (audio kept playing) on a openvibelive
     * restart until viewers refreshed. Returns the number of sessions closed.
     */
    stopAll() {
        const ids = [...this.sessions.keys()];
        for (const id of ids) {
            const s = this.sessions.get(id);
            if (!s) continue;
            s.stopped = true;
            if (s.restartTimer) { clearTimeout(s.restartTimer); s.restartTimer = null; }
            try { this._teardown(s); } catch { /* */ }
            this.sessions.delete(id);
        }
        if (ids.length) log('all', `closed ${ids.length} RS passthrough session(s) for shutdown`);
        return ids.length;
    }

    _scheduleRestart(session, stream, integration) {
        if (session.stopped || session.restartTimer) return;
        session.restartTimer = setTimeout(() => {
            session.restartTimer = null;
            if (session.stopped) return;
            this.sessions.delete(session.streamId);
            log(session.streamId, 'restarting passthrough…');
            this.start(stream, integration);
        }, 4000);
    }

    _teardown(session) {
        if (session.statsTimer) { clearInterval(session.statsTimer); session.statsTimer = null; }
        const sfu = require('../streaming/webrtc-sfu');
        for (const ing of session.ingests) {
            try { ing.socket.removeAllListeners('message'); ing.socket.close(); } catch {}
            try { sfu.closePlainConsumer(session.roomId, ing.transportId); } catch {}
        }
        session.ingests = [];
        try { session.pc?.close(); } catch {}
        try { session.peer?.close(); } catch {}
        session.pc = null; session.peer = null;
    }

    async _run(session) {
        const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } = werift;
        const sfu = require('../streaming/webrtc-sfu');
        if (!sfu.ready) throw new Error('mediasoup SFU not ready');
        const sid = session.streamId;

        // 1) Source producers on our SFU (wait for video; audio optional).
        const videoProd = await sfu.waitForProducer(session.roomId, 'video', 30000);
        const audioProd = sfu.findProducerByKind(session.roomId, 'audio');
        log(sid, `source producers: video=${videoProd.id}${audioProd ? ` audio=${audioProd.id}` : ' (no audio)'}`);

        // 2) Encoded-RTP ingest (PlainTransport → localhost UDP socket).
        const videoIn = await openPlainIngest(sfu, session.roomId, videoProd.id);
        session.ingests.push(videoIn);
        let audioIn = null;
        if (audioProd) { audioIn = await openPlainIngest(sfu, session.roomId, audioProd.id); session.ingests.push(audioIn); }

        // 3) Connect to RS: discover SFU, open protoo.
        const page = await postJson(RS_API_HOST, '/v1/robot_page_load', { token: session.token, robot_id: session.robotId, referrer: `https://robotstreamer.com/robot/${session.robotId}` });
        if (!page?.rtc_sfu?.host || !page?.rtc_sfu?.port) throw new Error('robot_page_load missing rtc_sfu');
        const peerId = `p:${crypto.randomBytes(3).toString('hex')}`;
        const wsUrl = `wss://${page.rtc_sfu.host}:${page.rtc_sfu.port}/?roomId=${encodeURIComponent(session.robotId)}&peerId=${encodeURIComponent(peerId)}`;
        const peer = new ProtooPeer(wsUrl, session.robotId, (code) => {
            if (session.stopped) return;
            log(sid, `RS ws closed (${code}) — will restart`);
            const st = { id: sid }; const integ = { robot_id: session.robotId, token: session.token };
            this._teardown(session); this._scheduleRestart(session, st, integ);
        });
        session.peer = peer;
        await peer.connect();
        log(sid, 'RS protoo connected');

        const routerRtpCapabilities = await peer.request('getRouterRtpCapabilities');
        try {
            const codecs = (routerRtpCapabilities.codecs || []).map(c => `${c.mimeType}#${c.preferredPayloadType}${(c.rtcpFeedback || []).length ? '[' + c.rtcpFeedback.map(f => f.type + (f.parameter ? '-' + f.parameter : '')).join(',') + ']' : ''}`).join(' | ');
            const exts = (routerRtpCapabilities.headerExtensions || []).map(e => `${e.preferredId}:${e.uri.split('/').pop()}`).join(', ');
            log(sid, 'RS ROUTER CAPS codecs:', codecs);
            log(sid, 'RS ROUTER CAPS exts:', exts);
        } catch { /* */ }

        // 4) Create RS send transport.
        const transportInfo = await peer.request('createWebRtcTransport', { producing: true, consuming: false, streamkey: session.token });

        // 5) Build werift peer: sendonly transceivers whose codec MATCHES the source (so RS
        //    decodes the forwarded payload) and that carry the header extensions RS needs
        //    (transport-cc / abs-send-time / mid) for its bandwidth estimator + keyframes.
        const { RTCRtpHeaderExtensionParameters, useH264, useVP8, useOPUS } = werift;
        const EXT_MID = 'urn:ietf:params:rtp-hdrext:sdes:mid';
        const EXT_AST = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time';
        const EXT_TWCC = 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01';
        const EXT_AUDIO_LEVEL = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';
        const HX = (uri, id) => new RTCRtpHeaderExtensionParameters({ uri, id });
        // Match the produced codec to the actual source so RS can decode the forwarded
        // payload. Use werift's own codec helpers (correct mimeType casing + registry entry).
        const isH264 = /h264/i.test(videoIn.mimeType || 'video/VP8');
        const videoCodec = isH264 ? useH264({ payloadType: 103 }) : useVP8({ payloadType: 101 });
        const audioCodec = useOPUS({ payloadType: 100 });
        log(sid, `source video codec: ${videoIn.mimeType} → producing ${videoCodec.mimeType}`);
        const pc = new RTCPeerConnection({
            codecs: { video: [videoCodec], audio: [audioCodec] },
            headerExtensions: {
                video: [HX(EXT_MID, 1), HX(EXT_AST, 4), HX(EXT_TWCC, 5)],
                audio: [HX(EXT_MID, 1), HX(EXT_AST, 4), HX(EXT_TWCC, 5), HX(EXT_AUDIO_LEVEL, 10)],
            },
        });
        session.pc = pc;
        pc.connectionStateChange.subscribe(() => {
            log(sid, 'werift conn', pc.connectionState);
            if ((pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && !session.stopped) {
                const st = { id: sid }; const integ = { robot_id: session.robotId, token: session.token };
                this._teardown(session); this._scheduleRestart(session, st, integ);
            }
        });

        const videoTrack = new MediaStreamTrack({ kind: 'video' });
        const videoTx = pc.addTransceiver(videoTrack, { direction: 'sendonly' });
        let audioTrack = null, audioTx = null;
        if (audioIn) { audioTrack = new MediaStreamTrack({ kind: 'audio' }); audioTx = pc.addTransceiver(audioTrack, { direction: 'sendonly' }); }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const parsed = parseOffer(pc.localDescription.sdp);
        const vMedia = parsed.media.find(m => m.kind === 'video');
        const aMedia = parsed.media.find(m => m.kind === 'audio');
        if (!vMedia?.ssrc || !vMedia?.pts.length) throw new Error('werift offer missing video ssrc/pt');

        // 6) Answer from RS transport params → werift connects ICE+DTLS as client.
        await pc.setRemoteDescription({ type: 'answer', sdp: buildAnswer(transportInfo, parsed) });

        // 7) Hand RS our DTLS fingerprint (role client) + join.
        const [fpAlg, fpVal] = parsed.fingerprint.split(' ');
        await peer.request('connectWebRtcTransport', { transportId: transportInfo.id, dtlsParameters: { role: 'client', fingerprints: [{ algorithm: fpAlg, value: fpVal }] } });
        await peer.request('join', { displayName: 'OpenVibe.Live', device: { flag: 'openvibe-relay', name: 'werift', version: '1' }, rtpCapabilities: routerRtpCapabilities, token: session.token });
        log(sid, 'RS transport connected + joined');

        // 8) Produce (video, then audio) with rtpParameters matching what werift sends.
        const vProd = await peer.request('produce', { transportId: transportInfo.id, kind: 'video', rtpParameters: buildProduceParams(vMedia), appData: { source: 'openvibe-passthrough' } });
        log(sid, 'RS video producer', vProd.id);
        if (aMedia?.ssrc) {
            const aProd = await peer.request('produce', { transportId: transportInfo.id, kind: 'audio', rtpParameters: buildProduceParams(aMedia), appData: { source: 'openvibe-passthrough' } });
            log(sid, 'RS audio producer', aProd.id);
        }

        // 9) Forward encoded RTP straight through (strip our-router ext ids, match declared PT).
        //    Each UDP datagram from the PlainTransport consumer is one RTP packet.
        const stats = { v: 0, a: 0, pli: 0, lostIn: 0, kf: 0, maxKfGap: 0, inj: 0, rtxDeep: 0, rtxMiss: 0 };
        const vPt = +vMedia.pts[0];

        // ── Deep retransmit cache ────────────────────────────────────────────────────────
        // werift answers NACKs from rtpCache[seq % RTP_HISTORY_SIZE] with RTP_HISTORY_SIZE = 128
        // — roughly 240ms at this stream's ~530 pkt/s — and on eviction the entry belongs to a
        // different sequence number, so it sends NOTHING. RS sits 70-110ms away (spiking past
        // 170ms), so a large share of its NACKs arrive after eviction and the loss is simply
        // never repaired: the picture stays broken until the next keyframe. That is also why a
        // LONGER keyframe interval made the stutters worse instead of better — keyframes were
        // doing the repair that retransmission was failing to do.
        //
        // So we keep our own much deeper ring. werift mutates the RtpPacket we hand it in place
        // into its final on-wire form (ssrc/pt/timestamp/sequence offsets + header extensions)
        // and caches that same object reference, so once writeRtp() has returned our entries
        // hold exactly what went out. Misses are re-sent through the same dtlsTransport.sendRtp
        // call werift itself uses, which keeps the sender's packet/octet counters untouched —
        // inflating those would corrupt the loss statistics RS derives from our RTCP reports.
        const RTX_RING = 4096;                       // ~7.7s of history at 530 pkt/s
        const _rtxRing = new Array(RTX_RING);
        const rtxRemember = (pkt) => {
            try { _rtxRing[pkt.header.sequenceNumber % RTX_RING] = pkt; } catch { /* */ }
        };

        // Pull a fresh keyframe from the SOURCE encoder (goosely's browser) via our plain consumer.
        // HARD rate-limit: every trigger (RS PLI, our loss detectors, startup) funnels through here,
        // and goosely emits a big keyframe for EACH request. Unlimited requests flooded the werift→RS
        // link with keyframes (~4/s measured!) → congestion → loss → more PLIs → more keyframes: a
        // vicious cycle that was itself the freeze cause. Cap it to one real keyframe pull per 2s.
        let _lastActualKeyReq = 0;
        // minGap defaults to the 2s anti-flood floor. The retry backstop passes a shorter gap so
        // it can actually get through — with the flat 2s floor the `setTimeout(reqKey, 300)`
        // retry below was always swallowed by the request that scheduled it, making the
        // "in case it's lost too" backstop dead code and stretching recovery to the full 2s.
        const reqKeyNow = (minGap) => {
            const now = Date.now();
            if (now - _lastActualKeyReq < (typeof minGap === 'number' ? minGap : 2000)) return;
            _lastActualKeyReq = now;
            stats.pli++;
            sfu.requestConsumerKeyFrame(session.roomId, videoIn.consumerId).catch?.(() => {});
        };
        // Arg-safe wrapper: this is handed to PLI subscribers, which invoke it with an event
        // object — that must never be mistaken for a minGap override.
        const reqKey = () => reqKeyNow(2000);

        // Video-loss recovery. A hole in the streamer→relay video (a stutter/drop that PAUSES the
        // RTP, OR partial packet loss that leaves holes while packets keep flowing) makes the
        // current + following frames undecodable until the next keyframe. Without help, RS viewers
        // stay frozen until THEY notice and PLI all the way back — slow, and why audio (which needs
        // no keyframes) keeps playing while video is stuck. So we watch the incoming stream directly
        // and pull a fresh keyframe from the source encoder the instant we see a hole, front-running
        // the viewer's PLI. Two detectors: a time-gap (full pause) and RTP sequence gaps (loss).
        const VIDEO_GAP_MS = 200;
        const SEQ_BURST = 12;        // >~ one frame of packets missing AT ONCE = real loss worth a keyframe
        const KF_STALE_MS = 2000;    // if RS hasn't been sent a keyframe in this long, pull one (recovery ceiling)
        let _lastVideoAt = Date.now();
        let _lastKeyReqAt = 0;
        let _maxSeq = -1, _vSsrc = -1;
        let _lastKfAt = Date.now();
        let _lastKfTs = -1;    // dedupe: H264 keyframe = SPS+PPS+IDR sharing one RTP timestamp

        // ── H264 SPS/PPS caching + re-injection ──────────────────────────────────────────────
        // OBS/WHIP sends H264 parameter sets (SPS/PPS) in-band; mediasoup replays them to its own
        // WebRTC consumers, but the plain-consumer→relay→RS path did not — so if RS lost an SPS/PPS
        // packet it couldn't decode ANY keyframe (video frozen, audio fine, refresh no help) until
        // the params happened to arrive intact again. We cache the latest params and re-inject them
        // ahead of every keyframe so each keyframe RS receives is self-contained. Requires taking
        // control of the outgoing sequence numbers (contiguous) so injected packets slot in cleanly.
        // Sequence handling: we must renumber (injected param-set packets need slots), but we
        // renumber by a running OFFSET rather than a counter. A counter renumbers packets
        // contiguously in ARRIVAL order, which silently erases holes — RS then sees a perfect
        // sequence with missing payload, so it never NACKs and never PLIs, and just feeds the
        // corrupt frame to its decoder (video glitches, audio fine). With an offset, incoming
        // loss stays visible to RS (it NACKs, werift retransmits from its buffer) and reordered
        // packets keep their true relative order.
        let _sps = null, _pps = null, _stapParams = null;
        let _seqOffset = 0;   // outSeq = (inSeq + _seqOffset) & 0xffff
        const cacheParamSets = (payload) => {
            if (!payload || payload.length < 1) return;
            const nal = payload[0] & 0x1f;
            if (nal === 7) _sps = Buffer.from(payload);
            else if (nal === 8) _pps = Buffer.from(payload);
            else if (nal === 24) { // STAP-A: cache the whole aggregate if it carries SPS/PPS
                let i = 1, hasParam = false;
                while (i + 2 <= payload.length) { const sz = (payload[i] << 8) | payload[i + 1]; i += 2; const t = payload[i] & 0x1f; if (t === 7 || t === 8) hasParam = true; i += sz; }
                if (hasParam) _stapParams = Buffer.from(payload);
            }
        };
        const injectPkt = (payload, ts, outSeq) => {
            const h = new RtpHeader();
            h.payloadType = vPt; h.sequenceNumber = outSeq; h.timestamp = ts; h.marker = false;
            try {
                const pkt = new RtpPacket(h, Buffer.from(payload));
                videoTrack.writeRtp(pkt);           // werift finalises `pkt` in place …
                rtxRemember(pkt);                   // … so cache it after the write, not before
                stats.v++; stats.inj++;
            } catch { /* */ }
        };
        // Slot the cached parameter sets into the sequence space immediately BEFORE the keyframe
        // packet (incoming seq `inSeq`), then advance the offset so the keyframe lands right after
        // them. Everything downstream shifts by the same amount, so real gaps still read as gaps.
        const injectParamSets = (ts, inSeq) => {
            const pkts = _stapParams ? [_stapParams] : [_sps, _pps].filter(Boolean);
            for (const payload of pkts) {
                injectPkt(payload, ts, (inSeq + _seqOffset) & 0xffff);
                _seqOffset = (_seqOffset + 1) & 0xffff;
            }
        };
        const pullKeyframe = (now) => {
            if (now - _lastKeyReqAt < 600) return;   // debounce so sustained loss can't spam keyframes
            _lastKeyReqAt = now;
            reqKey();                                 // pull a keyframe now …
            setTimeout(() => reqKeyNow(250), 300);    // … and a backstop in case it's lost too
        };
        videoIn.socket.on('message', (buf) => {
            const now = Date.now();
            const timeGap = (now - _lastVideoAt) > VIDEO_GAP_MS;
            _lastVideoAt = now;
            let p;
            try { p = RtpPacket.deSerialize(buf); } catch { return; /* drop malformed */ }
            // Reorder-tolerant loss detection on the MAIN video stream only (ignore RTX/other SSRCs
            // and out-of-order arrivals — those were inflating the count and spamming keyframes).
            let burst = false;
            if (_vSsrc < 0) _vSsrc = p.header.ssrc;
            if (p.header.ssrc === _vSsrc) {
                if (_maxSeq >= 0) {
                    const adv = (p.header.sequenceNumber - _maxSeq) & 0xffff; // forward distance
                    if (adv >= 1 && adv < 30000) {          // genuine forward progress (not a reorder/wrap)
                        if (adv > 1) stats.lostIn += (adv - 1);
                        if (adv > SEQ_BURST) burst = true;   // a whole frame+ missing at once → real hole
                        _maxSeq = p.header.sequenceNumber;
                    }
                    // adv >= 30000 → reordered packet arriving late; not a loss.
                } else _maxSeq = p.header.sequenceNumber;
            }
            if (isH264) cacheParamSets(p.payload);
            // Track keyframes actually reaching RS + how long since the last one (one count per
            // frame — H264's SPS/PPS/IDR share an RTP timestamp, so dedupe on it). On a new keyframe
            // frame, re-inject the cached parameter sets right before it so RS can always decode it.
            const isKf = (p.header.timestamp !== _lastKfTs && isVideoKeyframe(p.payload, isH264));
            if (isKf) {
                _lastKfTs = p.header.timestamp;
                const gap = now - _lastKfAt; if (gap > stats.maxKfGap) stats.maxKfGap = gap;
                _lastKfAt = now; stats.kf++;
                if (isH264) injectParamSets(p.header.timestamp, p.header.sequenceNumber);
            }
            // Safety-net: a decoder that lost sync can only recover on a keyframe. If none has been
            // forwarded for KF_STALE_MS, pull one so a freeze can never outlast ~2s.
            const kfStale = (now - _lastKfAt) > KF_STALE_MS;
            if (timeGap || burst || kfStale) pullKeyframe(now);
            p.header.payloadType = vPt; p.header.extensions = [];
            // For H264 shift the sequence by the running injection offset so the injected
            // param-set packets slot in cleanly (werift preserves the sequence number) WITHOUT
            // closing real loss gaps. VP8 injects nothing, so it keeps the source sequence as-is.
            if (isH264) p.header.sequenceNumber = (p.header.sequenceNumber + _seqOffset) & 0xffff;
            try { videoTrack.writeRtp(p); rtxRemember(p); stats.v++; } catch { /* */ }
        });
        if (audioIn && aMedia) {
            const aPt = +aMedia.pts[0];
            audioIn.socket.on('message', (buf) => {
                try { const p = RtpPacket.deSerialize(buf); p.header.payloadType = aPt; p.header.extensions = []; audioTrack.writeRtp(p); stats.a++; } catch { /* */ }
            });
        }

        // 10) Relay RS keyframe requests (PLI/FIR) back to the source encoder.
        const vSender = videoTx.sender;
        vSender.onPictureLossIndication?.subscribe(reqKey);

        // Throughput heartbeat + loss diagnostics. Splits loss into the two legs so we can see
        // where video freezes originate: IN = streamer→relay (our seq-gap detection), RS = relay→RS
        // (werift's RTCP receiver reports from RobotStreamer). pliRx/firRx = keyframes RS asked for.
        let lastV = 0, lastA = 0, lastLostIn = 0, lastKf = 0;
        session.statsTimer = setInterval(() => {
            const s = vSender || {};
            const rsLostPct = typeof s.remoteFractionLost === 'number' ? ((s.remoteFractionLost / 256) * 100).toFixed(1) : '?';
            log(sid, `flow: v ${Math.round((stats.v - lastV) / 10)}/s a ${Math.round((stats.a - lastA) / 10)}/s ` +
                `| kf ${stats.kf - lastKf}/10s maxKfGap ${stats.maxKfGap}ms injSPS/PPS=${stats.inj} ` +
                `| lossIN ${stats.lostIn - lastLostIn} (goosely→relay, now VISIBLE to RS) seqOff=${_seqOffset} ` +
                `| RS lost=${rsLostPct}% pktsLost=${s.remotePacketsLost ?? '?'} pliRx=${s.pliCount ?? '?'} firRx=${s.firCount ?? '?'} nackRx=${s.nackCount ?? '?'} retx=${s.retransmittedPacketsSent ?? '?'} deepRtx=${stats.rtxDeep} rtxMiss=${stats.rtxMiss} rtt=${Math.round((s.rtt || 0) * 1000)}ms ` +
                `| keyReq=${stats.pli} werift=${pc.connectionState}`);
            lastV = stats.v; lastA = stats.a; lastLostIn = stats.lostIn; lastKf = stats.kf; stats.maxKfGap = 0;
        }, 10000);
        session.statsTimer.unref?.();
        // Answer the NACKs werift could not. It fires this AFTER trying its own 128-packet
        // cache, so anything still missing here is a packet it evicted — exactly the repairs
        // that were silently being dropped on the floor. Serve those from the deep ring.
        vSender.onGenericNack?.subscribe((feedback) => {
            const lost = (feedback && feedback.lost) || [];
            if (!lost.length) return;
            const werHist = (vSender.rtpCache && vSender.rtpCache.length) || 128;
            const off = vSender.seqOffset || 0;
            for (const seqNum of lost) {
                // Skip the ones werift just handled from its own window.
                const near = vSender.rtpCache && vSender.rtpCache[seqNum % werHist];
                if (near && near.header.sequenceNumber === seqNum) continue;
                // Our ring is keyed by the sequence number we wrote; werift adds a constant
                // seqOffset on top (0 here, but derive it rather than assume).
                const pkt = _rtxRing[((seqNum - off) & 0xffff) % RTX_RING];
                if (!pkt || pkt.header.sequenceNumber !== seqNum) { stats.rtxMiss++; continue; }
                try {
                    // Same call werift uses — bypasses sendRtp so packet/octet counters stay
                    // truthful and RS's loss maths is not skewed by our repairs.
                    vSender.dtlsTransport.sendRtp(pkt.payload, pkt.header);
                    stats.rtxDeep++;
                } catch { /* transport closing */ }
            }
        });
        // One early keyframe is enough for RS to start decoding. The old flood (plus the plain
        // consumer's own 4 scheduled keyframes) spiked the bitrate on the fresh, fragile werift→RS
        // link and caused a loss burst → the freeze seen right after every (re)connect.
        setTimeout(reqKey, 600);

        log(sid, '✅ raw passthrough live (zero re-encode)');
    }
}

module.exports = new RsPassthroughRelay();
// Exposed for the offline bridge test harness.
module.exports._internals = { parseOffer, buildAnswer, buildProduceParams };
