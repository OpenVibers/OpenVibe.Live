'use strict';
/**
 * OpenVibe.Live — WHEP for agent streams (Agent Streams S1, the design's "Added 2026-11-06").
 *
 * POST /whep/agent/<ags_id> takes an SDP offer and answers an SDP answer for the stream's current live session, the
 * way /whip takes an ingest offer. A viewer authenticates with its **view ticket** (`Authorization: Bearer wvt_…`);
 * a public stream needs none. DELETE ends the session. CORS is the WHIP endpoint's (this serves third-party players
 * and Node's latency probe, `scripts/stream-viewer`), while Live's own player keeps /ws/broadcast.
 *
 * The server is the offerer's peer in the SFU: it creates one recv transport, consumes the stream's audio and video
 * producers with the codecs the client offered, and writes an answer whose m-sections are `sendonly` with the
 * consumers' own RTP parameters. Consumers are ordinary room consumers, so the curtain pauses them like any other
 * (server/streaming/curtains.js) — a WHEP player sees nothing while the desk's curtain is up.
 */
const crypto = require('crypto');
const config = require('../config');
const webrtcSFU = require('./webrtc-sfu');
const whip = require('./whip-handler');

let sdpTransform;
try {
    sdpTransform = require('sdp-transform');
} catch {
    console.warn('[WHEP] sdp-transform not installed — WHEP endpoint disabled');
}

/** resourceId → { streamId, agentId, managedStreamId, peerId, transportId, consumerIds, createdAt } */
const sessions = new Map();

const WHEP_CORS_HEADERS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
    'Access-Control-Expose-Headers': 'Location, X-WHEP-ERROR',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
});

function applyWhepCorsHeaders(res) {
    for (const [name, value] of Object.entries(WHEP_CORS_HEADERS)) res.set(name, value);
    return res;
}

/** Express middleware for /whep: open CORS (a WHEP player is usually on someone else's page) and preflights. */
function whepCors(req, res, next) {
    applyWhepCorsHeaders(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
}

function sendWhepError(res, status, code, message) {
    res.status(status)
        .set('X-WHEP-ERROR', code)
        .json({ error: message, error_code: code });
}

function resourceId() { return crypto.randomBytes(16).toString('hex'); }

function locationFor(req, agentId, resource) {
    const host = (typeof req?.get === 'function' && req.get('host')) ? `${req.protocol || 'https'}://${req.get('host')}` : null;
    const base = host || config.whip?.publicUrl || config.webrtc?.publicUrl || config.baseUrl;
    try { return new URL(`/whep/agent/${agentId}/${resource}`, base).toString(); } catch { return `/whep/agent/${agentId}/${resource}`; }
}

/** fmtp parameters, numbers where they are numbers (the H264 profile-level-id stays a string). */
function parseFmtp(config) {
    const out = {};
    for (const part of String(config || '').split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const at = trimmed.indexOf('=');
        if (at < 1) { out[trimmed] = true; continue; }
        const key = trimmed.slice(0, at).trim();
        const value = trimmed.slice(at + 1).trim();
        out[key] = /^\d+$/.test(value) ? parseInt(value, 10) : value;
    }
    return out;
}

/**
 * The client's RTP capabilities, read from its offer: what it says it can receive. This is what mediasoup's
 * `canConsume` and `consumer.rtpParameters` are negotiated against, so the answer carries codecs the client offered.
 */
function capabilitiesFromOffer(offerSdp) {
    const codecs = [];
    const headerExtensions = [];
    for (const media of offerSdp.media || []) {
        if (media.port === 0) continue;
        const rtpByPt = new Map((media.rtp || []).map((r) => [r.payload, r]));
        const fmtpByPt = new Map((media.fmtp || []).map((f) => [f.payload, f.config]));
        const fbByPt = new Map();
        for (const fb of media.rtcpFb || []) {
            if (!fbByPt.has(fb.payload)) fbByPt.set(fb.payload, []);
            fbByPt.get(fb.payload).push({ type: fb.type, parameter: fb.subtype || '' });
        }
        for (const pt of String(media.payloads || '').split(/\s+/).filter(Boolean).map(Number)) {
            const r = rtpByPt.get(pt);
            if (!r) continue;
            const mimeType = `${media.type}/${r.codec}`;
            if (mimeType.toLowerCase().endsWith('/rtx')) continue;
            codecs.push({
                mimeType,
                clockRate: r.rate,
                ...(r.encoding ? { channels: r.encoding } : {}),
                parameters: parseFmtp(fmtpByPt.get(pt)),
                rtcpFeedback: fbByPt.get(pt) || [],
            });
        }
        for (const ext of media.ext || []) {
            if (!ext.uri) continue;
            headerExtensions.push({ kind: media.type, uri: ext.uri, preferredId: ext.value, preferredEncrypt: false, direction: 'sendrecv' });
        }
    }
    return { codecs, headerExtensions };
}

/**
 * The SDP answer for what the server will send: one `sendonly` m-section per consumed producer, its payload types,
 * fmtp, header extensions and SSRC straight from the consumer's RTP parameters, BUNDLEd like the offer.
 */
function buildWhepAnswer(transport, offerSdp, consumersByIndex, { resourceId: resource } = {}) {
    const { iceParameters, iceCandidates, dtlsParameters } = transport;
    const fingerprint = whip._selectDtlsFingerprint(dtlsParameters.fingerprints);
    const setup = whip._getDtlsSetupAttribute(offerSdp) === 'passive' ? 'active' : 'passive';
    const serverAddress = iceCandidates?.[0]?.ip || config.mediasoup.announcedIp || '127.0.0.1';
    const bundledMids = [];
    const sdpObj = {
        version: 0,
        origin: { username: '-', sessionId: String(Date.now()), sessionVersion: 2, netType: 'IN', ipVer: 4, address: serverAddress },
        name: 'OpenVibe.Live',
        timing: { start: 0, stop: 0 },
        icelite: 'ice-lite',
        groups: [],
        msidSemantic: { semantic: 'WMS', token: '*' },
        media: [],
    };

    for (const [index, offerMedia] of (offerSdp.media || []).entries()) {
        const mid = offerMedia.mid != null ? String(offerMedia.mid) : String(index);
        const consumer = consumersByIndex[index];
        if (!consumer) {
            sdpObj.media.push({
                type: offerMedia.type,
                port: 0,
                protocol: offerMedia.protocol || 'UDP/TLS/RTP/SAVPF',
                payloads: String(offerMedia.payloads || '0'),
                mid,
                direction: 'inactive',
            });
            continue;
        }
        const params = consumer.rtpParameters;
        bundledMids.push(mid);
        const answerMedia = {
            type: offerMedia.type,
            port: 9,
            protocol: offerMedia.protocol || 'UDP/TLS/RTP/SAVPF',
            payloads: '',
            connection: { ip: '0.0.0.0', version: 4 },
            mid,
            iceUfrag: iceParameters.usernameFragment,
            icePwd: iceParameters.password,
            fingerprint: { type: fingerprint.algorithm, hash: fingerprint.value },
            setup,
            direction: 'sendonly',
            rtcpMux: 'rtcp-mux',
            rtp: [],
            fmtp: [],
            rtcpFb: [],
            ext: [],
            candidates: iceCandidates.map((c) => {
                const cand = { foundation: c.foundation, component: 1, transport: c.protocol.toUpperCase(), priority: c.priority, ip: c.ip, port: c.port, type: c.type };
                if (c.tcpType) cand.tcptype = c.tcpType;
                return cand;
            }),
        };

        const payloads = [];
        for (const codec of params.codecs) {
            payloads.push(codec.payloadType);
            answerMedia.rtp.push({ payload: codec.payloadType, codec: codec.mimeType.split('/')[1], rate: codec.clockRate, encoding: codec.channels });
            if (codec.parameters && Object.keys(codec.parameters).length) {
                answerMedia.fmtp.push({ payload: codec.payloadType, config: Object.entries(codec.parameters).map(([k, v]) => `${k}=${v}`).join(';') });
            }
            for (const fb of codec.rtcpFeedback || []) {
                answerMedia.rtcpFb.push({ payload: codec.payloadType, type: fb.type, subtype: fb.parameter || undefined });
            }
        }
        answerMedia.payloads = payloads.join(' ');

        for (const ext of params.headerExtensions || []) answerMedia.ext.push({ value: ext.id, uri: ext.uri });

        const encoding = (params.encodings || [])[0] || {};
        if (encoding.ssrc) {
            const cname = `whep-${resource || 'viewer'}`;
            answerMedia.ssrcs = [
                { id: String(encoding.ssrc), attribute: 'cname', value: cname },
                { id: String(encoding.ssrc), attribute: 'msid', value: `${cname} ${offerMedia.type}` },
            ];
            if (encoding.rtx && encoding.rtx.ssrc) answerMedia.ssrcs.push({ id: String(encoding.rtx.ssrc), attribute: 'cname', value: cname });
        }

        sdpObj.media.push(answerMedia);
    }

    if (bundledMids.length) sdpObj.groups.push({ type: 'BUNDLE', mids: bundledMids.join(' ') });
    return sdpTransform.write(sdpObj);
}

/** The live session and agent stream a WHEP request names, or null. */
async function targetFor(requestId) {
    const service = require('../agent-streams/service');
    const agent = await service.getByPublicId(requestId);
    if (!agent) return null;
    return { agent, live: await service.liveSession(agent.managed_stream_id) };
}

/**
 * POST /whep/agent/:id — the viewer's offer in, the server's sendonly answer out.
 *
 * A private or unlisted stream needs a view ticket, whatever the caller's cookies say (a WHEP client is often on
 * another site); a public one needs none. A stream that is not publishing has nothing to send: 409 not_live.
 */
async function handleWhepPost(req, res) {
    if (!sdpTransform) return sendWhepError(res, 503, 'whep_unavailable', 'WHEP not available (sdp-transform not installed)');
    try {
        const target = await targetFor(req.params.id);
        if (!target) return sendWhepError(res, 404, 'agent_stream_not_found', 'No such agent stream');
        const { agent, live } = target;

        if (agent.visibility !== 'public') {
            const header = String(req.headers.authorization || '');
            const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
            const ticket = bearer ? await require('../agent-streams/tickets').findViewById(bearer, agent.managed_stream_id) : null;
            if (!ticket) return sendWhepError(res, 401, 'invalid_ticket', 'A view ticket is required to watch this stream');
        }
        if (agent.state !== 'live' || !live) return sendWhepError(res, 409, 'not_live', 'This agent stream is not publishing');
        if (!webrtcSFU.ready) return sendWhepError(res, 503, 'sfu_unavailable', 'WebRTC SFU unavailable');

        const offerSdpStr = req.body;
        if (!offerSdpStr || typeof offerSdpStr !== 'string') return sendWhepError(res, 400, 'missing_sdp', 'Missing SDP offer in request body');
        let offerSdp;
        try { offerSdp = sdpTransform.parse(offerSdpStr); } catch { return sendWhepError(res, 400, 'invalid_sdp', 'Invalid SDP offer'); }

        const roomId = `stream-${live.id}`;
        const room = webrtcSFU.rooms?.get(roomId);
        if (!room) return sendWhepError(res, 409, 'not_live', 'No media for this stream right now');

        const capabilities = capabilitiesFromOffer(offerSdp);
        const producers = webrtcSFU.getProducers(roomId) || [];
        const chosen = ['video', 'audio'].map((kind) => {
            const current = webrtcSFU.findProducerByKind(roomId, kind);
            return producers.find((p) => p.id === current?.id) || producers.find((p) => p.kind === kind) || null;
        }).filter(Boolean);
        if (!chosen.length) return sendWhepError(res, 409, 'no_source', 'The stream has no audio or video yet');

        const resource = resourceId();
        const peerId = `whep-${resource}`;
        let transportInfo;
        try {
            transportInfo = await webrtcSFU.createTransport(roomId, peerId, { iceConsentTimeout: 0 });
        } catch (err) {
            console.warn('[WHEP] transport create failed:', err.message);
            return sendWhepError(res, 502, 'transport_creation_failed', 'WHEP transport creation failed');
        }
        const transport = webrtcSFU.rooms.get(roomId)?.transports.get(`${peerId}-${transportInfo.id}`);
        if (!transport) return sendWhepError(res, 502, 'transport_creation_failed', 'WHEP transport creation failed');

        const session = {
            streamId: Number(live.id),
            agentId: agent.public_id,
            managedStreamId: agent.managed_stream_id,
            peerId,
            transportId: transportInfo.id,
            consumerIds: [],
            createdAt: Date.now(),
            resourceId: resource,
        };
        sessions.set(resource, session);

        // A viewer that goes away must not linger as a viewer: the transport closing ends its session.
        transport.on('dtlsstatechange', (state) => {
            if (state === 'closed' || state === 'failed') cleanupWhepSession(resource).catch(() => {});
        });
        transport.on('icestatechange', (state) => {
            if (state === 'failed') cleanupWhepSession(resource).catch(() => {});
        });

        try {
            await webrtcSFU.connectTransport(roomId, peerId, transportInfo.id, whip._extractDtlsParameters(offerSdp));
        } catch (err) {
            console.warn('[WHEP] DTLS negotiation failed:', err.message);
            await cleanupWhepSession(resource);
            return sendWhepError(res, 502, 'dtls_negotiation_failed', 'DTLS negotiation failed');
        }

        // One consumer per offered m-section that matches a producer kind; extra sections are rejected in the answer.
        const consumersByIndex = [];
        for (const [index, media] of (offerSdp.media || []).entries()) {
            if (media.port === 0) continue;
            const producer = chosen.find((p) => p.kind === media.type);
            if (!producer) continue;
            try {
                const consumer = await webrtcSFU.consume(roomId, peerId, transportInfo.id, producer.id, capabilities);
                session.consumerIds.push(consumer.id);
                consumersByIndex[index] = consumer;
                // The curtain is a viewer's reality too: a consumer born while it is up starts paused.
                try { require('./curtains').applyToConsumer(live.id, consumer.id); } catch { /* not an agent room */ }
            } catch (err) {
                console.warn(`[WHEP] consume ${media.type} failed:`, err.message);
            }
        }
        if (!session.consumerIds.length) {
            await cleanupWhepSession(resource);
            return sendWhepError(res, 406, 'no_compatible_codecs', 'No compatible codecs in the offer');
        }

        let answerSdp;
        try {
            answerSdp = buildWhepAnswer(transport, offerSdp, consumersByIndex, { resourceId: resource });
        } catch (err) {
            console.error('[WHEP] answer generation failed:', err.message);
            await cleanupWhepSession(resource);
            return sendWhepError(res, 500, 'answer_generation_failed', 'Failed to generate the SDP answer');
        }

        console.log(`[WHEP] Session ${resource} for ${agent.public_id} (stream ${live.id}, ${session.consumerIds.length} consumer(s))`);
        res.status(201)
            .set('Content-Type', 'application/sdp')
            .set('Location', locationFor(req, agent.public_id, resource))
            .set('Access-Control-Expose-Headers', WHEP_CORS_HEADERS['Access-Control-Expose-Headers'])
            .send(answerSdp);
    } catch (err) {
        console.error('[WHEP] POST error:', err.message || err);
        sendWhepError(res, 500, 'internal_server_error', 'WHEP negotiation failed');
    }
}

/** PATCH /whep/agent/:id/:resourceId — trickle for a session this endpoint opened. */
function handleWhepPatch(req, res) {
    const session = sessions.get(req.params.resourceId);
    if (!session || session.agentId !== req.params.id) return sendWhepError(res, 404, 'session_not_found', 'Session not found');
    return res.status(204).end();
}

/** DELETE /whep/agent/:id/:resourceId — the viewer leaves; the stream keeps going. */
async function handleWhepDelete(req, res) {
    const session = sessions.get(req.params.resourceId);
    if (!session || session.agentId !== req.params.id) return sendWhepError(res, 404, 'session_not_found', 'Session not found');
    await cleanupWhepSession(req.params.resourceId);
    return res.status(200).end();
}

function handleWhepOptions(req, res) {
    applyWhepCorsHeaders(res.status(204)).end();
}

/** Close a WHEP session: its consumers, then its transport. Known to the curtain as ordinary consumers. */
async function cleanupWhepSession(resource) {
    const session = sessions.get(resource);
    if (!session) return;
    sessions.delete(resource);
    try {
        const room = webrtcSFU.rooms?.get(`stream-${session.streamId}`);
        if (room) {
            for (const consumerId of session.consumerIds) {
                const entry = room.consumers.get(consumerId);
                if (entry) {
                    try { entry.consumer.close(); } catch { /* already closed */ }
                    room.consumers.delete(consumerId);
                }
            }
            const key = `${session.peerId}-${session.transportId}`;
            const transport = room.transports.get(key);
            if (transport) {
                try { transport.close(); } catch { /* already closed */ }
                room.transports.delete(key);
            }
        }
    } catch (err) {
        console.warn('[WHEP] cleanup error:', err.message);
    }
    try { require('./curtains').forget(session.streamId, session.consumerIds); } catch { /* */ }
    console.log(`[WHEP] Session ${resource} cleaned up (stream ${session.streamId})`);
}

/** How many WHEP viewers a live session has (they count as viewers: the desk encodes only while someone watches). */
function countForStream(streamId) {
    let n = 0;
    for (const session of sessions.values()) if (session.streamId === Number(streamId)) n++;
    return n;
}

function closeAllForStream(streamId) {
    for (const [resource, session] of sessions) {
        if (session.streamId === Number(streamId)) cleanupWhepSession(resource).catch(() => {});
    }
}

module.exports = {
    handleWhepPost,
    handleWhepPatch,
    handleWhepDelete,
    handleWhepOptions,
    whepCors,
    applyWhepCorsHeaders,
    WHEP_CORS_HEADERS,
    sessions,
    cleanupWhepSession,
    countForStream,
    closeAllForStream,
    available: !!sdpTransform,
    _capabilitiesFromOffer: capabilitiesFromOffer,
    _buildWhepAnswer: buildWhepAnswer,
};
